import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import type { Change, CreateProjectRequest, FileVersion, SyncProject } from "@crosscode/protocol";
import { Pool, type PoolClient, type PoolConfig } from "pg";

export class StoreConflictError extends Error {}
export class StoreUnauthorizedError extends Error {}

export type ProjectRole = "owner" | "member";

export type ProjectMembership = {
  projectId: string;
  userId: string;
  role: ProjectRole;
  repo: string;
};

export type StoredInvite = {
  code: string;
  projectId: string;
  repo: string;
  expiresAt: string;
  redeemedAt: string | null;
};

/**
 * What the browser hands over at the end of a device handshake, and what the CLI collects.
 *
 * `githubToken` is Supabase's `provider_token`: the invitee's own GitHub OAuth token, which
 * is the only thing that can answer "can this person read owner/repo?" at invite
 * redemption. Supabase returns it once, to the browser, at sign-in and never persists it,
 * so the handshake is the single moment it can be passed on -- see the redeem route in
 * apps/service/src/http.ts. It is absent when the browser sign-in did not produce one.
 */
export type DeviceSession = {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  githubToken?: string;
};

export type StartedDeviceCode = { deviceCode: string; userCode: string; expiresAt: string };

/** Why a bind was refused, or that it took. Each case is a different thing to tell a human. */
export type DeviceBindResult = { status: "unknown" | "expired" | "consumed" | "already-bound" | "bound" };

export type DeviceClaimResult =
  | { status: "unknown" }
  | { status: "expired" }
  | { status: "consumed" }
  | { status: "pending" }
  | { status: "complete"; session: DeviceSession };

/**
 * One page of a room's change log, or a refusal to answer this cursor at all because
 * retention has deleted the rows it asks for. `resyncFrom` is the oldest cursor that can
 * still be answered completely.
 *
 * The refusal is a distinct shape rather than a short page on purpose: a page and "you are
 * caught up" are the same message on the wire, so serving whatever survived would silently
 * drop every change retention deleted.
 */
export type ChangePage =
  | { status: "ok"; changes: Change[]; cursor: number }
  | { status: "cursor-too-old"; resyncFrom: number; retentionDays: number };

/** How long the change log is kept. The one retention promise the service makes. */
export const HISTORY_RETENTION_DAYS = 7;

export class PgStore {
  readonly pool: Pool;

  constructor(config: PoolConfig | string, caCertificate?: string) {
    this.pool = new Pool(typeof config === "string" ? safePoolConfig(config, caCertificate) : config);
  }

