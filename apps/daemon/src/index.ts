import { createServer, type Server } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import chokidar, { type FSWatcher } from "chokidar";
import { analyzeOperation, changedExportedSymbols, contentHash, hunksOverlap, looksLikeInterfaceChange, pathOverlaps, redactPath, transactionRisk, type OperationAnalysis } from "@crosscode/core";
import { createCheckpoint, discoverRepository, findSymbolReferences, inspectCheckpoint, readRevisionFile, restoreCheckpointFile, safeRepositoryPath, snapshotWorktreeTree, threeWayMerge } from "@crosscode/git";
import {
  captureRequestSchema,
  changeTransactionSchema,
  checkpointInspectRequestSchema,
  checkpointRequestSchema,
  checkpointRestoreRequestSchema,
  claimRequestSchema,
  claimSchema,
  handoffRequestSchema,
  handoffRespondRequestSchema,
  handoffSchema,
  intentRequestSchema,
  intentSchema,
  taskRequestSchema,
  taskSchema,
  validationRequestSchema,
  EPOCH_CURSOR,
  type CaptureKind,
  type ChangeTransaction,
  type Claim,
  type ClaimCreatedEvent,
  type ClaimReleasedEvent,
  type Handoff,
  type HandoffRequestedEvent,
  type HandoffRespondedEvent,
  type Intent,
  type IntentPublishedEvent,
  type RemoteClaim,
  type RemoteHandoff,
  type RemoteIntent,
  type RemoteTask,
  type Task,
  type TaskCreatedEvent,
  type TaskUpdatedEvent,
  type Validation
} from "@crosscode/protocol";
import type { CoordinationService } from "../../service/src/index.js";
import { configuredExcludedPaths, matchesConfiguredExclusion, validationCommands } from "./config.js";
import { DaemonStateStore, type CheckpointRecord, type ClaimOutboundRecord, type GitState, type HandoffOutboundRecord, type IntentOutboundRecord, type OutboundRecord, type TaskOutboundRecord } from "./state.js";
import type { StoredOperation } from "./types.js";

const exec = promisify(execFile);
const now = () => new Date().toISOString();
const git = async (root: string, args: string[]) => (await exec("git", ["-C", root, ...args])).stdout.trim();
function decodeText(content: Buffer, path: string): string {
  const text = content.toString("utf8");
  if (content.includes(0) || !Buffer.from(text, "utf8").equals(content)) throw new Error(`Binary files are not supported: ${path}`);
  return text;
}
function assertText(content: string, path: string): void {
  if (content.includes("\0") || Buffer.from(content, "utf8").toString("utf8") !== content) throw new Error(`Binary or invalid text content is not supported: ${path}`);
}
function assertChangeIntegrity(change: ChangeTransaction["changes"][number]): void {
  if (change.kind !== "delete") {
    if (change.afterContent === undefined || change.afterHash !== contentHash(change.afterContent)) throw new Error(`Transaction content hash is invalid: ${change.path}`);
  }
}
function changesOverlap(left: ChangeTransaction["changes"][number], right: ChangeTransaction["changes"][number]): boolean {
  if (left.kind === "delete" || right.kind === "delete") return true;
  return hunksOverlap(left.unifiedPatch, right.unifiedPatch);
}
export type DaemonOptions = { workspaceId: string; replicaId: string; actorId: string };
export type RemoteSyncTransport = {
  upload(record: OutboundRecord): Promise<import("../../service/src/index.js").RemoteOperation>;
  list(after: number): Promise<{ operations: import("../../service/src/index.js").RemoteOperation[]; nextCursor: number }>;
  uploadTask(record: TaskOutboundRecord): Promise<RemoteTask>;
  listTasks(after: string): Promise<{ tasks: RemoteTask[]; nextCursor: string }>;
  uploadClaim(record: ClaimOutboundRecord): Promise<RemoteClaim>;
  listClaims(after: string): Promise<{ claims: RemoteClaim[]; nextCursor: string }>;
  uploadHandoff(record: HandoffOutboundRecord): Promise<RemoteHandoff>;
  listHandoffs(after: string): Promise<{ handoffs: RemoteHandoff[]; nextCursor: string }>;
  uploadIntent(record: IntentOutboundRecord): Promise<RemoteIntent>;
  listIntents(after: string): Promise<{ intents: RemoteIntent[]; nextCursor: string }>;
};

export class LocalDaemon {
  readonly tasks = new Map<string, Task>(); readonly claims = new Map<string, Claim>(); readonly operations = new Map<string, StoredOperation>(); readonly validations: Validation[] = []; readonly checkpoints: CheckpointRecord[] = []; readonly handoffs = new Map<string, Handoff>(); readonly intents = new Map<string, Intent>();
  readonly outbound = new Map<string, OutboundRecord>();
  readonly taskOutbound = new Map<string, TaskOutboundRecord>(); readonly claimOutbound = new Map<string, ClaimOutboundRecord>();
  readonly handoffOutbound = new Map<string, HandoffOutboundRecord>(); readonly intentOutbound = new Map<string, IntentOutboundRecord>();
  private remoteCursor = 0;
  private remoteTaskCursor = EPOCH_CURSOR;
  private remoteClaimCursor = EPOCH_CURSOR;
  private remoteHandoffCursor = EPOCH_CURSOR;
  private remoteIntentCursor = EPOCH_CURSOR;
  private eventSequence = 0;
  private readonly capturedHashes = new Map<string, string | null>();
  private gitState: GitState;
  private materializationPaused = false;
  private serviceStatus: { configured: boolean; online: boolean; lastSyncAt?: string; lastSyncError?: string } = { configured: false, online: false };
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly transactionListeners = new Set<(operation: StoredOperation) => void>();
  private constructor(readonly root: string, readonly options: DaemonOptions, private readonly state: DaemonStateStore, gitState: GitState) { this.gitState = gitState; }

