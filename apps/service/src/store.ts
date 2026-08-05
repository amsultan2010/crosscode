import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  EventEnvelope, Project, RemoteOperation, ChangeTransaction, TransactionCreatedEvent
} from "@crosscode/protocol";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import { hashCanonicalPayload } from "./crypto.js";
import { normalizeRepoRemote, normalizeRepoRoot, projectNameFrom } from "./projects.js";

export class StoreConflictError extends Error {}
export class StoreUnauthorizedError extends Error {}

export type StoredOperation = RemoteOperation & {
  event: EventEnvelope;
};

/**
 * One page of the operation history, or a refusal to answer this cursor at all because
 * retention has deleted the rows it asks for. `resyncFrom` is the oldest cursor that can
 * still be served completely; `retentionDays` is the window that caused the deletion, so
 * the message a client shows can name it.
 */
export type OperationPage =
  | { status: "ok"; items: StoredOperation[]; nextCursor: number; hasMore: boolean }
  | { status: "cursor-too-old"; resyncFrom: number; retentionDays: number };

export type Membership = {
  memberId: string;
  userId: string;
  actorId: string;
  workspaceId: string;
  role: "owner" | "member" | "viewer";
};

export type Invite = {
  id: string;
  workspaceId: string;
  code: string;
  role: Membership["role"];
  createdBy: string;
  expiresAt: string;
  redeemedAt: string | null;
  redeemedBy: string | null;
  createdAt: string;
};

export type MemberSummary = {
  memberId: string;
  actorId: string;
  role: Membership["role"];
  isPersonal: boolean;
  disabledAt: string | null;
  createdAt: string;
};

const DEFAULT_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

/**
 * How long the change log is kept, in days. Was a per-plan window (PLAN_LIMITS) until
 * billing was removed; it is now the one retention promise the service makes, and the only
 * thing that still reads it is the cursor-too-old answer below.
 */
const HISTORY_RETENTION_DAYS = 7;

/**
 * How many workspaces one user may create for themselves. Set far above what a real person
 * needs, so it is an abuse ceiling -- an account farming workspaces for free unmetered
 * storage -- rather than a plan wall.
 *
 * The Contract C personal workspace is deliberately outside this count: it is provisioned
 * by ensurePersonalWorkspace(), not createWorkspace(), so a user can never be locked out of
 * the workspace their first authenticated request depends on.
 */
export const MAX_SELF_SERVE_WORKSPACES_PER_USER = 10;

export class PgStore {
  readonly pool: Pool;

  constructor(config: PoolConfig | string) {
    this.pool = new Pool(typeof config === "string" ? safePoolConfig(config) : config);
  }

