import { createServer, type Server } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import chokidar, { type FSWatcher } from "chokidar";
import { contentHash, redactPath, transactionRisk } from "@crosscode/core";
import { discoverRepository, readRevisionFile, safeRepositoryPath, unifiedDiff } from "@crosscode/git";
import {
  captureRequestSchema,
  changeTransactionSchema,
  type CaptureKind,
  type ChangeTransaction,
  type EventEnvelope
} from "@crosscode/protocol";
import { configuredExcludedPaths, matchesConfiguredExclusion } from "./config.js";
import { DaemonStateStore, type GitState, type OutboundRecord } from "./state.js";
import type { LocalEvent } from "./local-event.js";
import type { LocalOperation } from "./types.js";

const exec = promisify(execFile);
const now = () => new Date().toISOString();
const git = async (root: string, args: string[]) => (await exec("git", ["-C", root, ...args])).stdout.trim();
function isBinaryContent(content: Buffer): boolean {
  const text = content.toString("utf8");
  return content.includes(0) || !Buffer.from(text, "utf8").equals(content);
}
function decodeText(content: Buffer, path: string): string {
  if (isBinaryContent(content)) throw new Error(`Binary files are not supported: ${path}`);
  return content.toString("utf8");
}
function assertChangeIntegrity(change: ChangeTransaction["changes"][number]): void {
  if (change.kind !== "delete") {
    if (change.afterContent === undefined) throw new Error(`Transaction content hash is invalid: ${change.path}`);
    const actual = change.afterEncoding === "base64" ? contentHash(Buffer.from(change.afterContent, "base64")) : contentHash(change.afterContent);
    if (change.afterHash !== actual) throw new Error(`Transaction content hash is invalid: ${change.path}`);
  }
}
/** Git's canonical empty tree, which every repository can name without it being written. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
/**
 * What to diff the working tree against. `HEAD` for any repository with a commit; the empty
 * tree before the first one, where `git diff HEAD` is a fatal "ambiguous argument" that took
 * the whole daemon down on startup. That is exactly the state `git init` leaves a new
 * project in, so it was the first thing a user starting from nothing hit. Diffing against
 * the empty tree reports staged-but-never-committed files as adds, which `ls-files --others`
 * would miss.
 */
async function diffBase(root: string): Promise<string> {
  return git(root, ["rev-parse", "-q", "--verify", "HEAD"]).then(() => "HEAD", () => EMPTY_TREE);
}

export type DaemonOptions = { workspaceId: string; replicaId: string; actorId: string; transport?: RemoteSyncTransport };

/**
 * The in-process coordination sink `capture()` optionally publishes to. Structural rather
 * than a named import of the service's `CoordinationService`, so the daemon does not
 * reach across an app boundary for a type; anything with these two methods fits.
 */
export type LocalCoordinationSink = {
  receive(event: EventEnvelope, transaction: ChangeTransaction): LocalOperation;
  list(workspaceId: string, afterSequence?: number): LocalOperation[];
};

/**
 * The service's answer when history retention has deleted everything after our cursor:
 * there is no page that would be honest, so it names the oldest cursor it can still serve
 * completely and we continue from there. See packages/protocol cursorTooOldResponseSchema.
 */
export type RemoteCursorTooOld = { status: "cursor-too-old"; resyncFrom: number; retentionDays: number };

export type RemoteSyncTransport = {
  upload(record: OutboundRecord): Promise<LocalOperation>;
  list(after: number): Promise<{ operations: LocalOperation[]; nextCursor: number } | RemoteCursorTooOld>;
};

export class LocalDaemon {
  readonly operations = new Map<string, LocalOperation>();
  readonly outbound = new Map<string, OutboundRecord>();
  private remoteCursor = 0;
  private eventSequence = 0;
  private readonly capturedHashes = new Map<string, string | null>();
  private gitState: GitState;
  private materializationPaused = false;
  private serviceStatus: { configured: boolean; online: boolean; lastSyncAt?: string; lastSyncError?: string } = { configured: false, online: false };
  // Kept apart from serviceStatus, which every successful sync replaces wholesale: a
  // retention resync is a gap in this replica's history and must stay visible afterwards.
  private lastResync: { at: string; message: string } | undefined;
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly transactionListeners = new Set<(operation: LocalOperation) => void>();
  private constructor(readonly root: string, readonly options: DaemonOptions, private readonly state: DaemonStateStore, gitState: GitState) { this.gitState = gitState; }

