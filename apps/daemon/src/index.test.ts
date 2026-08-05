import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { CoordinationService } from "../../service/src/index.js";
import { contentHash } from "@crosscode/core";
import { discoverRepository } from "@crosscode/git";
import { LocalDaemon, type RemoteSyncTransport } from "./index.js";

const exec = promisify(execFile); const directories: string[] = [];
async function repo(): Promise<string> { const path = await mkdtemp(join(tmpdir(), "crosscode-daemon-")); directories.push(path); await exec("git", ["init", "-q", "-b", "main", path]); await exec("git", ["-C", path, "config", "user.email", "test@example.com"]); await exec("git", ["-C", path, "config", "user.name", "Test"]); await writeFile(join(path, "a.txt"), "one\n"); await exec("git", ["-C", path, "add", "."]); await exec("git", ["-C", path, "commit", "-qm", "initial"]); return path; }
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

/** A transport with nothing to sync, for tests that care about exactly one of its methods. */
function emptyTransport(): RemoteSyncTransport {
  return {
    upload: async (record) => ({ id: record.transaction.id, workspaceId: "w", senderReplicaId: "replica", transaction: record.transaction, sequence: 1, createdAt: new Date().toISOString() }),
    list: async (after) => ({ operations: [], nextCursor: after })
  };
}

