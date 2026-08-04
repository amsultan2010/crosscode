import { readFile, stat } from "node:fs/promises";
import type { CaptureKind, Claim, Handoff, Intent, Task, Validation } from "@crosscode/protocol";
import { daemonConnectionSchema, type DaemonConnection } from "@crosscode/protocol";
import type { PendingSemanticReview, SemanticReview } from "@crosscode/core";
import type { CheckpointRecord, ConflictArtifactRecord } from "./state.js";
import type { SemanticReviewRecord, StoredOperation } from "./types.js";
import { daemonConnectionPath } from "./runtime.js";

type Status = {
  root: string;
  head?: string;
  branch?: string;
  worktree: string;
  remotes: string[];
  dirty: boolean;
  workspaceId: string;
  replicaId: string;
  tasks: number;
  claims: number;
  proposals: number;
  materializationPaused: boolean;
  eventSequence: number;
  remoteCursor: number;
  pendingOutbound: number;
  service: { configured: boolean; online: boolean; lastSyncAt?: string; lastSyncError?: string };
};

/**
 * No usable daemon for this worktree. Carries the `DAEMON_UNAVAILABLE` contract the CLI
 * and MCP server branch on, so every way of not reaching a daemon -- no descriptor, an
 * unreadable or corrupt one, or a descriptor whose daemon is gone -- reports the same
 * actionable code instead of leaking a raw errno and an absolute path.
 */
export class DaemonUnavailableError extends Error {
  readonly code = "DAEMON_UNAVAILABLE";
  constructor(reason: string) {
    super(`Crosscode daemon is unavailable: ${reason}`);
  }
}

export class DaemonClient {
  private constructor(private readonly connection: DaemonConnection) {}

