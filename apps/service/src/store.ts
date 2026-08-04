import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  Claim, ClaimCreatedEvent, ClaimReleasedEvent, CreateWorkspaceKeyGrantsRequest, DevicePublicKey, EventEnvelope, Handoff,
  HandoffRequestedEvent, HandoffRespondedEvent, Intent, IntentPublishedEvent, PairingStatus, Project, RemoteClaim,
  RemoteHandoff, RemoteIntent, RemoteOperation, RemoteTask, RemoteValidation, SealedTransactionCreatedEvent,
  SyncedTransaction, Task, TaskCreatedEvent, TaskUpdatedEvent, TransactionCreatedEvent, Validation,
  ValidationCompletedEvent, WorkspaceKeyGrant, WorkspaceKeyRecipient, WrappedKey
} from "@crosscode/protocol";
import { isSealedTransaction, PAIRING_CODE_ALPHABET, PAIRING_CODE_TTL_MS, WORKSPACE_TOKEN_PREFIX } from "@crosscode/protocol";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import {
  assertPlanAllowsAutonomyTier, assertSeatCapAvailable, assertSelfServeWorkspaceAvailable,
  clampAutonomyTierToPlan, entitlementForSubscription, maxAutonomyTierFor,
  AUTONOMY_TIER_NAMES, PAYMENT_GRACE_PERIOD_DAYS, PLAN_LIMITS,
  type BillingInterval, type PaidPlan, type Plan, type SubscriptionState
} from "./billing.js";
import { hashCanonicalPayload } from "./crypto.js";
import { normalizeRepoRemote, normalizeRepoRoot, projectNameFrom } from "./projects.js";

export class StoreConflictError extends Error {}
export class StoreUnauthorizedError extends Error {}
/**
 * A single-use credential that is gone: already claimed, expired, or never existed. All
 * three collapse into one error deliberately -- Contract A requires the claim endpoint
 * not to be an oracle that tells an attacker whether a guessed code was ever real.
 */
export class StoreGoneError extends Error {}

export type StoredOperation = RemoteOperation & {
  event: EventEnvelope;
};

/**
 * One page of the operation history, or a refusal to answer this cursor at all because
 * retention has deleted the rows it asks for. `resyncFrom` is the oldest cursor that can
 * still be served completely; `retentionDays` is the plan window that caused the deletion,
 * so the message a client shows can name it.
 */
export type OperationPage =
  | { status: "ok"; items: StoredOperation[]; nextCursor: number; hasMore: boolean }
  | { status: "cursor-too-old"; resyncFrom: number; retentionDays: number };

/** What one workspace's retention sweep did; `deleted: 0` means it was already inside its window. */
export type RetentionSweepResult = {
  workspaceId: string;
  plan: Plan;
  retentionDays: number;
  deleted: number;
  /** The watermark after the sweep: the highest server_sequence no longer present. */
  prunedThrough: number;
};

export type PresenceSummary = {
  replicaId: string;
  actorId: string;
  status: "online" | "offline";
  lastSeenAt: string | null;
  cursor: number | null;
  // Which project this replica is a checkout of (Contract B); null when it registered
  // before projects existed or reported no repository.
  projectId: string | null;
};

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

/**
 * A minted `ccw_` token, without the secret. Only the metadata a workspace owner needs
 * to recognise a device and decide whether to revoke it -- the plaintext exists once, in
 * the claim response, and only its hash is ever stored.
 */
