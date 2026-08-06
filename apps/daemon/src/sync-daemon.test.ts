import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { SyncStatus } from "@crosscode/protocol";
// The agent surface, imported as the agent's MCP client reaches it: the real tool
// dispatcher over the real loopback API, not a stand-in for either.
import { connectToDaemon } from "../../mcp-server/src/daemon-api.js";
import { callSyncTool } from "../../mcp-server/src/index.js";
import { DaemonClient } from "./client.js";
import { writeSyncConfig } from "./sync-config.js";
import { SyncDaemon, type SyncDaemonOptions } from "./sync-daemon.js";
import { startSyncServiceStub, type SyncServiceStub } from "./sync-service-stub.js";

/**
 * Three real daemons -- real watchers, real sockets, real git -- against an in-process
 * stand-in for the coordination service. PLAN.md's phase 4 verification, and the case the
 * spike explicitly left unproven: it only ever ran two replicas.
 */

const exec = promisify(execFile);
const directories: string[] = [];
const daemons: SyncDaemon[] = [];
const services: SyncServiceStub[] = [];

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()));
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const FAST: SyncDaemonOptions = {
  debounceMs: 40,
  flushMs: 100,
  deferralMs: 60,
  gitPollMs: 100,
  streamPollMs: 100,
  // The 10s hot window is real behaviour, not a constant worth waiting out in a test.
  engine: { hotWindowMs: 150, maxDeferrals: 3 }
};

async function seedOrigin(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "crosscode-origin-"));
  directories.push(root);
  await exec("git", ["init", "-q", "-b", "main", root]);
  await exec("git", ["-C", root, "config", "user.email", "seed@example.com"]);
  await exec("git", ["-C", root, "config", "user.name", "seed"]);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await exec("git", ["-C", root, "add", "-A"]);
  await exec("git", ["-C", root, "commit", "-qm", "seed"]);
  return root;
}

async function checkout(origin: string, name: string, service: SyncServiceStub): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), `crosscode-${name}-`));
  directories.push(parent);
  const root = join(parent, name);
  await exec("git", ["clone", "-q", origin, root]);
  await exec("git", ["-C", root, "config", "user.email", `${name}@example.com`]);
  await exec("git", ["-C", root, "config", "user.name", name]);
  await writeSyncConfig(root, { projectId: "project-1", repo: "acme/app", service: { url: service.url } });
  return root;
}

async function start(root: string, options: SyncDaemonOptions = {}): Promise<SyncDaemon> {
  const daemon = await SyncDaemon.start(root, { ...FAST, ...options });
  daemons.push(daemon);
  return daemon;
}

/** A user edit: the daemon has to notice it the same way it notices any other. */
async function type(root: string, path: string, content: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

const read = (root: string, path: string) => readFile(join(root, path), "utf8").catch(() => null);

const git = async (root: string, ...args: string[]) => (await exec("git", ["-C", root, ...args])).stdout.trim();
const head = (root: string) => git(root, "rev-parse", "HEAD");

/** A real commit, the way the user makes one: git only, nothing through the daemon. */
async function commit(root: string, paths: string[], message: string): Promise<string> {
  await git(root, "add", "--", ...paths);
  await git(root, "commit", "-qm", message);
  return head(root);
}

// Convergence is a real distributed handshake over real sockets and real git, so the only
// honest deadline is "longer than a loaded machine takes". 20s was under that on a 4-vCPU
// runner while the tests themselves were allowed 60s, so a slow-but-progressing sync failed
// with budget to spare. Stay just inside the test timeout instead.
async function waitFor<T>(description: string, probe: () => Promise<T | undefined>, timeoutMs = 45_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const result = await probe();
      if (result !== undefined && result !== false) return result;
    } catch (error) { last = error; }
    await new Promise((next) => setTimeout(next, 50));
  }
  throw new Error(`Timed out waiting for ${description}${last ? `: ${String(last)}` : ""}`);
}

async function allEqual(roots: string[], path: string, expected?: string): Promise<string | undefined> {
  const contents = await Promise.all(roots.map((root) => read(root, path)));
  const [first] = contents;
  if (first === null || !contents.every((content) => content === first)) return undefined;
  if (expected !== undefined && first !== expected) return undefined;
  return first;
}