  static async open(directory: string, options: DaemonOptions): Promise<LocalDaemon> {
    const repository = await discoverRepository(directory); const statePath = await git(repository.root, ["rev-parse", "--git-path", "crosscode/state.sqlite"]); const state = await DaemonStateStore.open(resolve(repository.root, statePath)); const saved = state.load(); const daemon = new LocalDaemon(repository.root, options, state, saved.gitState ?? { head: repository.head, headReflog: repository.headReflog, branch: repository.branch, worktree: repository.worktree, indexTree: repository.indexTree, operation: repository.operation });
    for (const operation of saved.operations) daemon.operations.set(operation.id, { ...operation, transaction: changeTransactionSchema.parse(operation.transaction) });
    for (const record of saved.outbound) daemon.outbound.set(record.event.id, record); daemon.remoteCursor = saved.remoteCursor; daemon.eventSequence = saved.eventSequence; daemon.materializationPaused = saved.materializationPaused; for (const [path, hash] of Object.entries(saved.capturedHashes)) daemon.capturedHashes.set(path, hash); return daemon;
  }
  /**
   * The public workspace status, served by `GET /v1/status` and surfaced verbatim by the
   * CLI's `crosscode status` and the MCP `get_workspace_state` tool.
   *
   * The repository fields are listed one by one rather than spread. Spreading leaked
   * `headReflog` -- an internal change-detection sentinel that joins a commit hash to its
   * reflog subject with a raw NUL -- into the first output every agent reads. Naming the
   * fields makes this an intentional contract, so the next field added to RepositoryState
   * is private until someone decides otherwise rather than published by accident.
   */
  async status() { const repository = await discoverRepository(this.root); return { root: repository.root, head: repository.head, branch: repository.branch, worktree: repository.worktree, remotes: repository.remotes, dirty: repository.dirty, indexTree: repository.indexTree, operation: repository.operation, workspaceId: this.options.workspaceId, replicaId: this.options.replicaId, materializationPaused: this.materializationPaused, eventSequence: this.eventSequence, remoteCursor: this.remoteCursor, pendingOutbound: [...this.outbound.values()].filter((record) => record.acknowledgedServerSequence === undefined).length, service: { ...this.serviceStatus, ...(this.lastResync ? { lastResyncAt: this.lastResync.at, lastResyncMessage: this.lastResync.message } : {}) } }; }
  configureRemoteSync(): void { this.serviceStatus = { ...this.serviceStatus, configured: true }; }
  recordRemoteSyncFailure(): void { this.serviceStatus = { ...this.serviceStatus, configured: true, online: false, lastSyncError: "Coordination service is unavailable" }; }
  async observeGitTransition(): Promise<{ kind: "unchanged" | "branch-switch" | "head-changed" | "index-changed" | "git-operation" | "reset"; paused: boolean }> {
    const repository = await discoverRepository(this.root); const current = { head: repository.head, headReflog: repository.headReflog, branch: repository.branch, worktree: repository.worktree, indexTree: repository.indexTree, operation: repository.operation };
    if (current.head === this.gitState.head && current.headReflog === this.gitState.headReflog && current.branch === this.gitState.branch && current.worktree === this.gitState.worktree && current.indexTree === this.gitState.indexTree && current.operation === this.gitState.operation) return { kind: "unchanged", paused: this.materializationPaused };
    const kind = current.branch !== this.gitState.branch ? "branch-switch" : current.operation !== this.gitState.operation ? "git-operation" : current.head !== this.gitState.head ? "head-changed" : current.headReflog !== this.gitState.headReflog ? "reset" : "index-changed";
    this.materializationPaused = true; await this.persist("git.materialization_paused", { kind, previous: this.gitState, current });
    this.gitState = current; this.capturedHashes.clear(); await this.persist("git.head_changed", { kind, current });
    return { kind, paused: true };
  }
  async flush(): Promise<void> {}
  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }
  async drain(): Promise<void> { await this.mutationTail; }
  close(): void { this.state.close(); }
  onTransaction(listener: (operation: LocalOperation) => void): () => void { this.transactionListeners.add(listener); return () => this.transactionListeners.delete(listener); }
  async watch(options: { debounceMs?: number; onError?: (error: unknown) => void } = {}): Promise<FSWatcher> {
    const debounceMs = options.debounceMs ?? 500;
    let timer: NodeJS.Timeout | undefined;
    let capturing = false;
    let closed = false;
    const watcher = chokidar.watch(this.root, { ignored: (path) => this.ignoredPath(path), ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: debounceMs, pollInterval: 20 } });
    const settle = () => {
      if (closed) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        if (capturing || closed) return;
        capturing = true;
        try {
          const operation = await this.runExclusive(() => this.capture("Settled filesystem edits"));
          this.transactionListeners.forEach((listener) => listener(operation));
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "No eligible working-tree changes to capture") (options.onError ?? console.error)(error);
        } finally { capturing = false; }
      }, debounceMs);
    };
    watcher.on("add", settle).on("change", settle).on("unlink", settle);
    const closeWatcher = watcher.close.bind(watcher);
    watcher.close = async () => { closed = true; if (timer) clearTimeout(timer); return closeWatcher(); };
    await new Promise<void>((resolveReady) => watcher.once("ready", resolveReady));
    return watcher;
  }

  async capture(intent: string, service?: LocalCoordinationSink, kind: CaptureKind = "intent"): Promise<LocalOperation> {
    let snapshot: { repository: Awaited<ReturnType<typeof discoverRepository>>; changes: Array<{ path: string; kind: "add" | "modify" | "delete" | "rename"; previousPath?: string; beforeHash?: string; afterHash?: string; afterContent?: string; afterEncoding?: "base64"; unifiedPatch?: string }> } | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const repository = await discoverRepository(this.root); const names = await this.changedPaths();
      if (!names.length) throw new Error("No eligible working-tree changes to capture");
      const changes = await Promise.all(names.map(async ({ path, kind, previousPath }) => {
        await this.eligiblePath(path);
        const beforeBytes = kind === "add" ? undefined : await readRevisionFile(this.root, "HEAD", kind === "rename" ? previousPath! : path).catch(() => undefined);
        const afterBytes = kind === "delete" ? undefined : await this.readWorkingBuffer(path);
        const binary = (beforeBytes !== undefined && isBinaryContent(beforeBytes)) || (afterBytes !== undefined && isBinaryContent(afterBytes));
        if (!binary) {
          const before = beforeBytes === undefined ? undefined : decodeText(beforeBytes, path);
          const after = afterBytes === undefined ? undefined : decodeText(afterBytes, path);
          const unifiedPatch = await unifiedDiff(before, after);
          return { path, kind, previousPath, beforeHash: before === undefined ? undefined : contentHash(before), afterHash: after === undefined ? undefined : contentHash(after), afterContent: after, unifiedPatch };
        }
        return {
          path, kind, previousPath,
          beforeHash: beforeBytes === undefined ? undefined : contentHash(beforeBytes),
          afterHash: afterBytes === undefined ? undefined : contentHash(afterBytes),
          afterContent: afterBytes === undefined ? undefined : afterBytes.toString("base64"),
          afterEncoding: afterBytes === undefined ? undefined : "base64" as const,
          unifiedPatch: undefined
        };
      }));
      if (!(await this.snapshotIsStable(repository, changes))) continue;
      snapshot = { repository, changes };
      break;
    }
    if (!snapshot) throw new Error("Working tree changed while assembling a transaction; retry the capture");
    const { repository, changes } = snapshot;
    const transaction = changeTransactionSchema.parse({ id: randomUUID(), intent, kind, base: { headCommit: repository.head, files: changes.filter((change) => change.beforeHash).map((change) => ({ path: change.path, contentHash: change.beforeHash! })) }, changes, provenance: { source: "filesystem", confidence: "known" }, safety: { risk: transactionRisk({ changes }), requiresApproval: transactionRisk({ changes }) === "critical" } });
    const local = { id: transaction.id, workspaceId: this.options.workspaceId, senderReplicaId: this.options.replicaId, transaction, sequence: 0, createdAt: now() };
    const event = { id: transaction.id, schemaVersion: 1 as const, workspaceId: this.options.workspaceId, replicaId: this.options.replicaId, actorId: this.options.actorId, type: "transaction.created", clientSequence: this.eventSequence + 1, createdAt: now(), payload: transaction };
    const outbound = { event, transaction };
    const previousHashes = changes.map((change) => [change.path, this.capturedHashes.get(change.path)] as const);
    changes.forEach((change) => this.capturedHashes.set(change.path, change.afterHash ?? null));
    this.operations.set(local.id, local);
    this.outbound.set(event.id, outbound);
    try { await this.persist("transaction.created", local); }
    catch (error) {
      this.operations.delete(local.id);
      this.outbound.delete(event.id);
      previousHashes.forEach(([path, hash]) => { if (hash === undefined) this.capturedHashes.delete(path); else this.capturedHashes.set(path, hash); });
      throw error;
    }
    if (!service) return local;
    const published = service.receive(event, transaction);
    this.operations.set(published.id, published);
    this.outbound.set(event.id, { ...outbound, acknowledgedServerSequence: published.sequence });
    try { await this.persist("transaction.published", published); }
    catch (error) { this.operations.set(local.id, local); this.outbound.set(event.id, outbound); throw error; }
    return published;
  }

  async syncRemote(transport: RemoteSyncTransport): Promise<{ uploaded: number; downloaded: number; cursor: number }> {
    let uploaded = 0;
    for (const record of [...this.outbound.values()].filter((item) => item.acknowledgedServerSequence === undefined).sort((left, right) => left.event.clientSequence - right.event.clientSequence)) {
      const remote = await transport.upload(record);
      if (remote.id !== record.transaction.id || remote.workspaceId !== this.options.workspaceId || remote.senderReplicaId !== this.options.replicaId) throw new Error("Service acknowledgement did not match the outbound operation");
      const existing = this.operations.get(remote.id);
      if (existing) this.operations.set(remote.id, { ...existing, sequence: remote.sequence, createdAt: remote.createdAt });
      this.outbound.set(record.event.id, { ...record, acknowledgedServerSequence: remote.sequence });
      try { await this.persist("transaction.published", { eventId: record.event.id, operationId: remote.id, serverSequence: remote.sequence }); }
      catch (error) {
        this.outbound.set(record.event.id, record);
        if (existing) this.operations.set(remote.id, existing);
        throw error;
      }
      uploaded += 1;
    }
    let page = await transport.list(this.remoteCursor);
    if ("status" in page) {
      // Our cursor points into history the service no longer keeps. Re-listing from the
      // watermark is the whole recovery; a second refusal means the watermark moved again
      // mid-resync (or the service is answering nonsense), and that is worth failing on
      // rather than looping.
      await this.resyncFromRetentionWatermark(page);
      page = await transport.list(this.remoteCursor);
      if ("status" in page) throw new Error("Coordination service refused the cursor it just told us to resynchronize from");
    }
    const listed = page;
    // The service assigns dense per-workspace sequences, so a gap means an operation went
    // missing between there and here -- which is why this check exists and why it stays
    // exact.
    const covered = listed.operations.map((operation) => operation.sequence).sort((left, right) => left - right);
    const ordered = covered.every((sequence, index) => sequence === (index === 0 ? this.remoteCursor + 1 : covered[index - 1]! + 1));
    const expectedCursor = covered.at(-1) ?? this.remoteCursor;
    if (!ordered || listed.nextCursor !== expectedCursor || listed.operations.some((operation) => operation.workspaceId !== this.options.workspaceId || operation.sequence <= this.remoteCursor)) throw new Error("Service cursor response was invalid");
    const previousCursor = this.remoteCursor;
    const insertedIds: string[] = [];
    let downloaded = 0;
    for (const remote of listed.operations) {
      const transaction = changeTransactionSchema.parse(remote.transaction);
      transaction.changes.forEach(assertChangeIntegrity);
      if (remote.senderReplicaId === this.options.replicaId || this.operations.has(remote.id)) continue;
      this.operations.set(remote.id, { ...remote, transaction });
      insertedIds.push(remote.id);
      downloaded += 1;
    }
    if (listed.nextCursor !== this.remoteCursor || downloaded) {
      this.remoteCursor = listed.nextCursor;
      try { await this.persist("remote.synchronized", { cursor: this.remoteCursor, downloaded }); }
      catch (error) {
        this.remoteCursor = previousCursor;
        insertedIds.forEach((id) => this.operations.delete(id));
        throw error;
      }
    }
    this.serviceStatus = { configured: true, online: true, lastSyncAt: now() };
    return { uploaded, downloaded, cursor: this.remoteCursor };
  }

  /**
   * Adopts the oldest cursor the service can still serve, after it reported that ours has
   * fallen out of the workspace's history retention window. Nothing can bring the deleted
   * operations back, so the only alternative to jumping forward is polling an unservable
   * cursor forever.
   *
   * What a resync costs is other replicas' changes this one never downloaded and now never
   * will. It costs nothing that Git holds -- commits, the working tree, and our own
   * outbound queue are untouched -- which is exactly why moving the cursor is the right
   * answer rather than a data-loss bug. The event log and `status().service` both record it
   * so the gap is visible after the fact.
   */
  private async resyncFromRetentionWatermark(status: RemoteCursorTooOld): Promise<void> {
    const previousCursor = this.remoteCursor;
    // A watermark at or below our cursor contradicts the refusal itself: the service can
    // serve this cursor. Rewinding on it would re-download operations we already have.
    if (status.resyncFrom <= previousCursor) throw new Error("Service asked for a resync to a cursor it can already serve");
    this.remoteCursor = status.resyncFrom;
    this.lastResync = {
      at: now(),
      message: `Coordination service no longer retains operations at or below sequence ${status.resyncFrom} (plan history retention is ${status.retentionDays} days); resynchronized from sequence ${previousCursor} to ${status.resyncFrom}. Changes inside that window were not downloaded and are gone; Git history and the working tree are unaffected.`
    };
    try { await this.persist("remote.resync_required", { cursor: this.remoteCursor, previousCursor, retentionDays: status.retentionDays }); }
    catch (error) {
      this.remoteCursor = previousCursor;
      this.lastResync = undefined;
      throw error;
    }
    process.stderr.write(`${this.lastResync.message}\n`);
  }

  async sync(service: LocalCoordinationSink): Promise<LocalOperation[]> {
    const incoming = service.list(this.options.workspaceId, this.remoteCursor); this.remoteCursor = Math.max(this.remoteCursor, ...incoming.map((operation) => operation.sequence), 0);
    const received = incoming.filter((operation) => operation.senderReplicaId !== this.options.replicaId).map((operation) => {
      const stored = { ...operation, transaction: changeTransactionSchema.parse(operation.transaction) };
      this.operations.set(stored.id, stored);
      return stored;
    });
    await this.persist("remote.synchronized", { cursor: this.remoteCursor, downloaded: received.length });
    return received;
  }
  private async changedPaths(): Promise<Array<{ path: string; kind: "add" | "modify" | "delete" | "rename"; previousPath?: string }>> {
    const [base, untracked, exclusions] = await Promise.all([diffBase(this.root), git(this.root, ["ls-files", "-z", "--others", "--exclude-standard"]), configuredExcludedPaths(this.root)]);
    const tracked = await git(this.root, ["diff", "--name-status", "-z", "-M", base]);
    const trackedParts = tracked.split("\0").filter(Boolean);
    const changed: Array<{ path: string; kind: "add" | "modify" | "delete" | "rename"; previousPath?: string }> = [];
    for (let index = 0; index < trackedParts.length;) {
      const status = trackedParts[index]!;
      if (status.startsWith("R")) {
        const oldPath = trackedParts[index + 1]!;
        const newPath = trackedParts[index + 2]!;
        changed.push({ path: newPath, kind: "rename" as const, previousPath: oldPath });
        index += 3;
      } else {
        const path = trackedParts[index + 1]!;
        changed.push({ path, kind: status === "D" ? "delete" as const : status === "A" ? "add" as const : "modify" as const });
        index += 2;
      }
    }
    const candidates = [...changed, ...untracked.split("\0").filter(Boolean).map((path) => ({ path, kind: "add" as const }))].filter((change) => !this.ignoredPath(change.path) && !matchesConfiguredExclusion(change.path, exclusions));
    return (await Promise.all(candidates.map(async (change) => {
      const content = change.kind === "delete" ? undefined : await this.readWorkingBuffer(change.path);
      const currentHash = content === undefined ? null : contentHash(content);
      return this.capturedHashes.get(change.path) === currentHash ? undefined : change;
    }))).filter((change): change is { path: string; kind: "add" | "modify" | "delete" | "rename"; previousPath?: string } => Boolean(change));
  }
  private async snapshotIsStable(repository: Awaited<ReturnType<typeof discoverRepository>>, changes: Array<{ path: string; kind: "add" | "modify" | "delete" | "rename"; afterHash?: string }>): Promise<boolean> {
    const latest = await discoverRepository(this.root);
    if (latest.head !== repository.head || latest.headReflog !== repository.headReflog || latest.branch !== repository.branch || latest.worktree !== repository.worktree || latest.indexTree !== repository.indexTree || latest.operation !== repository.operation) return false;
    const current = await this.changedPaths();
    if (current.length !== changes.length || current.some((change) => !changes.some((snapshot) => snapshot.path === change.path && snapshot.kind === change.kind))) return false;
    return (await Promise.all(changes.map(async (change) => {
      const content = change.kind === "delete" ? undefined : await this.readWorkingBuffer(change.path);
      return (content === undefined ? undefined : contentHash(content)) === change.afterHash;
    }))).every(Boolean);
  }
  private async eligiblePath(path: string): Promise<string> {
    if (redactPath(path) || matchesConfiguredExclusion(path, await configuredExcludedPaths(this.root))) throw new Error(`Refusing excluded path: ${path}`);
    return safeRepositoryPath(this.root, path);
  }
  private async readWorkingBuffer(path: string): Promise<Buffer | undefined> {
    const absolute = await safeRepositoryPath(this.root, path);
    try { return await readFile(absolute); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  private ignoredPath(path: string): boolean { const relative = path.startsWith(this.root) ? path.slice(this.root.length + 1) : path; return /(^|\/)(\.git|node_modules|dist|build|coverage)(\/|$)/.test(relative) || /(^|\/)\.[^/]+\.[0-9a-f-]+\.crosscode$/.test(relative) || redactPath(relative); }
  private async persist<T extends LocalEvent["type"]>(type: T, payload: Extract<LocalEvent, { type: T }>["payload"]): Promise<void> { this.eventSequence = this.state.record({ operations: [...this.operations.values()], outbound: [...this.outbound.values()], remoteCursor: this.remoteCursor, capturedHashes: Object.fromEntries(this.capturedHashes), gitState: this.gitState, materializationPaused: this.materializationPaused }, { type, payload } as LocalEvent); }
}

const MAX_BODY_BYTES = 1024 * 1024;

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function sendJson(response: import("node:http").ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request: import("node:http").IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") throw new HttpError(415, "Unsupported content type");
  const length = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) { request.resume(); throw new HttpError(413, "Request body too large"); }
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let oversized = false;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { oversized = true; chunks.length = 0; return; }
      if (!oversized) chunks.push(chunk);
    });
    request.on("error", rejectBody);
    request.on("end", () => {
      if (oversized) { rejectBody(new HttpError(413, "Request body too large")); return; }
      try { resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { rejectBody(new HttpError(400, "Malformed JSON")); }
    });
  });
}