  /**
   * Every file in ../migrations, in filename order, applied under a session advisory lock.
   * Every test file that shares a database calls this at startup, and the DROP/CREATE
   * POLICY statements in them need ACCESS EXCLUSIVE -- two connections racing to replace
   * the same policy deadlock.
   *
   * Order is the filename's numeric prefix and nothing else. Each file is idempotent on
   * its own, so this is a fresh-database bootstrap and a re-run of the whole schema at the
   * same time; there is no applied-migrations table to consult, and none is wanted.
   */
  async migrate(): Promise<void> {
    const directory = new URL("../migrations/", import.meta.url);
    const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
    const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(hashtext('crosscode_migrate'))");
      for (const file of files) {
        await client.query(await readFile(new URL(file, directory), "utf8"));
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext('crosscode_migrate'))");
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /**
   * The change log is append-only, so the role the service runs as must not be able to
   * rewrite or erase it. Retention deletes rows, but it runs as the migration role, not
   * this one.
   */
  async assertRuntimePrivileges(): Promise<void> {
    const result = await this.pool.query<{ update: boolean; delete: boolean; truncate: boolean }>(
      `SELECT has_table_privilege(current_user, 'file_versions', 'UPDATE') AS update,
              has_table_privilege(current_user, 'file_versions', 'DELETE') AS delete,
              has_table_privilege(current_user, 'file_versions', 'TRUNCATE') AS truncate`
    );
    if (Object.values(result.rows[0]!).some(Boolean)) throw new Error("DATABASE_URL must use a least-privilege runtime role");
  }

  /**
   * Is the database reachable, and can the runtime role actually use it?
   *
   * The second half is not padding. Migrations create tables but have never granted to
   * `crosscode_runtime` -- the original six were granted once, by hand -- so a table added
   * later arrives readable by nobody and the first request that touches it 500s with
   * `permission denied`. That is how `device_codes` shipped, and it stayed invisible
   * because every check we had asked whether the *service* was up, which it was.
   *
   * Returns the tables the runtime role cannot read, so the answer names the fault instead
   * of reporting a boolean somebody has to go and diagnose.
   */
  async checkHealth(): Promise<{ unreadableTables: string[] }> {
    const result = await this.pool.query<{ table: string }>(
      `SELECT c.relname AS table
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND NOT has_table_privilege(current_user, c.oid, 'SELECT')
        ORDER BY c.relname`
    );
    return { unreadableTables: result.rows.map((row) => row.table) };
  }

  /* --------------------------------------------------------------------------- users */

  /**
   * Every authenticated identity the service acts on has a row here, because projects,
   * invites and replicas all reference one. Called on the routes a brand-new user can
   * reach before belonging to anything -- create a project, redeem an invite.
   */
  async upsertUser(input: { id: string; githubId?: string; githubLogin?: string; email?: string }): Promise<{ created: boolean }> {
    // xmax is 0 on a row this statement inserted and non-zero on one it updated, which is
    // how an upsert reports which half it took. Analytics counts activations with it.
    const result = await this.pool.query<{ created: boolean }>(
      `INSERT INTO users (id, github_id, github_login, email)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE
         SET github_id = COALESCE(excluded.github_id, users.github_id),
             github_login = COALESCE(excluded.github_login, users.github_login),
             email = COALESCE(excluded.email, users.email)
       RETURNING (xmax = 0) AS created`,
      [input.id, input.githubId ?? null, input.githubLogin ?? null, input.email ?? null]
    );
    return { created: result.rows[0]?.created ?? false };
  }

  /* ------------------------------------------------------------------------ projects */

  /** The caller becomes the owner in the same transaction that creates the project. */
  async createProject(userId: string, input: CreateProjectRequest): Promise<SyncProject> {
    const id = randomUUID();
    return this.transaction(async (client) => {
      const inserted = await client.query<ProjectRow>(
        `INSERT INTO projects (id, name, repo, created_by) VALUES ($1, $2, $3, $4)
         RETURNING id, name, repo, plan, created_at`,
        [id, input.name, input.repo, userId]
      );
      await client.query(
        "INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'owner')",
        [id, userId]
      );
      return mapProject(inserted.rows[0]!);
    });
  }

  /**
   * The single authorization check every project-scoped route makes. A project the caller
   * is not a member of and a project that does not exist are the same answer: membership
   * is what makes a project id meaningful, so distinguishing them would leak which ids are
   * real.
   */
  async requireMembership(projectId: string, userId: string): Promise<ProjectMembership> {
    if (!UUID_PATTERN.test(projectId)) throw new StoreUnauthorizedError("Project is not available");
    const result = await this.pool.query<{ role: ProjectRole; repo: string }>(
      `SELECT m.role, p.repo FROM project_members m
         JOIN projects p ON p.id = m.project_id
        WHERE m.project_id = $1 AND m.user_id = $2`,
      [projectId, userId]
    );
    const row = result.rows[0];
    if (!row) throw new StoreUnauthorizedError("Project is not available");
    return { projectId, userId, role: row.role, repo: row.repo };
  }

  /* ------------------------------------------------------------------------- invites */

  async createInvite(input: { projectId: string; userId: string; expiresInHours: number }): Promise<StoredInvite> {
    const membership = await this.requireMembership(input.projectId, input.userId);
    if (membership.role !== "owner") throw new StoreUnauthorizedError("Only a project owner can invite");
    const expiresAt = new Date(Date.now() + input.expiresInHours * 3_600_000);
    // Retry on the (astronomically unlikely) chance a freshly generated code collides with
    // a live one, rather than surfacing a conflict the caller cannot act on.
    for (let attempt = 0; ; attempt += 1) {
      try {
        const inserted = await this.pool.query<{ code: string; expires_at: Date }>(
          `INSERT INTO invites (id, project_id, code, created_by, expires_at)
           VALUES ($1, $2, $3, $4, $5) RETURNING code, expires_at`,
          [randomUUID(), input.projectId, generateInviteCode(), input.userId, expiresAt]
        );
        const row = inserted.rows[0]!;
        return {
          code: row.code,
          projectId: input.projectId,
          repo: membership.repo,
          expiresAt: row.expires_at.toISOString(),
          redeemedAt: null
        };
      } catch (error) {
        if (!isUniqueViolation(error) || attempt >= 4) throw error;
      }
    }
  }

  /**
   * Read-only lookup, so the redeem route can learn which repository to check the caller's
   * GitHub access against before it commits to adding them. redeemInvite() re-checks
   * everything under a row lock; this is not the authorization decision.
   */
  async findInvite(code: string): Promise<StoredInvite | null> {
    const result = await this.pool.query<{ project_id: string; repo: string; expires_at: Date; redeemed_at: Date | null }>(
      `SELECT i.project_id, p.repo, i.expires_at, i.redeemed_at
         FROM invites i JOIN projects p ON p.id = i.project_id
        WHERE i.code = $1`,
      [code]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      code,
      projectId: row.project_id,
      repo: row.repo,
      expiresAt: row.expires_at.toISOString(),
      redeemedAt: row.redeemed_at?.toISOString() ?? null
    };
  }

  /** Adds the caller as a member. The GitHub access check happens before this is called. */
  async redeemInvite(input: { code: string; userId: string }): Promise<{ projectId: string; repo: string }> {
    return this.transaction(async (client) => {
      const found = await client.query<{ id: string; project_id: string; repo: string; expires_at: Date; redeemed_at: Date | null }>(
        `SELECT i.id, i.project_id, p.repo, i.expires_at, i.redeemed_at
           FROM invites i JOIN projects p ON p.id = i.project_id
          WHERE i.code = $1 FOR UPDATE OF i`,
        [input.code]
      );
      const invite = found.rows[0];
      if (!invite) throw new StoreUnauthorizedError("Invite code is not valid");
      if (invite.redeemed_at) throw new StoreConflictError("Invite has already been redeemed");
      if (invite.expires_at.getTime() <= Date.now()) throw new StoreConflictError("Invite has expired");
      await client.query(
        `INSERT INTO project_members (project_id, user_id) VALUES ($1, $2)
         ON CONFLICT (project_id, user_id) DO NOTHING`,
        [invite.project_id, input.userId]
      );
      await client.query("UPDATE invites SET redeemed_at = now(), redeemed_by = $2 WHERE id = $1", [invite.id, input.userId]);
      return { projectId: invite.project_id, repo: invite.repo };
    });
  }

  /* -------------------------------------------------------------------- device codes */

  /**
   * Opens a handshake: one secret the CLI keeps and one short code the human carries to a
   * browser.
   *
   * Both are minted here rather than by the route, because the device code's only defence
   * is its entropy and the hashing that goes with it, and one place to get that wrong is
   * better than two. The raw device code is returned once, to this caller, and never
   * stored -- what lands in the table is its SHA-256.
   */
  async startDeviceCode(input: { expiresInSeconds: number }): Promise<StartedDeviceCode> {
    // Rows are only ever read by an unexpired lookup, so leaving them would cost nothing
    // but storage. Deleted anyway: a table of dead credentials, even consumed ones, is a
    // thing worth not having, and a handshake is exactly when there is time to spare.
    await this.pool.query("DELETE FROM device_codes WHERE expires_at < now() - interval '1 hour'");
    const expiresAt = new Date(Date.now() + input.expiresInSeconds * 1_000);
    for (let attempt = 0; ; attempt += 1) {
      const deviceCode = randomBytes(32).toString("base64url");
      const userCode = generateUserCode();
      try {
        await this.pool.query(
          "INSERT INTO device_codes (id, device_code_hash, user_code, expires_at) VALUES ($1, $2, $3, $4)",
          [randomUUID(), hashDeviceCode(deviceCode), userCode, expiresAt]
        );
        return { deviceCode, userCode, expiresAt: expiresAt.toISOString() };
      } catch (error) {
        // A live user code collided -- ~40 bits against at most a few hundred open
        // handshakes, so this effectively never happens, but a retry is cheaper than
        // handing the caller a conflict they cannot act on.
        if (!isUniqueViolation(error) || attempt >= 4) throw error;
      }
    }
  }

  /**
   * The browser's half: attaches the signed-in session to the code the human typed.
   *
   * The row is locked for the update so two tabs racing on the same code cannot both
   * believe they bound it, and a code that is expired, unknown, or already bound is
   * refused rather than overwritten -- rebinding would let a second person redirect a
   * handshake the first one has already claimed.
   */
  async bindDeviceCode(input: { userCode: string; userId: string; session: DeviceSession }): Promise<DeviceBindResult> {
    return this.transaction(async (client) => {
      const found = await client.query<{ id: string; user_id: string | null; expires_at: Date; consumed_at: Date | null }>(
        "SELECT id, user_id, expires_at, consumed_at FROM device_codes WHERE user_code = $1 FOR UPDATE",
        [input.userCode]
      );
      const row = found.rows[0];
      if (!row) return { status: "unknown" };
      if (row.consumed_at) return { status: "consumed" };
      if (row.expires_at.getTime() <= Date.now()) return { status: "expired" };
      if (row.user_id) return { status: "already-bound" };
      await client.query(
        "UPDATE device_codes SET user_id = $2, session = $3::jsonb WHERE id = $1",
        [row.id, input.userId, JSON.stringify(input.session)]
      );
      return { status: "bound" };
    });
  }

  /**
   * The CLI's half: "has anybody signed in for this code yet?", answered at most once with
   * a session.
   *
   * Collection is a single locked read-and-clear, so a code that is polled twice -- by a
   * retrying client, or by somebody who found the code in a process listing -- hands over
   * the tokens to whoever got there first and nothing to anyone after. The row survives
   * with its `consumed_at` set, purely so the second caller can be told which of the two
   * things happened.
   */
  async claimDeviceCode(deviceCode: string): Promise<DeviceClaimResult> {
    return this.transaction(async (client) => {
      const found = await client.query<{ id: string; session: DeviceSession | null; expires_at: Date; consumed_at: Date | null }>(
        "SELECT id, session, expires_at, consumed_at FROM device_codes WHERE device_code_hash = $1 FOR UPDATE",
        [hashDeviceCode(deviceCode)]
      );
      const row = found.rows[0];
      if (!row) return { status: "unknown" };
      if (row.consumed_at) return { status: "consumed" };
      if (row.expires_at.getTime() <= Date.now()) return { status: "expired" };
      if (!row.session) return { status: "pending" };
      await client.query("UPDATE device_codes SET consumed_at = now(), session = NULL WHERE id = $1", [row.id]);
      return { status: "complete", session: row.session };
    });
  }

  /* ------------------------------------------------------------------------ replicas */

  /**
   * Registers a checkout and tells it where to resume from, which for a new replica is
   * always 0. A fresh checkout is a fresh clone: it holds what git gave it and none of the
   * uncommitted work its teammates have published, so it has to replay the room's log from
   * the beginning to catch up on the working tree.
   */
  async registerReplica(input: { projectId: string; userId: string; branch: string }): Promise<{ replicaId: string; cursor: number }> {
    const replicaId = randomUUID();
    await this.pool.query(
      "INSERT INTO replicas (id, project_id, user_id, branch) VALUES ($1, $2, $3, $4)",
      [replicaId, input.projectId, input.userId, input.branch]
    );
    return { replicaId, cursor: 0 };
  }

  /**
   * Confirms the replica is this user's, in this project, and marks it seen. Returns its
   * branch so the caller can reject a publish or a subscribe aimed at a different one.
   */
  async touchReplica(projectId: string, userId: string, replicaId: string): Promise<{ branch: string }> {
    if (!UUID_PATTERN.test(replicaId)) throw new StoreUnauthorizedError("Replica is not registered to this user");
    const result = await this.pool.query<{ branch: string }>(
      `UPDATE replicas SET last_seen_at = now()
        WHERE id = $1 AND project_id = $2 AND user_id = $3
        RETURNING branch`,
      [replicaId, projectId, userId]
    );
    const row = result.rows[0];
    if (!row) throw new StoreUnauthorizedError("Replica is not registered to this user");
    return { branch: row.branch };
  }

  /* ------------------------------------------------------------------------- changes */

  /**
   * Appends versions and assigns their sequences.
   *
   * The advisory lock is on (project, branch) and held for the transaction, so two
   * replicas publishing at once serialize against each other and the room's sequence stays
   * gap-free and duplicate-free. It is deliberately not a lock on the project: two branches
   * of the same repository are separate rooms and must not queue behind one another.
   *
   * Gap-freeness is what makes cursor-too-old detectable at all -- see listChanges.
   */
  async publishChanges(input: {
    projectId: string;
    branch: string;
    replicaId: string;
    versions: readonly FileVersion[];
  }): Promise<Change[]> {
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`crosscode:sequence:${input.projectId}:${input.branch}`]);
      const current = await client.query<{ head: string }>(
        "SELECT coalesce(max(sequence), 0)::text AS head FROM file_versions WHERE project_id = $1 AND branch = $2",
        [input.projectId, input.branch]
      );
      let sequence = Number(current.rows[0]!.head);
      const changes: Change[] = [];
      for (const version of input.versions) {
        sequence += 1;
        const inserted = await client.query<{ created_at: Date }>(
          `INSERT INTO file_versions (project_id, branch, sequence, replica_id, version)
           VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING created_at`,
          [input.projectId, input.branch, sequence, input.replicaId, JSON.stringify(version)]
        );
        changes.push({
          sequence,
          projectId: input.projectId,
          branch: input.branch,
          replicaId: input.replicaId,
          createdAt: inserted.rows[0]!.created_at.toISOString(),
          version
        });
      }
      return changes;
    });
  }

  /**
   * Everything after `since`, or a refusal when `since` predates retention.
   *
   * Sequences are contiguous within a room and retention only ever deletes a prefix of
   * them, so the oldest surviving sequence is all the watermark this needs: a cursor at
   * `oldest - 1` can still be answered completely, and anything below it is asking for
   * rows that are gone. An empty room with a non-zero cursor is the same situation -- the
   * whole log aged out.
   */
  async listChanges(input: { projectId: string; branch: string; since: number; limit: number }): Promise<ChangePage> {
    const bounds = await this.pool.query<{ oldest: string | null }>(
      "SELECT min(sequence)::text AS oldest FROM file_versions WHERE project_id = $1 AND branch = $2",
      [input.projectId, input.branch]
    );
    const oldest = bounds.rows[0]!.oldest === null ? null : Number(bounds.rows[0]!.oldest);
    const servableFrom = oldest === null ? 0 : oldest - 1;
    if (input.since > 0 && input.since < servableFrom) {
      return { status: "cursor-too-old", resyncFrom: servableFrom, retentionDays: HISTORY_RETENTION_DAYS };
    }
    if (input.since > 0 && oldest === null) {
      return { status: "cursor-too-old", resyncFrom: 0, retentionDays: HISTORY_RETENTION_DAYS };
    }
    const result = await this.pool.query<ChangeRow>(
      `SELECT project_id, branch, sequence, replica_id, version, created_at
         FROM file_versions
        WHERE project_id = $1 AND branch = $2 AND sequence > $3
        ORDER BY sequence ASC
        LIMIT $4`,
      [input.projectId, input.branch, input.since, input.limit]
    );
    const changes = result.rows.map(mapChange);
    return { status: "ok", changes, cursor: changes.at(-1)?.sequence ?? input.since };
  }

  private async transaction<T>(body: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const value = await body(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

/**
 * @param caCertificate PEM for a private root the server chains to. Managed Postgres
 *   commonly issues its certificates from its own CA rather than a publicly trusted one --
 *   Supabase's pooler chains to "Supabase Root 2021 CA" -- so verifying against the system
 *   trust store fails with `self-signed certificate in certificate chain`. Supplying the
 *   root keeps verification genuinely on (chain *and* hostname) instead of the usual
 *   workaround of turning it off. Read from DATABASE_CA_CERT.
 */
export function safePoolConfig(connectionString: string, caCertificate?: string): PoolConfig {
  const url = new URL(connectionString);
  for (const forbidden of ["host", "ssl", "uselibpqcompat"]) {
    if (url.searchParams.has(forbidden)) throw new Error(`PostgreSQL URL parameter is not allowed: ${forbidden}`);
  }
  const sslModes = url.searchParams.getAll("sslmode");
  if (sslModes.length > 1) throw new Error("PostgreSQL URL contains duplicate sslmode parameters");
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (!loopback && sslModes[0] !== "verify-full") throw new Error("Non-loopback PostgreSQL requires sslmode=verify-full");
  if (loopback) return { connectionString };
  // sslmode is validated above and then removed, because `pg` parses it out of the
  // connection string and builds its own TLS options from it -- which silently discards the
  // `ca` below, so a private root would never be consulted and verification would fail with
  // `self-signed certificate in certificate chain`. The explicit options are strictly
  // stronger than what the string can express: verification stays on either way.
  url.searchParams.delete("sslmode");
  return {
    connectionString: url.toString(),
    ssl: {
      rejectUnauthorized: true,
      servername: url.hostname,
      ...(caCertificate ? { ca: caCertificate } : {})
    }
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ProjectRow = { id: string; name: string; repo: string; plan: string; created_at: Date };

function mapProject(row: ProjectRow): SyncProject {
  return { id: row.id, name: row.name, repo: row.repo, plan: row.plan, createdAt: row.created_at.toISOString() };
}

type ChangeRow = {
  project_id: string;
  branch: string;
  sequence: string;
  replica_id: string;
  version: FileVersion;
  created_at: Date;
};

function mapChange(row: ChangeRow): Change {
  return {
    sequence: Number(row.sequence),
    projectId: row.project_id,
    branch: row.branch,
    replicaId: row.replica_id,
    createdAt: row.created_at.toISOString(),
    version: row.version
  };
}

// The invite code a human retypes: CC-7F3A-9C2E. The contract's alphabet is [0-9A-Z]; the
// subset here drops the characters that get misread aloud or in a screenshot (O/0, I/1,
// S/5), which leaves 8 characters of ~5 bits each -- enough that guessing one is hopeless,
// and short enough to say over a call.
const INVITE_CODE_ALPHABET = "ABCDEFGHJKLMNPQRTUVWXYZ2346789";

function generateInviteCode(): string {
  const bytes = randomBytes(8);
  let code = "";
  for (const byte of bytes) code += INVITE_CODE_ALPHABET[byte % INVITE_CODE_ALPHABET.length];
  return `CC-${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * The device code's lookup key. Exported because the poll route rate-limits on it and must
 * key its counters on the same non-reversible value the table holds, rather than keeping
 * the raw code in a map for a minute.
 */
export function hashDeviceCode(deviceCode: string): string {
  return createHash("sha256").update(deviceCode).digest("hex");
}

// The code a human copies from their terminal into a browser: WDJB-MJHT. Same alphabet as
// the invite code -- no O/0, I/1 or S/5 to misread off a screen -- and the same eight
// characters, which is ~40 bits: far too many to guess inside a fifteen-minute window, and
// short enough that nobody mistypes it twice.
function generateUserCode(): string {
  const bytes = randomBytes(8);
  let code = "";
  for (const byte of bytes) code += INVITE_CODE_ALPHABET[byte % INVITE_CODE_ALPHABET.length];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * The one spelling of a user code the table stores: upper case, one dash in the middle.
 * A human types it with the dash, without it, or in lower case, and all three are the same
 * code.
 */
export function normalizeUserCode(input: string): string | undefined {
  const bare = input.trim().toUpperCase().replace(/[\s-]/g, "");
  if (!/^[A-Z0-9]{8}$/.test(bare)) return undefined;
  return `${bare.slice(0, 4)}-${bare.slice(4)}`;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
