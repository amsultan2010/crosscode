import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
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

  constructor(config: PoolConfig | string) {
    this.pool = new Pool(typeof config === "string" ? safePoolConfig(config) : config);
  }

  /**
   * One file, applied under a session advisory lock. Every test file that shares a
   * database calls this at startup, and the DROP/CREATE POLICY statements in it need
   * ACCESS EXCLUSIVE -- two connections racing to replace the same policy deadlock.
   */
  async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(hashtext('crosscode_migrate'))");
      const sql = await readFile(new URL("../migrations/001_sync.sql", import.meta.url), "utf8");
      await client.query(sql);
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

export function safePoolConfig(connectionString: string): PoolConfig {
  const url = new URL(connectionString);
  for (const forbidden of ["host", "ssl", "uselibpqcompat"]) {
    if (url.searchParams.has(forbidden)) throw new Error(`PostgreSQL URL parameter is not allowed: ${forbidden}`);
  }
  const sslModes = url.searchParams.getAll("sslmode");
  if (sslModes.length > 1) throw new Error("PostgreSQL URL contains duplicate sslmode parameters");
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (!loopback && sslModes[0] !== "verify-full") throw new Error("Non-loopback PostgreSQL requires sslmode=verify-full");
  return { connectionString, ...(loopback ? {} : { ssl: { rejectUnauthorized: true } }) };
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

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