export type RunningDaemon = { daemon: LocalDaemon; server: Server; port: number; secret: string; close: () => Promise<void> };

export async function startDaemon(directory: string, options: DaemonOptions, port = 0): Promise<RunningDaemon> {
  const daemon = await LocalDaemon.open(directory, options);
  const secret = randomBytes(32).toString("base64url");
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${secret}`) { sendJson(response, 401, { ok: false, error: "Unauthorized" }); return; }
    try {
      const method = request.method ?? "GET";
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      const payload = method === "POST" || method === "PUT" ? await readJsonBody(request) : undefined;
      const result = await daemon.runExclusive(async () => {
        let status = 200;
        let data: unknown;
        if (method === "GET" && pathname === "/v1/status") data = await daemon.status();
        else if (method === "GET" && pathname === "/v1/workspace") data = { root: daemon.root, workspaceId: daemon.options.workspaceId, replicaId: daemon.options.replicaId, actorId: daemon.options.actorId };
        else if (method === "GET" && pathname === "/v1/operations") data = [...daemon.operations.values()];
        else if (method === "POST" && pathname === "/v1/transactions") { const parsed = captureRequestSchema.parse(payload); data = await daemon.capture(parsed.intent, undefined, parsed.kind ?? "intent"); status = 201; }
        else throw new HttpError(404, "Not found");
        return { status, data };
      });
      sendJson(response, result.status, { ok: true, data: result.data });
    } catch (error) {
      if (error instanceof HttpError) { sendJson(response, error.status, { ok: false, error: error.message }); return; }
      if (error && typeof error === "object" && "name" in error && error.name === "ZodError") { sendJson(response, 400, { ok: false, error: "Invalid request" }); return; }
      // The caller already proved it holds the daemon's secret over loopback, so it is
      // as trusted as the process itself -- there is nothing to withhold from it, and a
      // bare "Request failed" left every real failure (a stale base, an unreadable file)
      // undiagnosable from the CLI or an agent. The repository root is still masked so
      // absolute paths stay out of agent transcripts.
      const detail = error instanceof Error ? error.message.replaceAll(daemon.root, "<repository>") : "Unknown error";
      console.error("Crosscode request failed", detail);
      sendJson(response, 500, { ok: false, error: detail });
    }
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", () => { server.off("error", rejectListen); resolveListen(); });
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    const closing = new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
    server.closeAllConnections();
    await closing;
    await daemon.drain();
    daemon.close();
  };
  return { daemon, server, port: (server.address() as { port: number }).port, secret, close };
}
