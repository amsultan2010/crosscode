import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  ChangeTransaction, Claim, ClaimCreatedEvent, ClaimReleasedEvent, EventEnvelope, RemoteClaim, RemoteOperation,
  RemoteTask, Task, TaskCreatedEvent, TaskUpdatedEvent, TransactionCreatedEvent
} from "@crosscode/protocol";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import { hashCanonicalPayload, hashCredential, hashEnrollmentToken, randomCredential, verifyCredential } from "./crypto.js";
import type { AccessClaims } from "./auth.js";

export class StoreConflictError extends Error {}
export class StoreUnauthorizedError extends Error {}

export type StoredOperation = RemoteOperation & {
  event: EventEnvelope;
};

type IdentityRow = {
  member_id: string;
  actor_id: string;
  workspace_id: string;
  replica_id: string;
  role: AccessClaims["role"];
  token_version: number;
  credential_hash: string;
};

export class PgStore {
  readonly pool: Pool;

  constructor(config: PoolConfig | string) {
    this.pool = new Pool(typeof config === "string" ? safePoolConfig(config) : config);
  }

  async migrate(): Promise<void> {
    const sql = await readFile(new URL("../migrations/001_initial.sql", import.meta.url), "utf8");
    await this.pool.query(sql);
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
    actorId: string;
    enrollmentTtlSeconds?: number;
  }): Promise<{ workspaceId: string; memberId: string; enrollmentToken: string; expiresAt: string }> {
    const workspaceId = randomUUID();
    const memberId = randomUUID();
    const enrollmentId = randomUUID();
    const enrollmentToken = randomCredential();
    const expiresAt = new Date(Date.now() + (input.enrollmentTtlSeconds ?? 900) * 1_000);
    await this.transaction(async (client) => {
      await client.query("INSERT INTO workspaces (id, name) VALUES ($1, $2)", [workspaceId, input.workspaceName]);
      await client.query(
        "INSERT INTO members (id, workspace_id, actor_id, role) VALUES ($1, $2, $3, 'owner')",
        [memberId, workspaceId, input.actorId]
      );
      await client.query(
        "INSERT INTO enrollments (id, workspace_id, member_id, token_hash, expires_at) VALUES ($1, $2, $3, $4, $5)",
        [enrollmentId, workspaceId, memberId, hashEnrollmentToken(enrollmentToken), expiresAt]
      );
      await this.audit(client, workspaceId, memberId, null, "admin.provisioned", { enrollmentId });
    });
    return { workspaceId, memberId, enrollmentToken, expiresAt: expiresAt.toISOString() };
  }

  async provisionEnrollment(input: {
    workspaceId: string;
    actorId: string;
    role?: AccessClaims["role"];
    enrollmentTtlSeconds?: number;
  }): Promise<{ workspaceId: string; memberId: string; enrollmentToken: string; expiresAt: string }> {
    const memberId = randomUUID();
    const enrollmentId = randomUUID();
    const enrollmentToken = randomCredential();
    const expiresAt = new Date(Date.now() + (input.enrollmentTtlSeconds ?? 900) * 1_000);
    return this.transaction(async (client) => {
      const workspace = await client.query("SELECT id FROM workspaces WHERE id = $1", [input.workspaceId]);
      if (!workspace.rows[0]) throw new StoreUnauthorizedError("Workspace is not available");
      const member = await client.query<{ id: string }>(
        `INSERT INTO members (id, workspace_id, actor_id, role)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (workspace_id, actor_id) DO UPDATE SET role = members.role
         RETURNING id`,
        [memberId, input.workspaceId, input.actorId, input.role ?? "member"]
      );
      const persistedMemberId = member.rows[0]!.id;
      await client.query(
        "INSERT INTO enrollments (id, workspace_id, member_id, token_hash, expires_at) VALUES ($1, $2, $3, $4, $5)",
        [enrollmentId, input.workspaceId, persistedMemberId, hashEnrollmentToken(enrollmentToken), expiresAt]
      );
      await this.audit(client, input.workspaceId, persistedMemberId, null, "member.provisioned", { enrollmentId });
      return { workspaceId: input.workspaceId, memberId: persistedMemberId, enrollmentToken, expiresAt: expiresAt.toISOString() };
    });
  }

  async enroll(input: { enrollmentToken: string }): Promise<{
    claims: AccessClaims;
    replicaSecret: string;
  }> {
    return this.transaction(async (client) => {
      const result = await client.query<{
        id: string; workspace_id: string; member_id: string; actor_id: string;
        role: AccessClaims["role"]; token_version: number; expires_at: Date; used_at: Date | null;
      }>(
        `SELECT e.id, e.workspace_id, e.member_id, e.expires_at, e.used_at,
                m.actor_id, m.role, m.token_version
           FROM enrollments e
           JOIN members m ON m.id = e.member_id AND m.workspace_id = e.workspace_id
          WHERE e.token_hash = $1 AND m.disabled_at IS NULL
          FOR UPDATE OF e`,
        [hashEnrollmentToken(input.enrollmentToken)]
      );
      const row = result.rows[0];
      if (!row || row.used_at || new Date(row.expires_at).getTime() <= Date.now()) {
        throw new StoreUnauthorizedError("Enrollment token is invalid, expired, or already used");
      }
      const replicaId = randomUUID();
      const replicaName = `replica-${replicaId}`;
      const replicaSecret = randomCredential();
      const credentialHash = await hashCredential(replicaSecret);
      try {
        await client.query(
          `INSERT INTO replicas (id, workspace_id, member_id, name, credential_hash)
           VALUES ($1, $2, $3, $4, $5)`,
          [replicaId, row.workspace_id, row.member_id, replicaName, credentialHash]
        );
      } catch (error) {
        if (isUniqueViolation(error)) throw new StoreConflictError("Replica name is already registered");
        throw error;
      }
      await client.query("UPDATE enrollments SET used_at = now() WHERE id = $1", [row.id]);
      await this.audit(client, row.workspace_id, row.member_id, replicaId, "replica.enrolled", {});
      return {
        claims: {
          memberId: row.member_id,
          actorId: row.actor_id,
          workspaceId: row.workspace_id,
          replicaId,
          role: row.role,
          tokenVersion: row.token_version
        },
        replicaSecret
      };
    });
  }

  async authenticateReplica(
    replicaId: string,
    replicaSecret: string,
    expected?: { workspaceId: string; actorId: string }
  ): Promise<AccessClaims> {
    const result = await this.pool.query<IdentityRow>(
      `SELECT m.id AS member_id, m.actor_id, m.workspace_id, r.id AS replica_id, m.role, m.token_version, r.credential_hash
         FROM replicas r
         JOIN members m ON m.id = r.member_id AND m.workspace_id = r.workspace_id
        WHERE r.id = $1 AND r.disabled_at IS NULL AND m.disabled_at IS NULL`,
      [replicaId]
    );
    const row = result.rows[0];
    if (
      !row ||
      (expected && (row.workspace_id !== expected.workspaceId || row.actor_id !== expected.actorId)) ||
      !(await verifyCredential(replicaSecret, row.credential_hash))
    ) {
      throw new StoreUnauthorizedError("Replica credentials are invalid");
    }
    await this.pool.query("UPDATE replicas SET last_seen_at = now() WHERE id = $1", [replicaId]);
    return toClaims(row);
  }

  async reauthorize(claims: AccessClaims): Promise<AccessClaims> {
    const result = await this.pool.query<IdentityRow>(
      `SELECT m.id AS member_id, m.actor_id, m.workspace_id, r.id AS replica_id, m.role, m.token_version, r.credential_hash
         FROM replicas r
         JOIN members m ON m.id = r.member_id AND m.workspace_id = r.workspace_id
        WHERE r.id = $1 AND r.member_id = $2 AND r.workspace_id = $3
          AND r.disabled_at IS NULL AND m.disabled_at IS NULL`,
      [claims.replicaId, claims.memberId, claims.workspaceId]
    );
    const current = result.rows[0];
    if (!current || Number(current.token_version) !== claims.tokenVersion) {
      throw new StoreUnauthorizedError("Membership is no longer authorized");
    }
    return toClaims(current);
  }

  async appendOperation(identity: AccessClaims, event: TransactionCreatedEvent): Promise<StoredOperation> {
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
        [identity.workspaceId, transaction.id, event.id, identity.replicaId, event.clientSequence]
      );
      if (duplicate.rows[0]) {
        const stored = mapOperation(duplicate.rows[0]);
        if (
          stored.id === transaction.id && stored.eventId === event.id &&
          duplicate.rows[0].payload_hash === payloadHash &&
          stored.event.clientSequence === event.clientSequence &&
          stored.senderReplicaId === identity.replicaId
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
          transaction.id, identity.workspaceId, event.id, event.clientSequence, sequence, identity.replicaId,
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
      await this.audit(client, identity.workspaceId, identity.memberId, identity.replicaId, "operation.received", {
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

  async upsertTask(identity: AccessClaims, event: TaskCreatedEvent | TaskUpdatedEvent): Promise<RemoteTask> {
    const task = event.payload;
    const result = await this.pool.query<TaskRow>(
      `INSERT INTO tasks (id, workspace_id, event_id, replica_id, payload, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, now())
       ON CONFLICT (workspace_id, id) DO UPDATE
         SET event_id = excluded.event_id, replica_id = excluded.replica_id, payload = excluded.payload, updated_at = now()
       RETURNING id, workspace_id, event_id, replica_id, payload, updated_at`,
      [task.id, identity.workspaceId, event.id, identity.replicaId, JSON.stringify(task)]
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

  async upsertClaim(identity: AccessClaims, event: ClaimCreatedEvent | ClaimReleasedEvent): Promise<RemoteClaim> {
    const claim = event.payload;
    const released = event.type === "claim.released";
    const result = await this.pool.query<ClaimRow>(
      `INSERT INTO claims (id, workspace_id, event_id, replica_id, payload, released_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, now())
       ON CONFLICT (workspace_id, id) DO UPDATE
         SET event_id = excluded.event_id, replica_id = excluded.replica_id, payload = excluded.payload,
             released_at = excluded.released_at, updated_at = now()
       RETURNING id, workspace_id, event_id, replica_id, payload, released_at, updated_at`,
      [claim.id, identity.workspaceId, event.id, identity.replicaId, JSON.stringify(claim), released ? new Date() : null]
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

function toClaims(row: IdentityRow): AccessClaims {
  return {
    memberId: row.member_id,
    actorId: row.actor_id,
    workspaceId: row.workspace_id,
    replicaId: row.replica_id,
    role: row.role,
    tokenVersion: Number(row.token_version)
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

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