  static async open(directory: string, options: DaemonOptions): Promise<LocalDaemon> {
    const repository = await discoverRepository(directory); const statePath = await git(repository.root, ["rev-parse", "--git-path", "crosscode/state.sqlite"]); const state = await DaemonStateStore.open(resolve(repository.root, statePath)); const saved = state.load(); const daemon = new LocalDaemon(repository.root, options, state, saved.gitState ?? { head: repository.head, headReflog: repository.headReflog, branch: repository.branch, worktree: repository.worktree, indexTree: repository.indexTree, operation: repository.operation });
    for (const task of saved.tasks) daemon.tasks.set(task.id, task); for (const claim of saved.claims) daemon.claims.set(claim.id, claim);
    for (const operation of saved.operations) {
      const transaction = changeTransactionSchema.parse(operation.transaction);
      const risk = transactionRisk(transaction);
      daemon.operations.set(operation.id, { ...operation, transaction: { ...transaction, safety: { risk, requiresApproval: risk === "critical" } } });
    }
    daemon.validations.push(...saved.validations); daemon.checkpoints.push(...saved.checkpoints); for (const handoff of saved.handoffs) daemon.handoffs.set(handoff.id, handoff); for (const intent of saved.intents) daemon.intents.set(intent.id, intent); for (const record of saved.outbound) daemon.outbound.set(record.event.id, record); for (const record of saved.taskOutbound) daemon.taskOutbound.set(record.event.id, record); for (const record of saved.claimOutbound) daemon.claimOutbound.set(record.event.id, record); for (const record of saved.handoffOutbound) daemon.handoffOutbound.set(record.event.id, record); for (const record of saved.intentOutbound) daemon.intentOutbound.set(record.event.id, record); daemon.remoteCursor = saved.remoteCursor; daemon.remoteTaskCursor = saved.remoteTaskCursor; daemon.remoteClaimCursor = saved.remoteClaimCursor; daemon.remoteHandoffCursor = saved.remoteHandoffCursor; daemon.remoteIntentCursor = saved.remoteIntentCursor; daemon.eventSequence = saved.eventSequence; daemon.materializationPaused = saved.materializationPaused; for (const [path, hash] of Object.entries(saved.capturedHashes)) daemon.capturedHashes.set(path, hash); await daemon.reconcileInterruptedMaterializations(); return daemon;
  }
  async status() { const repository = await discoverRepository(this.root); return { ...repository, workspaceId: this.options.workspaceId, replicaId: this.options.replicaId, tasks: this.tasks.size, claims: this.claims.size, proposals: [...this.operations.values()].filter((operation) => operation.status === "proposed").length, materializationPaused: this.materializationPaused, eventSequence: this.eventSequence, remoteCursor: this.remoteCursor, pendingOutbound: [...this.outbound.values()].filter((record) => record.acknowledgedServerSequence === undefined).length, service: { ...this.serviceStatus } }; }
  configureRemoteSync(): void { this.serviceStatus = { ...this.serviceStatus, configured: true }; }
  recordRemoteSyncFailure(): void { this.serviceStatus = { ...this.serviceStatus, configured: true, online: false, lastSyncError: "Coordination service is unavailable" }; }
  async createTask(input: Pick<Task, "title"> & Partial<Pick<Task, "intent" | "paths" | "status">>): Promise<Task> {
    const task = taskSchema.parse({ id: randomUUID(), title: input.title, ownerId: this.options.actorId, status: input.status ?? "active", intent: input.intent, paths: input.paths ?? [], createdAt: now(), updatedAt: now() });
    const event: TaskCreatedEvent = { id: task.id, schemaVersion: 1, workspaceId: this.options.workspaceId, replicaId: this.options.replicaId, actorId: this.options.actorId, type: "task.created", clientSequence: this.eventSequence + 1, createdAt: now(), payload: task };
    const previous = this.tasks.get(task.id);
    this.tasks.set(task.id, task);
    this.taskOutbound.set(event.id, { event });
    try { await this.persist("task.created", task); }
    catch (error) { if (previous) this.tasks.set(task.id, previous); else this.tasks.delete(task.id); this.taskOutbound.delete(event.id); throw error; }
    return task;
  }
  async updateTask(id: string, input: Pick<Task, "title"> & Partial<Pick<Task, "intent" | "paths" | "status">>): Promise<Task> {
    const previous = this.tasks.get(id);
    if (!previous) throw new Error("Task was not found");
    const task = taskSchema.parse({ ...previous, title: input.title, status: input.status ?? previous.status, intent: input.intent, paths: input.paths ?? previous.paths, updatedAt: now() });
    const event: TaskUpdatedEvent = { id: task.id, schemaVersion: 1, workspaceId: this.options.workspaceId, replicaId: this.options.replicaId, actorId: this.options.actorId, type: "task.updated", clientSequence: this.eventSequence + 1, createdAt: now(), payload: task };
    this.tasks.set(task.id, task);
    this.taskOutbound.set(event.id, { event });
    try { await this.persist("task.updated", task); }
    catch (error) { this.tasks.set(id, previous); this.taskOutbound.delete(event.id); throw error; }
    return task;
  }
  async createClaim(input: Omit<Claim, "id" | "ownerId" | "createdAt">): Promise<Claim> {
    const claim = claimSchema.parse({ ...input, id: randomUUID(), ownerId: this.options.actorId, createdAt: now() });
    const event: ClaimCreatedEvent = { id: claim.id, schemaVersion: 1, workspaceId: this.options.workspaceId, replicaId: this.options.replicaId, actorId: this.options.actorId, type: "claim.created", clientSequence: this.eventSequence + 1, createdAt: now(), payload: claim };
    this.claims.set(claim.id, claim);
    this.claimOutbound.set(event.id, { event });
    try { await this.persist("claim.created", claim); }
    catch (error) { this.claims.delete(claim.id); this.claimOutbound.delete(event.id); throw error; }
    return claim;
  }
  async releaseClaim(id: string): Promise<Claim> {
    const claim = this.claims.get(id);
    if (!claim) throw new Error("Claim was not found");
    const event: ClaimReleasedEvent = { id: claim.id, schemaVersion: 1, workspaceId: this.options.workspaceId, replicaId: this.options.replicaId, actorId: this.options.actorId, type: "claim.released", clientSequence: this.eventSequence + 1, createdAt: now(), payload: claim };
    this.claims.delete(id);
    this.claimOutbound.set(event.id, { event });
    try { await this.persist("claim.released", claim); }
    catch (error) { this.claims.set(id, claim); this.claimOutbound.delete(event.id); throw error; }
    return claim;
  }
  async checkpoint(message = "Crosscode safety checkpoint") {
    const checkpoint = await createCheckpoint(this.root, this.options.replicaId, message);
    const record = { ...checkpoint, message, createdAt: now() };
    this.checkpoints.push(record);
    try { await this.persist("checkpoint.created", record); } catch (error) { this.checkpoints.pop(); throw error; }
    return checkpoint;
  }
  async inspectCheckpoint(ref: string) { return inspectCheckpoint(this.root, ref); }
  async requestHandoff(input: { operationId: string; note?: string }): Promise<Handoff> {
    const handoff = handoffSchema.parse({ id: randomUUID(), operationId: input.operationId, requestedBy: this.options.actorId, note: input.note, status: "pending", createdAt: now() });
    const event: HandoffRequestedEvent = { id: handoff.id, schemaVersion: 1, workspaceId: this.options.workspaceId, replicaId: this.options.replicaId, actorId: this.options.actorId, type: "handoff.requested", clientSequence: this.eventSequence + 1, createdAt: now(), payload: handoff };
    this.handoffs.set(handoff.id, handoff);
    this.handoffOutbound.set(event.id, { event });
    try { await this.persist("handoff.requested", handoff); }
    catch (error) { this.handoffs.delete(handoff.id); this.handoffOutbound.delete(event.id); throw error; }
    return handoff;
  }
  async respondHandoff(id: string, decision: "accepted" | "declined"): Promise<Handoff> {
    const handoff = this.handoffs.get(id); if (!handoff || handoff.status !== "pending") throw new Error("Handoff was not found");
    const responded = { ...handoff, status: decision, respondedAt: now() };
    const event: HandoffRespondedEvent = { id: responded.id, schemaVersion: 1, workspaceId: this.options.workspaceId, replicaId: this.options.replicaId, actorId: this.options.actorId, type: "handoff.responded", clientSequence: this.eventSequence + 1, createdAt: now(), payload: responded };
    this.handoffs.set(id, responded);
    this.handoffOutbound.set(event.id, { event });
    try { await this.persist("handoff.responded", responded); }
    catch (error) { this.handoffs.set(id, handoff); this.handoffOutbound.delete(event.id); throw error; }
    return responded;
  }
  async publishIntent(input: { text: string; taskId?: string }): Promise<Intent> {
    const intent = intentSchema.parse({ id: randomUUID(), taskId: input.taskId, actorId: this.options.actorId, text: input.text, createdAt: now() });
    const event: IntentPublishedEvent = { id: intent.id, schemaVersion: 1, workspaceId: this.options.workspaceId, replicaId: this.options.replicaId, actorId: this.options.actorId, type: "intent.published", clientSequence: this.eventSequence + 1, createdAt: now(), payload: intent };
    this.intents.set(intent.id, intent);
    this.intentOutbound.set(event.id, { event });
    try { await this.persist("intent.published", intent); }
    catch (error) { this.intents.delete(intent.id); this.intentOutbound.delete(event.id); throw error; }
    return intent;
  }
  async restoreCheckpointFile(ref: string, path: string): Promise<void> {
    await this.eligiblePath(path);
    await this.checkpoint(`Before restoring ${path}`); await this.restoreEligibleCheckpointFile(ref, path);
    const content = await this.readWorkingText(path); this.capturedHashes.set(path, content === undefined ? null : contentHash(content)); await this.persist("checkpoint.restored", { ref, path });
  }
  async observeGitTransition(): Promise<{ kind: "unchanged" | "branch-switch" | "head-changed" | "index-changed" | "git-operation" | "reset"; paused: boolean }> {
    const repository = await discoverRepository(this.root); const current = { head: repository.head, headReflog: repository.headReflog, branch: repository.branch, worktree: repository.worktree, indexTree: repository.indexTree, operation: repository.operation };
    if (current.head === this.gitState.head && current.headReflog === this.gitState.headReflog && current.branch === this.gitState.branch && current.worktree === this.gitState.worktree && current.indexTree === this.gitState.indexTree && current.operation === this.gitState.operation) return { kind: "unchanged", paused: this.materializationPaused };
    const kind = current.branch !== this.gitState.branch ? "branch-switch" : current.operation !== this.gitState.operation ? "git-operation" : current.head !== this.gitState.head ? "head-changed" : current.headReflog !== this.gitState.headReflog ? "reset" : "index-changed";
    this.materializationPaused = true; await this.persist("git.materialization_paused", { kind, previous: this.gitState, current });
    await this.checkpoint(`Before Git ${kind}`);
    this.gitState = current; this.capturedHashes.clear(); await this.persist("git.head_changed", { kind, current });
    return { kind, paused: true };
  }
  async reanalyzePendingOperations(): Promise<StoredOperation[]> {
    const updated = await Promise.all([...this.operations.values()].map(async (operation) => {
      if (operation.status !== "proposed") return operation;
      for (const change of operation.transaction.changes) {
        const current = await this.readWorkingText(change.path);
        const matches = change.kind === "add" ? current === undefined : (current === undefined ? undefined : contentHash(current)) === change.beforeHash;
        if (!matches) return { ...operation, status: "conflicted" as const };
      }
      return operation;
    }));
    updated.forEach((operation) => this.operations.set(operation.id, operation)); this.materializationPaused = Boolean(this.gitState.operation); await this.persist("transaction.reanalyzed", { operations: updated.map(({ id, status }) => ({ id, status })), materializationPaused: this.materializationPaused }); return updated;
  }
  async analyzeProposal(id: string): Promise<"independent" | "likely-compatible" | "stale-base" | "conflicted"> {
    const operation = this.operations.get(id); if (!operation || operation.status !== "proposed") throw new Error("Proposal was not found");
    let compatible = false;
    for (const change of operation.transaction.changes) {
      const current = await this.readWorkingText(change.path);
      const baseMatches = change.kind === "add" ? current === undefined : (current === undefined ? undefined : contentHash(current)) === change.beforeHash;
      if (baseMatches) continue;
      if (change.kind !== "modify" || current === undefined || change.afterContent === undefined) return "stale-base";
      const baseBytes = await readRevisionFile(this.root, "HEAD", change.path).catch(() => undefined);
      if (baseBytes === undefined) return "stale-base";
      const base = decodeText(baseBytes, change.path);
      const merge = await threeWayMerge(base, current, change.afterContent);
      if (!merge.clean) return "conflicted";
      compatible = true;
    }
    return compatible ? "likely-compatible" : "independent";
  }
  async flush(): Promise<void> {}
  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }
  async drain(): Promise<void> { await this.mutationTail; }
  close(): void { this.state.close(); }
  onTransaction(listener: (operation: StoredOperation) => void): () => void { this.transactionListeners.add(listener); return () => this.transactionListeners.delete(listener); }
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

  async capture(intent: string, service?: CoordinationService, kind: CaptureKind = "intent"): Promise<StoredOperation> {
    let snapshot: { repository: Awaited<ReturnType<typeof discoverRepository>>; checkpoint: Awaited<ReturnType<LocalDaemon["checkpoint"]>>; changes: Array<{ path: string; kind: "add" | "modify" | "delete"; beforeHash?: string; afterHash?: string; afterContent?: string }> } | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const repository = await discoverRepository(this.root); const names = await this.changedPaths();
      if (!names.length) throw new Error("No eligible working-tree changes to capture");
      const changes = await Promise.all(names.map(async ({ path, kind }) => {
        await this.eligiblePath(path);
        const beforeBytes = kind === "add" ? undefined : await readRevisionFile(this.root, "HEAD", path).catch(() => undefined);
        const before = beforeBytes === undefined ? undefined : decodeText(beforeBytes, path);
        const after = kind === "delete" ? undefined : await this.readWorkingText(path);
        return { path, kind, beforeHash: before === undefined ? undefined : contentHash(before), afterHash: after === undefined ? undefined : contentHash(after), afterContent: after };
      }));
      if (!(await this.snapshotIsStable(repository, changes))) continue;
      const checkpoint = await this.checkpoint(`Crosscode: ${intent}`);
      if (checkpoint.tree === await snapshotWorktreeTree(this.root) && await this.snapshotIsStable(repository, changes)) { snapshot = { repository, checkpoint, changes }; break; }
    }
    if (!snapshot) throw new Error("Working tree changed while assembling a transaction; retry the capture");
    const { repository, changes } = snapshot;
    const transaction = changeTransactionSchema.parse({ id: randomUUID(), intent, kind, base: { headCommit: repository.head, files: changes.filter((change) => change.beforeHash).map((change) => ({ path: change.path, contentHash: change.beforeHash! })) }, changes, provenance: { source: "filesystem", confidence: "known" }, safety: { risk: transactionRisk({ changes }), requiresApproval: transactionRisk({ changes }) === "critical" } });
    const local = { id: transaction.id, workspaceId: this.options.workspaceId, senderReplicaId: this.options.replicaId, transaction, sequence: 0, createdAt: now(), status: "local" as const };
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
    const remote = service.receive(event, transaction);
    const published = { ...remote, status: "local" as const };
    this.operations.set(published.id, published);
    this.outbound.set(event.id, { ...outbound, acknowledgedServerSequence: remote.sequence });
    try { await this.persist("transaction.published", published); }
    catch (error) { this.operations.set(local.id, local); this.outbound.set(event.id, outbound); throw error; }
    return published;
  }

  async syncRemote(transport: RemoteSyncTransport): Promise<{ uploaded: number; downloaded: number; cursor: number }> {
    await this.syncTasks(transport);
    await this.syncClaims(transport);
    await this.syncHandoffs(transport);
    await this.syncIntents(transport);
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
    const page = await transport.list(this.remoteCursor);
    const ordered = page.operations.every((operation, index) => operation.sequence === (index === 0 ? this.remoteCursor + 1 : page.operations[index - 1]!.sequence + 1));
    const expectedCursor = page.operations.at(-1)?.sequence ?? this.remoteCursor;
    if (!ordered || page.nextCursor !== expectedCursor || page.operations.some((operation) => operation.workspaceId !== this.options.workspaceId || operation.sequence <= this.remoteCursor)) throw new Error("Service cursor response was invalid");
    const previousCursor = this.remoteCursor;
    const insertedIds: string[] = [];
    let downloaded = 0;
    for (const remote of page.operations) {
      const transaction = changeTransactionSchema.parse(remote.transaction);
      transaction.changes.forEach(assertChangeIntegrity);
      if (remote.senderReplicaId === this.options.replicaId || this.operations.has(remote.id)) continue;
      const risk = transactionRisk(transaction);
      this.operations.set(remote.id, { ...remote, transaction: { ...transaction, safety: { risk, requiresApproval: risk === "critical" } }, status: "proposed" });
      insertedIds.push(remote.id);
      downloaded += 1;
    }
    if (page.nextCursor !== this.remoteCursor || downloaded) {
      this.remoteCursor = page.nextCursor;
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

  private async syncTasks(transport: RemoteSyncTransport): Promise<void> {
    for (const record of [...this.taskOutbound.values()].filter((item) => item.acknowledgedAt === undefined).sort((left, right) => left.event.clientSequence - right.event.clientSequence)) {
      const remote = await transport.uploadTask(record);
      if (remote.task.id !== record.event.payload.id || remote.workspaceId !== this.options.workspaceId || remote.senderReplicaId !== this.options.replicaId) throw new Error("Service acknowledgement did not match the outbound task");
      this.taskOutbound.set(record.event.id, { ...record, acknowledgedAt: remote.updatedAt });
      try { await this.persist("task.published", { eventId: record.event.id, taskId: remote.task.id, updatedAt: remote.updatedAt }); }
      catch (error) { this.taskOutbound.set(record.event.id, record); throw error; }
    }
    const page = await transport.listTasks(this.remoteTaskCursor);
    const previousCursor = this.remoteTaskCursor;
    const previousTasks = new Map(this.tasks);
    for (const remote of page.tasks) {
      if (remote.workspaceId !== this.options.workspaceId || remote.senderReplicaId === this.options.replicaId) continue;
      this.tasks.set(remote.task.id, remote.task);
    }
    if (page.nextCursor !== this.remoteTaskCursor) {
      this.remoteTaskCursor = page.nextCursor;
      try { await this.persist("task.synchronized", { cursor: this.remoteTaskCursor, downloaded: page.tasks.length }); }
      catch (error) { this.remoteTaskCursor = previousCursor; previousTasks.forEach((task, id) => this.tasks.set(id, task)); throw error; }
    }
  }

  private async syncClaims(transport: RemoteSyncTransport): Promise<void> {
    for (const record of [...this.claimOutbound.values()].filter((item) => item.acknowledgedAt === undefined).sort((left, right) => left.event.clientSequence - right.event.clientSequence)) {
      const remote = await transport.uploadClaim(record);
      if (remote.claim.id !== record.event.payload.id || remote.workspaceId !== this.options.workspaceId || remote.senderReplicaId !== this.options.replicaId) throw new Error("Service acknowledgement did not match the outbound claim");
      this.claimOutbound.set(record.event.id, { ...record, acknowledgedAt: remote.updatedAt });
      try { await this.persist("claim.published", { eventId: record.event.id, claimId: remote.claim.id, updatedAt: remote.updatedAt }); }
      catch (error) { this.claimOutbound.set(record.event.id, record); throw error; }
    }
    const page = await transport.listClaims(this.remoteClaimCursor);
    const previousCursor = this.remoteClaimCursor;
    const previousClaims = new Map(this.claims);
    for (const remote of page.claims) {
      if (remote.workspaceId !== this.options.workspaceId || remote.senderReplicaId === this.options.replicaId) continue;
      if (remote.released) this.claims.delete(remote.claim.id);
      else this.claims.set(remote.claim.id, remote.claim);
    }
    if (page.nextCursor !== this.remoteClaimCursor) {
      this.remoteClaimCursor = page.nextCursor;
      try { await this.persist("claim.synchronized", { cursor: this.remoteClaimCursor, downloaded: page.claims.length }); }
      catch (error) { this.remoteClaimCursor = previousCursor; previousClaims.forEach((claim, id) => this.claims.set(id, claim)); throw error; }
    }
  }

  private async syncHandoffs(transport: RemoteSyncTransport): Promise<void> {
    for (const record of [...this.handoffOutbound.values()].filter((item) => item.acknowledgedAt === undefined).sort((left, right) => left.event.clientSequence - right.event.clientSequence)) {
      const remote = await transport.uploadHandoff(record);
      if (remote.handoff.id !== record.event.payload.id || remote.workspaceId !== this.options.workspaceId || remote.senderReplicaId !== this.options.replicaId) throw new Error("Service acknowledgement did not match the outbound handoff");
      this.handoffOutbound.set(record.event.id, { ...record, acknowledgedAt: remote.updatedAt });
      try { await this.persist("handoff.published", { eventId: record.event.id, handoffId: remote.handoff.id, updatedAt: remote.updatedAt }); }
      catch (error) { this.handoffOutbound.set(record.event.id, record); throw error; }
    }
    const page = await transport.listHandoffs(this.remoteHandoffCursor);
    const previousCursor = this.remoteHandoffCursor;
    const previousHandoffs = new Map(this.handoffs);
    for (const remote of page.handoffs) {
      if (remote.workspaceId !== this.options.workspaceId || remote.senderReplicaId === this.options.replicaId) continue;
      this.handoffs.set(remote.handoff.id, remote.handoff);
    }
    if (page.nextCursor !== this.remoteHandoffCursor) {
      this.remoteHandoffCursor = page.nextCursor;
      try { await this.persist("handoff.synchronized", { cursor: this.remoteHandoffCursor, downloaded: page.handoffs.length }); }
      catch (error) { this.remoteHandoffCursor = previousCursor; previousHandoffs.forEach((handoff, id) => this.handoffs.set(id, handoff)); throw error; }
    }
  }

  private async syncIntents(transport: RemoteSyncTransport): Promise<void> {
    for (const record of [...this.intentOutbound.values()].filter((item) => item.acknowledgedAt === undefined).sort((left, right) => left.event.clientSequence - right.event.clientSequence)) {
      const remote = await transport.uploadIntent(record);
      if (remote.intent.id !== record.event.payload.id || remote.workspaceId !== this.options.workspaceId || remote.senderReplicaId !== this.options.replicaId) throw new Error("Service acknowledgement did not match the outbound intent");
      this.intentOutbound.set(record.event.id, { ...record, acknowledgedAt: remote.updatedAt });
      try { await this.persist("intent.published_remote", { eventId: record.event.id, intentId: remote.intent.id, updatedAt: remote.updatedAt }); }
      catch (error) { this.intentOutbound.set(record.event.id, record); throw error; }
    }
    const page = await transport.listIntents(this.remoteIntentCursor);
    const previousCursor = this.remoteIntentCursor;
    const previousIntents = new Map(this.intents);
    for (const remote of page.intents) {
      if (remote.workspaceId !== this.options.workspaceId || remote.senderReplicaId === this.options.replicaId) continue;
      this.intents.set(remote.intent.id, remote.intent);
    }
    if (page.nextCursor !== this.remoteIntentCursor) {
      this.remoteIntentCursor = page.nextCursor;
      try { await this.persist("intent.synchronized", { cursor: this.remoteIntentCursor, downloaded: page.intents.length }); }
      catch (error) { this.remoteIntentCursor = previousCursor; previousIntents.forEach((intent, id) => this.intents.set(id, intent)); throw error; }
    }
  }

  async sync(service: CoordinationService): Promise<StoredOperation[]> {
    const incoming = service.list(this.options.workspaceId, this.remoteCursor); this.remoteCursor = Math.max(this.remoteCursor, ...incoming.map((operation) => operation.sequence), 0);
    const proposals = incoming.filter((operation) => operation.senderReplicaId !== this.options.replicaId).map((operation) => {
      const transaction = changeTransactionSchema.parse(operation.transaction);
      const risk = transactionRisk(transaction);
      const stored = { ...operation, transaction: { ...transaction, safety: { risk, requiresApproval: risk === "critical" } }, status: "proposed" as const };
      this.operations.set(stored.id, stored);
      return stored;
    });
    await this.persist("transaction.proposed", { proposals, remoteCursor: this.remoteCursor }); return proposals;
  }
  async accept(id: string): Promise<StoredOperation> {
    if (this.materializationPaused) throw new Error("Proposal application is paused while Git state is being re-analyzed");
    await this.refuseChangedGitState();
    const operation = this.operations.get(id); if (!operation || operation.status !== "proposed") throw new Error("Proposal was not found");
    await this.assertApplicable(operation);
    const checkpoint = await this.checkpoint(`Before applying proposal ${id}`);
    await this.refuseChangedGitState();
    await this.assertApplicable(operation);
    const prepared: Array<{ change: ChangeTransaction["changes"][number]; absolute: string; temporary?: string }> = [];
    try {
      for (const change of operation.transaction.changes) {
        const absolute = await this.eligiblePath(change.path);
        if (change.kind === "delete") { prepared.push({ change, absolute }); continue; }
        if (change.afterContent === undefined) throw new Error(`Proposal does not contain materializable content: ${change.path}`);
        assertText(change.afterContent, change.path);
        await mkdir(dirname(absolute), { recursive: true });
        const temporary = join(dirname(absolute), `.${basename(absolute)}.${randomUUID()}.crosscode`);
        await writeFile(temporary, change.afterContent);
        prepared.push({ change, absolute, temporary });
      }
    } catch (error) {
      await Promise.all(prepared.filter((item) => item.temporary).map((item) => rm(item.temporary!, { force: true })));
      throw error;
    }
    await this.refuseChangedGitState();
    await this.assertApplicable(operation);
    const applying = { ...operation, status: "applying" as const, materializationCheckpoint: checkpoint.ref };
    this.operations.set(id, applying);
    await this.persist("transaction.applying", applying);
    const applied: typeof prepared = [];
    try {
      for (const item of prepared) {
        await this.refuseChangedGitState();
        await this.assertChangeApplicable(operation, item.change);
        if (item.change.kind === "delete") await rm(item.absolute, { force: true });
        else await rename(item.temporary!, item.absolute);
        applied.push(item);
      }
    } catch (error) {
      await Promise.all(prepared.filter((item) => !applied.includes(item) && item.temporary).map((item) => rm(item.temporary!, { force: true })));
      const rolledBack = await this.rollbackMaterialization(operation, checkpoint.ref).catch(() => false);
      const recovered = { ...operation, status: rolledBack ? "proposed" as const : "conflicted" as const };
      this.operations.set(id, recovered);
      await this.persist(rolledBack ? "transaction.apply_rolled_back" : "transaction.conflicted", { id, checkpoint: checkpoint.ref, recovery: rolledBack ? "live rollback" : "newer work preserved" });
      throw error;
    }
    operation.transaction.changes.forEach((change) => this.capturedHashes.set(change.path, change.afterHash ?? null));
    const accepted = { ...operation, status: "accepted" as const, materializationCheckpoint: checkpoint.ref }; this.operations.set(id, accepted); await this.persist("transaction.accepted", accepted); return accepted;
  }
  async reject(id: string): Promise<StoredOperation> { const operation = this.operations.get(id); if (!operation || operation.status !== "proposed") throw new Error("Proposal was not found"); const rejected = { ...operation, status: "rejected" as const }; this.operations.set(id, rejected); await this.persist("transaction.rejected", rejected); return rejected; }
  async validateProfile(profile: string): Promise<Validation[]> { return this.validate(profile, await validationCommands(this.root, profile)); }
  async validate(profile: string, commands: string[]): Promise<Validation[]> {
    const output: Validation[] = [];
    for (const command of commands) {
      const checkpoint = await this.checkpoint(`Before validation: ${profile}`);
      const started = Date.now();
      const result = await exec(command, { cwd: this.root, shell: true, timeout: 300_000, maxBuffer: 1024 * 1024 }).then(({ stdout, stderr }) => ({ exitCode: 0, output: `${stdout}${stderr}` })).catch((error: { code?: number | string; stdout?: string; stderr?: string; killed?: boolean }) => ({ exitCode: typeof error.code === "number" ? error.code : 1, output: `${error.stdout ?? ""}${error.stderr ?? ""}${error.killed ? "\nValidation timed out" : ""}` }));
      const afterTree = await snapshotWorktreeTree(this.root);
      const changedDuringValidation = afterTree !== checkpoint.tree;
      const validation = { id: randomUUID(), profile, command, exitCode: changedDuringValidation && result.exitCode === 0 ? 1 : result.exitCode, output: this.redactValidationOutput(`${changedDuringValidation ? "Validation invalidated because the working tree changed during the command\n" : ""}${result.output}`), durationMs: Date.now() - started, tree: checkpoint.tree, createdAt: now() };
      this.validations.push(validation); output.push(validation);
    }
    await this.persist("validation.completed", output);
    return output;
  }
  private async changedPaths(): Promise<Array<{ path: string; kind: "add" | "modify" | "delete" }>> {
    const [tracked, untracked, exclusions] = await Promise.all([git(this.root, ["diff", "--name-status", "-z", "--no-renames", "HEAD"]), git(this.root, ["ls-files", "-z", "--others", "--exclude-standard"]), configuredExcludedPaths(this.root)]);
    const trackedParts = tracked.split("\0").filter(Boolean);
    const changed = Array.from({ length: Math.floor(trackedParts.length / 2) }, (_, index) => {
      const status = trackedParts[index * 2]!;
      const path = trackedParts[index * 2 + 1]!;
      return { path, kind: status === "D" ? "delete" as const : status === "A" ? "add" as const : "modify" as const };
    });
    const candidates = [...changed, ...untracked.split("\0").filter(Boolean).map((path) => ({ path, kind: "add" as const }))].filter((change) => !this.ignoredPath(change.path) && !matchesConfiguredExclusion(change.path, exclusions));
    return (await Promise.all(candidates.map(async (change) => {
      const content = change.kind === "delete" ? undefined : await this.readWorkingText(change.path);
      const currentHash = content === undefined ? null : contentHash(content);
      return this.capturedHashes.get(change.path) === currentHash ? undefined : change;
    }))).filter((change): change is { path: string; kind: "add" | "modify" | "delete" } => Boolean(change));
  }
  private async assertApplicable(operation: StoredOperation): Promise<void> {
    for (const change of operation.transaction.changes) await this.assertChangeApplicable(operation, change);
  }
  private async analyzeChange(operationId: string, change: ChangeTransaction["changes"][number]): Promise<{ analysis: OperationAnalysis; beforeText?: string; current?: string; mergedCandidate?: string }> {
    const current = await this.readWorkingText(change.path); const baseMatches = (current === undefined ? undefined : contentHash(current)) === change.beforeHash;
    const conflicting = this.findConflictingChange(operationId, change.path);
    const overlaps = conflicting !== undefined && pathOverlaps(change.path, conflicting.path) && changesOverlap(change, conflicting);
    const beforeBytes = await readRevisionFile(this.root, "HEAD", change.path).catch(() => undefined);
    const beforeText = beforeBytes === undefined ? undefined : decodeText(beforeBytes, change.path);
    const semanticOverlap = looksLikeInterfaceChange(beforeText, change.afterContent, change.path);
    let dependents: string[] | undefined;
    if (semanticOverlap) {
      const changedSymbols = changedExportedSymbols(beforeText, change.afterContent);
      dependents = changedSymbols.length ? await findSymbolReferences(this.root, changedSymbols, change.path) : [];
    }
    let analysis = analyzeOperation({ path: change.path, baseMatches: change.kind === "add" ? current === undefined : baseMatches, overlaps, kind: change.kind, conflictingKind: conflicting?.kind, semanticOverlap, dependents });
    let mergedCandidate: string | undefined;
    if (analysis.classification === "stale-base" && change.kind === "modify" && current !== undefined && change.afterContent !== undefined && beforeText !== undefined) {
      const merge = await threeWayMerge(beforeText, current, change.afterContent);
      if (merge.clean) { analysis = { ...analysis, classification: "stale-base-resolved" }; mergedCandidate = merge.content; }
    }
    return { analysis, beforeText, current, mergedCandidate };
  }
  private async assertChangeApplicable(operation: StoredOperation, change: ChangeTransaction["changes"][number]): Promise<void> {
    await this.eligiblePath(change.path);
    assertChangeIntegrity(change);
    if (change.afterContent !== undefined) assertText(change.afterContent, change.path);
    const { analysis, beforeText, current, mergedCandidate } = await this.analyzeChange(operation.id, change);
    if (analysis.requiresApproval) {
      const stamped = { ...this.operations.get(operation.id)!, transaction: { ...operation.transaction, safety: { risk: analysis.risk, requiresApproval: true } } };
      this.operations.set(operation.id, stamped);
      await this.persist("transaction.safety_updated", stamped);
    }
    if (analysis.classification === "delete-vs-modify" || analysis.classification === "semantic-overlap" || analysis.classification === "stale-base" || analysis.classification === "stale-base-resolved") {
      await this.persistConflictArtifact(operation.id, change.path, analysis.classification, beforeText, current, change.afterContent, analysis.dependents, mergedCandidate);
    }
    if (analysis.classification === "stale-base") { const conflicted = { ...this.operations.get(operation.id)!, status: "conflicted" as const }; this.operations.set(operation.id, conflicted); await this.persist("transaction.conflicted", conflicted); throw new Error("Proposal has a stale base; local work was not changed"); }
    if (analysis.classification === "stale-base-resolved") throw new Error("Proposal has a stale base; a three-way merge candidate was prepared and requires human approval");
    if (analysis.requiresApproval) throw new Error("High-risk proposal requires local human approval policy");
  }
  private findConflictingChange(operationId: string, path: string): ChangeTransaction["changes"][number] | undefined {
    for (const candidate of this.operations.values()) {
      if (candidate.id === operationId) continue;
      if (candidate.status !== "local" && candidate.status !== "proposed") continue;
      const change = candidate.transaction.changes.find((item) => item.path === path);
      if (change) return change;
    }
    return undefined;
  }
  private async persistConflictArtifact(operationId: string, path: string, classification: string, base: string | undefined, local: string | undefined, proposed: string | undefined, dependents?: string[], mergedCandidate?: string): Promise<void> {
    this.state.recordConflictArtifact({ id: randomUUID(), operationId, path, classification, baseContent: base, localContent: local, proposedContent: proposed, dependents, mergedCandidate, createdAt: now() });
  }
  async diffProposal(id: string): Promise<Array<{ path: string; base?: string; local?: string; proposed?: string; classification: string; risk: string; requiresApproval: boolean; dependents?: string[]; mergedCandidate?: string }>> {
    const operation = this.operations.get(id); if (!operation) throw new Error("Proposal was not found");
    return Promise.all(operation.transaction.changes.map(async (change) => {
      const { analysis, beforeText, current, mergedCandidate } = await this.analyzeChange(id, change);
      return { path: change.path, base: beforeText, local: current, proposed: change.afterContent, classification: analysis.classification, risk: analysis.risk, requiresApproval: analysis.requiresApproval, dependents: analysis.dependents, mergedCandidate };
    }));
  }
  private async refuseChangedGitState(): Promise<void> {
    const transition = await this.observeGitTransition();
    if (transition.kind === "unchanged") return;
    await this.reanalyzePendingOperations();
    throw new Error(`Git state changed (${transition.kind}) while accepting the proposal; local work was not changed`);
  }
  private async reconcileInterruptedMaterializations(): Promise<void> {
    for (const operation of this.operations.values()) {
      if (operation.status !== "applying") continue;
      const fullyApplied = (await Promise.all(operation.transaction.changes.map(async (change) => {
        const current = await this.readWorkingText(change.path);
        return change.kind === "delete" ? current === undefined : current !== undefined && contentHash(current) === change.afterHash;
      }))).every(Boolean);
      if (fullyApplied) {
        const accepted = { ...operation, status: "accepted" as const };
        this.operations.set(operation.id, accepted);
        await this.persist("transaction.accepted", { ...accepted, recovery: "interrupted materialization" });
        continue;
      }
      if (!operation.materializationCheckpoint) {
        const conflicted = { ...operation, status: "conflicted" as const };
        this.operations.set(operation.id, conflicted);
        await this.persist("transaction.conflicted", { ...conflicted, recovery: "missing materialization checkpoint" });
        continue;
      }
      try {
        const rolledBack = await this.rollbackMaterialization(operation, operation.materializationCheckpoint);
        const recovered = { ...operation, status: rolledBack ? "proposed" as const : "conflicted" as const };
        this.operations.set(operation.id, recovered);
        await this.persist(rolledBack ? "transaction.apply_rolled_back" : "transaction.conflicted", { id: operation.id, checkpoint: operation.materializationCheckpoint, recovery: rolledBack ? "interrupted materialization" : "newer work preserved" });
      } catch {
        const conflicted = { ...operation, status: "conflicted" as const };
        this.operations.set(operation.id, conflicted);
        await this.persist("transaction.conflicted", { ...conflicted, recovery: "rollback failed" });
      }
    }
  }
  private async rollbackMaterialization(operation: StoredOperation, checkpoint: string): Promise<boolean> {
    const actions: ChangeTransaction["changes"] = [];
    for (const change of operation.transaction.changes) {
      await this.eligiblePath(change.path);
      const current = await this.readWorkingText(change.path);
      const checkpointBytes = await readRevisionFile(this.root, checkpoint, change.path).catch(() => undefined);
      if (change.kind !== "add" && checkpointBytes === undefined) return false;
      const checkpointContent = checkpointBytes === undefined ? undefined : decodeText(checkpointBytes, change.path);
      const proposalContent = change.kind === "delete" ? undefined : change.afterContent;
      if (change.kind !== "delete" && proposalContent === undefined) return false;
      const currentHash = current === undefined ? undefined : contentHash(current);
      const proposalMatches = currentHash === (proposalContent === undefined ? undefined : contentHash(proposalContent));
      const checkpointMatches = currentHash === (checkpointContent === undefined ? undefined : contentHash(checkpointContent));
      if (!proposalMatches && !checkpointMatches) return false;
      if (proposalMatches && !checkpointMatches) actions.push(change);
    }
    for (const change of [...actions].reverse()) {
      const current = await this.readWorkingText(change.path);
      const proposalContent = change.kind === "delete" ? undefined : change.afterContent;
      if ((current === undefined ? undefined : contentHash(current)) !== (proposalContent === undefined ? undefined : contentHash(proposalContent))) return false;
      if (change.kind === "add") await rm(await this.eligiblePath(change.path), { force: true });
      else await this.restoreEligibleCheckpointFile(checkpoint, change.path);
    }
    return true;
  }
  private async snapshotIsStable(repository: Awaited<ReturnType<typeof discoverRepository>>, changes: Array<{ path: string; kind: "add" | "modify" | "delete"; afterHash?: string }>): Promise<boolean> {
    const latest = await discoverRepository(this.root);
    if (latest.head !== repository.head || latest.headReflog !== repository.headReflog || latest.branch !== repository.branch || latest.worktree !== repository.worktree || latest.indexTree !== repository.indexTree || latest.operation !== repository.operation) return false;
    const current = await this.changedPaths();
    if (current.length !== changes.length || current.some((change) => !changes.some((snapshot) => snapshot.path === change.path && snapshot.kind === change.kind))) return false;
    return (await Promise.all(changes.map(async (change) => {
      const content = change.kind === "delete" ? undefined : await this.readWorkingText(change.path);
      return (content === undefined ? undefined : contentHash(content)) === change.afterHash;
    }))).every(Boolean);
  }
  private async eligiblePath(path: string): Promise<string> {
    if (redactPath(path) || matchesConfiguredExclusion(path, await configuredExcludedPaths(this.root))) throw new Error(`Refusing excluded path: ${path}`);
    return safeRepositoryPath(this.root, path);
  }
  private async restoreEligibleCheckpointFile(ref: string, path: string): Promise<void> {
    await this.eligiblePath(path);
    await restoreCheckpointFile(this.root, ref, path);
  }
  private async readWorkingText(path: string): Promise<string | undefined> {
    const absolute = await safeRepositoryPath(this.root, path);
    try { return decodeText(await readFile(absolute), path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  private ignoredPath(path: string): boolean { const relative = path.startsWith(this.root) ? path.slice(this.root.length + 1) : path; return /(^|\/)(\.git|node_modules|dist|build|coverage)(\/|$)/.test(relative) || /(^|\/)\.[^/]+\.[0-9a-f-]+\.crosscode$/.test(relative) || redactPath(relative); }
  private redactValidationOutput(output: string): string { return output.slice(0, 64 * 1024).replace(/((?:api[_-]?key|token|password|secret|authorization)\s*[:=]\s*)([^\s]+)/gi, "$1[REDACTED]"); }
  private async persist(type: string, payload: unknown): Promise<void> { this.eventSequence = this.state.record({ tasks: [...this.tasks.values()], claims: [...this.claims.values()], operations: [...this.operations.values()], validations: [...this.validations], checkpoints: [...this.checkpoints], handoffs: [...this.handoffs.values()], intents: [...this.intents.values()], outbound: [...this.outbound.values()], taskOutbound: [...this.taskOutbound.values()], claimOutbound: [...this.claimOutbound.values()], handoffOutbound: [...this.handoffOutbound.values()], intentOutbound: [...this.intentOutbound.values()], remoteCursor: this.remoteCursor, remoteTaskCursor: this.remoteTaskCursor, remoteClaimCursor: this.remoteClaimCursor, remoteHandoffCursor: this.remoteHandoffCursor, remoteIntentCursor: this.remoteIntentCursor, capturedHashes: Object.fromEntries(this.capturedHashes), gitState: this.gitState, materializationPaused: this.materializationPaused }, { type, payload }); }
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

function operationId(pathname: string, action: "accept" | "reject" | "analysis" | "diff"): string | undefined {
  const match = pathname.match(new RegExp(`^/v1/operations/([^/]+)/${action}$`));
  if (!match) return undefined;
  try { return decodeURIComponent(match[1]!); } catch { throw new HttpError(400, "Invalid operation ID"); }
}

function handoffRespondId(pathname: string): string | undefined {
  const match = pathname.match(/^\/v1\/handoffs\/([^/]+)\/respond$/);
  if (!match) return undefined;
  try { return decodeURIComponent(match[1]!); } catch { throw new HttpError(400, "Invalid handoff ID"); }
}

function taskId(pathname: string): string | undefined {
  const match = pathname.match(/^\/v1\/tasks\/([^/]+)$/);
  if (!match) return undefined;
  try { return decodeURIComponent(match[1]!); } catch { throw new HttpError(400, "Invalid task ID"); }
}

function claimReleaseId(pathname: string): string | undefined {
  const match = pathname.match(/^\/v1\/claims\/([^/]+)\/release$/);
  if (!match) return undefined;
  try { return decodeURIComponent(match[1]!); } catch { throw new HttpError(400, "Invalid claim ID"); }
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
      const payload = method === "POST" ? await readJsonBody(request) : undefined;
      const acceptId = operationId(pathname, "accept");
      const rejectId = operationId(pathname, "reject");
      const analysisId = operationId(pathname, "analysis");
      const diffId = operationId(pathname, "diff");
      const respondHandoffId = handoffRespondId(pathname);
      const updateTaskId = taskId(pathname);
      const releaseClaimId = claimReleaseId(pathname);
      const result = await daemon.runExclusive(async () => {
        let status = 200;
        let data: unknown;
        if (method === "GET" && pathname === "/v1/status") data = await daemon.status();
        else if (method === "GET" && pathname === "/v1/workspace") data = { root: daemon.root, ...daemon.options };
        else if (method === "GET" && pathname === "/v1/tasks") data = [...daemon.tasks.values()];
        else if (method === "POST" && pathname === "/v1/tasks") { data = await daemon.createTask(taskRequestSchema.parse(payload)); status = 201; }
        else if (method === "POST" && updateTaskId) data = await daemon.updateTask(updateTaskId, taskRequestSchema.parse(payload));
        else if (method === "GET" && pathname === "/v1/claims") data = [...daemon.claims.values()];
        else if (method === "POST" && pathname === "/v1/claims") { data = await daemon.createClaim(claimRequestSchema.parse(payload)); status = 201; }
        else if (method === "POST" && releaseClaimId) data = await daemon.releaseClaim(releaseClaimId);
        else if (method === "GET" && pathname === "/v1/operations") data = [...daemon.operations.values()];
        else if (method === "GET" && pathname === "/v1/checkpoints") data = [...daemon.checkpoints];
        else if (method === "GET" && pathname === "/v1/claims") data = [...daemon.claims.values()];
        else if (method === "GET" && analysisId) data = { operation: daemon.operations.get(analysisId), analysis: await daemon.analyzeProposal(analysisId) };
        else if (method === "GET" && diffId) data = await daemon.diffProposal(diffId);
        else if (method === "POST" && acceptId) data = await daemon.accept(acceptId);
        else if (method === "POST" && rejectId) data = await daemon.reject(rejectId);
        else if (method === "POST" && pathname === "/v1/checkpoints") { data = await daemon.checkpoint(checkpointRequestSchema.parse(payload).message); status = 201; }
        else if (method === "POST" && pathname === "/v1/checkpoints/inspect") { const { ref } = checkpointInspectRequestSchema.parse(payload); data = await daemon.inspectCheckpoint(ref); }
        else if (method === "POST" && pathname === "/v1/checkpoints/restore") { const input = checkpointRestoreRequestSchema.parse(payload); await daemon.restoreCheckpointFile(input.ref, input.path); data = { restored: input.path }; }
        else if (method === "POST" && pathname === "/v1/transactions") { const parsed = captureRequestSchema.parse(payload); data = await daemon.capture(parsed.intent, undefined, parsed.kind ?? "intent"); status = 201; }
        else if (method === "POST" && pathname === "/v1/intents") { data = await daemon.publishIntent(intentRequestSchema.parse(payload)); status = 201; }
        else if (method === "POST" && pathname === "/v1/validate") { const { profile } = validationRequestSchema.parse(payload); data = await daemon.validateProfile(profile); }
        else if (method === "POST" && pathname === "/v1/handoffs") { data = await daemon.requestHandoff(handoffRequestSchema.parse(payload)); status = 201; }
        else if (method === "POST" && respondHandoffId) { data = await daemon.respondHandoff(respondHandoffId, handoffRespondRequestSchema.parse(payload).decision); }
        else throw new HttpError(404, "Not found");
        return { status, data };
      });
      sendJson(response, result.status, { ok: true, data: result.data });
    } catch (error) {
      if (error instanceof HttpError) { sendJson(response, error.status, { ok: false, error: error.message }); return; }
      if (error && typeof error === "object" && "name" in error && error.name === "ZodError") { sendJson(response, 400, { ok: false, error: "Invalid request" }); return; }
      console.error("Crosscode request failed", error instanceof Error ? error.message.replaceAll(daemon.root, "<repository>") : "Unknown error");
      sendJson(response, 500, { ok: false, error: "Request failed" });
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
