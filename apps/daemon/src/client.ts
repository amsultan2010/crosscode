import { readFile, stat } from "node:fs/promises";
import type { CaptureKind } from "@crosscode/protocol";
import { daemonConnectionSchema, type DaemonConnection } from "@crosscode/protocol";
import type { LocalOperation } from "./types.js";
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
  materializationPaused: boolean;
  eventSequence: number;
  remoteCursor: number;
  pendingOutbound: number;
  service: { configured: boolean; online: boolean; lastSyncAt?: string; lastSyncError?: string; lastResyncAt?: string; lastResyncMessage?: string };
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
  operations(): Promise<LocalOperation[]> { return this.request("GET", "/v1/operations"); }
  capture(intent: string, kind?: CaptureKind): Promise<LocalOperation> { return this.request("POST", "/v1/transactions", kind ? { intent, kind } : { intent }); }

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
