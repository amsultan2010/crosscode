import type { AddressInfo } from "node:net";
import type { TransactionCreatedEvent } from "@crosscode/protocol";
import { contentHash } from "@crosscode/core";
import { afterEach, describe, expect, it } from "vitest";
import { createServiceServer } from "./http.js";
import type { Membership, PgStore, StoredOperation } from "./store.js";
import { signTestSupabaseToken, testSupabaseJwks } from "./test-jwks.js";

const supabaseUrl = "https://rzsslbmahvoesjxmgefr.supabase.co";
const WORKSPACE_HEADER = "x-crosscode-workspace-id";

const membership: Membership = {
  memberId: "member-1",
  userId: "user-1",
  actorId: "actor-1",
  workspaceId: "workspace-1",
  role: "member"
};

const servers: ReturnType<typeof createServiceServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("service HTTP boundary", () => {
  it("registers a replica, ingests idempotently, and reads a cursor", async () => {
    const operation = storedOperation(makeEvent());
    const store = {
      resolveMembership: async () => membership,
      registerReplica: async () => ({ replicaId: "replica-1", createdAt: "2026-01-01T00:00:00.000Z", projectId: null }),
      assertReplicaOwnership: async () => {},
      appendOperation: async () => operation,
      listOperations: async () => ({ status: "ok", items: [operation], nextCursor: 1, hasMore: false })
    } as unknown as PgStore;
    const base = await listen(store);
    const accessToken = await signToken(membership.userId);

    const registration = await post(base, "/v1/replicas", { name: "laptop" }, accessToken, membership.workspaceId);
    expect(registration.status).toBe(201);
    const registrationBody = await registration.json() as any;
    expect(registrationBody.data).toMatchObject({ replicaId: "replica-1" });

    const receipt = await post(base, "/v1/events", { event: makeEvent() }, accessToken, membership.workspaceId);
    expect(await receipt.json()).toEqual({
      ok: true,
      data: { eventId: "operation-1", operationId: "operation-1", serverSequence: 1 }
    });
    const secretEvent = makeEvent();
    secretEvent.id = "secret-operation";
    secretEvent.payload = { ...secretEvent.payload, id: secretEvent.id, changes: [{ path: ".env", kind: "add", afterContent: "TOKEN=value", afterHash: contentHash("TOKEN=value") }] };
    expect((await post(base, "/v1/events", { event: secretEvent }, accessToken, membership.workspaceId)).status).toBe(400);
    const forgedEvent = makeEvent();
    forgedEvent.id = "forged-operation";
    forgedEvent.payload = { ...forgedEvent.payload, id: forgedEvent.id, changes: [{ path: "safe.txt", kind: "add", afterContent: "actual", afterHash: "forged" }] };
    expect((await post(base, "/v1/events", { event: forgedEvent }, accessToken, membership.workspaceId)).status).toBe(400);

    const cursor = await fetch(`${base}/v1/operations?afterSequence=0`, {
      headers: { authorization: `Bearer ${accessToken}`, [WORKSPACE_HEADER]: membership.workspaceId }
    });
    expect((await cursor.json()) as any).toMatchObject({
      ok: true,
      data: { nextCursor: 1, operations: [{ id: "operation-1", serverSequence: 1 }] }
    });
  });

  it("enforces JSON bodies, body caps, authentication, the workspace header, and principal binding", async () => {
    const store = {
      resolveMembership: async () => membership,
      appendOperation: async () => storedOperation(makeEvent())
    } as unknown as PgStore;
    const base = await listen(store, 128);
    const accessToken = await signToken(membership.userId);

    expect((await fetch(`${base}/v1/operations`)).status).toBe(401);
    expect((await fetch(`${base}/v1/operations`, {
      headers: { authorization: `Bearer ${accessToken}` }
    })).status).toBe(400);
    expect((await fetch(`${base}/v1/replicas`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, [WORKSPACE_HEADER]: membership.workspaceId },
      body: "{}"
    })).status).toBe(415);
    expect((await post(base, "/v1/replicas", { name: "laptop", extra: true }, accessToken, membership.workspaceId)).status).toBe(400);
    expect((await post(base, "/v1/replicas", { name: "x".repeat(200) }, accessToken, membership.workspaceId)).status).toBe(413);
  });

  it("upserts, lists, and reads back projects, and 404s outside the caller's workspace", async () => {
    const project = {
      id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
      workspaceId: membership.workspaceId,
      name: "repo",
      repoRemote: "github.com/owner/repo",
      repoRoot: "/Users/dev/repo",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastActivityAt: "2026-01-02T00:00:00.000Z"
    };
    const upserts: Array<{ repoRoot?: string | null; repoRemote?: string | null }> = [];
    const store = {
      resolveMembership: async () => membership,
      upsertProject: async (_workspaceId: string, input: { repoRoot?: string | null; repoRemote?: string | null }) => {
        upserts.push(input);
        return project;
      },
      listProjects: async () => [project],
      // The store is already workspace-scoped, so "belongs to another workspace" is
      // indistinguishable from "does not exist" -- both come back as null.
      getProject: async (workspaceId: string, id: string) =>
        workspaceId === membership.workspaceId && id === project.id ? project : null
    } as unknown as PgStore;
    const base = await listen(store);
    const accessToken = await signToken(membership.userId);
    const headers = { authorization: `Bearer ${accessToken}`, [WORKSPACE_HEADER]: membership.workspaceId };

    const created = await post(base, "/v1/projects", { repoRoot: "/Users/dev/repo", repoRemote: "git@github.com:owner/repo.git" }, accessToken, membership.workspaceId);
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual({ ok: true, data: project });
    // Idempotent at the HTTP layer too: the same body upserts rather than creating.
    const again = await post(base, "/v1/projects", { repoRoot: "/Users/dev/repo", repoRemote: "git@github.com:owner/repo.git" }, accessToken, membership.workspaceId);
    expect(await again.json()).toEqual({ ok: true, data: project });
    expect(upserts).toHaveLength(2);

    expect((await post(base, "/v1/projects", {}, accessToken, membership.workspaceId)).status).toBe(400);
    expect((await post(base, "/v1/projects", { repoRoot: "/Users/dev/repo", extra: true }, accessToken, membership.workspaceId)).status).toBe(400);
    expect((await post(base, "/v1/projects", { repoRoot: "/Users/dev/repo" })).status).toBe(401);

    const listed = await fetch(`${base}/v1/projects`, { headers });
    expect(await listed.json()).toEqual({ ok: true, data: { projects: [project] } });

    const read = await fetch(`${base}/v1/projects/${project.id}`, { headers });
    expect(await read.json()).toEqual({ ok: true, data: project });

    // Another workspace's project id, and a malformed id, are both plain 404s.
    expect((await fetch(`${base}/v1/projects/9f2504e0-4f89-11d3-9a0c-0305e82c3399`, { headers })).status).toBe(404);
    expect((await fetch(`${base}/v1/projects/not-a-uuid`, { headers })).status).toBe(404);
  });

  // Regression: writing project_id is useless if no read path returns it. These assert on
  // the JSON a consumer actually receives, not on the database column.
  it("returns projectId on GET /v1/operations, populated and null", async () => {
    const projectId = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
    const attributed = storedOperation(makeEvent(), projectId);
    const unattributed = storedOperation({ ...makeEvent(), id: "operation-2", payload: { ...makeEvent().payload, id: "operation-2" } });
    unattributed.serverSequence = 2;
    const store = {
      resolveMembership: async () => membership,
      listOperations: async () => ({ status: "ok", items: [attributed, unattributed], nextCursor: 2, hasMore: false })
    } as unknown as PgStore;
    const base = await listen(store);
    const accessToken = await signToken(membership.userId);
    const headers = { authorization: `Bearer ${accessToken}`, [WORKSPACE_HEADER]: membership.workspaceId };

    const operations = await (await fetch(`${base}/v1/operations?afterSequence=0`, { headers })).json() as any;
    expect(operations.data.operations.map((operation: any) => [operation.id, operation.projectId])).toEqual([
      ["operation-1", projectId],
      ["operation-2", null]
    ]);
    // The daemon parses this response with a .strict() schema, so the field must be
    // present rather than merely undefined.
    expect(Object.keys(operations.data.operations[0])).toContain("projectId");
  });

  // A cursor pointing below the retention watermark has exactly one honest answer, and it
  // is not a page: serving the surviving rows (or an empty list, once everything the
  // replica had not seen is deleted) is indistinguishable from "you are caught up", which
  // is how a replica silently loses proposals forever.
  it("answers a cursor below the retention watermark with a resync order, never a short page", async () => {
    const store = {
      resolveMembership: async () => membership,
      listOperations: async () => ({ status: "cursor-too-old", resyncFrom: 42, retentionDays: 7 })
    } as unknown as PgStore;
    const base = await listen(store);
    const accessToken = await signToken(membership.userId);
    const headers = { authorization: `Bearer ${accessToken}`, [WORKSPACE_HEADER]: membership.workspaceId };

    const current = await fetch(`${base}/v1/operations?afterSequence=3&protocolVersion=2`, { headers });
    expect(current.status).toBe(200);
    expect(await current.json()).toEqual({
      ok: true,
      data: { status: "cursor-too-old", protocolVersion: 2, resyncFrom: 42, retentionDays: 7 }
    });

    // A daemon built before this status sends no protocolVersion. It must not receive a
    // 200 at all: it would parse the body with cursorResponseSchema and, whatever that
    // does, "the request succeeded" is the one conclusion it must never reach. A 410 lands
    // in the sync-error path it already has.
    const legacy = await fetch(`${base}/v1/operations?afterSequence=3`, { headers });
    expect(legacy.status).toBe(410);
    const legacyBody = await legacy.json() as { ok: boolean; error: string };
    expect(legacyBody.ok).toBe(false);
    expect(legacyBody.error).toContain("upgrade the daemon");

    expect((await fetch(`${base}/v1/operations?afterSequence=3&protocolVersion=nope`, { headers })).status).toBe(400);
  });

  it("registers a replica with its repository so the replica is attributed to a project", async () => {
    const seen: Array<unknown[]> = [];
    const store = {
      resolveMembership: async () => membership,
      registerReplica: async (...args: unknown[]) => {
        seen.push(args);
        return { replicaId: "replica-1", createdAt: "2026-01-01T00:00:00.000Z", projectId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301" };
      }
    } as unknown as PgStore;
    const base = await listen(store);
    const accessToken = await signToken(membership.userId);

    const registered = await post(
      base, "/v1/replicas",
      { name: "laptop", repoRoot: "/Users/dev/repo", repoRemote: "git@github.com:owner/repo.git" },
      accessToken, membership.workspaceId
    );
    expect(registered.status).toBe(201);
    expect(await registered.json()).toEqual({
      ok: true,
      data: { replicaId: "replica-1", createdAt: "2026-01-01T00:00:00.000Z", projectId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301" }
    });
    expect(seen[0]?.[3]).toEqual({ repoRoot: "/Users/dev/repo", repoRemote: "git@github.com:owner/repo.git" });
  });

  it("self-serve creates a workspace for a token that has no membership yet", async () => {
    const store = {
      createWorkspace: async (input: { workspaceName: string; userId: string; actorId: string }) => {
        expect(input).toEqual({ workspaceName: "acme", userId: "user-2", actorId: "member@example.com" });
        return { workspaceId: "workspace-2", memberId: "member-2" };
      }
    } as unknown as PgStore;
    const base = await listen(store);
    const accessToken = await signToken("user-2");

    // No WORKSPACE_HEADER: a brand-new user has no workspace to scope one to yet.
    const created = await post(base, "/v1/workspaces", { name: "acme" }, accessToken);
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ ok: true, data: { workspaceId: "workspace-2", memberId: "member-2" } });

    expect((await post(base, "/v1/workspaces", { name: "acme" })).status).toBe(401);
  });

  it("lets a workspace owner create, list, and revoke invites, and rejects a non-owner", async () => {
    const owner: Membership = { ...membership, role: "owner" };
    const invite = {
      id: "invite-1", workspaceId: owner.workspaceId, code: "ABCDEFGHJK", role: "member" as const,
      createdBy: owner.memberId, expiresAt: "2026-01-08T00:00:00.000Z", redeemedAt: null, redeemedBy: null,
      createdAt: "2026-01-01T00:00:00.000Z"
    };
    const store = {
      resolveMembership: async () => owner,
      createInvite: async () => invite,
      listInvites: async () => [invite],
      revokeInvite: async () => {}
    } as unknown as PgStore;
    const base = await listen(store);
    const accessToken = await signToken(owner.userId);

    const created = await post(base, "/v1/invites", {}, accessToken, owner.workspaceId);
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ ok: true, data: invite });

    const listed = await fetch(`${base}/v1/invites`, { headers: { authorization: `Bearer ${accessToken}`, [WORKSPACE_HEADER]: owner.workspaceId } });
    expect((await listed.json()) as any).toEqual({ ok: true, data: { invites: [invite] } });

    const revoked = await fetch(`${base}/v1/invites/${invite.id}`, { method: "DELETE", headers: { authorization: `Bearer ${accessToken}`, [WORKSPACE_HEADER]: owner.workspaceId } });
    expect(revoked.status).toBe(200);

    const memberStore = { resolveMembership: async () => membership } as unknown as PgStore;
    const memberBase = await listen(memberStore);
    const memberToken = await signToken(membership.userId);
    expect((await post(memberBase, "/v1/invites", {}, memberToken, membership.workspaceId)).status).toBe(403);
    expect((await fetch(`${memberBase}/v1/invites`, { headers: { authorization: `Bearer ${memberToken}`, [WORKSPACE_HEADER]: membership.workspaceId } })).status).toBe(403);
    expect((await fetch(`${memberBase}/v1/invites/invite-1`, { method: "DELETE", headers: { authorization: `Bearer ${memberToken}`, [WORKSPACE_HEADER]: membership.workspaceId } })).status).toBe(403);
  });

  it("redeems a valid invite without requiring an existing membership", async () => {
    const store = {
      redeemInvite: async (input: { code: string; userId: string; actorId: string }) => {
        expect(input).toEqual({ code: "ABCDEFGHJK", userId: "user-3", actorId: "member@example.com" });
        return { workspaceId: "workspace-1", memberId: "member-3", role: "member" as const };
      }
    } as unknown as PgStore;
    const base = await listen(store);
    const accessToken = await signToken("user-3");

    const redeemed = await fetch(`${base}/v1/invites/ABCDEFGHJK/redeem`, { method: "POST", headers: { authorization: `Bearer ${accessToken}` } });
    expect(redeemed.status).toBe(200);
    expect(await redeemed.json()).toEqual({ ok: true, data: { workspaceId: "workspace-1", memberId: "member-3", role: "member" } });
  });

  it("rejects redeeming an invalid, expired, or already-redeemed invite code", async () => {
    const { StoreConflictError, StoreUnauthorizedError } = await import("./store.js");
    const store = {
      redeemInvite: async (input: { code: string }) => {
        if (input.code === "MISSING") throw new StoreUnauthorizedError("Invite code is not valid");
        if (input.code === "EXPIRED") throw new StoreConflictError("Invite has expired");
        if (input.code === "REDEEMED") throw new StoreConflictError("Invite has already been redeemed");
        throw new Error("unexpected code");
      }
    } as unknown as PgStore;
    const base = await listen(store);
    const accessToken = await signToken("user-4");

    const redeem = (code: string, token?: string) => fetch(`${base}/v1/invites/${code}/redeem`, {
      method: "POST",
      headers: token ? { authorization: `Bearer ${token}` } : {}
    });
    expect((await redeem("MISSING", accessToken)).status).toBe(401);
    expect((await redeem("EXPIRED", accessToken)).status).toBe(409);
    expect((await redeem("REDEEMED", accessToken)).status).toBe(409);
    expect((await redeem("ANY")).status).toBe(401);
  });

  it("lists every workspace a user belongs to, for the CLI's workspace switching", async () => {
    const store = {
      ensurePersonalWorkspace: async () => ({ workspaceId: "workspace-a", memberId: "m1", created: false }),
      listMembershipsForUser: async (userId: string) => {
        expect(userId).toBe("user-5");
        return [
          { memberId: "m1", userId, actorId: "a@example.com", role: "owner" as const, workspaceId: "workspace-a", workspaceName: "Acme" },
          { memberId: "m2", userId, actorId: "a@example.com", role: "member" as const, workspaceId: "workspace-b", workspaceName: "Beta" }
        ];
      }
    } as unknown as PgStore;
    const base = await listen(store);
    const accessToken = await signToken("user-5");

    const response = await fetch(`${base}/v1/memberships`, { headers: { authorization: `Bearer ${accessToken}` } });
    expect(await response.json()).toEqual({
      ok: true,
      data: {
        memberships: [
          { workspaceId: "workspace-a", workspaceName: "Acme", role: "owner" },
          { workspaceId: "workspace-b", workspaceName: "Beta", role: "member" }
        ]
      }
    });
  });

  it("auto-provisions a personal workspace before listing memberships", async () => {
    const provisioned: string[] = [];
    const store = {
      ensurePersonalWorkspace: async (input: { userId: string; actorId: string }) => {
        provisioned.push(input.actorId);
        return { workspaceId: "workspace-personal", memberId: "member-personal", created: true };
      },
      listMembershipsForUser: async (userId: string) => [
        { memberId: "member-personal", userId, actorId: "member@example.com", role: "owner" as const, workspaceId: "workspace-personal", workspaceName: "member@example.com's workspace" }
      ]
    } as unknown as PgStore;
    const base = await listen(store);
    const accessToken = await signToken("user-6");

    const response = await fetch(`${base}/v1/memberships`, { headers: { authorization: `Bearer ${accessToken}` } });
    expect(await response.json()).toEqual({
      ok: true,
      data: { memberships: [{ workspaceId: "workspace-personal", workspaceName: "member@example.com's workspace", role: "owner" }] }
    });
    expect(provisioned).toEqual(["member@example.com"]);
  });

});

