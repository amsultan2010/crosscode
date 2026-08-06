import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createServiceServer, type ServiceServerOptions } from "./http.js";
import { ACCEPTANCE_SURFACES, LEGAL_VERSIONS, type AcceptanceSurface, type LegalDocument } from "./legal.js";
import type { PgStore, RecordedAcceptance } from "./store.js";
import { signTestSupabaseToken, testSupabaseJwks } from "./test-jwks.js";

/**
 * The acceptance mechanism end to end, over real HTTP, through the real route handlers.
 *
 * The table underneath is in memory and mirrors migrations/003_terms_acceptances.sql: rows
 * are appended and never replaced, and the "what did they last accept" read is the SQL's
 * DISTINCT ON, done in JavaScript.
 *
 * The first test is the one that matters. `docs/terms.md` carries a warranty disclaimer and a
 * liability cap, and neither binds anybody who never assented -- so what is asserted is that
 * a fresh account cannot reach a synced or registered state at all without a row in this
 * table. Everything else here is detail around that.
 */

const supabaseUrl = "https://rzsslbmahvoesjxmgefr.supabase.co";
const projectId = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const replicaId = "9a1e8b7c-1111-4222-8333-444455556666";
const userId = "5c9f2a10-2222-4333-8444-555566667777";

const CURRENT = { terms: LEGAL_VERSIONS.terms!, privacy: LEGAL_VERSIONS.privacy! };

type Row = RecordedAcceptance & { acceptedAt: number };

/** The table, in memory. Append-only, exactly as the grant in the migration makes it. */
function inMemoryStore(seed: Row[] = []) {
  const rows: Row[] = [...seed];
  let clock = seed.length;
  return {
    rows,
    async recordAcceptances(acceptances: readonly RecordedAcceptance[]): Promise<void> {
      for (const acceptance of acceptances) {
        clock += 1;
        rows.push({ ...acceptance, acceptedAt: clock });
      }
    },
    async latestAcceptedVersions(id: string): Promise<Partial<Record<LegalDocument, string>>> {
      const latest: Partial<Record<LegalDocument, string>> = {};
      for (const row of [...rows].filter((entry) => entry.userId === id).sort((a, b) => a.acceptedAt - b.acceptedAt)) {
        latest[row.document] = row.version;
      }
      return latest;
    },
    // Everything the gated routes need past the gate, so a refusal is provably the gate and
    // not a stub that was never going to answer.
    async upsertUser() { return { created: false }; },
    async createProject() {
      return { id: projectId, name: "app", repo: "acme/app", plan: "free", createdAt: "2026-01-01T00:00:00.000Z" };
    },
    async requireMembership() { return { projectId, userId, role: "owner" as const, repo: "acme/app" }; },
    async registerReplica() { return { replicaId, cursor: 0 }; },
    async findInvite(code: string) {
      return { code, projectId, repo: "acme/app", expiresAt: "2099-01-01T00:00:00.000Z", redeemedAt: null };
    },
    async redeemInvite() { return { projectId, repo: "acme/app" }; },
    async bindDeviceCode() { return { status: "bound" as const }; }
  };
}

const servers: ReturnType<typeof createServiceServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("an account that has accepted nothing", () => {
  /**
   * The mechanical proof that the liability cap binds. Four routes, one per way in, and a
   * checkout that cannot become a registered replica through any of them.
   */
  it("cannot create a project, redeem an invite, sign a terminal in, or register a replica", async () => {
    const store = inMemoryStore();
    const base = await listen(store);
    const token = await signToken();

    expect((await post(base, "/v1/projects", { name: "app", repo: "acme/app" }, token)).status).toBe(403);
    expect((await post(base, "/v1/invites/CC-7F3A-9C2E/redeem", {}, token, { "x-crosscode-github-token": "gho_x" })).status).toBe(403);
    expect((await post(base, "/v1/auth/github/device/bind", { userCode: "WDJB-MJHT", refreshToken: "r" }, token)).status).toBe(403);
    expect((await post(base, "/v1/replicas", { projectId, branch: "main" }, token)).status).toBe(403);

    // Not a single row, and nothing was let through on the way to finding that out.
    expect(store.rows).toEqual([]);
  });

  it("is told which documents it owes, and where to go and read them", async () => {
    const store = inMemoryStore();
    const base = await listen(store);
    const token = await signToken();

    const refused = await post(base, "/v1/replicas", { projectId, branch: "main" }, token);
    expect((await refused.json() as Envelope).error).toContain("terms and privacy");

    const owed = await get(base, "/v1/legal/acceptances", token);
    expect((await owed.json() as Envelope).data).toMatchObject({ accepted: {}, outstanding: ["terms", "privacy"] });
  });
});

