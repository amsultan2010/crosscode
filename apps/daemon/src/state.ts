import { chmod, lstat, mkdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import type { ChangeTransaction, EventEnvelope } from "@crosscode/protocol";
import type { LocalOperation } from "./types.js";
import { localEventSchema, type LocalEvent } from "./local-event.js";

export type GitState = { head?: string; headReflog?: string; branch?: string; worktree: string; indexTree?: string; operation?: "merge" | "rebase" | "cherry-pick" | "revert" };
export type OutboundRecord = { event: EventEnvelope; transaction: ChangeTransaction; acknowledgedServerSequence?: number };

export type DaemonSnapshot = {
  operations: LocalOperation[];
  outbound: OutboundRecord[];
  remoteCursor: number;
  capturedHashes: Record<string, string | null>;
  gitState?: GitState;
  materializationPaused: boolean;
  eventSequence: number;
};

const initialSnapshot = (): DaemonSnapshot => ({
  operations: [],
  outbound: [],
  remoteCursor: 0,
  capturedHashes: {},
  materializationPaused: false,
  eventSequence: 0
});

function parseRows<T>(rows: Array<{ payload: string }>): T[] {
  return rows.map((row) => JSON.parse(row.payload) as T);
}

/** Every projection table and the column that keys it, in one place for the diff cache. */
const PROJECTION_TABLES: ReadonlyArray<readonly [table: string, key: string]> = [
  ["operation_projection", "id"],
  ["outbox_projection", "event_id"]
];

export class DaemonStateStore {
  /** table -> key -> serialized payload currently on disk. See replaceProjection(). */
  private readonly written = new Map<string, Map<string, string>>();
  private readonly writtenMeta = new Map<string, string>();
  /** Tables whose cache could not be re-read; each falls back to a full rewrite once. */
  private readonly desynced = new Set<string>();

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
      CREATE TABLE IF NOT EXISTS operation_projection (
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
    // Before the legacy migration, so that migration's own writes diff against what is
    // really on disk rather than against an empty cache.
    store.primeWrittenProjections();
    store.migrateLegacySnapshot();
    return store;
  }

  load(): DaemonSnapshot {
    const meta = new Map(
      (this.database.prepare("SELECT key, value FROM meta_projection").all() as Array<{ key: string; value: string }>).map((row) => [row.key, JSON.parse(row.value)])
    );
    const sequence = this.database.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM local_events").get() as { sequence: number };
    return {
      operations: parseRows<LocalOperation>(this.database.prepare("SELECT payload FROM operation_projection ORDER BY id").all() as Array<{ payload: string }>),
      outbound: parseRows<OutboundRecord>(this.database.prepare("SELECT payload FROM outbox_projection ORDER BY event_id").all() as Array<{ payload: string }>),
      remoteCursor: (meta.get("remoteCursor") as number | undefined) ?? 0,
      capturedHashes: (meta.get("capturedHashes") as Record<string, string | null> | undefined) ?? {},
      gitState: meta.get("gitState") as GitState | undefined,
      materializationPaused: (meta.get("materializationPaused") as boolean | undefined) ?? false,
      eventSequence: sequence.sequence
    };
  }

  record(snapshot: Omit<DaemonSnapshot, "eventSequence">, event: LocalEvent): number {
    const validated = localEventSchema.parse(event);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const inserted = this.database.prepare("INSERT INTO local_events (type, created_at, payload) VALUES (?, ?, ?)").run(validated.type, new Date().toISOString(), JSON.stringify(validated.payload));
      this.replaceProjection("operation_projection", "id", snapshot.operations.map((operation) => [operation.id, operation]));
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
      // The diff cache was updated as statements ran; the rollback undid them on disk, so
      // re-read rather than leave the cache describing writes that never landed -- a stale
      // cache would make the next record() skip a row it thinks is already persisted.
      this.resyncWrittenProjections();
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
      remoteCursor: saved.remoteCursor ?? saved.cursor ?? 0
    };
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.replaceProjection("operation_projection", "id", snapshot.operations.map((operation) => [operation.id, operation]));
      this.replaceProjection("outbox_projection", "event_id", snapshot.outbound.map((record) => [record.event.id, record]));
      this.replaceMeta("remoteCursor", snapshot.remoteCursor);
      this.replaceMeta("capturedHashes", snapshot.capturedHashes);
      this.replaceMeta("gitState", snapshot.gitState);
      this.replaceMeta("materializationPaused", snapshot.materializationPaused);
      this.replaceMeta("projectionVersion", 1);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      this.resyncWrittenProjections();
      throw error;
    }
  }

  /**
   * Writes a projection table to match `values`, touching only the rows that actually
   * changed.
   *
   * This used to be `DELETE FROM <table>` followed by a re-INSERT of every row. Since
   * operations accumulate for the life of the checkout and `record()` runs on every
   * persisted event -- which for a watched worktree means every debounced filesystem
   * settle -- that made the cost of one edit proportional to the whole history, and the
   * cost of a session quadratic in it.
   *
   * `written` mirrors what is currently on disk (populated on open and kept in step
   * here), so the diff costs a string compare per row and the database sees only real
   * changes. It is the same data the daemon already holds in memory, serialized.
   */
  private replaceProjection(table: string, key: string, values: Array<[string, unknown]>): void {
    const next = new Map<string, string>();
    for (const [id, value] of values) next.set(id, JSON.stringify(value));
    const upsert = this.database.prepare(
      `INSERT INTO ${table} (${key}, payload) VALUES (?, ?) ON CONFLICT(${key}) DO UPDATE SET payload = excluded.payload`
    );

    if (this.desynced.has(table)) {
      // Cache state unknown: fall back to the unconditional rewrite, which is correct
      // whatever is on disk, and re-establish the cache from what we just wrote.
      this.database.exec(`DELETE FROM ${table}`);
      for (const [id, payload] of next) upsert.run(id, payload);
      this.desynced.delete(table);
      this.written.set(table, next);
      return;
    }

    const current = this.written.get(table) ?? new Map<string, string>();
    const remove = this.database.prepare(`DELETE FROM ${table} WHERE ${key} = ?`);
    for (const id of current.keys()) {
      if (!next.has(id)) remove.run(id);
    }
    for (const [id, payload] of next) {
      if (current.get(id) !== payload) upsert.run(id, payload);
    }
    this.written.set(table, next);
  }

  /** Seeds the diff cache from disk, so the first record() after open writes only changes. */
  private primeWrittenProjections(): void {
    for (const [table, key] of PROJECTION_TABLES) {
      const rows = this.database.prepare(`SELECT ${key} AS id, payload FROM ${table}`).all() as Array<{ id: string; payload: string }>;
      this.written.set(table, new Map(rows.map((row) => [row.id, row.payload])));
    }
    const meta = this.database.prepare("SELECT key, value FROM meta_projection").all() as Array<{ key: string; value: string }>;
    this.writtenMeta.clear();
    for (const row of meta) this.writtenMeta.set(row.key, row.value);
  }

  /**
   * Re-reads the diff cache after a rolled-back transaction left it ahead of disk. If even
   * that read fails, mark every table unknown rather than guessing: an empty cache would
   * look like "no rows on disk" and the next write would skip the deletes it owes.
   */
  private resyncWrittenProjections(): void {
    try {
      this.primeWrittenProjections();
    } catch {
      this.written.clear();
      this.writtenMeta.clear();
      for (const [table] of PROJECTION_TABLES) this.desynced.add(table);
    }
  }

  private replaceMeta(key: string, value: unknown): void {
    if (value === undefined) {
      if (this.writtenMeta.has(key)) {
        this.database.prepare("DELETE FROM meta_projection WHERE key = ?").run(key);
        this.writtenMeta.delete(key);
      }
      return;
    }
    const payload = JSON.stringify(value);
    if (this.writtenMeta.get(key) === payload) return;
    this.database.prepare("INSERT INTO meta_projection (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, payload);
    this.writtenMeta.set(key, payload);
  }
}