const lines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
function edit(source: string, index: number, replacement: string): string {
  const parts = source.split("\n");
  parts[index] = replacement;
  return parts.join("\n");
}

describe("three real daemons", () => {
  it("converges byte-identically on concurrent edits, with no conflicts and no interaction", async () => {
    const service = await startSyncServiceStub();
    services.push(service);
    const origin = await seedOrigin({ "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n", "shared.txt": lines(30) });
    const roots = await Promise.all(["alice", "bob", "carol"].map((name) => checkout(origin, name, service)));
    const running = [];
    for (const root of roots) running.push(await start(root));

    // Three peers, three files, at the same time.
    await Promise.all([
      type(roots[0]!, "a.txt", "alice\n"),
      type(roots[1]!, "b.txt", "bob\n"),
      type(roots[2]!, "c.txt", "carol\n")
    ]);

    await waitFor("a.txt everywhere", () => allEqual(roots, "a.txt", "alice\n"));
    await waitFor("b.txt everywhere", () => allEqual(roots, "b.txt", "bob\n"));
    await waitFor("c.txt everywhere", () => allEqual(roots, "c.txt", "carol\n"));

    // ...and three disjoint hunks of one file.
    const base = lines(30);
    await type(roots[0]!, "shared.txt", edit(base, 1, "ALICE"));
    await type(roots[1]!, "shared.txt", edit(base, 14, "BOB"));
    await type(roots[2]!, "shared.txt", edit(base, 27, "CAROL"));

    const merged = await waitFor("shared.txt to converge", async () => {
      const content = await allEqual(roots, "shared.txt");
      return content?.includes("ALICE") && content.includes("BOB") && content.includes("CAROL") ? content : undefined;
    });

    expect(merged).toContain("ALICE");
    expect(running.flatMap((daemon) => daemon.conflicts())).toHaveLength(0);
    for (const daemon of running) expect(daemon.status().pendingConflicts).toBe(0);
  }, 60_000);

  it("turns one deliberate collision into exactly one conflict, and resolves it", async () => {
    const service = await startSyncServiceStub();
    services.push(service);
    const base = lines(20);
    const origin = await seedOrigin({ "shared.txt": base });
    const roots = await Promise.all(["alice", "bob", "carol"].map((name) => checkout(origin, name, service)));
    const [alice, bob, carol] = [await start(roots[0]!), await start(roots[1]!), await start(roots[2]!)];

    // Bob is paused, so his edit stays home and alice's arrives while he is holding it:
    // a collision on the same line, deterministically ordered.
    await bob.setPaused(true);
    await type(roots[1]!, "shared.txt", edit(base, 9, "BOB"));
    await type(roots[0]!, "shared.txt", edit(base, 9, "ALICE"));
    await waitFor("alice's line to reach carol", () => allEqual([roots[0]!, roots[2]!], "shared.txt", edit(base, 9, "ALICE")));
    await bob.setPaused(false);

    const conflicts = await waitFor("bob's conflict", async () => {
      const found = bob.conflicts();
      return found.length ? found : undefined;
    });

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.path).toBe("shared.txt");
    expect(conflicts[0]!.ours).toBe(edit(base, 9, "BOB"));
    expect(conflicts[0]!.theirs).toBe(edit(base, 9, "ALICE"));
    expect(conflicts[0]!.ancestor).toBe(base);
    // Exactly one: bob quarantines the path rather than publishing his side of it, so
    // alice and carol never sit down to fix the same collision from the other end.
    expect(alice.conflicts()).toHaveLength(0);
    expect(carol.conflicts()).toHaveLength(0);
    // And nothing was written over bob's work.
    expect(await read(roots[1]!, "shared.txt")).toBe(edit(base, 9, "BOB"));

    const resolution = edit(base, 9, "ALICE AND BOB");
    const client = await DaemonClient.connect(roots[1]!);
    await expect(client.conflicts()).resolves.toHaveLength(1);
    await expect(client.resolve(conflicts[0]!.id, resolution)).resolves.toHaveLength(0);

    await waitFor("the resolution everywhere", () => allEqual(roots, "shared.txt", resolution));
    expect((await client.status()).pendingConflicts).toBe(0);
  }, 60_000);
});