  static async connect(directory: string): Promise<DaemonClient> {
    const path = await daemonConnectionPath(directory);
    let connection: DaemonConnection;
    try {
      const metadata = await stat(path);
      if ((metadata.mode & 0o077) !== 0) throw new Error("the daemon descriptor's permissions are unsafe");
      if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) throw new Error("the daemon descriptor is owned by another user");
      connection = daemonConnectionSchema.parse(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      // ENOENT is the overwhelmingly common case -- no daemon has been started for this
      // worktree -- and it used to escape as a bare `stat` failure, so the one error an
      // agent is told to branch on was unreachable in exactly the situation it names.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new DaemonUnavailableError("no daemon is running for this worktree");
      }
      throw new DaemonUnavailableError(error instanceof Error ? error.message : "the daemon descriptor could not be read");
    }
    const client = new DaemonClient(connection);
    await client.status().catch((error: unknown) => {
      throw new DaemonUnavailableError(error instanceof Error ? error.message : "connection failed");
    });
    return client;
  }

  static from(connection: DaemonConnection): DaemonClient {
    return new DaemonClient(daemonConnectionSchema.parse(connection));
  }

  status(): Promise<Status> { return this.request("GET", "/v1/status"); }
  workspace(): Promise<{ root: string; workspaceId: string; replicaId: string; actorId: string }> { return this.request("GET", "/v1/workspace"); }
  workspaceAutonomy(): Promise<{ tier: 0 | 1 | 2 }> { return this.request("GET", "/v1/workspace/autonomy"); }
  setWorkspaceAutonomy(tier: 0 | 1 | 2): Promise<{ tier: 0 | 1 | 2 }> { return this.request("PUT", "/v1/workspace/autonomy", { tier }); }
  tasks(): Promise<Task[]> { return this.request("GET", "/v1/tasks"); }
  createTask(input: { title: string; intent?: string; paths?: string[]; status?: Task["status"] }): Promise<Task> { return this.request("POST", "/v1/tasks", input); }
  createClaim(input: { taskId: string; kind: Claim["kind"]; target: string; mode: Claim["mode"]; expiresAt?: string }): Promise<Claim> { return this.request("POST", "/v1/claims", input); }
  claims(): Promise<Claim[]> { return this.request("GET", "/v1/claims"); }
  releaseClaim(id: string): Promise<Claim> { return this.request("POST", `/v1/claims/${encodeURIComponent(id)}/release`, {}); }
  updateTask(id: string, input: { title: string; intent?: string; paths?: string[]; status?: Task["status"] }): Promise<Task> { return this.request("POST", `/v1/tasks/${encodeURIComponent(id)}`, input); }
  operations(): Promise<StoredOperation[]> { return this.request("GET", "/v1/operations"); }
  analyze(id: string): Promise<{ operation: StoredOperation; analysis: string }> { return this.request("GET", `/v1/operations/${encodeURIComponent(id)}/analysis`); }
  diff(id: string): Promise<Array<{ path: string; base?: string; local?: string; proposed?: string; classification: string; risk: string; requiresApproval: boolean; dependents?: string[]; mergedCandidate?: string }>> { return this.request("GET", `/v1/operations/${encodeURIComponent(id)}/diff`); }
  artifacts(id: string): Promise<ConflictArtifactRecord[]> { return this.request("GET", `/v1/operations/${encodeURIComponent(id)}/artifacts`); }
  accept(id: string, options?: { reviewApprovals?: Record<string, string> }): Promise<StoredOperation> { return this.request("POST", `/v1/operations/${encodeURIComponent(id)}/accept`, options ?? {}); }
  reject(id: string): Promise<StoredOperation> { return this.request("POST", `/v1/operations/${encodeURIComponent(id)}/reject`, {}); }
  requestSemanticReview(operationId: string, path: string, providerId: string): Promise<SemanticReviewRecord> { return this.request("POST", `/v1/operations/${encodeURIComponent(operationId)}/reviews`, { path, providerId }); }
  semanticReviews(operationId: string): Promise<SemanticReviewRecord[]> { return this.request("GET", `/v1/operations/${encodeURIComponent(operationId)}/reviews`); }
  acceptSemanticReview(reviewId: string): Promise<SemanticReviewRecord> { return this.request("POST", `/v1/reviews/${encodeURIComponent(reviewId)}/accept`, {}); }
  rejectSemanticReview(reviewId: string): Promise<SemanticReviewRecord> { return this.request("POST", `/v1/reviews/${encodeURIComponent(reviewId)}/reject`, {}); }
  pendingSemanticReviews(): Promise<PendingSemanticReview[]> { return this.request("GET", "/v1/semantic-reviews/pending"); }
  submitSemanticReview(requestId: string, review: SemanticReview): Promise<{ ok: true }> { return this.request("POST", `/v1/semantic-reviews/${encodeURIComponent(requestId)}/submit`, review); }
  checkpoints(): Promise<CheckpointRecord[]> { return this.request("GET", "/v1/checkpoints"); }
  checkpoint(message?: string): Promise<{ ref: string; commit: string; tree: string }> { return this.request("POST", "/v1/checkpoints", message ? { message } : {}); }
  inspectCheckpoint(ref: string): Promise<{ ref: string; commit: string; tree: string; files: string[] }> { return this.request("POST", "/v1/checkpoints/inspect", { ref }); }
  restoreCheckpoint(ref: string, path: string): Promise<{ restored: string }> { return this.request("POST", "/v1/checkpoints/restore", { ref, path }); }
  capture(intent: string, kind?: CaptureKind): Promise<StoredOperation> { return this.request("POST", "/v1/transactions", kind ? { intent, kind } : { intent }); }
  validate(profile: string): Promise<Validation[]> { return this.request("POST", "/v1/validate", { profile }); }
  publish(input: { branch: string; profile: string; message?: string; dryRun?: boolean }): Promise<{ branch: string; tree: string; changedPaths: Array<{ path: string; kind: "add" | "modify" | "delete" }> } | { branch: string; commit: string; tree: string; previous?: string }> { return this.request("POST", "/v1/publish", input); }
  requestHandoff(input: { operationId: string; note?: string }): Promise<Handoff> { return this.request("POST", "/v1/handoffs", input); }
  respondHandoff(id: string, decision: "accepted" | "declined"): Promise<Handoff> { return this.request("POST", `/v1/handoffs/${encodeURIComponent(id)}/respond`, { decision }); }
  publishIntent(input: { text: string; taskId?: string }): Promise<Intent> { return this.request("POST", "/v1/intents", input); }

  private async request<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${this.connection.port}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.connection.secret}`,
          ...(body === undefined ? {} : { "content-type": "application/json" })
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000)
      });
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : "Daemon request failed");
    }
    const envelope = await response.json().catch(() => undefined) as { ok?: boolean; data?: T; error?: string } | undefined;
    if (!response.ok || !envelope?.ok) throw new Error(envelope?.error ?? `Daemon request failed with status ${response.status}`);
    return envelope.data as T;
  }
}
