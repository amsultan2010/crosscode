import { readFile, stat } from "node:fs/promises";
import {
  conflictSchema,
  syncStatusSchema,
  type Conflict,
  type SyncStatus
} from "@crosscode/protocol";
import { daemonDescriptorPath, daemonDescriptorSchema, type DaemonDescriptor } from "./sync-config.js";

/**
 * No usable daemon for this worktree. Carries the `DAEMON_UNAVAILABLE` contract the CLI
 * and the MCP server branch on, so every way of not reaching a daemon -- no descriptor, an
 * unreadable one, or one whose daemon is gone -- reports the same actionable code instead
 * of leaking a raw errno and an absolute path.
 */
export class DaemonUnavailableError extends Error {
  readonly code = "DAEMON_UNAVAILABLE";
  constructor(reason: string) {
    super(`Crosscode daemon is unavailable: ${reason}`);
  }
}

/** The loopback client behind `crosscode status` and the four MCP tools. */
export class DaemonClient {
  private constructor(private readonly descriptor: DaemonDescriptor) {}

  static async connect(directory: string): Promise<DaemonClient> {
    const path = await daemonDescriptorPath(directory);
    let descriptor: DaemonDescriptor;
    try {
      const metadata = await stat(path);
      if ((metadata.mode & 0o077) !== 0) throw new Error("the daemon descriptor's permissions are unsafe");
      if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) throw new Error("the daemon descriptor is owned by another user");
      descriptor = daemonDescriptorSchema.parse(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new DaemonUnavailableError("no daemon is running for this worktree");
      throw new DaemonUnavailableError(error instanceof Error ? error.message : "the daemon descriptor could not be read");
    }
    const client = new DaemonClient(descriptor);
    await client.status().catch((error: unknown) => {
      throw new DaemonUnavailableError(error instanceof Error ? error.message : "connection failed");
    });
    return client;
  }

  static from(descriptor: DaemonDescriptor): DaemonClient {
    return new DaemonClient(daemonDescriptorSchema.parse(descriptor));
  }

  async status(): Promise<SyncStatus> {
    return syncStatusSchema.parse(await this.request("GET", "/v1/status"));
  }

  async conflicts(): Promise<Conflict[]> {
    return conflictSchema.array().parse(await this.request("GET", "/v1/conflicts"));
  }

  /** Hands the agent's merged result back. A path leaves quarantine here and nowhere else. */
  async resolve(conflictId: string, content: string): Promise<Conflict[]> {
    return conflictSchema.array().parse(await this.request("POST", "/v1/conflicts/resolve", { conflictId, content }));
  }

  async pause(paused: boolean): Promise<SyncStatus> {
    return syncStatusSchema.parse(await this.request("POST", "/v1/pause", { paused }));
  }

  private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${this.descriptor.port}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.descriptor.secret}`,
          ...(body === undefined ? {} : { "content-type": "application/json" })
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000)
      });
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : "Daemon request failed");
    }
    const envelope = await response.json().catch(() => undefined) as { ok?: boolean; data?: unknown; error?: string } | undefined;
    if (!response.ok || !envelope?.ok) throw new Error(envelope?.error ?? `Daemon request failed with status ${response.status}`);
    return envelope.data;
  }
}
