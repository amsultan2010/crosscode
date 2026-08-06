import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createServiceServer, type ServiceServerOptions } from "./http.js";
import { StoreUnauthorizedError, type PgStore } from "./store.js";
import { signTestSupabaseToken, testSupabaseJwks } from "./test-jwks.js";

const supabaseUrl = "https://rzsslbmahvoesjxmgefr.supabase.co";
const projectId = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const replicaId = "9a1e8b7c-1111-4222-8333-444455556666";
const userId = "5c9f2a10-2222-4333-8444-555566667777";

const servers: ReturnType<typeof createServiceServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("service HTTP boundary", () => {
  it("captures a product event per real action, and an activation only for a new account", async () => {
    const captured: Array<{ event: string; userId: string }> = [];
    const analytics = {
      enabled: true,
      capture: (event: string, id: string) => { captured.push({ event, userId: id }); },
      flush: async () => {}
    };
    const store = {
      upsertUser: async () => ({ created: true }),
      createProject: async () => ({
        id: projectId, name: "app", repo: "acme/app", plan: "free", createdAt: "2026-01-01T00:00:00.000Z"
      }),
      requireMembership: async () => ({ projectId, userId, role: "owner" as const, repo: "acme/app" }),
      registerReplica: async () => ({ replicaId, cursor: 0 })
    } as unknown as PgStore;
    const base = await listen(store, { analytics } as Partial<ServiceServerOptions>);
    const token = await signToken();

    expect((await post(base, "/v1/projects", { name: "app", repo: "acme/app" }, token)).status).toBe(201);
    expect((await post(base, "/v1/replicas", { projectId, branch: "main" }, token)).status).toBe(201);

    // upsertUser reported an insert, so this account is new and is counted once.
    expect(captured.map((entry) => entry.event)).toEqual(["user_activated", "project_created", "replica_registered"]);
    expect(new Set(captured.map((entry) => entry.userId))).toEqual(new Set([userId]));
  });

  it("creates a project, mints an invite, and registers a replica", async () => {
    const store = {
      upsertUser: async () => ({ created: false }),
      createProject: async () => ({
        id: projectId, name: "app", repo: "acme/app", plan: "free", createdAt: "2026-01-01T00:00:00.000Z"
      }),
      createInvite: async () => ({
        code: "CC-7F3A-9C2E", projectId, repo: "acme/app", expiresAt: "2026-01-08T00:00:00.000Z", redeemedAt: null
      }),
      requireMembership: async () => ({ projectId, userId, role: "owner" as const, repo: "acme/app" }),
      registerReplica: async () => ({ replicaId, cursor: 0 })
    } as unknown as PgStore;
    const base = await listen(store, { appUrl: "https://getcrosscode.dev" });
    const token = await signToken();

    const created = await post(base, "/v1/projects", { name: "app", repo: "acme/app" }, token);
    expect(created.status).toBe(201);
    expect((await created.json() as Envelope).data).toEqual({
      id: projectId, name: "app", repo: "acme/app", plan: "free", createdAt: "2026-01-01T00:00:00.000Z"
    });

    const invited = await post(base, "/v1/invites", { projectId }, token);
    expect(invited.status).toBe(201);
    expect((await invited.json() as Envelope).data).toEqual({
      code: "CC-7F3A-9C2E",
      url: "https://getcrosscode.dev/join/CC-7F3A-9C2E",
      projectId,
      repo: "acme/app",
      expiresAt: "2026-01-08T00:00:00.000Z"
    });

    const registered = await post(base, "/v1/replicas", { projectId, branch: "main" }, token);
    expect(registered.status).toBe(201);
    expect((await registered.json() as Envelope).data).toEqual({ replicaId, cursor: 0 });
  });

  it("redeems an invite only for a caller GitHub says can read the repository", async () => {
    const redeemed: string[] = [];
    const store = {
      upsertUser: async () => ({ created: false }),
      findInvite: async (code: string) => code === "CC-7F3A-9C2E"
        ? { code, projectId, repo: "acme/app", expiresAt: "2099-01-01T00:00:00.000Z", redeemedAt: null }
        : null,
      redeemInvite: async ({ code }: { code: string }) => {
        redeemed.push(code);
        return { projectId, repo: "acme/app" };
      }
    } as unknown as PgStore;
    let allowed = false;
    const base = await listen(store, { checkRepoAccess: async () => allowed });
    const token = await signToken();

    expect((await post(base, "/v1/invites/CC-0000-0000/redeem", {}, token)).status).toBe(404);
    // No GitHub token at all is a refusal, not a pass: the caller has shown nothing.
    expect((await post(base, "/v1/invites/CC-7F3A-9C2E/redeem", {}, token)).status).toBe(403);
    expect((await post(base, "/v1/invites/CC-7F3A-9C2E/redeem", {}, token, { "x-crosscode-github-token": "gho_x" })).status).toBe(403);
    expect(redeemed).toEqual([]);

    allowed = true;
    const ok = await post(base, "/v1/invites/CC-7F3A-9C2E/redeem", {}, token, { "x-crosscode-github-token": "gho_x" });
    expect(ok.status).toBe(200);
    expect((await ok.json() as Envelope).data).toEqual({
      projectId, repo: "acme/app", cloneCommand: "git clone git@github.com:acme/app.git && cd app"
    });
    expect(redeemed).toEqual(["CC-7F3A-9C2E"]);
  });

  it("publishes changes, refuses another branch's replica, and refuses a denylisted path", async () => {
    const store = {
      requireMembership: async () => ({ projectId, userId, role: "member" as const, repo: "acme/app" }),
      touchReplica: async () => ({ branch: "main" }),
      publishChanges: async () => ([{
        sequence: 4, projectId, branch: "main", replicaId,
        createdAt: "2026-01-01T00:00:00.000Z",
        version: { path: "src/a.ts", op: "modify", baseHash: null, contentHash: "h", content: "x", encoding: "utf8" }
      }])
    } as unknown as PgStore;
    const base = await listen(store);
    const token = await signToken();
    const version = { path: "src/a.ts", op: "modify", baseHash: null, contentHash: "h", content: "x" };

    const published = await post(base, "/v1/changes", { projectId, branch: "main", replicaId, versions: [version] }, token);
    expect(published.status).toBe(200);
    expect((await published.json() as Envelope).data).toEqual({ cursor: 4 });

    expect((await post(base, "/v1/changes", {
      projectId, branch: "feature", replicaId, versions: [version]
    }, token)).status).toBe(409);

    expect((await post(base, "/v1/changes", {
      projectId, branch: "main", replicaId, versions: [{ ...version, path: ".env" }]
    }, token)).status).toBe(400);
  });

  it("answers a live cursor with a page and a too-old cursor with its own shape", async () => {
    const change = {
      sequence: 51, projectId, branch: "main", replicaId,
      createdAt: "2026-01-01T00:00:00.000Z",
      version: { path: "src/a.ts", op: "modify" as const, baseHash: null, contentHash: "h", content: "x", encoding: "utf8" as const }
    };
    const store = {
      requireMembership: async () => ({ projectId, userId, role: "member" as const, repo: "acme/app" }),
      listChanges: async ({ since }: { since: number }) => since < 50
        ? { status: "cursor-too-old" as const, resyncFrom: 50, retentionDays: 7 }
        : { status: "ok" as const, changes: [change], cursor: 51 }
    } as unknown as PgStore;
    const base = await listen(store);
    const token = await signToken();

    const page = await get(base, `/v1/changes?projectId=${projectId}&branch=main&since=50`, token);
    expect(page.status).toBe(200);
    expect((await page.json() as Envelope).data).toEqual({ changes: [change], cursor: 51 });

    const tooOld = await get(base, `/v1/changes?projectId=${projectId}&branch=main&since=10`, token);
    // Deliberately not a page: a short page would be indistinguishable from "caught up".
    expect((await tooOld.json() as Envelope).data).toEqual({ status: "cursor-too-old", resyncFrom: 50, retentionDays: 7 });

    expect((await get(base, `/v1/changes?projectId=${projectId}&branch=main&since=-1`, token)).status).toBe(400);
    expect((await get(base, "/v1/changes?branch=main", token)).status).toBe(400);
  });

  it("enforces authentication, membership, JSON bodies, body caps, and unknown routes", async () => {
    const store = {
      requireMembership: async () => { throw new StoreUnauthorizedError("Project is not available"); },
      checkHealth: async () => ({ unreadableTables: [] })
    } as unknown as PgStore;
    const base = await listen(store, { bodyLimitBytes: 128 });
    const token = await signToken();

    expect((await fetch(`${base}/v1/changes?projectId=${projectId}&branch=main`)).status).toBe(401);
    expect((await fetch(`${base}/v1/changes?projectId=${projectId}&branch=main`, {
      headers: { authorization: "Bearer not-a-real-token" }
    })).status).toBe(401);
    // A project the caller is not in is refused, and is refused identically to one that
    // does not exist.
    expect((await get(base, `/v1/changes?projectId=${projectId}&branch=main`, token)).status).toBe(403);
    expect((await fetch(`${base}/v1/replicas`, {
      method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}"
    })).status).toBe(415);
    expect((await post(base, "/v1/replicas", { projectId, branch: "main", extra: true }, token)).status).toBe(400);
    expect((await post(base, "/v1/replicas", { projectId, branch: "x".repeat(400) }, token)).status).toBe(413);
    expect((await get(base, "/v1/operations", token)).status).toBe(404);

    const health = await fetch(`${base}/healthz`);
    expect(await health.json()).toEqual({ ok: true, data: { status: "ok", service: "crosscode-service" } });
  });

  /**
   * The outage this route exists to catch. `device_codes` shipped without a grant to the
   * runtime role, every request touching it 500ed with `permission denied`, and health
   * answered `ok` the whole time because it only ever proved the process was running.
   */
  it("reports a table the runtime role cannot read as an outage, not as healthy", async () => {
    const store = {
      checkHealth: async () => ({ unreadableTables: ["device_codes"] })
    } as unknown as PgStore;
    const base = await listen(store);

    const health = await fetch(`${base}/healthz`);

    expect(health.status).toBe(503);
    expect((await health.json() as Envelope).data).toMatchObject({ status: "degraded", unreadableTables: ["device_codes"] });
  });
});

type Envelope = { ok: boolean; data?: unknown; error?: string };

async function listen(store: PgStore, extra: Partial<ServiceServerOptions> = {}): Promise<string> {
  const server = createServiceServer({ store, jwks: await testSupabaseJwks(), supabaseUrl, ...extra });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function signToken(): Promise<string> {
  return signTestSupabaseToken(supabaseUrl, { sub: userId });
}

function post(base: string, path: string, body: unknown, token: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

function get(base: string, path: string, token: string): Promise<Response> {
  return fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
}
