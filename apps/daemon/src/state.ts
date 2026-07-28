import { chmod, lstat, mkdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import type { ChangeTransaction, Claim, EventEnvelope, Handoff, Task, Validation } from "@crosscode/protocol";
import type { StoredOperation } from "./types.js";

export type GitState = { head?: string; headReflog?: string; branch?: string; worktree: string; indexTree?: string; operation?: "merge" | "rebase" | "cherry-pick" | "revert" };
export type CheckpointRecord = { ref: string; commit: string; tree: string; message: string; createdAt: string };
export type LocalEvent = { type: string; payload: unknown };
export type OutboundRecord = { event: EventEnvelope; transaction: ChangeTransaction; acknowledgedServerSequence?: number };

export type DaemonSnapshot = {
  tasks: Task[];
  claims: Claim[];
  operations: StoredOperation[];
  validations: Validation[];
  checkpoints: CheckpointRecord[];
  handoffs: Handoff[];
  outbound: OutboundRecord[];
  remoteCursor: number;
  capturedHashes: Record<string, string | null>;
  gitState?: GitState;
  materializationPaused: boolean;
  eventSequence: number;
};

const initialSnapshot = (): DaemonSnapshot => ({
  tasks: [],
  claims: [],
  operations: [],
  validations: [],
  checkpoints: [],
  handoffs: [],
  outbound: [],
  remoteCursor: 0,
  capturedHashes: {},
  materializationPaused: false,
  eventSequence: 0
});

function parseRows<T>(rows: Array<{ payload: string }>): T[] {
  return rows.map((row) => JSON.parse(row.payload) as T);
}

export class DaemonStateStore {
  private constructor(private readonly database: DatabaseSync) {}

  static async open(path: string): Promise<DaemonStateStore> {
    const directory = dirname(path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await lstat(directory)).isSymbolicLink()) throw new Error("Crosscode state directory must not be a symbolic link");
    await chmod(directory, 0o700);
    const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
    if (existing?.isSymbolicLink()) throw new Error("Crosscode state database must not be a symbolic link");
    const database = new DatabaseSync(path);
    await chmod(path, 0o600);
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS local_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        payload TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS local_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS task_projection (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS claim_projection (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS operation_projection (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS validation_projection (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS checkpoint_projection (
        ref TEXT PRIMARY KEY,
        payload TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS handoff_projection (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS outbox_projection (
        event_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS meta_projection (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
    `);
    const store = new DaemonStateStore(database);
    store.migrateLegacySnapshot();
    return store;
  }

  load(): DaemonSnapshot {
    const meta = new Map(
      (this.database.prepare("SELECT key, value FROM meta_projection").all() as Array<{ key: string; value: string }>).map((row) => [row.key, JSON.parse(row.value)])
    );
    const sequence = this.database.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM local_events").get() as { sequence: number };
    return {
      tasks: parseRows<Task>(this.database.prepare("SELECT payload FROM task_projection ORDER BY id").all() as Array<{ payload: string }>),
      claims: parseRows<Claim>(this.database.prepare("SELECT payload FROM claim_projection ORDER BY id").all() as Array<{ payload: string }>),
      operations: parseRows<StoredOperation>(this.database.prepare("SELECT payload FROM operation_projection ORDER BY id").all() as Array<{ payload: string }>),
      validations: parseRows<Validation>(this.database.prepare("SELECT payload FROM validation_projection ORDER BY id").all() as Array<{ payload: string }>),
      checkpoints: parseRows<CheckpointRecord>(this.database.prepare("SELECT payload FROM checkpoint_projection ORDER BY ref").all() as Array<{ payload: string }>),
      handoffs: parseRows<Handoff>(this.database.prepare("SELECT payload FROM handoff_projection ORDER BY id").all() as Array<{ payload: string }>),
      outbound: parseRows<OutboundRecord>(this.database.prepare("SELECT payload FROM outbox_projection ORDER BY event_id").all() as Array<{ payload: string }>),
      remoteCursor: (meta.get("remoteCursor") as number | undefined) ?? 0,
      capturedHashes: (meta.get("capturedHashes") as Record<string, string | null> | undefined) ?? {},
      gitState: meta.get("gitState") as GitState | undefined,
      materializationPaused: (meta.get("materializationPaused") as boolean | undefined) ?? false,
      eventSequence: sequence.sequence
    };
  }

  record(snapshot: Omit<DaemonSnapshot, "eventSequence">, event: LocalEvent): number {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const inserted = this.database.prepare("INSERT INTO local_events (type, created_at, payload) VALUES (?, ?, ?)").run(event.type, new Date().toISOString(), JSON.stringify(event.payload));
      this.replaceProjection("task_projection", "id", snapshot.tasks.map((task) => [task.id, task]));
      this.replaceProjection("claim_projection", "id", snapshot.claims.map((claim) => [claim.id, claim]));
      this.replaceProjection("operation_projection", "id", snapshot.operations.map((operation) => [operation.id, operation]));
      this.replaceProjection("validation_projection", "id", snapshot.validations.map((validation) => [validation.id, validation]));
      this.replaceProjection("checkpoint_projection", "ref", snapshot.checkpoints.map((checkpoint) => [checkpoint.ref, checkpoint]));
      this.replaceProjection("handoff_projection", "id", snapshot.handoffs.map((handoff) => [handoff.id, handoff]));
      this.replaceProjection("outbox_projection", "event_id", snapshot.outbound.map((record) => [record.event.id, record]));
      this.replaceMeta("remoteCursor", snapshot.remoteCursor);
      this.replaceMeta("capturedHashes", snapshot.capturedHashes);
      this.replaceMeta("gitState", snapshot.gitState);
      this.replaceMeta("materializationPaused", snapshot.materializationPaused);
      this.replaceMeta("projectionVersion", 1);
      this.database.exec("COMMIT");
      return Number(inserted.lastInsertRowid);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }

  private migrateLegacySnapshot(): void {
    const migrated = this.database.prepare("SELECT value FROM meta_projection WHERE key = ?").get("projectionVersion") as { value: string } | undefined;
    if (migrated) return;
    const legacy = this.database.prepare("SELECT value FROM local_state WHERE key = ?").get("snapshot") as { value: string } | undefined;
    if (!legacy) {
      this.replaceMeta("projectionVersion", 1);
      return;
    }
    const saved = JSON.parse(legacy.value) as Partial<DaemonSnapshot> & { cursor?: number };
    const snapshot = {
      ...initialSnapshot(),
      ...saved,
      remoteCursor: saved.remoteCursor ?? saved.cursor ?? 0,
      checkpoints: saved.checkpoints ?? []
    };
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.replaceProjection("task_projection", "id", snapshot.tasks.map((task) => [task.id, task]));
      this.replaceProjection("claim_projection", "id", snapshot.claims.map((claim) => [claim.id, claim]));
      this.replaceProjection("operation_projection", "id", snapshot.operations.map((operation) => [operation.id, operation]));
      this.replaceProjection("validation_projection", "id", snapshot.validations.map((validation) => [validation.id, validation]));
      this.replaceProjection("checkpoint_projection", "ref", snapshot.checkpoints.map((checkpoint) => [checkpoint.ref, checkpoint]));
      this.replaceProjection("handoff_projection", "id", snapshot.handoffs.map((handoff) => [handoff.id, handoff]));
      this.replaceProjection("outbox_projection", "event_id", snapshot.outbound.map((record) => [record.event.id, record]));
      this.replaceMeta("remoteCursor", snapshot.remoteCursor);
      this.replaceMeta("capturedHashes", snapshot.capturedHashes);
      this.replaceMeta("gitState", snapshot.gitState);
      this.replaceMeta("materializationPaused", snapshot.materializationPaused);
      this.replaceMeta("projectionVersion", 1);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private replaceProjection(table: string, key: string, values: Array<[string, unknown]>): void {
    this.database.exec(`DELETE FROM ${table}`);
    const insert = this.database.prepare(`INSERT INTO ${table} (${key}, payload) VALUES (?, ?)`);
    values.forEach(([id, value]) => insert.run(id, JSON.stringify(value)));
  }

  private replaceMeta(key: string, value: unknown): void {
    if (value === undefined) {
      this.database.prepare("DELETE FROM meta_projection WHERE key = ?").run(key);
      return;
    }
    this.database.prepare("INSERT INTO meta_projection (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
  }
}
