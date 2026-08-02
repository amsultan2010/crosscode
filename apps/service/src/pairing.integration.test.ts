import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import { createServiceServer } from "./http.js";
import { PgStore } from "./store.js";
import { signTestSupabaseToken, testSupabaseJwks } from "./test-jwks.js";

/**
 * Contract A (pairing & verification) and Contract C (auto-provisioned personal
 * workspace) from docs/onboarding-contracts.md, exercised over real HTTP against real
 * Postgres. Both contracts hinge on database semantics -- an atomic conditional UPDATE
 * for single-use claiming, a partial unique index for one-personal-workspace-per-user --
 * which a fake store cannot honestly stand in for.
 */
const databaseUrl = process.env.CROSSCODE_TEST_DATABASE_URL;
const supabaseUrl = "https://rzsslbmahvoesjxmgefr.supabase.co";
const WORKSPACE_HEADER = "x-crosscode-workspace-id";

const servers: Server[] = [];
const stores: PgStore[] = [];

afterAll(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

describe.skipIf(!databaseUrl)("pairing and personal workspaces over PostgreSQL", () => {
  it("mints a code, claims it once, and flips the poll endpoint from pending to claimed", async () => {
    const { base, store } = await listen();
    const userId = randomUUID();
    const accessToken = await signTestSupabaseToken(supabaseUrl, { sub: userId, email: `${userId}@example.com` });
    const workspaceId = await personalWorkspaceId(base, accessToken);

    const minted = await post(base, "/v1/pairing-codes", {}, { accessToken, workspaceId });
    expect(minted.status).toBe(201);
    const { code, pairingId, expiresAt } = (await minted.json() as any).data;
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(new Date(expiresAt).getTime() - Date.now()).toBeGreaterThan(14 * 60 * 1_000);

    // Only the hash is persisted -- the plaintext must not be recoverable from the row.
    const stored = await store.pool.query<{ code_hash: string }>("SELECT code_hash FROM pairing_codes WHERE id = $1", [pairingId]);
    expect(stored.rows[0]!.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.rows[0]!.code_hash).not.toContain(code);

    expect((await pollPairing(base, pairingId, accessToken, workspaceId)).status).toBe("pending");

    const claimed = await post(base, "/v1/pairing-codes/claim", claimBody(code));
    expect(claimed.status).toBe(200);
    const claimData = (await claimed.json() as any).data;
    expect(claimData.workspaceId).toBe(workspaceId);
    expect(claimData.token.startsWith("ccw_")).toBe(true);
    // The claim attributes the replica to the repository it reported, so pairing and
    // projects are joined up from the first claim rather than backfilled later.
    expect(claimData.projectId).toMatch(/^[0-9a-f-]{36}$/);
    const attributed = await store.pool.query<{ project_id: string | null }>(
      "SELECT project_id FROM replicas WHERE id = $1", [claimData.replicaId]
    );
    expect(attributed.rows[0]!.project_id).toBe(claimData.projectId);

    const polled = await pollPairing(base, pairingId, accessToken, workspaceId);
    expect(polled.status).toBe("claimed");
    expect(polled.replicaId).toBe(claimData.replicaId);
    expect(polled.actorId).toBe("pairing@example.com");
    expect(polled.claimedAt).not.toBeNull();

    const tokens = await store.pool.query<{ token_hash: string }>("SELECT token_hash FROM workspace_tokens WHERE workspace_id = $1", [workspaceId]);
    expect(tokens.rows[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokens.rows.some((row) => row.token_hash === claimData.token)).toBe(false);
  });

  it("returns 410 for a second claim of the same code and for an expired one, indistinguishably", async () => {
    const { base, store } = await listen();
    const userId = randomUUID();
    const accessToken = await signTestSupabaseToken(supabaseUrl, { sub: userId, email: `${userId}@example.com` });
    const workspaceId = await personalWorkspaceId(base, accessToken);

    const first = (await (await post(base, "/v1/pairing-codes", {}, { accessToken, workspaceId })).json() as any).data;
    expect((await post(base, "/v1/pairing-codes/claim", claimBody(first.code))).status).toBe(200);
    const doubleClaim = await post(base, "/v1/pairing-codes/claim", claimBody(first.code));
    expect(doubleClaim.status).toBe(410);

    const second = (await (await post(base, "/v1/pairing-codes", {}, { accessToken, workspaceId })).json() as any).data;
    await store.pool.query("UPDATE pairing_codes SET expires_at = now() - interval '1 minute' WHERE id = $1", [second.pairingId]);
    const expiredClaim = await post(base, "/v1/pairing-codes/claim", claimBody(second.code));
    expect(expiredClaim.status).toBe(410);

    const unknownClaim = await post(base, "/v1/pairing-codes/claim", claimBody("ZZZZ-ZZZZ"));
    expect(unknownClaim.status).toBe(410);

    // Two daemons racing on the same code: the conditional UPDATE lets exactly one win.
    const contested = (await (await post(base, "/v1/pairing-codes", {}, { accessToken, workspaceId })).json() as any).data;
    const raced = await Promise.all([
      post(base, "/v1/pairing-codes/claim", claimBody(contested.code)),
      post(base, "/v1/pairing-codes/claim", claimBody(contested.code))
    ]);
    expect(raced.map((response) => response.status).sort()).toEqual([200, 410]);

    // Claimed, expired, and never-existed must be one indistinguishable response so the
    // endpoint cannot be used to probe which codes are real.
    const bodies = await Promise.all([doubleClaim, expiredClaim, unknownClaim].map((response) => response.json()));
    expect(new Set(bodies.map((body) => JSON.stringify(body))).size).toBe(1);

    expect((await pollPairing(base, second.pairingId, accessToken, workspaceId)).status).toBe("expired");
  });

  it("accepts a ccw_ token on the daemon read surface and rejects it on the user surface", async () => {
    const { base } = await listen();
    const userId = randomUUID();
    const accessToken = await signTestSupabaseToken(supabaseUrl, { sub: userId, email: `${userId}@example.com` });
    const workspaceId = await personalWorkspaceId(base, accessToken);
    const minted = (await (await post(base, "/v1/pairing-codes", {}, { accessToken, workspaceId })).json() as any).data;
    const token = (await (await post(base, "/v1/pairing-codes/claim", claimBody(minted.code))).json() as any).data.token;

    const operations = await get(base, "/v1/operations?afterSequence=0", { accessToken: token });
    expect(operations.status).toBe(200);
    expect((await operations.json() as any).data.operations).toEqual([]);
    expect((await get(base, "/v1/presence", { accessToken: token })).status).toBe(200);

    // Contract A: a terminal-side credential must not reach the user/team surface.
    expect((await get(base, "/v1/memberships", { accessToken: token })).status).toBe(403);
    expect((await get(base, "/v1/invites", { accessToken: token, workspaceId })).status).toBe(403);
    expect((await post(base, "/v1/workspaces", { name: "sneaky" }, { accessToken: token })).status).toBe(403);
    expect((await post(base, "/v1/pairing-codes", {}, { accessToken: token, workspaceId })).status).toBe(403);
    expect((await get(base, `/v1/pairing-codes/${minted.pairingId}`, { accessToken: token, workspaceId })).status).toBe(403);

    // A token scoped elsewhere cannot be pointed at another workspace via the header.
    expect((await get(base, "/v1/operations?afterSequence=0", { accessToken: token, workspaceId: randomUUID() })).status).toBe(403);
    expect((await get(base, "/v1/operations?afterSequence=0", { accessToken: "ccw_not-a-real-token" })).status).toBe(401);
  });

  it("provisions exactly one personal workspace for a user with zero memberships, even concurrently", async () => {
    const { base, store } = await listen();
    const userId = randomUUID();
    const accessToken = await signTestSupabaseToken(supabaseUrl, { sub: userId, email: `${userId}@example.com` });

    const [left, right] = await Promise.all([
      get(base, "/v1/memberships", { accessToken }),
      get(base, "/v1/memberships", { accessToken })
    ]);
    expect(left.status).toBe(200);
    expect(right.status).toBe(200);
    for (const response of [left, right]) {
      expect((await response.json() as any).data.memberships).toHaveLength(1);
    }

    const rows = await store.pool.query("SELECT id FROM members WHERE user_id = $1 AND is_personal", [userId]);
    expect(rows.rows).toHaveLength(1);

    // Two HTTP requests may still serialize by luck; hit the store directly with enough
    // simultaneous callers that the partial unique index is genuinely the thing deciding.
    const raced = randomUUID();
    const results = await Promise.all(Array.from({ length: 5 }, () =>
      store.ensurePersonalWorkspace({ userId: raced, actorId: `${raced}@example.com` })));
    expect(new Set(results.map((r) => r.workspaceId)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);

    // Contract C also requires that a personal workspace does not block joining a team.
    const team = await post(base, "/v1/workspaces", { name: `team-${randomUUID()}` }, { accessToken });
    expect(team.status).toBe(201);
    const after = await get(base, "/v1/memberships", { accessToken });
    expect((await after.json() as any).data.memberships).toHaveLength(2);
  });
});

// One store and one server for the whole file. migrate() runs 005_rls_hardening.sql's
// DROP/CREATE POLICY statements, which take ACCESS EXCLUSIVE locks on every table; calling
// it once per test would contend with the other suites sharing this database. Each test
// isolates itself with fresh random user ids instead.
let shared: Promise<{ base: string; store: PgStore }> | undefined;

function listen(): Promise<{ base: string; store: PgStore }> {
  shared ??= (async () => {
    const store = new PgStore(databaseUrl!);
    stores.push(store);
    await store.migrate();
    const server = createServiceServer({ store, jwks: await testSupabaseJwks(), supabaseUrl });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, store };
  })();
  return shared;
}

function claimBody(code: string) {
  return {
    code,
    actorId: "pairing@example.com",
    replicaName: `laptop-${randomUUID().slice(0, 8)}`,
    repoRoot: "/tmp/checkout",
    repoRemote: "git@github.com:acme/widgets.git"
  };
}

async function personalWorkspaceId(base: string, accessToken: string): Promise<string> {
  const response = await get(base, "/v1/memberships", { accessToken });
  return (await response.json() as any).data.memberships[0].workspaceId;
}

async function pollPairing(base: string, pairingId: string, accessToken: string, workspaceId: string) {
  const response = await get(base, `/v1/pairing-codes/${pairingId}`, { accessToken, workspaceId });
  expect(response.status).toBe(200);
  return (await response.json() as any).data;
}

function get(base: string, path: string, auth: { accessToken?: string; workspaceId?: string }) {
  return fetch(`${base}${path}`, { headers: authHeaders(auth) });
}

function post(base: string, path: string, body: unknown, auth: { accessToken?: string; workspaceId?: string } = {}) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(auth) },
    body: JSON.stringify(body)
  });
}

function authHeaders(auth: { accessToken?: string; workspaceId?: string }): Record<string, string> {
  return {
    ...(auth.accessToken ? { authorization: `Bearer ${auth.accessToken}` } : {}),
    ...(auth.workspaceId ? { [WORKSPACE_HEADER]: auth.workspaceId } : {})
  };
}