describe("recording an acceptance", () => {
  it("writes a row for each of the four web surfaces and for the CLI", async () => {
    for (const surface of ACCEPTANCE_SURFACES) {
      const store = inMemoryStore();
      const base = await listen(store);
      const token = await signToken();

      const recorded = await post(base, "/v1/legal/acceptances", { surface, documents: CURRENT }, token);

      expect(recorded.status).toBe(201);
      expect(store.rows.map((row) => ({ document: row.document, version: row.version, surface: row.surface }))).toEqual([
        { document: "terms", version: CURRENT.terms, surface },
        { document: "privacy", version: CURRENT.privacy, surface }
      ]);
      // And the route that was refused a moment ago now answers.
      expect((await post(base, "/v1/replicas", { projectId, branch: "main" }, token)).status).toBe(201);
    }
    // Every surface the schema allows was covered, so a new one cannot be added without
    // this test noticing.
    expect([...ACCEPTANCE_SURFACES]).toEqual(["signup", "signin", "device", "join", "cli"]);
  });

  /**
   * The version recorded is the version that was on the screen. `GET /v1/legal` is where a
   * page gets it, and posting anything else back is refused rather than reinterpreted -- so
   * "we recorded assent to a text they never saw" is not a state this can reach.
   */
  it("records exactly the version the page was told to display", async () => {
    const store = inMemoryStore();
    const base = await listen(store);
    const token = await signToken();

    const published = (await (await fetch(`${base}/v1/legal`)).json() as Envelope).data as {
      documents: { document: LegalDocument; version: string; url: string }[];
    };
    const displayed = Object.fromEntries(published.documents.map((entry) => [entry.document, entry.version]));

    await post(base, "/v1/legal/acceptances", { surface: "signup", documents: displayed }, token);

    expect(store.rows.map((row) => [row.document, row.version])).toEqual(Object.entries(displayed));
    expect(displayed).toEqual(CURRENT);
  });

  it("refuses a version that is not the published one, and records nothing", async () => {
    const store = inMemoryStore();
    const base = await listen(store);
    const token = await signToken();

    const stale = await post(base, "/v1/legal/acceptances", {
      surface: "signup", documents: { ...CURRENT, terms: "2019-01-01" }
    }, token);

    expect(stale.status).toBe(409);
    expect((await stale.json() as Envelope).error).toContain("changed");
    expect(store.rows).toEqual([]);
  });

  it("refuses an acceptance that leaves out a required document", async () => {
    const store = inMemoryStore();
    const base = await listen(store);
    const token = await signToken();

    expect((await post(base, "/v1/legal/acceptances", { surface: "signup", documents: { terms: CURRENT.terms } }, token)).status).toBe(400);
    expect((await post(base, "/v1/legal/acceptances", { surface: "nowhere", documents: CURRENT }, token)).status).toBe(400);
    expect(store.rows).toEqual([]);
  });

  it("keeps the circumstances: which surface, from which address, in which client", async () => {
    const store = inMemoryStore();
    const base = await listen(store);
    const token = await signToken();

    await post(base, "/v1/legal/acceptances", { surface: "device", documents: CURRENT }, token, { "user-agent": "Mozilla/5.0 (test)" });

    expect(store.rows[0]).toMatchObject({ userId, surface: "device", userAgent: "Mozilla/5.0 (test)" });
    expect(store.rows[0]?.ip).toBeTruthy();
  });

  /**
   * Append-only is the whole point. A row saying they accepted the 2026-08-01 terms has to
   * survive them accepting a later version, or there is no evidence of what they agreed to
   * on the day they agreed to it.
   */
  it("never replaces the row that says what they accepted before", async () => {
    const store = inMemoryStore();
    const base = await listen(store);
    const token = await signToken();

    await post(base, "/v1/legal/acceptances", { surface: "signup", documents: CURRENT }, token);
    await post(base, "/v1/legal/acceptances", { surface: "device", documents: CURRENT }, token);

    expect(store.rows).toHaveLength(4);
    expect(store.rows.map((row) => row.surface)).toEqual(["signup", "signup", "device", "device"]);
  });
});

/**
 * Terms §11 promises thirty days' notice and re-acceptance on a material change. This is the
 * half of that promise a program can keep: when the stored version is not the published one,
 * the account owes it again and is refused until it says so.
 */
describe("a version older than the published one", () => {
  it("is outstanding again, and the account is refused until it accepts", async () => {
    const store = inMemoryStore([
      { userId, document: "terms", version: "2025-01-01", surface: "signup" as AcceptanceSurface, acceptedAt: 1 },
      { userId, document: "privacy", version: CURRENT.privacy, surface: "signup" as AcceptanceSurface, acceptedAt: 2 }
    ]);
    const base = await listen(store);
    const token = await signToken();

    const owed = await get(base, "/v1/legal/acceptances", token);
    expect((await owed.json() as Envelope).data).toMatchObject({ outstanding: ["terms"] });
    expect((await post(base, "/v1/replicas", { projectId, branch: "main" }, token)).status).toBe(403);

    await post(base, "/v1/legal/acceptances", { surface: "signin", documents: CURRENT }, token);

    expect((await post(base, "/v1/replicas", { projectId, branch: "main" }, token)).status).toBe(201);
    // The old row is still there. That is the point of never updating one.
    expect(store.rows.map((row) => row.version)).toContain("2025-01-01");
  });
});

describe("what the pages are told to show", () => {
  it("publishes the current documents and versions without asking who is asking", async () => {
    const base = await listen(inMemoryStore());

    const published = await fetch(`${base}/v1/legal`);

    expect(published.status).toBe(200);
    expect((await published.json() as Envelope).data).toEqual({
      documents: [
        { document: "terms", version: CURRENT.terms, url: "/docs/terms.html" },
        { document: "privacy", version: CURRENT.privacy, url: "/docs/privacy-policy.html" }
      ],
      required: ["terms", "privacy"]
    });
  });
});

type Envelope = { ok: boolean; data?: unknown; error?: string };

async function listen(store: unknown, extra: Partial<ServiceServerOptions> = {}): Promise<string> {
  const server = createServiceServer({ store: store as PgStore, jwks: await testSupabaseJwks(), supabaseUrl, ...extra });
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
