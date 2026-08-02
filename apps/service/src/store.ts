import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  ChangeTransaction, Claim, ClaimCreatedEvent, ClaimReleasedEvent, EventEnvelope, Handoff, HandoffRequestedEvent,
  HandoffRespondedEvent, Intent, IntentPublishedEvent, RemoteClaim, RemoteHandoff, RemoteIntent, RemoteOperation,
  RemoteTask, RemoteValidation, Task, TaskCreatedEvent, TaskUpdatedEvent, TransactionCreatedEvent, Validation, ValidationCompletedEvent
} from "@crosscode/protocol";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import { hashCanonicalPayload } from "./crypto.js";

export class StoreConflictError extends Error {}
export class StoreUnauthorizedError extends Error {}

export type StoredOperation = RemoteOperation & {
  event: EventEnvelope;
};

export type PresenceSummary = {
  replicaId: string;
  actorId: string;
  status: "online" | "offline";
  lastSeenAt: string | null;
  cursor: number | null;
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

const DEFAULT_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export class PgStore {
  readonly pool: Pool;

  constructor(config: PoolConfig | string) {
    this.pool = new Pool(typeof config === "string" ? safePoolConfig(config) : config);
  }

  async migrate(): Promise<void> {
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
      await client.query("INSERT INTO workspaces (id, name) VALUES ($1, $2)", [workspaceId, input.workspaceName]);
      await client.query(
        "INSERT INTO members (id, workspace_id, user_id, actor_id, role) VALUES ($1, $2, $3, $4, 'owner')",
        [memberId, workspaceId, input.userId, input.actorId]
      );
      await this.audit(client, workspaceId, memberId, null, "workspace.self_serve_created", {});
    });
    return { workspaceId, memberId };
  }

  async addMember(input: {
    workspaceId: string;
    userId: string;
    actorId: string;
    role?: Membership["role"];
  }): Promise<{ workspaceId: string; memberId: string }> {
    const memberId = randomUUID();
    return this.transaction(async (client) => {
      const workspace = await client.query("SELECT id FROM workspaces WHERE id = $1", [input.workspaceId]);
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

  async registerReplica(userId: string, workspaceId: string, name: string): Promise<{ replicaId: string; createdAt: string }> {
    const membership = await this.resolveMembership(userId, workspaceId);
    const replicaId = randomUUID();
    try {
      const result = await this.pool.query<{ created_at: Date }>(
        `INSERT INTO replicas (id, workspace_id, member_id, name) VALUES ($1, $2, $3, $4) RETURNING created_at`,
        [replicaId, workspaceId, membership.memberId, name]
      );
      return { replicaId, createdAt: new Date(result.rows[0]!.created_at).toISOString() };
    } catch (error) {
      if (isUniqueViolation(error)) throw new StoreConflictError("Replica name is already registered");
      throw error;
    }
  }

  async assertReplicaOwnership(workspaceId: string, memberId: string, replicaId: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE replicas SET last_seen_at = now()
        WHERE id = $1 AND workspace_id = $2 AND member_id = $3 AND disabled_at IS NULL
        RETURNING id`,
      [replicaId, workspaceId, memberId]
    );
    if (!result.rows[0]) throw new StoreUnauthorizedError("Replica is not registered to this member");
  }

  async appendOperation(identity: Membership, event: TransactionCreatedEvent): Promise<StoredOperation> {
    const transaction = event.payload;
    if (new Set(transaction.changes.map((change) => change.path)).size !== transaction.changes.length) {
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
        `SELECT id, workspace_id, replica_id, event, transaction, server_sequence, created_at, payload_hash
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
        `INSERT INTO operations
          (id, workspace_id, event_id, client_sequence, server_sequence, replica_id, member_id,
           actor_id, payload_hash, event, transaction)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb)
         RETURNING id, workspace_id, replica_id, event, transaction, server_sequence, created_at, payload_hash`,
        [
          transaction.id, identity.workspaceId, event.id, event.clientSequence, sequence, event.replicaId,
          identity.memberId, identity.actorId, payloadHash, JSON.stringify(storedEvent), JSON.stringify(transaction)
        ]
      );
      for (const file of transaction.changes) {
        await client.query(
          `INSERT INTO operation_files
            (workspace_id, operation_id, path, kind, before_hash, after_hash, payload)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
          [identity.workspaceId, transaction.id, file.path, file.kind, file.beforeHash ?? null, file.afterHash ?? null, JSON.stringify(file)]
        );
      }
      await client.query("UPDATE workspaces SET next_sequence = $2 WHERE id = $1", [identity.workspaceId, sequence]);
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

  async getWorkspaceAutonomyTier(workspaceId: string): Promise<0 | 1 | 2> {
    const result = await this.pool.query<{ autonomy_tier: number }>(
      "SELECT autonomy_tier FROM workspaces WHERE id = $1",
      [workspaceId]
    );
    if (!result.rows[0]) throw new StoreUnauthorizedError("Workspace is not available");
    return result.rows[0].autonomy_tier as 0 | 1 | 2;
  }

  /**
   * Only the workspace owner may change the autonomy tier -- callers (http.ts) are
   * expected to have already checked identity.role, this is a second gate at the
   * data layer so the check can never be skipped by a new call site.
   */
  async setWorkspaceAutonomyTier(identity: Membership, tier: 0 | 1 | 2): Promise<0 | 1 | 2> {
    if (identity.role !== "owner") throw new StoreUnauthorizedError("Only the workspace owner can change the autonomy tier");
    const result = await this.pool.query<{ autonomy_tier: number }>(
      "UPDATE workspaces SET autonomy_tier = $2 WHERE id = $1 RETURNING autonomy_tier",
      [identity.workspaceId, tier]
    );
    if (!result.rows[0]) throw new StoreUnauthorizedError("Workspace is not available");
    return result.rows[0].autonomy_tier as 0 | 1 | 2;
  }

  async listOperations(workspaceId: string, cursor: number, limit: number): Promise<{
    items: StoredOperation[]; nextCursor: number; hasMore: boolean;
  }> {
    const result = await this.pool.query<OperationRow>(
      `SELECT id, workspace_id, replica_id, event, transaction, server_sequence, created_at
         FROM operations
        WHERE workspace_id = $1 AND server_sequence > $2
        ORDER BY server_sequence ASC
        LIMIT $3`,
      [workspaceId, cursor, limit + 1]
    );
    const items = result.rows.slice(0, limit).map(mapOperation);
    return { items, nextCursor: items.at(-1)?.serverSequence ?? cursor, hasMore: result.rows.length > limit };
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
      replica_id: string; actor_id: string; started_at: Date | null; ended_at: Date | null; summary: { cursor?: number } | null;
    }>(
      `SELECT DISTINCT ON (r.id) r.id AS replica_id, m.actor_id, s.started_at, s.ended_at, s.summary
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
        cursor: typeof row.summary?.cursor === "number" ? row.summary.cursor : null
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

  async pruneAuditEvents(olderThanDays: number): Promise<number> {
    assertPositiveInteger(olderThanDays, "olderThanDays");
    const result = await this.pool.query(
      `DELETE FROM audit_events WHERE created_at < now() - ($1 || ' days')::interval RETURNING id`,
      [olderThanDays]
    );
    return result.rowCount ?? result.rows.length;
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
  event: EventEnvelope;
  transaction: ChangeTransaction;
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
    event: row.event,
    transaction: row.transaction,
    serverSequence: Number(row.server_sequence),
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