describe("local daemon coordination", () => {
  it("restores local state from its SQLite event store after restart", async () => {
    const root = await repo();
    const daemon = await LocalDaemon.open(root, { workspaceId: "w", replicaId: "replica", actorId: "actor" });
    await writeFile(join(root, "a.txt"), "changed\n");
    const operation = await daemon.capture("persist operation");
    const statePath = join(root, ".git", "crosscode", "state.sqlite");
    expect((await stat(statePath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, ".git", "crosscode"))).mode & 0o777).toBe(0o700);

    const restarted = await LocalDaemon.open(root, { workspaceId: "w", replicaId: "replica", actorId: "actor" });
    expect(restarted.operations.get(operation.id)).toMatchObject({ id: operation.id });

    const database = new DatabaseSync(statePath, { readOnly: true });
    const events = database.prepare("SELECT sequence, type, payload FROM local_events ORDER BY sequence").all() as Array<{ sequence: number; type: string; payload: string }>;
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(["transaction.created"]));
    expect(events.every((event, index) => event.sequence === index + 1)).toBe(true);
    expect(database.prepare("SELECT COUNT(*) AS count FROM operation_projection").get()).toEqual({ count: 1 });
    database.close();
  });

  it("captures settled filesystem edits as a single local transaction", async () => {
    const root = await repo();
    const daemon = await LocalDaemon.open(root, { workspaceId: "w", replicaId: "replica", actorId: "actor" });
    const captured = new Promise<string>((resolveCapture) => daemon.onTransaction((operation) => resolveCapture(operation.id)));
    const watcher = await daemon.watch({ debounceMs: 40 });
    await writeFile(join(root, "a.txt"), "two\n");

    const operationId = await captured;
    await watcher.close();
    expect(daemon.operations.get(operationId)?.transaction.changes).toMatchObject([{ path: "a.txt", kind: "modify" }]);
  });

  it("does not capture excluded filesystem paths", async () => {
    const root = await repo();
    const daemon = await LocalDaemon.open(root, { workspaceId: "w", replicaId: "replica", actorId: "actor" });
    const watcher = await daemon.watch({ debounceMs: 40 });
    await writeFile(join(root, ".env"), "TOKEN=not-for-sync\n");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 120));
    await watcher.close();

    expect(daemon.operations.size).toBe(0);
  });

  it("does not advance the remote cursor for offline local work", async () => {
    const senderRoot = await repo(); const receiverRoot = await repo(); const service = new CoordinationService();
    const sender = await LocalDaemon.open(senderRoot, { workspaceId: "w", replicaId: "sender", actorId: "a" }); const receiver = await LocalDaemon.open(receiverRoot, { workspaceId: "w", replicaId: "receiver", actorId: "b" });
    await writeFile(join(receiverRoot, "offline.txt"), "local only\n");
    await receiver.capture("offline work");
    await writeFile(join(senderRoot, "a.txt"), "shared\n");
    const remote = await sender.capture("shared work", service);

    const received = await receiver.sync(service);
    expect(received).toMatchObject([{ id: remote.id }]);
  });

  it("does not repeat an already captured uncommitted edit", async () => {
    const root = await repo();
    const daemon = await LocalDaemon.open(root, { workspaceId: "w", replicaId: "replica", actorId: "actor" });
    await writeFile(join(root, "a.txt"), "first\n");
    await daemon.capture("first edit");
    await writeFile(join(root, "b.txt"), "second\n");
    const second = await daemon.capture("second edit");

    expect(second.transaction.changes).toMatchObject([{ path: "b.txt", kind: "add" }]);
  });

  it("captures a Git rename with a content edit in the same commit as a rename (not a delete+add)", async () => {
    const senderRoot = await repo(); const service = new CoordinationService();
    const original = "line1\nline2\nline3\nline4\nline5\n";
    await writeFile(join(senderRoot, "a.txt"), original);
    await exec("git", ["-C", senderRoot, "commit", "-aqm", "seed multi-line content"]);
    const sender = await LocalDaemon.open(senderRoot, { workspaceId: "w", replicaId: "sender", actorId: "a" });

    await exec("git", ["-C", senderRoot, "mv", "a.txt", "b.txt"]);
    const edited = "line1\nline2\nEDITED\nline4\nline5\n";
    await writeFile(join(senderRoot, "b.txt"), edited);

    const operation = await sender.capture("rename and edit", service);
    expect(operation.transaction.changes).toEqual([
      expect.objectContaining({ path: "b.txt", kind: "rename", previousPath: "a.txt", afterContent: edited, afterHash: contentHash(edited), beforeHash: contentHash(original) })
    ]);
  });

  it("rejects symlink traversal and honors committed configured exclusions", async () => {
    const root = await repo();
    const outside = await mkdtemp(join(tmpdir(), "crosscode-outside-"));
    directories.push(outside);
    await writeFile(join(outside, "secret.txt"), "outside\n");
    await symlink(outside, join(root, "linked"));
    const daemon = await LocalDaemon.open(root, { workspaceId: "w", replicaId: "replica", actorId: "actor" });
    await expect(daemon.capture("read symlink")).rejects.toThrow(/symbolic link/i);

    await rm(join(root, "linked"));
    await mkdir(join(root, ".crosscode"), { recursive: true });
    await writeFile(join(root, ".crosscode", "config.yaml"), "version: 1\nexcludedPaths:\n  - private/**\n");
    await mkdir(join(root, "private"), { recursive: true });
    await writeFile(join(root, "private", "ignored.txt"), "ignored\n");
    await exec("git", ["-C", root, "add", "-f", ".crosscode/config.yaml", "private/ignored.txt"]);
    await exec("git", ["-C", root, "commit", "-qm", "add exclusions"]);
    await writeFile(join(root, "private", "ignored.txt"), "still ignored\n");
    await expect(daemon.capture("excluded edit")).rejects.toThrow("No eligible");
  });

  it("records a local transaction durably before publishing it", async () => {
    const root = await repo(); const service = new CoordinationService();
    const daemon = await LocalDaemon.open(root, { workspaceId: "w", replicaId: "replica", actorId: "actor" });
    const originalReceive = service.receive.bind(service);
    let durableAtPublish = false;
    service.receive = (event, transaction) => {
      const database = new DatabaseSync(join(root, ".git", "crosscode", "state.sqlite"), { readOnly: true });
      durableAtPublish = database.prepare("SELECT COUNT(*) AS count FROM operation_projection WHERE id = ?").get(transaction.id)!.count === 1;
      database.close();
      return originalReceive(event, transaction);
    };
    await writeFile(join(root, "a.txt"), "published\n");

    await daemon.capture("durable publish", service);

    expect(durableAtPublish).toBe(true);
  });

  it("persists a stable outbox event and reconnects without applying remote files", async () => {
    const root = await repo();
    let daemon = await LocalDaemon.open(root, { workspaceId: "w", replicaId: "replica", actorId: "actor" });
    await writeFile(join(root, "a.txt"), "offline\n");
    const local = await daemon.capture("offline durable event");
    const queued = [...daemon.outbound.values()].find((record) => record.event.id === local.id)!;
    daemon.close();

    daemon = await LocalDaemon.open(root, { workspaceId: "w", replicaId: "replica", actorId: "actor" });
    expect(daemon.outbound.get(queued.event.id)?.event).toEqual(queued.event);
    const remoteTransaction = {
      ...local.transaction,
      id: "remote-operation",
      changes: [{ ...local.transaction.changes[0]!, afterContent: "remote\n", afterHash: contentHash("remote\n") }]
    };
    const result = await daemon.syncRemote({
      upload: async (record) => ({ id: record.transaction.id, workspaceId: "w", senderReplicaId: "replica", transaction: record.transaction, sequence: 1, createdAt: new Date().toISOString() }),
      list: async () => ({ operations: [
        { id: local.id, workspaceId: "w", senderReplicaId: "replica", transaction: local.transaction, sequence: 1, createdAt: new Date().toISOString() },
        { id: remoteTransaction.id, workspaceId: "w", senderReplicaId: "other", transaction: remoteTransaction, sequence: 2, createdAt: new Date().toISOString() }
      ], nextCursor: 2 })
    });

    expect(result).toEqual({ uploaded: 1, downloaded: 1, cursor: 2 });
    expect(daemon.outbound.get(queued.event.id)?.acknowledgedServerSequence).toBe(1);
    expect(daemon.operations.has("remote-operation")).toBe(true);
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("offline\n");
  });

  // The failure this guards against is silent: with retention deleting operations, a
  // replica whose cursor sits below the deleted range would be handed a short (often empty)
  // list, conclude it was caught up, and never learn the changes existed. The service now
  // refuses that cursor outright, and the daemon's job is to adopt the watermark, say so,
  // and keep syncing rather than stall.
  it("resynchronizes from the retention watermark when its cursor is too old to serve", async () => {
    const root = await repo();
    let daemon = await LocalDaemon.open(root, { workspaceId: "w", replicaId: "replica", actorId: "actor" });
    const survivor = {
      id: "operation-after-retention",
      workspaceId: "w",
      senderReplicaId: "other",
      transaction: {
        id: "operation-after-retention",
        base: { files: [] },
        changes: [{ path: "b.txt", kind: "add" as const, afterContent: "kept\n", afterHash: contentHash("kept\n") }],
        provenance: { source: "filesystem" as const, confidence: "known" as const },
        safety: { risk: "low" as const, requiresApproval: false }
      },
      sequence: 6,
      createdAt: new Date().toISOString()
    };
    const requested: number[] = [];
    const transport = {
      ...emptyTransport(),
      list: async (after: number) => {
        requested.push(after);
        // Everything at or below sequence 5 aged out of the plan's window.
        if (after < 5) return { status: "cursor-too-old" as const, resyncFrom: 5, retentionDays: 7 };
        return { operations: [survivor], nextCursor: 6 };
      }
    };

    const result = await daemon.syncRemote(transport);

    expect(requested).toEqual([0, 5]);
    expect(result).toEqual({ uploaded: 0, downloaded: 1, cursor: 6 });
    expect(daemon.operations.has(survivor.id)).toBe(true);
    const service = (await daemon.status()).service as { lastResyncAt?: string; lastResyncMessage?: string };
    expect(service.lastResyncAt).toEqual(expect.any(String));
    expect(service.lastResyncMessage).toContain("7 days");
    expect(service.lastResyncMessage).toContain("resynchronized from sequence 0 to 5");

    // The jump has to be durable, or the next start walks back into the unservable cursor.
    daemon.close();
    daemon = await LocalDaemon.open(root, { workspaceId: "w", replicaId: "replica", actorId: "actor" });
    expect((await daemon.status()).remoteCursor).toBe(6);
  });

  it("refuses a resync order that would rewind its cursor", async () => {
    const root = await repo();
    const daemon = await LocalDaemon.open(root, { workspaceId: "w", replicaId: "replica", actorId: "actor" });
    // resyncFrom at or below the cursor contradicts the refusal: the service can serve this
    // cursor. Obeying it would re-download operations already held here.
    await expect(daemon.syncRemote({
      ...emptyTransport(),
      list: async () => ({ status: "cursor-too-old" as const, resyncFrom: 0, retentionDays: 7 })
    })).rejects.toThrow("resync to a cursor it can already serve");
    expect((await daemon.status()).remoteCursor).toBe(0);
  });

  it("recognizes a same-HEAD hard reset as a Git transition", async () => {
    const root = await repo();
    const daemon = await LocalDaemon.open(root, { workspaceId: "w", replicaId: "replica", actorId: "actor" });
    await writeFile(join(root, "a.txt"), "dirty\n");
    await exec("git", ["-C", root, "reset", "--hard", "HEAD"]);

    await expect(daemon.observeGitTransition()).resolves.toMatchObject({ kind: "reset", paused: true });
  });

  it("keeps the internal reflog sentinel out of the public status payload", async () => {
    const root = await repo();
    const daemon = await LocalDaemon.open(root, { workspaceId: "w", replicaId: "replica", actorId: "actor" });
    const status = await daemon.status();

    // Built rather than written literally: a raw NUL in a source file is the kind of character
    // an editor or a future formatter silently eats, which would turn these into assertions
    // that quietly test nothing.
    const nul = String.fromCharCode(0);
    // JSON.stringify escapes a NUL into six literal characters instead of emitting the byte,
    // so this is the needle to look for in serialized output. Searching the JSON text for the
    // byte itself would pass vacuously even with the sentinel still in the payload.
    const escapedNul = JSON.stringify(nul).slice(1, -1);

    // headReflog joins a commit hash to its reflog subject with a raw NUL. It exists only to
    // detect a same-HEAD reset (the test above) and has no consumer outside this process, but
    // status() is what `crosscode status --json` and the MCP get_workspace_state tool return
    // verbatim -- so leaking it put a NUL byte into the first thing every agent reads.
    expect(status).not.toHaveProperty("headReflog");
    // Asserted against the serialized form, because that is what actually reaches an agent.
    expect(JSON.stringify(status)).not.toContain(escapedNul);
    // The sentinel is still computed and still drives reset detection; it is only unpublished.
    expect((await discoverRepository(root)).headReflog).toContain(nul);
    // Fields the documented status contract does promise. `root` is asserted loosely because
    // discoverRepository resolves it through realpath, and on macOS the tmpdir this test runs
    // in is a symlink (/var -> /private/var).
    expect(status).toMatchObject({ branch: "main", dirty: false, workspaceId: "w", replicaId: "replica" });
    expect(status.root).toEqual(expect.any(String));
    expect(status.head).toEqual(expect.any(String));
    expect(status.remotes).toEqual([]);
  });

  it("captures binary working-tree content as base64 instead of throwing, alongside an unrelated text change", async () => {
    const root = await repo();
    const daemon = await LocalDaemon.open(root, { workspaceId: "w", replicaId: "replica", actorId: "actor" });
    await writeFile(join(root, "a.txt"), "two\n");
    const binaryBytes = Buffer.from([0xff, 0x00, 0xfe]);
    await writeFile(join(root, "binary.dat"), binaryBytes);

    const operation = await daemon.capture("binary edit alongside text edit");

    const textChange = operation.transaction.changes.find((change) => change.path === "a.txt")!;
    expect(textChange.afterContent).toBe("two\n");
    expect(textChange.afterEncoding).toBeUndefined();
    const binaryChange = operation.transaction.changes.find((change) => change.path === "binary.dat")!;
    expect(binaryChange.afterEncoding).toBe("base64");
    expect(Buffer.from(binaryChange.afterContent!, "base64")).toEqual(binaryBytes);
    expect(binaryChange.afterHash).toBe(contentHash(binaryBytes));
    expect(binaryChange.unifiedPatch).toBeUndefined();
  });

  it("stays paused for the duration of a merge operation", async () => {
    const root = await repo();
    const daemon = await LocalDaemon.open(root, { workspaceId: "w", replicaId: "replica", actorId: "actor" });
    await exec("git", ["-C", root, "switch", "-c", "feature"]);
    await writeFile(join(root, "feature.txt"), "feature\n");
    await exec("git", ["-C", root, "add", "."]);
    await exec("git", ["-C", root, "commit", "-qm", "feature"]);
    await exec("git", ["-C", root, "switch", "main"]);
    await exec("git", ["-C", root, "merge", "--no-ff", "--no-commit", "feature"]);

    await expect(daemon.observeGitTransition()).resolves.toMatchObject({ kind: "git-operation", paused: true });
    await expect(daemon.status()).resolves.toMatchObject({ materializationPaused: true, operation: "merge" });
  });

  it("creates a real second worktree with `git worktree add` and keeps each daemon's identity and state isolated from the other", async () => {
    const root = await repo();
    const worktreePath = await mkdtemp(join(tmpdir(), "crosscode-worktree-"));
    directories.push(worktreePath);
    const original = await LocalDaemon.open(root, { workspaceId: "w", replicaId: "original", actorId: "a" });
    const originalRoot = (await original.status()).root;
    await writeFile(join(root, "original-only.txt"), "original work\n");
    const originalOperation = await original.capture("original worktree edit");

    await exec("git", ["-C", root, "worktree", "add", "-q", "-b", "sibling-branch", worktreePath]);

    // Adding a sibling worktree must not perturb the original daemon's own Git identity.
    await expect(original.observeGitTransition()).resolves.toMatchObject({ kind: "unchanged" });
    await expect(original.status()).resolves.toMatchObject({ root: originalRoot, branch: "main" });

    const sibling = await LocalDaemon.open(worktreePath, { workspaceId: "w", replicaId: "sibling", actorId: "b" });
    const siblingStatus = await sibling.status();
    expect(siblingStatus.branch).toBe("sibling-branch");
    expect(siblingStatus.root).not.toBe(originalRoot);
    expect(sibling.operations.size).toBe(0);

    await writeFile(join(worktreePath, "sibling-only.txt"), "sibling work\n");
    await sibling.capture("sibling worktree edit");

    // Each worktree keeps its own crosscode state.sqlite (git-path resolves per-worktree
    // for paths that are not one of Git's shared "common" files), so neither daemon's
    // operations or Git identity leak into the other's.
    expect(original.operations.has(originalOperation.id)).toBe(true);
    expect(original.operations.size).toBe(1);
    expect(sibling.operations.size).toBe(1);
    await expect(original.status()).resolves.toMatchObject({ root: originalRoot, branch: "main" });
  });

  it("detects a real named `git pull` that moves HEAD via a local file-based remote", async () => {
    const localRoot = await repo();
    const bareRemote = join(await mkdtemp(join(tmpdir(), "crosscode-bare-")), "origin.git");
    directories.push(dirname(bareRemote));
    await exec("git", ["init", "-q", "--bare", "-b", "main", bareRemote]);
    await exec("git", ["-C", localRoot, "remote", "add", "origin", bareRemote]);
    await exec("git", ["-C", localRoot, "push", "-q", "origin", "main"]);

    const upstreamClone = await mkdtemp(join(tmpdir(), "crosscode-upstream-"));
    directories.push(upstreamClone);
    await exec("git", ["clone", "-q", "-b", "main", bareRemote, upstreamClone]);
    await exec("git", ["-C", upstreamClone, "config", "user.email", "test@example.com"]);
    await exec("git", ["-C", upstreamClone, "config", "user.name", "Test"]);
    await writeFile(join(upstreamClone, "a.txt"), "pulled-from-remote\n");
    await exec("git", ["-C", upstreamClone, "commit", "-aqm", "advance upstream"]);
    await exec("git", ["-C", upstreamClone, "push", "-q", "origin", "main"]);

    const receiver = await LocalDaemon.open(localRoot, { workspaceId: "w", replicaId: "receiver", actorId: "b" });

    const headBefore = await exec("git", ["-C", localRoot, "rev-parse", "HEAD"]).then(({ stdout }) => stdout.trim());
    await exec("git", ["-C", localRoot, "pull", "-q", "origin", "main"]);
    const headAfter = await exec("git", ["-C", localRoot, "rev-parse", "HEAD"]).then(({ stdout }) => stdout.trim());
    expect(headAfter).not.toBe(headBefore);
    expect(await readFile(join(localRoot, "a.txt"), "utf8")).toBe("pulled-from-remote\n");

    await expect(receiver.observeGitTransition()).resolves.toMatchObject({ kind: "head-changed", paused: true });
    expect(await readFile(join(localRoot, "a.txt"), "utf8")).toBe("pulled-from-remote\n");
  });

  it("populates unifiedPatch with a real diff during capture, end-to-end, without any test manually setting the field", async () => {
    const senderRoot = await repo(); const receiverRoot = await repo(); const service = new CoordinationService();
    const base = "line1\nline2\nline3\nline4\nline5\nline6\n";
    await writeFile(join(senderRoot, "a.txt"), base); await exec("git", ["-C", senderRoot, "commit", "-aqm", "seed"]);
    await writeFile(join(receiverRoot, "a.txt"), base); await exec("git", ["-C", receiverRoot, "commit", "-aqm", "seed"]);
    const sender = await LocalDaemon.open(senderRoot, { workspaceId: "w", replicaId: "sender", actorId: "a" });
    const receiver = await LocalDaemon.open(receiverRoot, { workspaceId: "w", replicaId: "receiver", actorId: "b" });

    await writeFile(join(senderRoot, "a.txt"), "line1\nline2\nline3\nline4\nLINE5\nLINE6\n");
    const operation = await sender.capture("edit bottom lines", service);
    expect(operation.transaction.changes[0]!.unifiedPatch).toMatch(/^@@ -5,2 \+5,2 @@/m);
    await receiver.sync(service);
    expect(receiver.operations.get(operation.id)!.transaction.changes[0]!.unifiedPatch).toBe(operation.transaction.changes[0]!.unifiedPatch);
  });
});
