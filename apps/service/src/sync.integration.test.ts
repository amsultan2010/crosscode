import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Change, FileVersion, WsSyncServerMessage } from "@crosscode/protocol";
import { WebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServiceServer } from "./http.js";
import { PgStore } from "./store.js";
import { signTestSupabaseToken, testSupabaseJwks } from "./test-jwks.js";

/**
 * The service against a real PostgreSQL, over real HTTP and a real WebSocket. What it is
 * here to prove is Phase 3's verify line: a room's change log is gap-free and
 * duplicate-free across two replicas, a replica that misses a stretch of it catches up
 * from its cursor, and a cursor retention has outrun is refused rather than answered.
 *
 * Gated on CROSSCODE_TEST_DATABASE_URL. Without it these tests skip, and a skipped suite
 * has proved nothing.
 */
const databaseUrl = process.env.CROSSCODE_TEST_DATABASE_URL;

const supabaseUrl = "https://rzsslbmahvoesjxmgefr.supabase.co";

describe.skipIf(!databaseUrl)("sync service on PostgreSQL", () => {
  let store: PgStore;
  let base: string;
  let wsBase: string;
  let server: ReturnType<typeof createServiceServer>;
  const sockets: WebSocket[] = [];

  beforeAll(async () => {
    store = new PgStore(databaseUrl!);
    await store.migrate();
    server = createServiceServer({
      store,
      jwks: await testSupabaseJwks(),
      supabaseUrl,
      appUrl: "https://getcrosscode.dev",
      // The real checker calls GitHub. Access is denied-by-default in the route itself and
      // the denial paths are covered in http.test.ts; here it stands in for a yes.
      checkRepoAccess: async () => true
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    wsBase = `ws://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.close();
  });

  it("keeps every table behind row level security", async () => {
    const result = await store.pool.query<{ tablename: string; rowsecurity: boolean }>(
      `SELECT tablename, rowsecurity FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename IN ('users', 'projects', 'project_members', 'invites', 'replicas', 'file_versions')
        ORDER BY tablename`
    );
    expect(result.rows.map((row) => row.tablename)).toEqual([
      "file_versions", "invites", "project_members", "projects", "replicas", "users"
    ]);
    expect(result.rows.every((row) => row.rowsecurity)).toBe(true);
  });

  it("carries 100 changes from two replicas in sequence order, with no gaps and no duplicates", async () => {
    const owner = await signIn();
    const project = await createProject(owner);
    const alice = await registerReplica(owner, project.id);
    const bob = await registerReplica(owner, project.id);

    // Ten batches of ten, alternating senders, all in flight at once: the sequence has to
    // come from the service's per-(project, branch) lock, because neither publisher is in
    // a position to know what the other is being assigned.
    const published = await Promise.all(Array.from({ length: 10 }, async (_unused, batch) => {
      const replicaId = batch % 2 === 0 ? alice : bob;
      const versions = Array.from({ length: 10 }, (_ignored, index) => version(`src/f${batch * 10 + index}.ts`));
      const response = await post(owner, "/v1/changes", { projectId: project.id, branch: "main", replicaId, versions });
      expect(response.status).toBe(200);
      return (await response.json() as Envelope<{ cursor: number }>).data.cursor;
    }));
    // Ten disjoint blocks of ten, in some order: no two publishes were handed the same range.
    expect([...published].sort((left, right) => left - right)).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);

    // Read back in pages, which is how a real catch-up reads: the pages have to join up.
    const changes: Change[] = [];
    for (let cursor = 0; ;) {
      const page = await getChanges(owner, project.id, cursor, 25);
      if ("status" in page) throw new Error(`Expected a page, got ${page.status}`);
      changes.push(...page.changes);
      if (page.changes.length === 0) break;
      cursor = page.cursor;
    }

    expect(changes.map((entry) => entry.sequence)).toEqual(Array.from({ length: 100 }, (_unused, index) => index + 1));
    expect(new Set(changes.map((entry) => entry.version.path)).size).toBe(100);
    expect(new Set(changes.map((entry) => entry.replicaId))).toEqual(new Set([alice, bob]));
    // Every change carries back the payload that was published, not a rebuilt one. Asserted
    // across all 100 rather than on changes[0]: the ten batches are published concurrently, so
    // which one is assigned sequences 1-10 is genuinely undecided and pinning f0 to the front
    // only passed when that race happened to fall the right way.
    for (const entry of changes) {
      expect(entry.version).toMatchObject({ path: entry.version.path, op: "modify", content: `content of ${entry.version.path}` });
    }
  });

  it("catches a replica up from its cursor after a forced disconnect", async () => {
    const owner = await signIn();
    const project = await createProject(owner);
    const alice = await registerReplica(owner, project.id);
    const bob = await registerReplica(owner, project.id);

    await post(owner, "/v1/changes", { projectId: project.id, branch: "main", replicaId: alice, versions: [version("src/one.ts")] });

    const first = await subscribe(owner, project.id, bob, 0);
    expect((await nextChange(first)).sequence).toBe(1);

    // The disconnect: no close frame, the socket simply dies mid-session.
    first.terminate();
    await post(owner, "/v1/changes", {
      projectId: project.id, branch: "main", replicaId: alice,
      versions: [version("src/two.ts"), version("src/three.ts")]
    });

    // Reconnecting from the last applied sequence replays exactly what was missed, in
    // order, and nothing that was already applied.
    const resumed = await subscribe(owner, project.id, bob, 1);
    const replayed = [await nextChange(resumed), await nextChange(resumed)];
    expect(replayed.map((entry) => entry.sequence)).toEqual([2, 3]);
    expect(replayed.map((entry) => entry.version.path)).toEqual(["src/two.ts", "src/three.ts"]);

    // And live push resumes from there, still skipping the sender's own echo.
    await post(owner, "/v1/changes", { projectId: project.id, branch: "main", replicaId: alice, versions: [version("src/four.ts")] });
    expect((await nextChange(resumed)).sequence).toBe(4);
  });

  it("refuses a cursor retention has outrun instead of answering it with a page", async () => {
    const owner = await signIn();
    const project = await createProject(owner);
    const alice = await registerReplica(owner, project.id);
    await post(owner, "/v1/changes", {
      projectId: project.id, branch: "main", replicaId: alice,
      versions: Array.from({ length: 6 }, (_unused, index) => version(`src/g${index}.ts`))
    });
    // What the retention sweep will do: delete a prefix of the room's history.
    await store.pool.query("DELETE FROM file_versions WHERE project_id = $1 AND sequence <= 3", [project.id]);

    const tooOld = await getChanges(owner, project.id, 1, 200);
    expect(tooOld).toEqual({ status: "cursor-too-old", resyncFrom: 3, retentionDays: 7 });

    // The oldest cursor that can still be answered completely is answered normally.
    const servable = await getChanges(owner, project.id, 3, 200);
    if ("status" in servable) throw new Error("Expected a page");
    expect(servable.changes.map((entry) => entry.sequence)).toEqual([4, 5, 6]);
  });

  it("invites a teammate, who joins by code once GitHub says they can read the repo", async () => {
    const owner = await signIn();
    const teammate = await signIn();
    const project = await createProject(owner);

    const invited = await post(owner, "/v1/invites", { projectId: project.id });
    expect(invited.status).toBe(201);
    const invite = (await invited.json() as Envelope<{ code: string; url: string; repo: string }>).data;
    expect(invite.code).toMatch(/^CC-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(invite.url).toBe(`https://getcrosscode.dev/join/${invite.code}`);

    // Before redeeming, the teammate is not in the project at all.
    expect((await post(teammate, "/v1/replicas", { projectId: project.id, branch: "main" })).status).toBe(403);

    const redeemed = await post(teammate, `/v1/invites/${invite.code}/redeem`, {}, { "x-crosscode-github-token": "gho_test" });
    expect(redeemed.status).toBe(200);
    expect((await redeemed.json() as Envelope<{ cloneCommand: string }>).data.cloneCommand)
      .toBe(`git clone git@github.com:${invite.repo}.git && cd ${invite.repo.split("/")[1]}`);

    expect((await post(teammate, "/v1/replicas", { projectId: project.id, branch: "main" })).status).toBe(201);
    // A code is single-use.
    expect((await post(teammate, `/v1/invites/${invite.code}/redeem`, {}, { "x-crosscode-github-token": "gho_test" })).status).toBe(409);
  });

  /* ------------------------------------------------------------------------ helpers */

  type Envelope<T> = { ok: boolean; data: T };

  function version(path: string): FileVersion {
    return { path, op: "modify", baseHash: null, contentHash: `hash-${path}`, content: `content of ${path}`, encoding: "utf8" };
  }

  /** A fresh Supabase-authenticated GitHub user. */
  async function signIn(): Promise<string> {
    const id = randomUUID();
    return signTestSupabaseToken(supabaseUrl, {
      sub: id, email: `${id}@example.com`, github: { id: id.slice(0, 8), login: `octo-${id.slice(0, 8)}` }
    });
  }

  async function createProject(token: string): Promise<{ id: string; repo: string }> {
    const response = await post(token, "/v1/projects", { name: "app", repo: `acme/app-${randomUUID().slice(0, 8)}` });
    expect(response.status).toBe(201);
    return (await response.json() as Envelope<{ id: string; repo: string }>).data;
  }

  async function registerReplica(token: string, projectId: string): Promise<string> {
    const response = await post(token, "/v1/replicas", { projectId, branch: "main" });
    expect(response.status).toBe(201);
    return (await response.json() as Envelope<{ replicaId: string }>).data.replicaId;
  }

  function post(token: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${base}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
      body: JSON.stringify(body)
    });
  }

  async function getChanges(token: string, projectId: string, since: number, limit: number): Promise<
    { changes: Change[]; cursor: number } | { status: string; resyncFrom: number; retentionDays: number }
  > {
    const response = await fetch(`${base}/v1/changes?projectId=${projectId}&branch=main&since=${since}&limit=${limit}`, {
      headers: { authorization: `Bearer ${token}` }
    });
    expect(response.status).toBe(200);
    return (await response.json() as Envelope<never>).data;
  }

  async function subscribe(token: string, projectId: string, replicaId: string, since: number): Promise<WebSocket> {
    const socket = new WebSocket(`${wsBase}/v1/stream`, { headers: { authorization: `Bearer ${token}` } });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    socket.send(JSON.stringify({ type: "subscribe", projectId, branch: "main", replicaId, since }));
    // The presence frame the server sends once it has registered the connection: waiting
    // for it means a change published next cannot race the registration.
    await waitFor(socket, (messages) => messages.some((message) => message.type === "presence"));
    return socket;
  }

  const inboxes = new WeakMap<WebSocket, WsSyncServerMessage[]>();

  function inbox(socket: WebSocket): WsSyncServerMessage[] {
    let messages = inboxes.get(socket);
    if (!messages) {
      messages = [];
      inboxes.set(socket, messages);
      socket.on("message", (data) => messages!.push(JSON.parse(data.toString()) as WsSyncServerMessage));
    }
    return messages;
  }

  function waitFor(socket: WebSocket, ready: (messages: WsSyncServerMessage[]) => boolean): Promise<void> {
    const messages = inbox(socket);
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        if (ready(messages)) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() - started > 5_000) {
          clearInterval(timer);
          reject(new Error("timed out waiting for a message"));
        }
      }, 5);
    });
  }

  async function nextChange(socket: WebSocket): Promise<Change> {
    for (;;) {
      await waitFor(socket, (messages) => messages.length > 0);
      const message = inbox(socket).shift()!;
      if (message.type === "change") return message.change;
      if (message.type === "error") throw new Error(message.message);
    }
  }
});