// CROSSCODE_ALLOWED_ORIGINS is unset by default and should stay that way: the service's
// clients are daemons and the CLI, never a browser, and the website talks only to Supabase
// and to a loopback port. These cover the opt-in case -- an operator who does put a browser
// app in front of the service -- because without the headers such an origin cannot make a
// single authenticated call. The origin below is a stand-in for that, not a live deployment.
describe("browser CORS", () => {
  const browserOrigin = "https://browser-client.example";
  const store = { resolveMembership: async () => membership } as unknown as PgStore;

  it("answers preflight for an allowed origin with the headers a browser client sends", async () => {
    const base = await listen(store, undefined, [browserOrigin]);

    const response = await fetch(`${base}/v1/memberships`, {
      method: "OPTIONS",
      headers: { origin: browserOrigin, "access-control-request-method": "GET", "access-control-request-headers": "authorization" }
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(browserOrigin);
    const allowedHeaders = response.headers.get("access-control-allow-headers")!.toLowerCase();
    // A browser client cannot authenticate or name its workspace without both of these.
    expect(allowedHeaders).toContain("authorization");
    expect(allowedHeaders).toContain(WORKSPACE_HEADER);
    expect(response.headers.get("vary")!.toLowerCase()).toContain("origin");
  });

  it("echoes the allowed origin on a real authenticated response", async () => {
    const listStore = {
      resolveMembership: async () => membership,
      ensurePersonalWorkspace: async () => {},
      listMembershipsForUser: async () => [{ workspaceId: membership.workspaceId, workspaceName: "Ada", role: "owner" }]
    } as unknown as PgStore;
    const base = await listen(listStore, undefined, [browserOrigin]);
    const accessToken = await signToken(membership.userId);

    const response = await fetch(`${base}/v1/memberships`, {
      headers: { origin: browserOrigin, authorization: `Bearer ${accessToken}` }
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(browserOrigin);
  });

  it("refuses an origin that is not on the allowlist", async () => {
    const base = await listen(store, undefined, [browserOrigin]);

    const preflight = await fetch(`${base}/v1/memberships`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "GET" }
    });

    expect(preflight.status).toBe(403);
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("stays closed to browsers when no allowlist is configured", async () => {
    const base = await listen(store);

    const response = await fetch(`${base}/healthz`, { headers: { origin: browserOrigin } });

    // Still serves the daemon and CLI, which are not subject to CORS -- it just never
    // hands a browser permission it was not explicitly given.
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("answers GET /health with no credentials and no database call", async () => {
    // Every property read on this store returns a function that throws when called, so a
    // route that reaches for the database fails the test instead of passing against a mock
    // that happily returns rows. The probe has to survive an unreachable database to be
    // worth anything as a check on the deployed function itself.
    const hostileStore = new Proxy({}, {
      get: (_target, property) => () => {
        throw new Error(`/health called the store: ${String(property)}`);
      }
    }) as unknown as PgStore;
    const base = await listen(hostileStore);

    const response = await fetch(`${base}/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: { status: "ok", service: "crosscode-service" } });
  });
});

async function signToken(userId: string): Promise<string> {
  return signTestSupabaseToken(supabaseUrl, { sub: userId });
}

async function listen(
  store: PgStore, bodyLimitBytes?: number, allowedOrigins?: readonly string[],
  extra: { trustProxy?: boolean; onError?: (error: unknown) => void } = {}
): Promise<string> {
  const server = createServiceServer({ store, jwks: await testSupabaseJwks(), supabaseUrl, bodyLimitBytes, allowedOrigins, ...extra });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function post(base: string, path: string, body: unknown, accessToken?: string, workspaceId?: string) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...(workspaceId ? { [WORKSPACE_HEADER]: workspaceId } : {})
    },
    body: JSON.stringify(body)
  });
}

function put(base: string, path: string, body: unknown, accessToken?: string, workspaceId?: string) {
  return fetch(`${base}${path}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...(workspaceId ? { [WORKSPACE_HEADER]: workspaceId } : {})
    },
    body: JSON.stringify(body)
  });
}

function makeEvent(): TransactionCreatedEvent {
  return {
    id: "operation-1",
    schemaVersion: 1,
    workspaceId: membership.workspaceId,
    replicaId: "replica-1",
    actorId: membership.actorId,
    type: "transaction.created",
    clientSequence: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    payload: {
      id: "operation-1",
      base: { files: [] },
      changes: [{ path: "test.txt", kind: "add", afterContent: "test", afterHash: contentHash("test") }],
      provenance: { source: "filesystem", confidence: "known" },
      safety: { risk: "low", requiresApproval: false }
    }
  };
}

function storedOperation(event: TransactionCreatedEvent, projectId: string | null = null): StoredOperation {
  return {
    id: event.id,
    eventId: event.id,
    workspaceId: event.workspaceId,
    senderReplicaId: event.replicaId,
    projectId,
    transaction: event.payload,
    serverSequence: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    event: { ...event, serverSequence: 1 }
  };
}

describe("per-identity rate limiting", () => {
  // Every daemon in an office or a CI fleet leaves through one NAT egress address. Keying
  // the real quota on that address makes them throttle each other, which reads to the user
  // as Crosscode being broken rather than as a limit.
  it("does not throttle many distinct identities sharing one address", async () => {
    const store = {
      resolveMembership: async (userId: string, workspaceId: string) => ({
        memberId: `member-${userId}`, userId, actorId: userId, workspaceId, role: "member" as const
      }),
      listMembers: async () => []
    } as unknown as PgStore;
    const base = await listen(store);

    // Ten separate accounts, one shared source address, well past the old 300/min per-IP
    // bucket they would all have shared.
    for (let user = 0; user < 10; user += 1) {
      const accessToken = await signToken(`user-${user}`);
      for (let call = 0; call < 40; call += 1) {
        const response = await fetch(`${base}/v1/members`, {
          headers: { authorization: `Bearer ${accessToken}`, [WORKSPACE_HEADER]: membership.workspaceId }
        });
        expect(response.status).toBe(200);
      }
    }
  });

  it("throttles a single identity once it exhausts its own budget", async () => {
    const store = {
      resolveMembership: async (userId: string, workspaceId: string) => ({
        memberId: `member-${userId}`, userId, actorId: userId, workspaceId, role: "member" as const
      }),
      listMembers: async () => []
    } as unknown as PgStore;
    const base = await listen(store);
    const accessToken = await signToken("noisy-user");
    const call = () => fetch(`${base}/v1/members`, {
      headers: { authorization: `Bearer ${accessToken}`, [WORKSPACE_HEADER]: membership.workspaceId }
    });

    let throttled = false;
    for (let attempt = 0; attempt < 700 && !throttled; attempt += 1) {
      throttled = (await call()).status === 429;
    }
    expect(throttled).toBe(true);

    // ...and a different account from the same address is untouched by that exhaustion.
    const otherToken = await signToken("quiet-user");
    const other = await fetch(`${base}/v1/members`, {
      headers: { authorization: `Bearer ${otherToken}`, [WORKSPACE_HEADER]: membership.workspaceId }
    });
    expect(other.status).toBe(200);
  });
});

describe("unexpected failures", () => {
  it("reports a 500 rather than swallowing it, while keeping the detail out of the response", async () => {
    const reported: unknown[] = [];
    const store = {
      resolveMembership: async () => membership,
      listMembers: async () => { throw new Error("connection terminated unexpectedly"); }
    } as unknown as PgStore;
    const base = await listen(store, undefined, undefined, { onError: (error) => reported.push(error) });
    const accessToken = await signToken(membership.userId);

    const response = await fetch(`${base}/v1/members`, {
      headers: { authorization: `Bearer ${accessToken}`, [WORKSPACE_HEADER]: membership.workspaceId }
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: "Internal server error" });
    expect(reported).toHaveLength(1);
    expect((reported[0] as Error).message).toBe("connection terminated unexpectedly");
  });

  it("does not report deliberate refusals as failures", async () => {
    const reported: unknown[] = [];
    const store = { resolveMembership: async () => membership } as unknown as PgStore;
    const base = await listen(store, undefined, undefined, { onError: (error) => reported.push(error) });
    const accessToken = await signToken(membership.userId);

    const response = await fetch(`${base}/v1/nope`, {
      headers: { authorization: `Bearer ${accessToken}`, [WORKSPACE_HEADER]: membership.workspaceId }
    });

    expect(response.status).toBe(404);
    expect(reported).toHaveLength(0);
  });
});