  /**
   * The advisory lock below serializes concurrent migrators, but it cannot serialize a
   * migrator against unrelated in-flight DML: 004/005's DROP/CREATE POLICY needs ACCESS
   * EXCLUSIVE on tables another pool may already hold ACCESS SHARE on, and the two can
   * deadlock. Postgres kills one side, so retry the whole (idempotent) sequence when we
   * are the victim rather than failing a run for a transient lock ordering.
   */
  async migrate(): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.runMigrations();
        return;
      } catch (error) {
        if (attempt >= 4 || !isDeadlock(error)) throw error;
      }
    }
  }

  private async runMigrations(): Promise<void> {
    // Migrations 004/005 DROP+CREATE RLS policies, which (unlike the IF NOT EXISTS
    // DDL in 001-003) is not safe to run concurrently: two connections racing to
    // DROP/CREATE the same policy on the same table can deadlock in Postgres. Every
    // test file that shares one database calls migrate() at startup, so serialize
    // the whole sequence behind a session-level advisory lock on a single connection.
    const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(hashtext('crosscode_migrate'))");
      const sql = await readFile(new URL("../migrations/001_initial.sql", import.meta.url), "utf8");
      await client.query(sql);
      const handoffsIntentsSql = await readFile(new URL("../migrations/002_handoffs_intents.sql", import.meta.url), "utf8");
      await client.query(handoffsIntentsSql);
      const validationsCursorSql = await readFile(new URL("../migrations/003_validations_cursor.sql", import.meta.url), "utf8");
      await client.query(validationsCursorSql);
      const supabaseAuthSql = await readFile(new URL("../migrations/004_supabase_auth.sql", import.meta.url), "utf8");
      await client.query(supabaseAuthSql);
      const rlsHardeningSql = await readFile(new URL("../migrations/005_rls_hardening.sql", import.meta.url), "utf8");
      await client.query(rlsHardeningSql);
      const invitesSql = await readFile(new URL("../migrations/006_invites.sql", import.meta.url), "utf8");
      await client.query(invitesSql);
      const autonomyPolicySql = await readFile(new URL("../migrations/007_autonomy_policy.sql", import.meta.url), "utf8");
      await client.query(autonomyPolicySql);
      const billingSql = await readFile(new URL("../migrations/008_billing.sql", import.meta.url), "utf8");
      await client.query(billingSql);
      const pairingSql = await readFile(new URL("../migrations/009_pairing.sql", import.meta.url), "utf8");
      await client.query(pairingSql);
      const projectsSql = await readFile(new URL("../migrations/010_projects.sql", import.meta.url), "utf8");
      await client.query(projectsSql);
      const teamPlanSql = await readFile(new URL("../migrations/011_team_plan.sql", import.meta.url), "utf8");
      await client.query(teamPlanSql);
      const rateLimitsSql = await readFile(new URL("../migrations/012_rate_limits.sql", import.meta.url), "utf8");
      await client.query(rateLimitsSql);
      const contentHomeSql = await readFile(new URL("../migrations/013_single_content_home_and_retention.sql", import.meta.url), "utf8");
      await client.query(contentHomeSql);
      const billingLifecycleSql = await readFile(new URL("../migrations/014_billing_lifecycle.sql", import.meta.url), "utf8");
      await client.query(billingLifecycleSql);
      // After 013, which drops operations.transaction and operation_files.payload: the
      // sealed columns and the encryption latch are added to the tables in their final
      // shape, so this never has to be re-stated when a column it touches moves.
      const encryptionSql = await readFile(new URL("../migrations/015_encryption.sql", import.meta.url), "utf8");
      await client.query(encryptionSql);
      // Last, because it drops what everything above created and this service no longer
      // serves. The earlier files stay as the applied history of deployed databases.
      const stripSql = await readFile(new URL("../migrations/016_strip.sql", import.meta.url), "utf8");
      await client.query(stripSql);
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext('crosscode_migrate'))");
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async assertRuntimePrivileges(): Promise<void> {
    const result = await this.pool.query<{ operations_update: boolean; operations_delete: boolean; operations_truncate: boolean; audit_update: boolean; audit_delete: boolean; audit_truncate: boolean }>(
      `SELECT has_table_privilege(current_user, 'operations', 'UPDATE') AS operations_update,
              has_table_privilege(current_user, 'operations', 'DELETE') AS operations_delete,
              has_table_privilege(current_user, 'operations', 'TRUNCATE') AS operations_truncate,
              has_table_privilege(current_user, 'audit_events', 'UPDATE') AS audit_update,
              has_table_privilege(current_user, 'audit_events', 'DELETE') AS audit_delete,
              has_table_privilege(current_user, 'audit_events', 'TRUNCATE') AS audit_truncate`
    );
    if (Object.values(result.rows[0]!).some(Boolean)) throw new Error("DATABASE_URL must use a least-privilege runtime role");
  }

  async provisionAdmin(input: {
    workspaceName: string;
    userId: string;
    actorId: string;
  }): Promise<{ workspaceId: string; memberId: string }> {
    const workspaceId = randomUUID();
    const memberId = randomUUID();
    await this.transaction(async (client) => {
      await client.query("INSERT INTO workspaces (id, name) VALUES ($1, $2)", [workspaceId, input.workspaceName]);
      await client.query(
        "INSERT INTO members (id, workspace_id, user_id, actor_id, role) VALUES ($1, $2, $3, $4, 'owner')",
        [memberId, workspaceId, input.userId, input.actorId]
      );
      await this.audit(client, workspaceId, memberId, null, "admin.provisioned", {});
    });
    return { workspaceId, memberId };
  }

  // Self-serve counterpart to provisionAdmin: callable by any authenticated Supabase user
  // (no service-role key), so an agent can spin up a workspace just by opening a folder.
  async createWorkspace(input: {
    workspaceName: string;
    userId: string;
    actorId: string;
  }): Promise<{ workspaceId: string; memberId: string }> {
    const workspaceId = randomUUID();
    const memberId = randomUUID();
    await this.transaction(async (client) => {
      // Serialize concurrent creates by the same user so two in-flight requests cannot both
      // read a count under the cap and both insert. Keyed on the user, so it never contends
      // with anybody else's create.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`crosscode:workspace-create:${input.userId}`]);
      const owned = await client.query<{ count: string }>(
        `SELECT count(*) FROM members
           WHERE user_id = $1 AND role = 'owner' AND NOT is_personal AND disabled_at IS NULL`,
        [input.userId]
      );
      if (Number(owned.rows[0]!.count) >= MAX_SELF_SERVE_WORKSPACES_PER_USER) {
        throw new StoreConflictError(`You already own ${MAX_SELF_SERVE_WORKSPACES_PER_USER} workspaces, which is the per-account limit`);
      }
      await client.query("INSERT INTO workspaces (id, name) VALUES ($1, $2)", [workspaceId, input.workspaceName]);
      await client.query(
        "INSERT INTO members (id, workspace_id, user_id, actor_id, role) VALUES ($1, $2, $3, $4, 'owner')",
        [memberId, workspaceId, input.userId, input.actorId]
      );
      await this.audit(client, workspaceId, memberId, null, "workspace.self_serve_created", {});
    });
    return { workspaceId, memberId };
  }

  /** Self-serve workspaces this user owns, which is what MAX_SELF_SERVE_WORKSPACES_PER_USER caps. */
  async countOwnedSelfServeWorkspaces(userId: string): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT count(*) FROM members
         WHERE user_id = $1 AND role = 'owner' AND NOT is_personal AND disabled_at IS NULL`,
      [userId]
    );
    return Number(result.rows[0]!.count);
  }

  async addMember(input: {
    workspaceId: string;
    userId: string;
    actorId: string;
    role?: Membership["role"];
  }): Promise<{ workspaceId: string; memberId: string }> {
    const memberId = randomUUID();
    return this.transaction(async (client) => {
      const workspace = await client.query("SELECT id FROM workspaces WHERE id = $1 FOR UPDATE", [input.workspaceId]);
      if (!workspace.rows[0]) throw new StoreUnauthorizedError("Workspace is not available");
      try {
        await client.query(
          `INSERT INTO members (id, workspace_id, user_id, actor_id, role) VALUES ($1, $2, $3, $4, $5)`,
          [memberId, input.workspaceId, input.userId, input.actorId, input.role ?? "member"]
        );
      } catch (error) {
        if (isUniqueViolation(error)) throw new StoreConflictError("User is already a member of a workspace");
        throw error;
      }
      await this.audit(client, input.workspaceId, memberId, null, "member.provisioned", {});
      return { workspaceId: input.workspaceId, memberId };
    });
  }

  async resolveMembership(userId: string, workspaceId: string): Promise<Membership> {
    const result = await this.pool.query<{ id: string; actor_id: string; role: Membership["role"] }>(
      `SELECT id, actor_id, role FROM members WHERE user_id = $1 AND workspace_id = $2 AND disabled_at IS NULL`,
      [userId, workspaceId]
    );
    const row = result.rows[0];
    if (!row) throw new StoreUnauthorizedError("Membership is not available");
    return { memberId: row.id, userId, actorId: row.actor_id, workspaceId, role: row.role };
  }

  // Powers `GET /v1/memberships` and the CLI's workspace switching -- every workspace a
  // user currently belongs to, with the workspace name for display.
  async listMembershipsForUser(userId: string): Promise<Array<Membership & { workspaceName: string; isPersonal: boolean }>> {
    const result = await this.pool.query<{ member_id: string; actor_id: string; role: Membership["role"]; workspace_id: string; workspace_name: string; is_personal: boolean }>(
      `SELECT m.id AS member_id, m.actor_id, m.role, m.workspace_id, w.name AS workspace_name, m.is_personal
         FROM members m JOIN workspaces w ON w.id = m.workspace_id
         WHERE m.user_id = $1 AND m.disabled_at IS NULL
         ORDER BY w.name`,
      [userId]
    );
    return result.rows.map((row) => ({
      memberId: row.member_id, userId, actorId: row.actor_id, role: row.role,
      workspaceId: row.workspace_id, workspaceName: row.workspace_name, isPersonal: row.is_personal
    }));
  }

  async createInvite(identity: Membership, input: { role?: Invite["role"]; ttlMs?: number }): Promise<Invite> {
    if (identity.role !== "owner") throw new StoreUnauthorizedError("Only workspace owners can create invites");
    const role = input.role ?? "member";
    if (role === "owner") throw new StoreUnauthorizedError("Invites cannot grant the owner role");
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + (input.ttlMs ?? DEFAULT_INVITE_TTL_MS));
    return this.transaction(async (client) => {
      let row: InviteRow | undefined;
      // Retry on the (astronomically unlikely) chance a freshly generated code collides
      // with an existing one, rather than surfacing a conflict the caller can't act on.
      for (let attempt = 0; attempt < 5 && !row; attempt += 1) {
        try {
          const inserted = await client.query<InviteRow>(
            `INSERT INTO invites (id, workspace_id, code, role, created_by, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id, workspace_id, code, role, created_by, expires_at, redeemed_at, redeemed_by, created_at`,
            [id, identity.workspaceId, generateInviteCode(), role, identity.memberId, expiresAt]
          );
          row = inserted.rows[0];
        } catch (error) {
          if (!isUniqueViolation(error) || attempt === 4) throw error;
        }
      }
      await this.audit(client, identity.workspaceId, identity.memberId, null, "invite.created", { inviteId: id });
      return mapInvite(row!);
    });
  }

  async listInvites(identity: Membership): Promise<Invite[]> {
    if (identity.role !== "owner") throw new StoreUnauthorizedError("Only workspace owners can list invites");
    const result = await this.pool.query<InviteRow>(
      `SELECT id, workspace_id, code, role, created_by, expires_at, redeemed_at, redeemed_by, created_at
         FROM invites
        WHERE workspace_id = $1
        ORDER BY created_at DESC`,
      [identity.workspaceId]
    );
    return result.rows.map(mapInvite);
  }

  async revokeInvite(identity: Membership, inviteId: string): Promise<void> {
    if (identity.role !== "owner") throw new StoreUnauthorizedError("Only workspace owners can revoke invites");
    const result = await this.pool.query(
      `DELETE FROM invites WHERE id = $1 AND workspace_id = $2 AND redeemed_at IS NULL RETURNING id`,
      [inviteId, identity.workspaceId]
    );
    if (!result.rows[0]) throw new StoreConflictError("Invite is not available to revoke");
  }

  async redeemInvite(input: { code: string; userId: string; actorId: string }): Promise<{ workspaceId: string; memberId: string; role: Invite["role"] }> {
    return this.transaction(async (client) => {
      const inviteResult = await client.query<InviteRow>(
        `SELECT id, workspace_id, code, role, created_by, expires_at, redeemed_at, redeemed_by, created_at
           FROM invites WHERE code = $1 FOR UPDATE`,
        [input.code]
      );
      const invite = inviteResult.rows[0];
      if (!invite) throw new StoreUnauthorizedError("Invite code is not valid");
      if (invite.redeemed_at) throw new StoreConflictError("Invite has already been redeemed");
      if (invite.expires_at.getTime() <= Date.now()) throw new StoreConflictError("Invite has expired");
      const workspace = await client.query("SELECT id FROM workspaces WHERE id = $1 FOR UPDATE", [invite.workspace_id]);
      if (!workspace.rows[0]) throw new StoreUnauthorizedError("Workspace is not available");
      const memberId = randomUUID();
      try {
        await client.query(
          `INSERT INTO members (id, workspace_id, user_id, actor_id, role) VALUES ($1, $2, $3, $4, $5)`,
          [memberId, invite.workspace_id, input.userId, input.actorId, invite.role]
        );
      } catch (error) {
        if (isUniqueViolation(error)) throw new StoreConflictError("User is already a member of a workspace");
        throw error;
      }
      await client.query(`UPDATE invites SET redeemed_at = now(), redeemed_by = $2 WHERE id = $1`, [invite.id, input.userId]);
      await this.audit(client, invite.workspace_id, memberId, null, "invite.redeemed", { inviteId: invite.id });
      return { workspaceId: invite.workspace_id, memberId, role: invite.role };
    });
  }

  /**
   * Contract C: a user with zero memberships gets a personal workspace and an owner
   * membership, transactionally and idempotently. The idempotency is enforced by
   * 009_pairing.sql's partial unique index on members(user_id) WHERE is_personal rather
   * than by a check-then-insert, so two concurrent first requests cannot both provision:
   * the loser's INSERT raises a unique violation and it re-reads the winner's row.
   */
  async ensurePersonalWorkspace(input: { userId: string; actorId: string; workspaceName?: string }): Promise<{ workspaceId: string; memberId: string; created: boolean }> {
    const existing = await this.findPersonalWorkspace(input.userId);
    if (existing) return { ...existing, created: false };
    const workspaceId = randomUUID();
    const memberId = randomUUID();
    try {
      await this.transaction(async (client) => {
        await client.query("INSERT INTO workspaces (id, name, is_personal) VALUES ($1, $2, true)", [
          workspaceId, input.workspaceName ?? `${input.actorId}'s workspace`
        ]);
        await client.query(
          "INSERT INTO members (id, workspace_id, user_id, actor_id, role, is_personal) VALUES ($1, $2, $3, $4, 'owner', true)",
          [memberId, workspaceId, input.userId, input.actorId]
        );
        await this.audit(client, workspaceId, memberId, null, "workspace.personal_provisioned", {});
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const winner = await this.findPersonalWorkspace(input.userId);
      if (!winner) throw error;
      return { ...winner, created: false };
    }
    return { workspaceId, memberId, created: true };
  }

  private async findPersonalWorkspace(userId: string): Promise<{ workspaceId: string; memberId: string } | undefined> {
    const result = await this.pool.query<{ id: string; workspace_id: string }>(
      "SELECT id, workspace_id FROM members WHERE user_id = $1 AND is_personal AND disabled_at IS NULL",
      [userId]
    );
    const row = result.rows[0];
    return row ? { workspaceId: row.workspace_id, memberId: row.id } : undefined;
  }
  async listMembers(identity: Membership): Promise<MemberSummary[]> {
    const result = await this.pool.query<{ id: string; actor_id: string; role: Membership["role"]; is_personal: boolean; disabled_at: Date | null; created_at: Date }>(
      `SELECT id, actor_id, role, is_personal, disabled_at, created_at
         FROM members WHERE workspace_id = $1 ORDER BY created_at ASC`,
      [identity.workspaceId]
    );
    return result.rows.map((row) => ({
      memberId: row.id,
      actorId: row.actor_id,
      role: row.role,
      isPersonal: row.is_personal,
      disabledAt: row.disabled_at ? new Date(row.disabled_at).toISOString() : null,
      createdAt: new Date(row.created_at).toISOString()
    }));
  }

  /**
   * Removes a member's access. Sets disabled_at rather than deleting the row: operations
   * and audit events reference members, and history must stay attributable after someone
   * leaves. Every authorization path already filters on `disabled_at IS NULL`, so this
   * takes effect on the member's next request.
   */
  async disableMember(identity: Membership, memberId: string): Promise<MemberSummary> {
    if (identity.role !== "owner") throw new StoreUnauthorizedError("Only workspace owners can remove members");
    if (memberId === identity.memberId) throw new StoreConflictError("A workspace owner cannot remove themselves");
    return this.transaction(async (client) => {
      // Lock the workspace's members before counting owners, so two concurrent removals
      // cannot each see the other's owner as still active and leave the workspace ownerless.
      const owners = await client.query<{ id: string }>(
        "SELECT id FROM members WHERE workspace_id = $1 AND role = 'owner' AND disabled_at IS NULL FOR UPDATE",
        [identity.workspaceId]
      );
      const target = await client.query<{ id: string; actor_id: string; role: Membership["role"]; is_personal: boolean; created_at: Date }>(
        "SELECT id, actor_id, role, is_personal, created_at FROM members WHERE id = $1 AND workspace_id = $2 AND disabled_at IS NULL",
        [memberId, identity.workspaceId]
      );
      const row = target.rows[0];
      if (!row) throw new StoreConflictError("Member is not available to remove");
      if (row.role === "owner" && owners.rows.length <= 1) throw new StoreConflictError("A workspace must keep at least one owner");
      const disabled = await client.query<{ disabled_at: Date }>(
        "UPDATE members SET disabled_at = now() WHERE id = $1 RETURNING disabled_at",
        [memberId]
      );
      // Their devices go with them: the replicas stop being able to ingest, without
      // waiting for anything to expire.
      await client.query("UPDATE replicas SET disabled_at = now() WHERE member_id = $1 AND disabled_at IS NULL", [memberId]);
      await this.audit(client, identity.workspaceId, identity.memberId, null, "member.removed", { memberId });
      return {
        memberId: row.id,
        actorId: row.actor_id,
        role: row.role,
        isPersonal: row.is_personal,
        disabledAt: new Date(disabled.rows[0]!.disabled_at).toISOString(),
        createdAt: new Date(row.created_at).toISOString()
      };
    });
  }

  /**
   * Idempotent upsert of a project (Contract B), keyed by the normalized git remote when
   * the checkout has one and by the absolute repo root otherwise. Returns null when the
   * caller reported neither usable key, so every call site can safely do
   * `(await store.upsertProject(...))?.id ?? null`.
   *
   * Safe to call on every registration: repeat calls only bump
   * last_activity_at and refresh the advisory repo_root.
   */
  async upsertProject(
    workspaceId: string,
    input: { repoRoot?: string | null; repoRemote?: string | null }
  ): Promise<Project | null> {
    const repoRemote = normalizeRepoRemote(input.repoRemote);
    const repoRoot = normalizeRepoRoot(input.repoRoot);
    if (!repoRemote && !repoRoot) return null;
    const name = projectNameFrom(repoRemote, repoRoot);
    // Two partial unique indexes back the two-tiered key (see 010_projects.sql), so the
    // conflict target has to name the matching one -- Postgres cannot infer a partial
    // index without its predicate.
    const conflictTarget = repoRemote
      ? "(workspace_id, repo_remote) WHERE repo_remote IS NOT NULL"
      : "(workspace_id, repo_root) WHERE repo_remote IS NULL AND repo_root IS NOT NULL";
    const columns = "id, workspace_id, name, repo_remote, repo_root, created_at, last_activity_at";
    return this.transaction(async (client) => {
      // A checkout that first registered without a remote is already filed under its
      // repo_root. The moment it reports one, the remote-keyed conflict target below
      // stops seeing that row -- it would insert a second project for the same checkout
      // and split its activity across both. Promote the existing row instead. Skipped
      // when something else already holds the remote, in which case the two rows really
      // are distinct and the ordinary upsert converges on the remote-keyed one.
      if (repoRemote && repoRoot) {
        await client.query("SAVEPOINT crosscode_project_adopt");
        try {
          const adopted = await client.query<ProjectRow>(
            `UPDATE projects SET repo_remote = $3, name = $4, last_activity_at = now()
              WHERE workspace_id = $1 AND repo_root = $2 AND repo_remote IS NULL
                AND NOT EXISTS (
                  SELECT 1 FROM projects claimed
                   WHERE claimed.workspace_id = $1 AND claimed.repo_remote = $3
                )
              RETURNING ${columns}`,
            [workspaceId, repoRoot, repoRemote, name]
          );
          await client.query("RELEASE SAVEPOINT crosscode_project_adopt");
          if (adopted.rows[0]) return mapProject(adopted.rows[0]);
        } catch (error) {
          // Two checkouts reporting the same new remote at once: one adoption wins and
          // the loser trips the partial unique index. Fall through to the upsert, which
          // resolves onto the winner's row.
          if (!isUniqueViolation(error)) throw error;
          await client.query("ROLLBACK TO SAVEPOINT crosscode_project_adopt");
        }
      }
      const result = await client.query<ProjectRow>(
        `INSERT INTO projects (id, workspace_id, name, repo_remote, repo_root, last_activity_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT ${conflictTarget} DO UPDATE
           SET repo_root = COALESCE(excluded.repo_root, projects.repo_root), last_activity_at = now()
         RETURNING ${columns}`,
        [randomUUID(), workspaceId, name, repoRemote, repoRoot]
      );
      return mapProject(result.rows[0]!);
    });
  }

  async listProjects(workspaceId: string): Promise<Project[]> {
    const result = await this.pool.query<ProjectRow>(
      `SELECT id, workspace_id, name, repo_remote, repo_root, created_at, last_activity_at
         FROM projects
        WHERE workspace_id = $1
        ORDER BY last_activity_at DESC NULLS LAST, created_at DESC`,
      [workspaceId]
    );
    return result.rows.map(mapProject);
  }

  // Workspace-scoped on purpose: a project id from another workspace must be
  // indistinguishable from one that does not exist (http.ts turns null into a 404).
  async getProject(workspaceId: string, projectId: string): Promise<Project | null> {
    const result = await this.pool.query<ProjectRow>(
      `SELECT id, workspace_id, name, repo_remote, repo_root, created_at, last_activity_at
         FROM projects WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, projectId]
    );
    return result.rows[0] ? mapProject(result.rows[0]) : null;
  }

  async registerReplica(
    userId: string, workspaceId: string, name: string,
    repo: { repoRoot?: string | null; repoRemote?: string | null } = {}
  ): Promise<{ replicaId: string; createdAt: string; projectId: string | null }> {
    const membership = await this.resolveMembership(userId, workspaceId);
    const project = await this.upsertProject(workspaceId, repo);
    const replicaId = randomUUID();
    try {
      const result = await this.pool.query<{ created_at: Date }>(
        `INSERT INTO replicas (id, workspace_id, member_id, name, project_id) VALUES ($1, $2, $3, $4, $5) RETURNING created_at`,
        [replicaId, workspaceId, membership.memberId, name, project?.id ?? null]
      );
      return { replicaId, createdAt: new Date(result.rows[0]!.created_at).toISOString(), projectId: project?.id ?? null };
    } catch (error) {
      if (isUniqueViolation(error)) throw new StoreConflictError("Replica name is already registered");
      throw error;
    }
  }

  /**
   * Returns the replica's project id (null when unattributed) so callers that already pay
   * for this round-trip -- the WebSocket handshake in particular -- can attribute live
   * presence without a second query. Ingest call sites ignore the return value.
   */
  async assertReplicaOwnership(workspaceId: string, memberId: string, replicaId: string): Promise<string | null> {
    const result = await this.pool.query<{ project_id: string | null }>(
      `UPDATE replicas SET last_seen_at = now()
        WHERE id = $1 AND workspace_id = $2 AND member_id = $3 AND disabled_at IS NULL
        RETURNING project_id`,
      [replicaId, workspaceId, memberId]
    );
    if (!result.rows[0]) throw new StoreUnauthorizedError("Replica is not registered to this member");
    return result.rows[0].project_id;
  }

  async appendOperation(identity: Membership, event: TransactionCreatedEvent): Promise<StoredOperation> {
    const transaction = event.payload;
    const files = transaction.changes.map((change) => ({
      key: change.path, kind: change.kind, beforeHash: change.beforeHash ?? null, afterHash: change.afterHash ?? null
    }));
    if (new Set(files.map((file) => file.key)).size !== files.length) {
      throw new StoreConflictError("An operation may change each path only once");
    }
    const payloadHash = hashCanonicalPayload(event);
    return this.transaction(async (client) => {
      const workspace = await client.query<{ next_sequence: string }>(
        "SELECT next_sequence FROM workspaces WHERE id = $1 FOR UPDATE",
        [identity.workspaceId]
      );
      if (!workspace.rows[0]) throw new StoreUnauthorizedError("Workspace is not available");

      const duplicate = await client.query<OperationRow>(
        `SELECT id, workspace_id, replica_id, project_id, event, server_sequence, created_at, payload_hash
           FROM operations
          WHERE workspace_id = $1
            AND (id = $2 OR event_id = $3 OR (replica_id = $4 AND client_sequence = $5))`,
        [identity.workspaceId, transaction.id, event.id, event.replicaId, event.clientSequence]
      );
      if (duplicate.rows[0]) {
        const stored = mapOperation(duplicate.rows[0]);
        if (
          stored.id === transaction.id && stored.eventId === event.id &&
          duplicate.rows[0].payload_hash === payloadHash &&
          stored.event.clientSequence === event.clientSequence &&
          stored.senderReplicaId === event.replicaId
        ) return stored;
        throw new StoreConflictError("Event or operation id was reused with different content");
      }

      const sequence = Number(workspace.rows[0].next_sequence) + 1;
      const storedEvent = { ...event, serverSequence: sequence };
      const inserted = await client.query<OperationRow>(
        // project_id is derived from the sending replica rather than sent by the client:
        // the replica already declared its repository at registration, and a client must
        // not be able to attribute its edits to an arbitrary project. NULL when the
        // replica registered before projects existed.
        //
        // `event` is the single home of this operation's content: its payload is the
        // transaction, whose changes[].afterContent are the file bodies. Nothing else
        // stores those bytes; mapOperation() reads the transaction back out of this
        // column, and operation_files below indexes into it by path.
        `INSERT INTO operations
          (id, workspace_id, event_id, client_sequence, server_sequence, replica_id, member_id,
           actor_id, payload_hash, event, project_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb,
                 (SELECT project_id FROM replicas WHERE id = $6 AND workspace_id = $2))
         RETURNING id, workspace_id, replica_id, project_id, event, server_sequence, created_at, payload_hash`,
        [
          transaction.id, identity.workspaceId, event.id, event.clientSequence, sequence, event.replicaId,
          identity.memberId, identity.actorId, payloadHash, JSON.stringify(storedEvent)
        ]
      );
      // A per-path index into the operation above, not a second copy of it: kind and the
      // two hashes are what a "who else touched this file" query needs, and the change
      // itself is reachable from (workspace_id, operation_id, path).
      for (const file of files) {
        await client.query(
          `INSERT INTO operation_files
            (workspace_id, operation_id, path, kind, before_hash, after_hash)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [identity.workspaceId, transaction.id, file.key, file.kind, file.beforeHash, file.afterHash]
        );
      }
      await client.query(
        "UPDATE workspaces SET next_sequence = $2 WHERE id = $1",
        [identity.workspaceId, sequence]
      );
      await this.audit(client, identity.workspaceId, identity.memberId, event.replicaId, "operation.received", {
        operationId: transaction.id, eventId: event.id, serverSequence: sequence
      });
      return mapOperation(inserted.rows[0]!);
    });
  }

  async getCursor(workspaceId: string): Promise<number> {
    const result = await this.pool.query<{ next_sequence: string }>(
      "SELECT next_sequence FROM workspaces WHERE id = $1",
      [workspaceId]
    );
    if (!result.rows[0]) throw new StoreUnauthorizedError("Workspace is not available");
    return Number(result.rows[0].next_sequence);
  }

  /**
   * Cursor-based reconnect, with retention made explicit.
   *
   * A replica resumes by asking for everything after its last-known server_sequence, so a
   * short answer and "you are caught up" are the same message on the wire. Once retention
   * deletes rows, that ambiguity becomes silent proposal loss: a replica whose cursor sits
   * below the deleted range would be handed whatever survives -- possibly nothing -- and
   * conclude it had seen everything.
   *
   * operations_pruned_through is what removes the ambiguity. Retention only ever deletes a
   * prefix of the sequence, so every sequence above the watermark is still present and any
   * cursor at or above it can be answered completely. A cursor below it is answered with
   * "cursor-too-old" instead, which callers must surface as a resync rather than a page.
   */
  async listOperations(workspaceId: string, cursor: number, limit: number): Promise<OperationPage> {
    const workspace = await this.pool.query<{ operations_pruned_through: string }>(
      "SELECT operations_pruned_through FROM workspaces WHERE id = $1",
      [workspaceId]
    );
    if (!workspace.rows[0]) throw new StoreUnauthorizedError("Workspace is not available");
    const prunedThrough = Number(workspace.rows[0].operations_pruned_through);
    if (cursor < prunedThrough) {
      return {
        status: "cursor-too-old",
        resyncFrom: prunedThrough,
        retentionDays: HISTORY_RETENTION_DAYS
      };
    }
    const result = await this.pool.query<OperationRow>(
      `SELECT id, workspace_id, replica_id, project_id, event, server_sequence, created_at
         FROM operations
        WHERE workspace_id = $1 AND server_sequence > $2
        ORDER BY server_sequence ASC
        LIMIT $3`,
      [workspaceId, cursor, limit + 1]
    );
    const items = result.rows.slice(0, limit).map(mapOperation);
    return { status: "ok", items, nextCursor: items.at(-1)?.serverSequence ?? cursor, hasMore: result.rows.length > limit };
  }

  async recordSessionStart(workspaceId: string, replicaId: string, cursor: number): Promise<void> {
    await this.pool.query(
      "INSERT INTO sessions (id, workspace_id, replica_id, summary) VALUES ($1, $2, $3, $4::jsonb)",
      [randomUUID(), workspaceId, replicaId, JSON.stringify({ cursor })]
    );
  }

  async recordSessionEnd(workspaceId: string, replicaId: string, cursor: number): Promise<void> {
    await this.pool.query(
      `UPDATE sessions SET ended_at = now(), summary = summary || $3::jsonb
        WHERE id = (
          SELECT id FROM sessions
           WHERE workspace_id = $1 AND replica_id = $2 AND ended_at IS NULL
           ORDER BY started_at DESC
           LIMIT 1
        )`,
      [workspaceId, replicaId, JSON.stringify({ cursor })]
    );
  }

  async listActiveSessions(workspaceId: string): Promise<Array<{ replicaId: string; actorId: string; startedAt: string }>> {
    const result = await this.pool.query<{ replica_id: string; actor_id: string; started_at: Date }>(
      `SELECT s.replica_id, m.actor_id, s.started_at
         FROM sessions s
         JOIN replicas r ON r.id = s.replica_id
         JOIN members m ON m.id = r.member_id
        WHERE s.workspace_id = $1 AND s.ended_at IS NULL
        ORDER BY s.started_at ASC`,
      [workspaceId]
    );
    return result.rows.map((row) => ({ replicaId: row.replica_id, actorId: row.actor_id, startedAt: new Date(row.started_at).toISOString() }));
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

  private async audit(
    client: PoolClient, workspaceId: string, memberId: string | null, replicaId: string | null,
    action: string, details: Record<string, unknown>
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_events (id, workspace_id, member_id, replica_id, action, details)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [randomUUID(), workspaceId, memberId, replicaId, action, JSON.stringify(details)]
    );
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

type OperationRow = {
  id: string;
  workspace_id: string;
  replica_id: string;
  project_id: string | null;
  /** The stored envelope; its payload is this operation's transaction. */
  event: TransactionCreatedEvent;
  server_sequence: string;
  created_at: Date;
  payload_hash?: string;
};

function mapOperation(row: OperationRow): StoredOperation {
  return {
    id: row.id,
    eventId: row.event.id,
    workspaceId: row.workspace_id,
    senderReplicaId: row.replica_id,
    projectId: row.project_id,
    event: row.event,
    // Read out of the envelope rather than from a column of its own. jsonb canonicalizes
    // a value the same way wherever it is stored, so this is byte-for-byte what the
    // dropped operations.transaction column returned -- see the byte-identity assertion
    // in store.integration.test.ts.
    transaction: row.event.payload as ChangeTransaction,
    serverSequence: Number(row.server_sequence),
    createdAt: new Date(row.created_at).toISOString()
  };
}

type ProjectRow = {
  id: string;
  workspace_id: string;
  name: string;
  repo_remote: string | null;
  repo_root: string | null;
  created_at: Date;
  last_activity_at: Date | null;
};

function mapProject(row: ProjectRow): Project {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    repoRemote: row.repo_remote,
    repoRoot: row.repo_root,
    createdAt: new Date(row.created_at).toISOString(),
    lastActivityAt: row.last_activity_at ? new Date(row.last_activity_at).toISOString() : null
  };
}

type InviteRow = {
  id: string;
  workspace_id: string;
  code: string;
  role: Invite["role"];
  created_by: string;
  expires_at: Date;
  redeemed_at: Date | null;
  redeemed_by: string | null;
  created_at: Date;
};

function mapInvite(row: InviteRow): Invite {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    code: row.code,
    role: row.role,
    createdBy: row.created_by,
    expiresAt: new Date(row.expires_at).toISOString(),
    redeemedAt: row.redeemed_at ? new Date(row.redeemed_at).toISOString() : null,
    redeemedBy: row.redeemed_by,
    createdAt: new Date(row.created_at).toISOString()
  };
}

// No ambiguous characters (0/O, 1/I) so a human can read a code back over voice/chat
// without transcription errors; 10 chars from a 32-symbol alphabet is ~50 bits of entropy.
const INVITE_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateInviteCode(): string {
  const bytes = randomBytes(10);
  let code = "";
  for (const byte of bytes) code += INVITE_CODE_ALPHABET[byte % INVITE_CODE_ALPHABET.length];
  return code;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

function isDeadlock(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "40P01";
}