describe("the daemon around the engine", () => {
  it("catches up from its cursor after the socket drops", async () => {
    const service = await startSyncServiceStub();
    services.push(service);
    const origin = await seedOrigin({ "a.txt": "0\n" });
    const roots = await Promise.all(["alice", "bob"].map((name) => checkout(origin, name, service)));
    const [alice, bob] = [await start(roots[0]!), await start(roots[1]!)];
    await waitFor("both daemons connected", async () => alice.status().connected && bob.status().connected);

    service.disconnectAll();
    await type(roots[0]!, "a.txt", "published while bob was away\n");

    await waitFor("bob to catch up", () => allEqual(roots, "a.txt", "published while bob was away\n"));
    // The cursor moves once the change is fully accounted for, which is a beat after the
    // bytes land on disk.
    await waitFor("bob's cursor to advance", async () => bob.status().cursor > 0);
  }, 60_000);

  /**
   * The production outage this covers: the service runs as a serverless function, which
   * cannot answer a WebSocket upgrade, so `/v1/stream` 404s forever. Publishing worked and
   * receiving did not -- an uploader, not a sync -- and `crosscode status` said
   * `connected: false` with no way for it to ever become true.
   */
  it("still receives a peer's edits when the host cannot serve a stream at all", async () => {
    const service = await startSyncServiceStub({ streams: false });
    services.push(service);
    const origin = await seedOrigin({ "a.txt": "0\n" });
    const roots = await Promise.all(["alice", "bob"].map((name) => checkout(origin, name, service)));
    const [alice, bob] = [await start(roots[0]!), await start(roots[1]!)];

    // Reachable by the only transport there is, and honest about saying so.
    await waitFor("both daemons to report themselves connected", async () => alice.status().connected && bob.status().connected);

    await type(roots[0]!, "a.txt", "arrived without a socket\n");
    await waitFor("bob to receive it", () => allEqual(roots, "a.txt", "arrived without a socket\n"));

    // And the other way, so it is a two-way sync rather than one lucky direction.
    await type(roots[1]!, "a.txt", "and back again\n");
    await waitFor("alice to receive it", () => allEqual(roots, "a.txt", "and back again\n"));
  }, 60_000);

  /**
   * `crosscode start` polls for the descriptor every 100ms and reports success the moment
   * it appears. Written when the loopback server bound, it appeared before the stream was
   * up -- so a daemon that then died on an expired session still had `start` announcing
   * "Daemon started; this checkout is syncing" about a process that was already gone.
   */
  it("does not advertise itself as ready while start-up is still in flight", async () => {
    // Accepts the connection and never answers, so the daemon is unambiguously still
    // starting up while the assertions below run.
    const hanging = createServer(() => {});
    await new Promise<void>((ready) => hanging.listen(0, "127.0.0.1", ready));
    const service = await startSyncServiceStub();
    services.push(service);
    const origin = await seedOrigin({ "a.txt": "0\n" });
    const root = await checkout(origin, "alice", service);
    await writeSyncConfig(root, {
      projectId: "project-1", repo: "acme/app",
      service: { url: `http://127.0.0.1:${(hanging.address() as { port: number }).port}` }
    });

    const starting = start(root).catch(() => undefined);
    // Comfortably past the point the loopback server has bound and the old code would have
    // published the descriptor, and well inside the request that never returns.
    await new Promise((settle) => setTimeout(settle, 2_000));
    const descriptor = await read(root, ".git/crosscode/daemon.json");

    // Dropping the connection fails the pending request now rather than at its 10s timeout,
    // which is 8s this suite does not need to spend.
    hanging.closeAllConnections();
    await new Promise<void>((closed) => hanging.close(() => closed()));
    await starting;

    expect(descriptor).toBeNull();
  }, 60_000);

  /**
   * A change built on a blob this checkout has never held makes apply() call catchUp() to
   * fill the gap. Called from inside a drain, that re-walked the same page from the same
   * cursor -- and the cursor cannot move past a change that has not applied, so it never
   * moved. One such change from one peer span the real service at several requests a second
   * indefinitely, while `crosscode status` showed `cursor` frozen and no error anywhere.
   */
  it("does not spin the service on a change it cannot rebase", async () => {
    const service = await startSyncServiceStub();
    services.push(service);
    const origin = await seedOrigin({ "a.txt": "0\n" });
    const root = await checkout(origin, "alice", service);
    // A modify whose baseHash names a blob that exists nowhere: the sender's history is one
    // this checkout has no way to reach.
    service.changes.push({
      sequence: 1, projectId: "project-1", branch: "main",
      replicaId: "00000000-1111-4222-8333-444455556666",
      createdAt: "2026-01-01T00:00:00.000Z",
      version: {
        path: "a.txt", op: "modify", baseHash: "0".repeat(40),
        contentHash: "1".repeat(40), content: "from a history we never had\n", encoding: "utf8"
      }
    });

    const daemon = await start(root);
    await waitFor("the cursor to get past it", async () => daemon.status().cursor >= 1);
    const afterSettling = service.listCalls;
    await new Promise((settle) => setTimeout(settle, 1_000));

    // Ten polls a second would be a spin; the configured interval is 100ms in these tests,
    // so a healthy daemon asks a handful of times in a second and no more.
    expect(service.listCalls - afterSettling).toBeLessThan(20);
  }, 60_000);

  it("resyncs from full content when the service says the cursor is too old", async () => {
    const service = await startSyncServiceStub();
    services.push(service);
    const origin = await seedOrigin({ "a.txt": "0\n" });
    const roots = await Promise.all(["alice", "bob"].map((name) => checkout(origin, name, service)));
    const [alice, bob] = [await start(roots[0]!), await start(roots[1]!)];
    await waitFor("both connected", async () => alice.status().connected && bob.status().connected);

    // History bob never saw is gone; the only honest recovery is full content.
    service.disconnectAll();
    await type(roots[0]!, "a.txt", "first\n");
    await waitFor("alice to publish", async () => service.changes.length > 0);
    service.retentionFloor = 1_000;

    await waitFor("bob to adopt the watermark", async () => bob.status().cursor >= 1_000);
    expect(bob.status().cursor).toBeGreaterThanOrEqual(1_000);
  }, 60_000);

  it("pauses during a git operation and resyncs when it is over", async () => {
    const service = await startSyncServiceStub();
    services.push(service);
    const origin = await seedOrigin({ "a.txt": "0\n" });
    const roots = await Promise.all(["alice", "bob"].map((name) => checkout(origin, name, service)));
    const [alice, bob] = [await start(roots[0]!), await start(roots[1]!)];
    await waitFor("both connected", async () => alice.status().connected && bob.status().connected);

    // A merge left mid-flight is exactly the state `git merge` stops in on a conflict.
    await writeFile(join(roots[0]!, ".git", "MERGE_HEAD"), `${await exec("git", ["-C", roots[0]!, "rev-parse", "HEAD"]).then(({ stdout }) => stdout.trim())}\n`);
    await waitFor("alice to pause", async () => alice.status().paused);
    await type(roots[0]!, "a.txt", "mid-merge\n");
    await new Promise((next) => setTimeout(next, 400));
    expect(await read(roots[1]!, "a.txt")).toBe("0\n");

    await rm(join(roots[0]!, ".git", "MERGE_HEAD"));
    await waitFor("alice to resume and resync", () => allEqual(roots, "a.txt", "mid-merge\n"));
    expect(alice.status().paused).toBe(false);
  }, 60_000);

  it("notices a plain commit on the same branch without republishing anything", async () => {
    const service = await startSyncServiceStub();
    services.push(service);
    const origin = await seedOrigin({ "a.txt": "a\n", "b.txt": "b\n" });
    const roots = await Promise.all(["alice", "bob"].map((name) => checkout(origin, name, service)));
    const [alice, bob] = [await start(roots[0]!), await start(roots[1]!)];
    await waitFor("both connected", async () => alice.status().connected && bob.status().connected);

    // Two uncommitted edits, both agreed with bob.
    await type(roots[0]!, "a.txt", "alice edits a\n");
    await type(roots[0]!, "b.txt", "alice edits b\n");
    await waitFor("a.txt at bob", () => allEqual(roots, "a.txt", "alice edits a\n"));
    await waitFor("b.txt at bob", () => allEqual(roots, "b.txt", "alice edits b\n"));
    const published = service.changes.length;

    // Only a.txt is committed. Neither the branch check nor the operation check fires.
    const committed = await commit(roots[0]!, ["a.txt"], "commit a");
    await waitFor("alice to notice the commit", async () => alice.status().head === committed);

    // Several poll and debounce cycles later, nothing has gone out: a.txt matches HEAD, and
    // b.txt is still agreed at the bytes bob holds rather than reset back to the seed.
    await new Promise((next) => setTimeout(next, 600));
    // ...and a full sweep, the widest thing that ever publishes, still finds nothing to say.
    // This is where resetToHead() would broadcast b.txt again with a base bob never agreed to.
    await alice.setPaused(true);
    await alice.setPaused(false);
    await alice.drain();
    expect(service.changes.length).toBe(published);
    expect(alice.engine.shadowHash("a.txt")).toBe(await git(roots[0]!, "rev-parse", "HEAD:a.txt"));
    expect(alice.engine.shadowHash("b.txt")).toBe(await git(roots[0]!, "hash-object", "b.txt"));
    expect(alice.conflicts()).toHaveLength(0);
    expect(await read(roots[1]!, "b.txt")).toBe("alice edits b\n");
  }, 60_000);

  it("tells the teammate's agent to pull when a peer commits, and leaves their tree alone", async () => {
    const service = await startSyncServiceStub();
    services.push(service);
    const origin = await seedOrigin({ "a.txt": "a\n", "notes.txt": "notes\n" });
    const roots = await Promise.all(["alice", "bob"].map((name) => checkout(origin, name, service)));
    const [alice, bob] = [await start(roots[0]!), await start(roots[1]!)];
    await waitFor("both connected", async () => alice.status().connected && bob.status().connected);

    // Alice and bob end up holding the same uncommitted edit, and bob has work of his own.
    await type(roots[0]!, "a.txt", "shared, and uncommitted\n");
    await waitFor("a.txt at bob", () => allEqual(roots, "a.txt", "shared, and uncommitted\n"));
    await type(roots[1]!, "notes.txt", "bob's own uncommitted work\n");
    await waitFor("notes.txt at alice", () => allEqual(roots, "notes.txt", "bob's own uncommitted work\n"));
    const bobHead = await head(roots[1]!);

    await commit(roots[0]!, ["a.txt"], "alice commits the shared edit");

    const notice = await waitFor("bob's pull notice", async () => bob.status().notice);
    expect(notice).toContain("git pull");
    expect(notice).toContain("main");
    // Nothing was done to bob's checkout to make that pull succeed: same HEAD, same bytes,
    // and a.txt is still the modified-but-uncommitted file it was.
    expect(await head(roots[1]!)).toBe(bobHead);
    expect(await read(roots[1]!, "a.txt")).toBe("shared, and uncommitted\n");
    expect(await read(roots[1]!, "notes.txt")).toBe("bob's own uncommitted work\n");
    expect(await git(roots[1]!, "status", "--porcelain")).toContain("a.txt");
    expect(bob.conflicts()).toHaveLength(0);
    // Alice is ahead, not behind: bob's HEAD is an ancestor of hers, so she is told nothing.
    expect(alice.status().notice).toBeUndefined();
  }, 60_000);

  it("clears the notice once the teammate pulls, without republishing what the pull brought in", async () => {
    const service = await startSyncServiceStub();
    services.push(service);
    const origin = await seedOrigin({ "a.txt": "a\n" });
    const roots = await Promise.all(["alice", "bob"].map((name) => checkout(origin, name, service)));
    const [alice, bob] = [await start(roots[0]!), await start(roots[1]!)];
    await waitFor("both connected", async () => alice.status().connected && bob.status().connected);
    await type(roots[0]!, "a.txt", "shared, and uncommitted\n");
    await waitFor("a.txt at bob", () => allEqual(roots, "a.txt", "shared, and uncommitted\n"));

    await commit(roots[0]!, ["a.txt"], "alice commits the shared edit");
    await waitFor("bob's pull notice", async () => bob.status().notice);
    const published = service.changes.length;

    // The remedy the notice describes, run by hand the way the agent would run it: the
    // local change is byte-identical to what is landing, so it is dropped and then pulled.
    await git(roots[1]!, "checkout", "--", "a.txt");
    await git(roots[1]!, "pull", "-q", "--no-rebase", roots[0]!, "main");

    await waitFor("bob's notice to clear", async () => (bob.status().notice === undefined ? true : undefined));
    expect(await head(roots[1]!)).toBe(await head(roots[0]!));
    expect(await read(roots[1]!, "a.txt")).toBe("shared, and uncommitted\n");
    // The pull is git's business. Nothing about it goes on the wire, in either direction.
    await new Promise((next) => setTimeout(next, 400));
    await bob.drain();
    expect(service.changes.length).toBe(published);
    expect(bob.conflicts()).toHaveLength(0);
    expect(bob.engine.shadowHash("a.txt")).toBe(await git(roots[1]!, "rev-parse", "HEAD:a.txt"));
  }, 60_000);

  it("hands that notice to the agent through the MCP status tool", async () => {
    const service = await startSyncServiceStub();
    services.push(service);
    const origin = await seedOrigin({ "a.txt": "a\n" });
    const roots = await Promise.all(["alice", "bob"].map((name) => checkout(origin, name, service)));
    const [alice, bob] = [await start(roots[0]!), await start(roots[1]!)];
    await waitFor("both connected", async () => alice.status().connected && bob.status().connected);
    await type(roots[0]!, "a.txt", "shared, and uncommitted\n");
    await waitFor("a.txt at bob", () => allEqual(roots, "a.txt", "shared, and uncommitted\n"));

    await commit(roots[0]!, ["a.txt"], "alice commits");
    await waitFor("bob's pull notice", async () => bob.status().notice);

    // The agent's path: the MCP server's own dispatcher, over the daemon's loopback API.
    delete process.env.CROSSCODE_DAEMON_URL;
    const result = await callSyncTool(await connectToDaemon(roots[1]!), "status", {});
    const status = result.status as SyncStatus;

    expect(status.head).toBe(await head(roots[1]!));
    expect(status.notice).toContain("git pull");
    expect(result.conflicts).toEqual([]);
  }, 60_000);

  it("refuses a second daemon for the same worktree", async () => {
    const service = await startSyncServiceStub();
    services.push(service);
    const origin = await seedOrigin({ "a.txt": "0\n" });
    const root = await checkout(origin, "alice", service);
    await start(root);

    await expect(SyncDaemon.start(root, FAST)).rejects.toThrow("already running");
  }, 30_000);

  it("serves the local API the CLI and MCP server use", async () => {
    const service = await startSyncServiceStub();
    services.push(service);
    const origin = await seedOrigin({ "a.txt": "0\n" });
    const root = await checkout(origin, "alice", service);
    const daemon = await start(root);
    const client = await DaemonClient.connect(root);

    const status = await client.status();
    expect(status.branch).toBe("main");
    expect(status.paused).toBe(false);
    await expect(client.conflicts()).resolves.toEqual([]);
    await expect(client.pause(true)).resolves.toMatchObject({ paused: true });
    expect(daemon.status().paused).toBe(true);
    await expect(client.pause(false)).resolves.toMatchObject({ paused: false });
    await expect(client.resolve("no-such-conflict", "x")).rejects.toThrow();
  }, 30_000);

  it("never publishes a secret, however hard the user edits it", async () => {
    const service = await startSyncServiceStub();
    services.push(service);
    const origin = await seedOrigin({ ".env": "SECRET=1\n", "a.txt": "0\n" });
    const roots = await Promise.all(["alice", "bob"].map((name) => checkout(origin, name, service)));
    const [alice, bob] = [await start(roots[0]!), await start(roots[1]!)];
    await waitFor("both connected", async () => alice.status().connected && bob.status().connected);

    await type(roots[0]!, ".env", "SECRET=leaked\n");
    await type(roots[0]!, "a.txt", "1\n");

    await waitFor("the harmless file to travel", () => allEqual(roots, "a.txt", "1\n"));
    expect(service.changes.some((change) => change.version.path === ".env")).toBe(false);
    expect(await read(roots[1]!, ".env")).toBe("SECRET=1\n");
  }, 60_000);
});