export type WorkspaceTokenSummary = {
  id: string;
  workspaceId: string;
  replicaId: string | null;
  replicaName: string | null;
  actorId: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
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

export type PairingCodeMint = {
  pairingId: string;
  /** The only time the plaintext code exists server-side; only its hash is persisted. */
  code: string;
  expiresAt: string;
};

export type PairingCodeStatus = {
  status: PairingStatus;
  claimedAt: string | null;
  replicaId: string | null;
  actorId: string | null;
  /** The claiming device's X25519 public key, relayed so the minter can wrap the keyring to it. */
  devicePublicKey: DevicePublicKey | null;
};

export type PairingClaimResult = {
  workspaceId: string;
  replicaId: string;
  /** Plaintext `ccw_` workspace token; likewise only ever persisted as a hash. */
  token: string;
  pairingId: string;
};

/**
 * What a `ccw_` workspace token resolves to. It borrows the membership of whoever minted
 * the pairing code it came from, so downstream authorization (role checks, replica
 * ownership) is the same code path a Supabase-authenticated request takes.
 */
export type WorkspaceTokenIdentity = Membership & { replicaId: string | null };

const DEFAULT_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

/**
 * The plan a workspace is entitled to *right now*, as a SQL expression over the workspaces
 * row. It is the stored plan, except that a dunning grace period which has run out drops it
 * to free without waiting for the sweep in billing-sweep.ts to write that down.
 *
 * Every enforcement path reads through this rather than `plan` directly, so an unswept row
 * cannot buy a workspace extra seats, extra autonomy, or a longer retention promise.
 */
const EFFECTIVE_PLAN_SQL =
  "CASE WHEN grace_period_ends_at IS NOT NULL AND grace_period_ends_at <= now() THEN 'free' ELSE plan END";

/** Everything about a workspace's subscription, with the effective plan already applied. */
export type WorkspaceBillingRecord = {
  workspaceId: string;
  /** Effective plan -- what limits apply. See EFFECTIVE_PLAN_SQL. */
  plan: Plan;
  /** The plan being paid for; differs from `plan` only while a payment is failing. */
  billingPlan: PaidPlan | null;
  billingInterval: BillingInterval | null;
  billingStatus: string | null;
  billingSeats: number | null;
  gracePeriodEndsAt: string | null;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  billingOwnerMemberId: string | null;
  billingOwnerActorId: string | null;
};

type BillingRow = {
  billing_owner_actor_id?: string | null;
  plan: Plan;
  billing_plan: PaidPlan | null;
  billing_interval: BillingInterval | null;
  billing_status: string | null;
  billing_seats: number | null;
  grace_period_ends_at: Date | null;
  subscription_cancel_at_period_end: boolean;
  subscription_current_period_end: Date | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  billing_owner_member_id: string | null;
};

// Unqualified column names throughout, so the same list works in a SELECT over `workspaces
// w` and in an UPDATE ... RETURNING, where it reads the post-update row.
const BILLING_COLUMNS = `${EFFECTIVE_PLAN_SQL} AS plan, billing_plan, billing_interval, billing_status,
        billing_seats, grace_period_ends_at, subscription_cancel_at_period_end,
        subscription_current_period_end, stripe_customer_id, stripe_subscription_id,
        billing_owner_member_id`;

function mapBilling(workspaceId: string, row: BillingRow): WorkspaceBillingRecord {
  return {
    workspaceId,
    plan: row.plan,
    billingPlan: row.billing_plan,
    billingInterval: row.billing_interval,
    billingStatus: row.billing_status,
    billingSeats: row.billing_seats,
    gracePeriodEndsAt: row.grace_period_ends_at ? new Date(row.grace_period_ends_at).toISOString() : null,
    cancelAtPeriodEnd: row.subscription_cancel_at_period_end,
    currentPeriodEnd: row.subscription_current_period_end ? new Date(row.subscription_current_period_end).toISOString() : null,
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    billingOwnerMemberId: row.billing_owner_member_id,
    // Only the SELECT path joins members for the display name; the UPDATE ... RETURNING
    // path does not, and its caller (applySubscriptionState) has no use for it.
    billingOwnerActorId: row.billing_owner_actor_id ?? null
  };
}

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
      assertSelfServeWorkspaceAvailable(Number(owned.rows[0]!.count));
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
      const workspace = await client.query<{ plan: Plan }>(`SELECT ${EFFECTIVE_PLAN_SQL} AS plan FROM workspaces WHERE id = $1 FOR UPDATE`, [input.workspaceId]);
      if (!workspace.rows[0]) throw new StoreUnauthorizedError("Workspace is not available");
      await assertSeatAvailable(client, input.workspaceId, workspace.rows[0].plan);
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
      // The seat cap is checked at the moment a seat is actually taken, not when the
      // invite was minted: an owner can hand out more invites than seats, and the plan
      // can change in between. FOR UPDATE on the workspace serialises concurrent
      // redemptions so two invites cannot both slip past the last free seat.
      //
      // This is also where "a downgrade below the current seat count keeps existing
      // members and refuses new ones" is enforced: nothing here inspects or touches the
      // members already in the workspace, it only refuses to add another one.
      const workspace = await client.query<{ plan: Plan }>(`SELECT ${EFFECTIVE_PLAN_SQL} AS plan FROM workspaces WHERE id = $1 FOR UPDATE`, [invite.workspace_id]);
      if (!workspace.rows[0]) throw new StoreUnauthorizedError("Workspace is not available");
      await assertSeatAvailable(client, invite.workspace_id, workspace.rows[0].plan);
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

  async createPairingCode(identity: Membership): Promise<PairingCodeMint> {
    const pairingId = randomUUID();
    const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS);
    const code = generatePairingCode();
    return this.transaction(async (client) => {
      await client.query(
        `INSERT INTO pairing_codes (id, workspace_id, code_hash, created_by, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [pairingId, identity.workspaceId, sha256(code), identity.memberId, expiresAt]
      );
      await this.audit(client, identity.workspaceId, identity.memberId, null, "pairing.code_created", { pairingId });
      return { pairingId, code, expiresAt: expiresAt.toISOString() };
    });
  }

  async getPairingCodeStatus(identity: Membership, pairingId: string): Promise<PairingCodeStatus | undefined> {
    const result = await this.pool.query<{ expires_at: Date; claimed_at: Date | null; claimed_replica_id: string | null; claimed_actor_id: string | null; device_public_key: string | null }>(
      `SELECT p.expires_at, p.claimed_at, p.claimed_replica_id, p.claimed_actor_id, r.device_public_key
         FROM pairing_codes p
         LEFT JOIN replicas r ON r.id = p.claimed_replica_id
        WHERE p.id = $1 AND p.workspace_id = $2`,
      [pairingId, identity.workspaceId]
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      status: row.claimed_at ? "claimed" : row.expires_at.getTime() <= Date.now() ? "expired" : "pending",
      claimedAt: row.claimed_at ? new Date(row.claimed_at).toISOString() : null,
      replicaId: row.claimed_replica_id,
      actorId: row.claimed_actor_id,
      devicePublicKey: row.device_public_key as DevicePublicKey | null
    };
  }

  /**
   * Redeems a pairing code, unauthenticated: the code is the credential. Single-use is
   * enforced by the conditional UPDATE below -- zero rows back means already-claimed,
   * expired, or never existed, and the caller cannot tell which (StoreGoneError -> 410).
   * Everything after it runs in the same transaction, so a failure anywhere (a replica
   * name that cannot be made unique, say) releases the code rather than burning it.
   */
  async claimPairingCode(input: { code: string; actorId: string; replicaName: string; devicePublicKey?: DevicePublicKey }): Promise<PairingClaimResult> {
    return this.transaction(async (client) => {
      const claimed = await client.query<{ id: string; workspace_id: string; created_by: string }>(
        `UPDATE pairing_codes SET claimed_at = now(), claimed_actor_id = $2
          WHERE code_hash = $1 AND claimed_at IS NULL AND expires_at > now()
          RETURNING id, workspace_id, created_by`,
        [sha256(input.code), input.actorId]
      );
      const pairing = claimed.rows[0];
      if (!pairing) throw new StoreGoneError("Pairing code is no longer available");

      const replicaId = randomUUID();
      let registered = false;
      // replicas are UNIQUE (workspace_id, name); a second machine called "laptop" must
      // still be able to pair, so fall back to a disambiguated name rather than failing.
      for (const name of [input.replicaName, `${input.replicaName}-${randomBytes(3).toString("hex")}`]) {
        // A failed statement poisons the surrounding transaction, so each attempt runs
        // inside a savepoint the unique violation can be rolled back to.
        await client.query("SAVEPOINT crosscode_replica_insert");
        try {
          await client.query("INSERT INTO replicas (id, workspace_id, member_id, name, device_public_key) VALUES ($1, $2, $3, $4, $5)", [
            replicaId, pairing.workspace_id, pairing.created_by, name, input.devicePublicKey ?? null
          ]);
          await client.query("RELEASE SAVEPOINT crosscode_replica_insert");
          registered = true;
          break;
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          await client.query("ROLLBACK TO SAVEPOINT crosscode_replica_insert");
        }
      }
      if (!registered) throw new StoreConflictError("Replica name is already registered");

      await client.query("UPDATE pairing_codes SET claimed_replica_id = $2 WHERE id = $1", [pairing.id, replicaId]);

      const token = generateWorkspaceToken();
      await client.query(
        `INSERT INTO workspace_tokens (id, workspace_id, member_id, replica_id, token_hash, pairing_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [randomUUID(), pairing.workspace_id, pairing.created_by, replicaId, sha256(token), pairing.id]
      );
      await this.audit(client, pairing.workspace_id, pairing.created_by, replicaId, "pairing.code_claimed", { pairingId: pairing.id });
      return { workspaceId: pairing.workspace_id, replicaId, token, pairingId: pairing.id };
    });
  }

  /**
   * Resolves a `ccw_` workspace token to the membership it was minted against. Lookup is
   * by hash, so a stolen database dump does not yield usable tokens.
   */
  async resolveWorkspaceToken(token: string): Promise<WorkspaceTokenIdentity> {
    const result = await this.pool.query<{ member_id: string; user_id: string; actor_id: string; role: Membership["role"]; workspace_id: string; replica_id: string | null }>(
      `UPDATE workspace_tokens t SET last_used_at = now()
         FROM members m
        WHERE t.token_hash = $1 AND t.revoked_at IS NULL
          AND m.id = t.member_id AND m.disabled_at IS NULL
        RETURNING m.id AS member_id, m.user_id, m.actor_id, m.role, t.workspace_id, t.replica_id`,
      [sha256(token)]
    );
    const row = result.rows[0];
    if (!row) throw new StoreUnauthorizedError("Workspace token is invalid or revoked");
    return {
      memberId: row.member_id, userId: row.user_id, actorId: row.actor_id,
      workspaceId: row.workspace_id, role: row.role, replicaId: row.replica_id
    };
  }

  /**
   * Every `ccw_` token minted for this workspace, secret excluded. Owner-gated at the
   * route, and re-gated here so a new call site cannot hand a member the device list.
   */
  async listWorkspaceTokens(identity: Membership): Promise<WorkspaceTokenSummary[]> {
    if (identity.role !== "owner") throw new StoreUnauthorizedError("Only workspace owners can list workspace tokens");
    const result = await this.pool.query<{
      id: string; workspace_id: string; replica_id: string | null; replica_name: string | null;
      actor_id: string; last_used_at: Date | null; revoked_at: Date | null; created_at: Date;
    }>(
      `SELECT t.id, t.workspace_id, t.replica_id, r.name AS replica_name, m.actor_id,
              t.last_used_at, t.revoked_at, t.created_at
         FROM workspace_tokens t
         JOIN members m ON m.id = t.member_id
         LEFT JOIN replicas r ON r.id = t.replica_id
        WHERE t.workspace_id = $1
        ORDER BY t.created_at DESC`,
      [identity.workspaceId]
    );
    return result.rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      replicaId: row.replica_id,
      replicaName: row.replica_name,
      actorId: row.actor_id,
      lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
      revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
      createdAt: new Date(row.created_at).toISOString()
    }));
  }

  /**
   * Revokes a paired device's `ccw_` token. resolveWorkspaceToken() already refuses a
   * token with revoked_at set, so this takes effect on the very next request -- there is
   * no cached session to wait out, which is the whole reason the tokens are opaque and
   * resolved against the database on every call rather than being self-describing.
   */
  async revokeWorkspaceToken(identity: Membership, tokenId: string): Promise<WorkspaceTokenSummary> {
    if (identity.role !== "owner") throw new StoreUnauthorizedError("Only workspace owners can revoke workspace tokens");
    return this.transaction(async (client) => {
      const result = await client.query<{ id: string; replica_id: string | null; member_id: string; last_used_at: Date | null; revoked_at: Date; created_at: Date }>(
        `UPDATE workspace_tokens SET revoked_at = now()
          WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL
          RETURNING id, replica_id, member_id, last_used_at, revoked_at, created_at`,
        [tokenId, identity.workspaceId]
      );
      const row = result.rows[0];
      if (!row) throw new StoreConflictError("Workspace token is not available to revoke");
      // Retiring the replica too, so a revoked device stops appearing as a live
      // participant: assertReplicaOwnership already refuses a disabled replica, which
      // closes the ingest path even for a credential that somehow survives.
      if (row.replica_id) {
        await client.query("UPDATE replicas SET disabled_at = now() WHERE id = $1 AND workspace_id = $2", [row.replica_id, identity.workspaceId]);
      }
      const actor = await client.query<{ actor_id: string; name: string | null }>(
        `SELECT m.actor_id, r.name FROM members m LEFT JOIN replicas r ON r.id = $2 WHERE m.id = $1`,
        [row.member_id, row.replica_id]
      );
      await this.audit(client, identity.workspaceId, identity.memberId, row.replica_id, "workspace_token.revoked", { tokenId });
      return {
        id: row.id,
        workspaceId: identity.workspaceId,
        replicaId: row.replica_id,
        replicaName: actor.rows[0]?.name ?? null,
        actorId: actor.rows[0]?.actor_id ?? "",
        lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
        revokedAt: new Date(row.revoked_at).toISOString(),
        createdAt: new Date(row.created_at).toISOString()
      };
    });
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
   * Removes a member's access. Sets disabled_at rather than deleting the row: operations,
   * validations, and audit events reference members, and history must stay attributable
   * after someone leaves. Every authorization path already filters on
   * `disabled_at IS NULL`, so this takes effect on the member's next request -- including
   * for any `ccw_` token minted from their pairing codes, which resolveWorkspaceToken
   * joins through the same member row.
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
      // Their devices go with them: the replicas stop being able to ingest and the
      // tokens stop resolving, without waiting for anything to expire.
      await client.query("UPDATE replicas SET disabled_at = now() WHERE member_id = $1 AND disabled_at IS NULL", [memberId]);
      await client.query("UPDATE workspace_tokens SET revoked_at = now() WHERE member_id = $1 AND revoked_at IS NULL", [memberId]);
      // The subscription belongs to the workspace, not to whoever happened to start it, so
      // the payer leaving reassigns a label and cancels nothing. The remaining owner check
      // above guarantees there is somebody to reassign to; the longest-tenured one is
      // picked so the choice is stable rather than arbitrary.
      const reassigned = await client.query<{ billing_owner_member_id: string | null }>(
        `UPDATE workspaces SET billing_owner_member_id = (
             SELECT id FROM members
              WHERE workspace_id = $1 AND role = 'owner' AND disabled_at IS NULL AND id <> $2
              ORDER BY created_at ASC LIMIT 1
           )
          WHERE id = $1 AND billing_owner_member_id = $2
          RETURNING billing_owner_member_id`,
        [identity.workspaceId, memberId]
      );
      if (reassigned.rows[0]) {
        await this.audit(client, identity.workspaceId, identity.memberId, null, "billing.owner_reassigned", {
          from: memberId, to: reassigned.rows[0].billing_owner_member_id
        });
      }
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

  /** Active (non-disabled) member count, for the plan seat cap. */
  async countActiveMembers(workspaceId: string): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      "SELECT count(*) FROM members WHERE workspace_id = $1 AND disabled_at IS NULL",
      [workspaceId]
    );
    return Number(result.rows[0]!.count);
  }

  async getWorkspaceBilling(workspaceId: string): Promise<WorkspaceBillingRecord> {
    const result = await this.pool.query<BillingRow>(
      `SELECT ${BILLING_COLUMNS}, (SELECT actor_id FROM members WHERE id = w.billing_owner_member_id) AS billing_owner_actor_id
         FROM workspaces w WHERE w.id = $1`,
      [workspaceId]
    );
    if (!result.rows[0]) throw new StoreUnauthorizedError("Workspace is not available");
    return mapBilling(workspaceId, result.rows[0]);
  }

  /**
   * Records the Stripe customer a workspace's cards live on, and who is paying. Both are
   * written before checkout rather than after, so a customer created for a checkout that
   * was then abandoned is still found and reused next time instead of being orphaned.
   */
  async linkStripeCustomer(workspaceId: string, customerId: string, billingOwnerMemberId: string): Promise<void> {
    await this.pool.query(
      `UPDATE workspaces
          SET stripe_customer_id = COALESCE(stripe_customer_id, $2),
              billing_owner_member_id = COALESCE(billing_owner_member_id, $3)
        WHERE id = $1`,
      [workspaceId, customerId, billingOwnerMemberId]
    );
  }

  /** The workspace a webhook is about, resolved from Stripe's own ids. */
  async findWorkspaceForBilling(input: { subscriptionId?: string | null; customerId?: string | null }): Promise<string | null> {
    if (!input.subscriptionId && !input.customerId) return null;
    const result = await this.pool.query<{ id: string }>(
      `SELECT id FROM workspaces
        WHERE ($1::text IS NOT NULL AND stripe_subscription_id = $1)
           OR ($2::text IS NOT NULL AND stripe_customer_id = $2)
        ORDER BY (stripe_subscription_id = $1) DESC NULLS LAST
        LIMIT 1`,
      [input.subscriptionId ?? null, input.customerId ?? null]
    );
    return result.rows[0]?.id ?? null;
  }

  /**
   * Applies a subscription's authoritative state to a workspace. This is the single write
   * path for `plan`, and every lifecycle decision that has a database consequence lands
   * here:
   *
   * - Payment failure opens a grace period (COALESCE, so redelivered or repeated failure
   *   events extend nothing -- the deadline is set once, by the first failure).
   * - A successful payment clears it.
   * - Losing auto-always clamps autonomy_tier down instead of leaving a tier the plan no
   *   longer unlocks, and never below auto-if-clean.
   * - Nothing is deleted, disabled, or counted: members, operations, replicas and tokens
   *   are not touched by a plan change in either direction.
   *
   * It is a pure function of the state passed in, which is what makes replayed and
   * out-of-order webhooks safe: applying an old event re-reads current state from Stripe
   * first, so the write it produces is the same one the newest event would produce.
   */
  async applySubscriptionState(input: {
    workspaceId: string;
    state: SubscriptionState;
    graceDays?: number;
  }): Promise<WorkspaceBillingRecord> {
    const entitlement = entitlementForSubscription(input.state);
    return this.transaction(async (client) => {
      const previousRow = await client.query<BillingRow>(
        `SELECT ${BILLING_COLUMNS} FROM workspaces WHERE id = $1 FOR UPDATE`,
        [input.workspaceId]
      );
      if (!previousRow.rows[0]) throw new StoreUnauthorizedError("Workspace is not available");
      const previous = mapBilling(input.workspaceId, previousRow.rows[0]);
      // A workspace that cancelled and then bought again has two subscriptions in Stripe's
      // history, and the dead one keeps emitting for a while (a final invoice, a deletion).
      // Those events must not write, or a delayed one lands after the new checkout and
      // takes the plan the user just paid for straight back off them. A non-current
      // subscription may only be applied when the current one is itself finished
      // (billingPlan null), which is exactly the case where it is the new one arriving.
      if (
        previous.stripeSubscriptionId !== null &&
        previous.stripeSubscriptionId !== input.state.subscriptionId &&
        previous.billingPlan !== null
      ) return previous;
      const updated = await client.query<BillingRow>(
        `UPDATE workspaces w SET
            plan = $2,
            billing_plan = $3,
            billing_interval = $4,
            billing_status = $5,
            billing_seats = $6,
            stripe_customer_id = COALESCE($7, w.stripe_customer_id),
            stripe_subscription_id = $8,
            subscription_cancel_at_period_end = $9,
            subscription_current_period_end = $10,
            grace_period_ends_at = CASE WHEN $11::boolean
              THEN COALESCE(w.grace_period_ends_at, now() + ($12 || ' days')::interval)
              ELSE NULL END,
            autonomy_tier = LEAST(w.autonomy_tier, $13::integer)
          WHERE w.id = $1
          RETURNING ${BILLING_COLUMNS}`,
        [
          input.workspaceId,
          entitlement.plan,
          // Keep naming the plan being paid for through a grace period; drop it only once
          // the subscription is terminal, where there is nothing left being paid for.
          entitlement.plan === "free" && !entitlement.inGrace ? null : input.state.plan,
          input.state.interval,
          input.state.status,
          input.state.seats,
          input.state.customerId,
          input.state.subscriptionId,
          input.state.cancelAtPeriodEnd,
          input.state.currentPeriodEnd,
          entitlement.inGrace,
          input.graceDays ?? PAYMENT_GRACE_PERIOD_DAYS,
          maxAutonomyTierFor(entitlement.plan)
        ]
      );
      await this.audit(client, input.workspaceId, null, null, "billing.plan_applied", {
        from: previous.plan, to: entitlement.plan,
        status: input.state.status, subscriptionId: input.state.subscriptionId, inGrace: entitlement.inGrace
      });
      return mapBilling(input.workspaceId, updated.rows[0]!);
    });
  }

  /** Mirrors a seat-quantity change Stripe has already accepted (Team's per-seat price). */
  async recordSeatQuantity(workspaceId: string, seats: number): Promise<void> {
    await this.pool.query("UPDATE workspaces SET billing_seats = $2 WHERE id = $1", [workspaceId, seats]);
  }

  /**
   * Claims a Stripe webhook event id. Returns false when the event has already been
   * processed to completion, which is what makes redelivery a no-op.
   *
   * An event that was claimed but never completed (the handler crashed, or Stripe timed us
   * out mid-flight) is deliberately allowed through again: the handler is idempotent, and
   * silently swallowing a half-applied delivery would be the worse failure.
   */
  async claimBillingEvent(eventId: string, type: string): Promise<boolean> {
    const inserted = await this.pool.query(
      "INSERT INTO billing_events (id, type) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING RETURNING id",
      [eventId, type]
    );
    if (inserted.rows[0]) return true;
    const existing = await this.pool.query<{ processed_at: Date | null }>(
      "SELECT processed_at FROM billing_events WHERE id = $1",
      [eventId]
    );
    return existing.rows[0]?.processed_at === null;
  }

  async completeBillingEvent(eventId: string, workspaceId: string | null): Promise<void> {
    await this.pool.query(
      "UPDATE billing_events SET processed_at = now(), workspace_id = $2 WHERE id = $1",
      [eventId, workspaceId]
    );
  }

  /**
   * Drops workspaces whose payment grace period has run out to free's limits, durably.
   * Nothing is deleted: members stay, history stays, and the autonomy tier is clamped to
   * what free unlocks rather than reset. Reads already apply this via EFFECTIVE_PLAN_SQL,
   * so the sweep is about writing the state down (and auditing it), not about enforcement.
   */
  async expireBillingGracePeriods(): Promise<number> {
    return this.transaction(async (client) => {
      const expired = await client.query<{ id: string; billing_plan: string | null }>(
        `UPDATE workspaces SET plan = 'free', autonomy_tier = LEAST(autonomy_tier, $1::integer)
          WHERE grace_period_ends_at IS NOT NULL AND grace_period_ends_at <= now() AND plan <> 'free'
          RETURNING id, billing_plan`,
        [maxAutonomyTierFor("free")]
      );
      for (const row of expired.rows) {
        await this.audit(client, row.id, null, null, "billing.grace_period_expired", { previousPlan: row.billing_plan });
      }
      return expired.rows.length;
    });
  }

  async getWorkspacePlan(workspaceId: string): Promise<string> {
    const result = await this.pool.query<{ plan: string }>(`SELECT ${EFFECTIVE_PLAN_SQL} AS plan FROM workspaces WHERE id = $1`, [workspaceId]);
    if (!result.rows[0]) throw new StoreUnauthorizedError("Workspace is not available");
    return result.rows[0].plan;
  }

  /**
   * Idempotent upsert of a project (Contract B), keyed by the normalized git remote when
   * the checkout has one and by the absolute repo root otherwise. Returns null when the
   * caller reported neither usable key, so every call site can safely do
   * `(await store.upsertProject(...))?.id ?? null`.
   *
   * Safe to call on every registration/claim/pairing: repeat calls only bump
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

  /**
   * Upserts the project for a reported checkout and links an already-registered replica to
   * it, returning the project id (null when the caller reported no usable key).
   *
   * This is the single call the pairing claim handler needs to populate Contract A's
   * `projectId` -- it registers its replica first, then attributes it here -- so the
   * projects logic stays entirely on this side of the ownership seam.
   */
  async attachReplicaToProject(
    workspaceId: string, replicaId: string,
    repo: { repoRoot?: string | null; repoRemote?: string | null }
  ): Promise<string | null> {
    const project = await this.upsertProject(workspaceId, repo);
    if (!project) return null;
    await this.pool.query(
      "UPDATE replicas SET project_id = $3 WHERE id = $1 AND workspace_id = $2",
      [replicaId, workspaceId, project.id]
    );
    return project.id;
  }

  async registerReplica(
    userId: string, workspaceId: string, name: string,
    repo: { repoRoot?: string | null; repoRemote?: string | null; devicePublicKey?: DevicePublicKey } = {}
  ): Promise<{ replicaId: string; createdAt: string; projectId: string | null }> {
    const membership = await this.resolveMembership(userId, workspaceId);
    const project = await this.upsertProject(workspaceId, repo);
    const replicaId = randomUUID();
    try {
      const result = await this.pool.query<{ created_at: Date }>(
        `INSERT INTO replicas (id, workspace_id, member_id, name, project_id, device_public_key) VALUES ($1, $2, $3, $4, $5, $6) RETURNING created_at`,
        [replicaId, workspaceId, membership.memberId, name, project?.id ?? null, repo.devicePublicKey ?? null]
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

  async appendOperation(identity: Membership, event: TransactionCreatedEvent | SealedTransactionCreatedEvent): Promise<StoredOperation> {
    const transaction = event.payload;
    // A sealed operation exposes one opaque token per changed file instead of a path (see
    // sealedFileSchema). Everything below treats that token exactly as it treated a path:
    // it is the per-file key in operation_files, and it is what "each path only once"
    // ranges over. The service does not know, and no longer needs to know, which file it is.
    const files = isSealedTransaction(transaction)
      ? transaction.changes.map((change) => ({ key: change.pathToken, kind: change.kind, beforeHash: null, afterHash: null }))
      : transaction.changes.map((change) => ({ key: change.path, kind: change.kind, beforeHash: change.beforeHash ?? null, afterHash: change.afterHash ?? null }));
    const sealed = isSealedTransaction(transaction);
    if (new Set(files.map((file) => file.key)).size !== files.length) {
      throw new StoreConflictError("An operation may change each path only once");
    }
    const payloadHash = hashCanonicalPayload(event);
    return this.transaction(async (client) => {
      const workspace = await client.query<{ next_sequence: string; plan: Plan; encryption_latched_at: Date | null }>(
        `SELECT next_sequence, encryption_latched_at, ${EFFECTIVE_PLAN_SQL} AS plan FROM workspaces WHERE id = $1 FOR UPDATE`,
        [identity.workspaceId]
      );
      if (!workspace.rows[0]) throw new StoreUnauthorizedError("Workspace is not available");
      // The anti-downgrade latch. Whether a client encrypts is decided entirely by whether
      // it holds a workspace key, so this does not cause encryption -- it prevents a
      // workspace that has started sending ciphertext from silently going back, whether
      // because a client was rolled back, misconfigured, or told to by a compromised
      // service. There is deliberately no way to unlatch: doing so would be a supported
      // path for making previously-unreadable data readable to us.
      if (!sealed && workspace.rows[0].encryption_latched_at) {
        throw new StoreConflictError("This workspace is end-to-end encrypted; plaintext operations are refused");
      }

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
        // transaction, whose changes[].afterContent are the file bodies -- or, for an
        // encrypted workspace, the sealed envelope those bodies are inside. Nothing else
        // stores those bytes; mapOperation() reads the transaction back out of this
        // column, and operation_files below indexes into it by path (or, when sealed, by
        // the opaque per-operation token that stands in for one).
        //
        // retention_days is stamped from the plan in effect *now*, which is what makes a
        // later downgrade unable to delete this row early: retention is a promise made when
        // the row is written, not a property of whatever plan the workspace is on when the
        // sweep eventually runs (BUILD_INSTRUCTIONS.md Phase 10).
        `INSERT INTO operations
          (id, workspace_id, event_id, client_sequence, server_sequence, replica_id, member_id,
           actor_id, payload_hash, event, project_id, retention_days, sealed, key_epoch)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb,
                 (SELECT project_id FROM replicas WHERE id = $6 AND workspace_id = $2), $11, $12, $13)
         RETURNING id, workspace_id, replica_id, project_id, event, server_sequence, created_at, payload_hash`,
        [
          transaction.id, identity.workspaceId, event.id, event.clientSequence, sequence, event.replicaId,
          identity.memberId, identity.actorId, payloadHash, JSON.stringify(storedEvent),
          PLAN_LIMITS[workspace.rows[0].plan].historyRetentionDays,
          sealed, isSealedTransaction(transaction) ? transaction.sealed.epoch : null
        ]
      );
      // A per-path index into the operation above, not a second copy of it: kind and the
      // two hashes are what a "who else touched this file" query needs, and the change
      // itself is reachable from (workspace_id, operation_id, path). For a sealed
      // operation the hashes are absent and `path` holds the opaque token instead -- the
      // index keeps its shape, and stops being an index anyone here can read.
      for (const file of files) {
        await client.query(
          `INSERT INTO operation_files
            (workspace_id, operation_id, path, kind, before_hash, after_hash)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [identity.workspaceId, transaction.id, file.key, file.kind, file.beforeHash, file.afterHash]
        );
      }
      await client.query(
        `UPDATE workspaces SET next_sequence = $2,
                encryption_latched_at = CASE WHEN $3 AND encryption_latched_at IS NULL THEN now() ELSE encryption_latched_at END
          WHERE id = $1`,
        [identity.workspaceId, sequence, sealed]
      );
      await this.audit(client, identity.workspaceId, identity.memberId, event.replicaId, "operation.received", {
        operationId: transaction.id, eventId: event.id, serverSequence: sequence
      });
      return mapOperation(inserted.rows[0]!);
    });
  }

  // -------------------------------------------------------------------------
  // Workspace key distribution (docs/security.md#end-to-end-encryption)
  //
  // Everything below relays ciphertext between devices. The service picks no keys,
  // holds no private key, and can open none of what it stores here -- its only jobs
  // are to say who is eligible to receive a grant, and to keep a grant addressed to
  // the public key the recipient actually registered.
  // -------------------------------------------------------------------------

  /**
   * Records a device's X25519 public key. Write-once: a replica that already has one on
   * file cannot swap it, because a swap would silently redirect every future grant --
   * including the ones a rotation issues automatically -- to a key of the caller's
   * choosing. Re-sending the same key is a no-op so a restarting daemon can be naive.
   */
  async registerDevicePublicKey(workspaceId: string, replicaId: string, publicKey: DevicePublicKey): Promise<void> {
    const result = await this.pool.query(
      `UPDATE replicas SET device_public_key = $3
        WHERE id = $1 AND workspace_id = $2 AND (device_public_key IS NULL OR device_public_key = $3)
        RETURNING id`,
      [replicaId, workspaceId, publicKey]
    );
    if (result.rows[0]) return;
    const existing = await this.pool.query<{ id: string }>("SELECT id FROM replicas WHERE id = $1 AND workspace_id = $2", [replicaId, workspaceId]);
    if (!existing.rows[0]) throw new StoreUnauthorizedError("Replica is not registered in this workspace");
    throw new StoreConflictError("This device already registered a different encryption key");
  }

  /**
   * What a device needs to decide whether it may mint the workspace's first key, plus
   * every epoch already wrapped to it. `keyHolders` counts *active* replicas holding at
   * least one grant; a removed member's disabled replicas drop out of it, which is what
   * makes a post-removal rotation stop granting them anything.
   */
  async getWorkspaceKeyState(workspaceId: string, replicaId: string): Promise<{ encrypted: boolean; keyHolders: number; grants: WorkspaceKeyGrant[] }> {
    const [workspace, holders, grants] = await Promise.all([
      this.pool.query<{ encryption_latched_at: Date | null }>("SELECT encryption_latched_at FROM workspaces WHERE id = $1", [workspaceId]),
      this.pool.query<{ count: string }>(
        `SELECT count(DISTINCT g.recipient_replica_id)
           FROM workspace_key_grants g
           JOIN replicas r ON r.id = g.recipient_replica_id
          WHERE g.workspace_id = $1 AND r.disabled_at IS NULL`,
        [workspaceId]
      ),
      this.pool.query<KeyGrantRow>(
        `SELECT epoch, key_id, recipient_replica_id, wrapped, created_at
           FROM workspace_key_grants
          WHERE workspace_id = $1 AND recipient_replica_id = $2
          ORDER BY epoch ASC`,
        [workspaceId, replicaId]
      )
    ]);
    if (!workspace.rows[0]) throw new StoreUnauthorizedError("Workspace is not available");
    return {
      encrypted: workspace.rows[0].encryption_latched_at !== null,
      keyHolders: Number(holders.rows[0]!.count),
      grants: grants.rows.map(mapKeyGrant)
    };
  }

  /**
   * Every active device with a registered key, and which epochs it already holds. A
   * recipient with a non-empty `epochs` was approved by a human once (grants are only
   * ever issued after the pairing fingerprint check), which is what lets a rotating
   * device re-grant to it without asking again -- and why a recipient with no epochs is
   * never auto-granted anything.
   */
  async listWorkspaceKeyRecipients(workspaceId: string): Promise<WorkspaceKeyRecipient[]> {
    const result = await this.pool.query<{ id: string; name: string; actor_id: string; device_public_key: string; epochs: number[] | null }>(
      `SELECT r.id, r.name, m.actor_id, r.device_public_key,
              array_remove(array_agg(g.epoch ORDER BY g.epoch), NULL) AS epochs
         FROM replicas r
         JOIN members m ON m.id = r.member_id
         LEFT JOIN workspace_key_grants g ON g.workspace_id = r.workspace_id AND g.recipient_replica_id = r.id
        WHERE r.workspace_id = $1 AND r.disabled_at IS NULL AND m.disabled_at IS NULL AND r.device_public_key IS NOT NULL
        GROUP BY r.id, r.name, m.actor_id, r.device_public_key
        ORDER BY r.name`,
      [workspaceId]
    );
    return result.rows.map((row) => ({
      replicaId: row.id, replicaName: row.name, actorId: row.actor_id,
      publicKey: row.device_public_key as DevicePublicKey, epochs: row.epochs ?? []
    }));
  }

  /**
   * Stores wrapped epoch keys. The recipient's public key is checked against the one on
   * file rather than trusted from the request, so a grant can never be filed against a
   * key the recipient did not register -- otherwise a caller could park a grant wrapped
   * to itself and wait for the recipient's key to be "corrected" later.
   *
   * Re-issuing an epoch a device already holds is ignored rather than rejected: the
   * daemon's sweep re-offers every epoch it holds on every sync, and making that a
   * conflict would turn ordinary operation into a stream of errors.
   */
  async insertWorkspaceKeyGrants(
    identity: Membership,
    senderReplicaId: string | null,
    grants: CreateWorkspaceKeyGrantsRequest["grants"],
    options: { requireFirst?: boolean } = {}
  ): Promise<{ stored: number }> {
    if (identity.role === "viewer") throw new StoreUnauthorizedError("Viewer membership cannot grant workspace keys");
    return this.transaction(async (client) => {
      // `requireFirst` is how a device claims the right to mint the workspace's very
      // first key. Two devices starting against a brand-new workspace at the same instant
      // would otherwise each mint an epoch 0, and the two would be different keys under
      // the same number -- a fork neither side could reconcile. Serializing on the
      // workspace row turns that into one winner and one caller that learns to wait.
      if (options.requireFirst) {
        await client.query("SELECT id FROM workspaces WHERE id = $1 FOR UPDATE", [identity.workspaceId]);
        const existing = await client.query("SELECT 1 FROM workspace_key_grants WHERE workspace_id = $1 LIMIT 1", [identity.workspaceId]);
        if (existing.rows[0]) throw new StoreConflictError("This workspace already has a key holder");
      }
      let stored = 0;
      for (const grant of grants) {
        const recipient = await client.query<{ device_public_key: string | null }>(
          `SELECT r.device_public_key FROM replicas r JOIN members m ON m.id = r.member_id
            WHERE r.id = $1 AND r.workspace_id = $2 AND r.disabled_at IS NULL AND m.disabled_at IS NULL`,
          [grant.recipientReplicaId, identity.workspaceId]
        );
        const registered = recipient.rows[0]?.device_public_key;
        if (!registered) throw new StoreConflictError("Grant recipient is not an active device with a registered key");
        if (registered !== grant.recipientPublicKey) throw new StoreConflictError("Grant recipient's registered key does not match");
        const inserted = await client.query(
          `INSERT INTO workspace_key_grants
             (workspace_id, epoch, recipient_replica_id, key_id, recipient_public_key, sender_replica_id, wrapped)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
           ON CONFLICT (workspace_id, epoch, recipient_replica_id) DO NOTHING
           RETURNING epoch`,
          [identity.workspaceId, grant.epoch, grant.recipientReplicaId, grant.keyId, grant.recipientPublicKey, senderReplicaId, JSON.stringify(grant.wrapped)]
        );
        if (inserted.rows[0]) {
          stored += 1;
          await this.audit(client, identity.workspaceId, identity.memberId, senderReplicaId, "workspace_key.granted", {
            epoch: grant.epoch, keyId: grant.keyId, recipientReplicaId: grant.recipientReplicaId
          });
        }
      }
      return { stored };
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
   * The clamp on the way out is what makes auto-always a wall rather than a suggestion. A
   * plan change writes the clamped tier back (see applySubscriptionState), but a grace
   * period that lapses does not write anything until the sweep runs, and this is the value
   * the daemon syncs its auto-apply policy from -- so it is clamped here too. Falling back
   * to auto-if-clean rather than erroring is deliberate: losing the paid tier should cost
   * the feature, not the workspace.
   */
  async getWorkspaceAutonomyTier(workspaceId: string): Promise<0 | 1 | 2> {
    const result = await this.pool.query<{ autonomy_tier: number; plan: Plan }>(
      `SELECT autonomy_tier, ${EFFECTIVE_PLAN_SQL} AS plan FROM workspaces WHERE id = $1`,
      [workspaceId]
    );
    if (!result.rows[0]) throw new StoreUnauthorizedError("Workspace is not available");
    return clampAutonomyTierToPlan(result.rows[0].autonomy_tier as 0 | 1 | 2, result.rows[0].plan);
  }

  /**
   * Only the workspace owner may change the autonomy tier -- callers (http.ts) are
   * expected to have already checked identity.role, this is a second gate at the
   * data layer so the check can never be skipped by a new call site.
   */
  async setWorkspaceAutonomyTier(identity: Membership, tier: 0 | 1 | 2): Promise<0 | 1 | 2> {
    if (identity.role !== "owner") throw new StoreUnauthorizedError("Only the workspace owner can change the autonomy tier");
    return this.transaction(async (client) => {
      const workspace = await client.query<{ plan: Plan }>(`SELECT ${EFFECTIVE_PLAN_SQL} AS plan FROM workspaces WHERE id = $1 FOR UPDATE`, [identity.workspaceId]);
      if (!workspace.rows[0]) throw new StoreUnauthorizedError("Workspace is not available");
      // The tier a plan unlocks is checked here rather than only at the route, for the
      // same reason the owner check is: this is the single write path, so a new caller
      // cannot reach a tier the workspace has not paid for by skipping a gate.
      assertPlanAllowsAutonomyTier(workspace.rows[0].plan, AUTONOMY_TIER_NAMES[tier]);
      const result = await client.query<{ autonomy_tier: number }>(
        "UPDATE workspaces SET autonomy_tier = $2 WHERE id = $1 RETURNING autonomy_tier",
        [identity.workspaceId, tier]
      );
      return result.rows[0]!.autonomy_tier as 0 | 1 | 2;
    });
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
    const workspace = await this.pool.query<{ plan: Plan; operations_pruned_through: string }>(
      "SELECT plan, operations_pruned_through FROM workspaces WHERE id = $1",
      [workspaceId]
    );
    if (!workspace.rows[0]) throw new StoreUnauthorizedError("Workspace is not available");
    const prunedThrough = Number(workspace.rows[0].operations_pruned_through);
    if (cursor < prunedThrough) {
      return {
        status: "cursor-too-old",
        resyncFrom: prunedThrough,
        retentionDays: PLAN_LIMITS[workspace.rows[0].plan].historyRetentionDays
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

  async upsertTask(identity: Membership, event: TaskCreatedEvent | TaskUpdatedEvent): Promise<RemoteTask> {
    const task = event.payload;
    const result = await this.pool.query<TaskRow>(
      `INSERT INTO tasks (id, workspace_id, event_id, replica_id, payload, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, now())
       ON CONFLICT (workspace_id, id) DO UPDATE
         SET event_id = excluded.event_id, replica_id = excluded.replica_id, payload = excluded.payload, updated_at = now()
       RETURNING id, workspace_id, event_id, replica_id, payload, updated_at`,
      [task.id, identity.workspaceId, event.id, event.replicaId, JSON.stringify(task)]
    );
    return mapTask(result.rows[0]!);
  }

  async listTasks(workspaceId: string, after: string, limit: number): Promise<{ items: RemoteTask[]; nextCursor: string }> {
    const result = await this.pool.query<TaskRow>(
      `SELECT id, workspace_id, event_id, replica_id, payload, updated_at
         FROM tasks
        WHERE workspace_id = $1 AND updated_at > $2
        ORDER BY updated_at ASC
        LIMIT $3`,
      [workspaceId, after, limit]
    );
    const items = result.rows.map(mapTask);
    return { items, nextCursor: items.at(-1)?.updatedAt ?? after };
  }

  async upsertClaim(identity: Membership, event: ClaimCreatedEvent | ClaimReleasedEvent): Promise<RemoteClaim> {
    const claim = event.payload;
    const released = event.type === "claim.released";
    const result = await this.pool.query<ClaimRow>(
      `INSERT INTO claims (id, workspace_id, event_id, replica_id, payload, released_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, now())
       ON CONFLICT (workspace_id, id) DO UPDATE
         SET event_id = excluded.event_id, replica_id = excluded.replica_id, payload = excluded.payload,
             released_at = excluded.released_at, updated_at = now()
       RETURNING id, workspace_id, event_id, replica_id, payload, released_at, updated_at`,
      [claim.id, identity.workspaceId, event.id, event.replicaId, JSON.stringify(claim), released ? new Date() : null]
    );
    return mapClaim(result.rows[0]!);
  }

  async listClaims(workspaceId: string, after: string, limit: number): Promise<{ items: RemoteClaim[]; nextCursor: string }> {
    const result = await this.pool.query<ClaimRow>(
      `SELECT id, workspace_id, event_id, replica_id, payload, released_at, updated_at
         FROM claims
        WHERE workspace_id = $1 AND updated_at > $2
        ORDER BY updated_at ASC
        LIMIT $3`,
      [workspaceId, after, limit]
    );
    const items = result.rows.map(mapClaim);
    return { items, nextCursor: items.at(-1)?.updatedAt ?? after };
  }

  async upsertHandoff(identity: Membership, event: HandoffRequestedEvent | HandoffRespondedEvent): Promise<RemoteHandoff> {
    const handoff = event.payload;
    const responded = event.type === "handoff.responded";
    const result = await this.pool.query<HandoffRow>(
      `INSERT INTO handoffs (id, workspace_id, event_id, replica_id, payload, responded_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, now())
       ON CONFLICT (workspace_id, id) DO UPDATE
         SET event_id = excluded.event_id, replica_id = excluded.replica_id, payload = excluded.payload,
             responded_at = excluded.responded_at, updated_at = now()
       RETURNING id, workspace_id, event_id, replica_id, payload, responded_at, updated_at`,
      [handoff.id, identity.workspaceId, event.id, event.replicaId, JSON.stringify(handoff), responded ? new Date() : null]
    );
    return mapHandoff(result.rows[0]!);
  }

  async listHandoffs(workspaceId: string, after: string, limit: number): Promise<{ items: RemoteHandoff[]; nextCursor: string }> {
    const result = await this.pool.query<HandoffRow>(
      `SELECT id, workspace_id, event_id, replica_id, payload, responded_at, updated_at
         FROM handoffs
        WHERE workspace_id = $1 AND updated_at > $2
        ORDER BY updated_at ASC
        LIMIT $3`,
      [workspaceId, after, limit]
    );
    const items = result.rows.map(mapHandoff);
    return { items, nextCursor: items.at(-1)?.updatedAt ?? after };
  }

  async upsertIntent(identity: Membership, event: IntentPublishedEvent): Promise<RemoteIntent> {
    const intent = event.payload;
    const result = await this.pool.query<IntentRow>(
      `INSERT INTO intents (id, workspace_id, event_id, replica_id, payload, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, now())
       ON CONFLICT (workspace_id, id) DO UPDATE
         SET event_id = excluded.event_id, replica_id = excluded.replica_id, payload = excluded.payload, updated_at = now()
       RETURNING id, workspace_id, event_id, replica_id, payload, updated_at`,
      [intent.id, identity.workspaceId, event.id, event.replicaId, JSON.stringify(intent)]
    );
    return mapIntent(result.rows[0]!);
  }

  async listIntents(workspaceId: string, after: string, limit: number): Promise<{ items: RemoteIntent[]; nextCursor: string }> {
    const result = await this.pool.query<IntentRow>(
      `SELECT id, workspace_id, event_id, replica_id, payload, updated_at
         FROM intents
        WHERE workspace_id = $1 AND updated_at > $2
        ORDER BY updated_at ASC
        LIMIT $3`,
      [workspaceId, after, limit]
    );
    const items = result.rows.map(mapIntent);
    return { items, nextCursor: items.at(-1)?.updatedAt ?? after };
  }

  async recordValidation(identity: Membership, event: ValidationCompletedEvent): Promise<RemoteValidation> {
    const validation = event.payload;
    const result = await this.pool.query<ValidationRow>(
      `INSERT INTO validations (id, workspace_id, event_id, replica_id, payload, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, now())
       ON CONFLICT (workspace_id, id) DO UPDATE
         SET event_id = excluded.event_id, replica_id = excluded.replica_id, payload = excluded.payload
       RETURNING id, workspace_id, event_id, replica_id, payload, created_at`,
      [validation.id, identity.workspaceId, event.id, event.replicaId, JSON.stringify(validation)]
    );
    return mapValidation(result.rows[0]!);
  }

  async listValidations(workspaceId: string, after: string, limit: number): Promise<{ items: RemoteValidation[]; nextCursor: string }> {
    const result = await this.pool.query<ValidationRow>(
      `SELECT id, workspace_id, event_id, replica_id, payload, created_at
         FROM validations
        WHERE workspace_id = $1 AND created_at > $2
        ORDER BY created_at ASC
        LIMIT $3`,
      [workspaceId, after, limit]
    );
    const items = result.rows.map(mapValidation);
    return { items, nextCursor: items.at(-1)?.createdAt ?? after };
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

  async listPresence(workspaceId: string): Promise<PresenceSummary[]> {
    const result = await this.pool.query<{
      replica_id: string; actor_id: string; project_id: string | null; started_at: Date | null; ended_at: Date | null; summary: { cursor?: number } | null;
    }>(
      `SELECT DISTINCT ON (r.id) r.id AS replica_id, m.actor_id, r.project_id, s.started_at, s.ended_at, s.summary
         FROM replicas r
         JOIN members m ON m.id = r.member_id
         LEFT JOIN sessions s ON s.workspace_id = r.workspace_id AND s.replica_id = r.id
        WHERE r.workspace_id = $1
        ORDER BY r.id, s.started_at DESC NULLS LAST`,
      [workspaceId]
    );
    return result.rows.map((row) => {
      const lastSeenAt = row.ended_at ?? row.started_at;
      return {
        replicaId: row.replica_id,
        actorId: row.actor_id,
        status: row.started_at !== null && row.ended_at === null ? "online" : "offline",
        lastSeenAt: lastSeenAt ? new Date(lastSeenAt).toISOString() : null,
        cursor: typeof row.summary?.cursor === "number" ? row.summary.cursor : null,
        projectId: row.project_id
      };
    });
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

  /**
   * Shared-across-instances counterpart to the in-process rate limiter, for limits that are
   * a security control rather than a courtesy (see migrations/012_rate_limits.sql).
   *
   * One statement, so concurrent requests on different instances cannot interleave a read
   * and a write and both conclude they are under the limit. Returns false once the caller
   * has spent its budget for the current window.
   */
  async takeRateLimit(bucket: string, maximum: number, windowSeconds: number): Promise<boolean> {
    const result = await this.pool.query<{ count: number }>(
      `INSERT INTO rate_limits (bucket, window_start, count) VALUES ($1, now(), 1)
       ON CONFLICT (bucket) DO UPDATE SET
         count = CASE WHEN now() - rate_limits.window_start >= make_interval(secs => $2)
                      THEN 1 ELSE rate_limits.count + 1 END,
         window_start = CASE WHEN now() - rate_limits.window_start >= make_interval(secs => $2)
                             THEN now() ELSE rate_limits.window_start END
       RETURNING count`,
      [bucket, windowSeconds]
    );
    return (result.rows[0]?.count ?? 1) <= maximum;
  }

  /** Expired buckets carry no state worth keeping; without this the table grows per distinct IP. */
  async pruneRateLimits(olderThanSeconds = 3_600): Promise<number> {
    const result = await this.pool.query(
      "DELETE FROM rate_limits WHERE window_start < now() - make_interval(secs => $1)",
      [olderThanSeconds]
    );
    return result.rowCount ?? 0;
  }

  async pruneAuditEvents(olderThanDays: number): Promise<number> {
    assertPositiveInteger(olderThanDays, "olderThanDays");
    const result = await this.pool.query(
      `DELETE FROM audit_events WHERE created_at < now() - ($1 || ' days')::interval RETURNING id`,
      [olderThanDays]
    );
    return result.rowCount ?? result.rows.length;
  }

  /**
   * Enforces PLAN_LIMITS[plan].historyRetentionDays across every workspace. Safe to run
   * concurrently with ingest and with itself: each workspace is swept under its own row
   * lock, and the watermark only ever moves forward.
   *
   * Requires a role with DELETE on operations, which the request-serving role deliberately
   * does not have (assertRuntimePrivileges). Callers pass a privileged connection: the
   * scheduled sweep in retention.ts, or `pnpm service:prune`.
   */
  async pruneOperationsByRetention(): Promise<RetentionSweepResult[]> {
    const workspaces = await this.pool.query<{ id: string; plan: Plan }>("SELECT id, plan FROM workspaces ORDER BY id");
    const results: RetentionSweepResult[] = [];
    for (const workspace of workspaces.rows) {
      results.push(await this.pruneWorkspaceOperations(workspace.id, workspace.plan));
    }
    return results;
  }

  private async pruneWorkspaceOperations(workspaceId: string, plan: Plan): Promise<RetentionSweepResult> {
    const retentionDays = PLAN_LIMITS[plan].historyRetentionDays;
    assertPositiveInteger(retentionDays, "historyRetentionDays");
    return this.transaction(async (client) => {
      const locked = await client.query<{ operations_pruned_through: string }>(
        "SELECT operations_pruned_through FROM workspaces WHERE id = $1 FOR UPDATE",
        [workspaceId]
      );
      const unchanged = { workspaceId, plan, retentionDays, deleted: 0 };
      if (!locked.rows[0]) return { ...unchanged, prunedThrough: 0 };
      const prunedThrough = Number(locked.rows[0].operations_pruned_through);
      // Deleted by sequence, never directly by age. server_sequence is assigned under the
      // workspace row lock while created_at is the inserting transaction's clock, so two
      // concurrent ingests can commit with their timestamps inverted relative to their
      // sequences. Deleting a prefix of the sequence keeps what remains a contiguous
      // suffix, which is precisely what the watermark promises readers.
      //
      // Each row is measured against its *own* retention_days -- the window promised by the
      // plan in effect when it was written -- rather than against the workspace's current
      // plan. That is what makes a downgrade unable to delete history retroactively
      // (BUILD_INSTRUCTIONS.md Phase 10): shrinking the window stops history being extended,
      // it does not shorten what was already kept.
      //
      // The cutoff is therefore the sequence just below the oldest row that is *still* live,
      // not the newest expired one. Those differ exactly when an expired row sits above a
      // live one -- which per-row windows make possible and a single window does not -- and
      // taking the newest expired sequence there would delete live rows underneath it.
      // When nothing is live the whole table is expired and the cutoff is the highest
      // sequence. COALESCE keeps a row that predates the column (none after 014's backfill)
      // on the workspace's current window rather than treating NULL as expired.
      const cutoff = await client.query<{ cutoff: string | null }>(
        `SELECT COALESCE(
                  (SELECT min(server_sequence) - 1 FROM operations
                    WHERE workspace_id = $1
                      AND created_at >= now() - (COALESCE(retention_days, $2) || ' days')::interval),
                  (SELECT max(server_sequence) FROM operations WHERE workspace_id = $1)
                ) AS cutoff`,
        [workspaceId, retentionDays]
      );
      const cutoffSequence = Number(cutoff.rows[0]?.cutoff ?? 0);
      if (cutoffSequence <= prunedThrough) return { ...unchanged, prunedThrough };
      // operation_files rows follow via ON DELETE CASCADE.
      const deleted = await client.query(
        "DELETE FROM operations WHERE workspace_id = $1 AND server_sequence <= $2",
        [workspaceId, cutoffSequence]
      );
      await client.query(
        "UPDATE workspaces SET operations_pruned_through = $2 WHERE id = $1",
        [workspaceId, cutoffSequence]
      );
      return { workspaceId, plan, retentionDays, deleted: deleted.rowCount ?? 0, prunedThrough: cutoffSequence };
    });
  }

  async pruneEndedSessions(olderThanDays: number): Promise<number> {
    assertPositiveInteger(olderThanDays, "olderThanDays");
    const result = await this.pool.query(
      `DELETE FROM sessions WHERE ended_at IS NOT NULL AND ended_at < now() - ($1 || ' days')::interval RETURNING id`,
      [olderThanDays]
    );
    return result.rowCount ?? result.rows.length;
  }
}

/**
 * Enforces the plan's seat cap inside the caller's transaction, so the count and the
 * INSERT that follows it cannot be separated by a concurrent redemption. Callers are
 * expected to hold FOR UPDATE on the workspace row first.
 */
async function assertSeatAvailable(client: PoolClient, workspaceId: string, plan: Plan): Promise<void> {
  const result = await client.query<{ count: string }>(
    "SELECT count(*) FROM members WHERE workspace_id = $1 AND disabled_at IS NULL",
    [workspaceId]
  );
  assertSeatCapAvailable(plan, Number(result.rows[0]!.count));
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
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
  /**
   * The stored envelope; its payload is this operation's transaction, plaintext
   * (`transaction.created`) or sealed (`transaction.sealed`).
   */
  event: TransactionCreatedEvent | SealedTransactionCreatedEvent;
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
    // in store.integration.test.ts. For an encrypted workspace this is the sealed
    // envelope, and it passes through this service without ever being opened.
    transaction: row.event.payload as SyncedTransaction,
    serverSequence: Number(row.server_sequence),
    createdAt: new Date(row.created_at).toISOString()
  };
}

type KeyGrantRow = {
  epoch: number;
  key_id: string;
  recipient_replica_id: string;
  wrapped: WrappedKey;
  created_at: Date;
};

function mapKeyGrant(row: KeyGrantRow): WorkspaceKeyGrant {
  return {
    epoch: row.epoch,
    keyId: row.key_id,
    recipientReplicaId: row.recipient_replica_id,
    wrapped: row.wrapped,
    createdAt: new Date(row.created_at).toISOString()
  };
}

type TaskRow = {
  id: string;
  workspace_id: string;
  event_id: string;
  replica_id: string;
  payload: Task;
  updated_at: Date;
};

function mapTask(row: TaskRow): RemoteTask {
  return {
    eventId: row.event_id,
    workspaceId: row.workspace_id,
    senderReplicaId: row.replica_id,
    task: row.payload,
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

type ClaimRow = {
  id: string;
  workspace_id: string;
  event_id: string;
  replica_id: string;
  payload: Claim;
  released_at: Date | null;
  updated_at: Date;
};

function mapClaim(row: ClaimRow): RemoteClaim {
  return {
    eventId: row.event_id,
    workspaceId: row.workspace_id,
    senderReplicaId: row.replica_id,
    claim: row.payload,
    released: row.released_at !== null,
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

type HandoffRow = {
  id: string;
  workspace_id: string;
  event_id: string;
  replica_id: string;
  payload: Handoff;
  responded_at: Date | null;
  updated_at: Date;
};

function mapHandoff(row: HandoffRow): RemoteHandoff {
  return {
    eventId: row.event_id,
    workspaceId: row.workspace_id,
    senderReplicaId: row.replica_id,
    handoff: row.payload,
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

type IntentRow = {
  id: string;
  workspace_id: string;
  event_id: string;
  replica_id: string;
  payload: Intent;
  updated_at: Date;
};

function mapIntent(row: IntentRow): RemoteIntent {
  return {
    eventId: row.event_id,
    workspaceId: row.workspace_id,
    senderReplicaId: row.replica_id,
    intent: row.payload,
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

type ValidationRow = {
  id: string;
  workspace_id: string;
  event_id: string;
  replica_id: string;
  payload: Validation;
  created_at: Date;
};

function mapValidation(row: ValidationRow): RemoteValidation {
  return {
    eventId: row.event_id,
    workspaceId: row.workspace_id,
    senderReplicaId: row.replica_id,
    validation: row.payload,
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

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// XXXX-XXXX over Crockford base32 is 40 bits of entropy behind a 15-minute TTL and a
// 10-attempts-per-minute-per-IP claim limit. 256 is divisible by the 32-symbol alphabet,
// so the modulo below is uniform rather than biased toward the first symbols.
function generatePairingCode(): string {
  const bytes = randomBytes(8);
  let code = "";
  for (const [index, byte] of bytes.entries()) {
    if (index === 4) code += "-";
    code += PAIRING_CODE_ALPHABET[byte % PAIRING_CODE_ALPHABET.length];
  }
  return code;
}

function generateWorkspaceToken(): string {
  return `${WORKSPACE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

function isDeadlock(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "40P01";
}
