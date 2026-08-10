import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { z } from "zod";
import {
  conflictSchema,
  daemonConnectionSchema,
  syncStatusSchema,
  type Conflict,
  type PauseRequest,
  type ResolveConflictRequest,
  type SyncStatus
} from "@crosscode/protocol";

const exec = promisify(execFile);

/**
 * Everything this server needs from the daemon, and nothing else. The daemon's local HTTP
 * API is being written in a different workstream; this interface is the seam. Tests
 * substitute a fake, and if the daemon's routes end up spelled differently only
 * `HttpDaemonApi` below changes.
 */
export interface DaemonApi {
  status(): Promise<SyncStatus>;
  conflicts(): Promise<Conflict[]>;
  resolve(request: ResolveConflictRequest): Promise<void>;
  pause(request: PauseRequest): Promise<void>;
}

export const DAEMON_ROUTES = {
  status: "/v1/status",
  conflicts: "/v1/conflicts",
  resolve: "/v1/conflicts/resolve",
  pause: "/v1/pause"
} as const;

export const START_HINT = "Run `crosscode start` in this checkout, then retry.";

/** No usable daemon here. One code for every way of not reaching one, so agents branch once. */
export class DaemonUnavailableError extends Error {
  readonly code = "DAEMON_UNAVAILABLE";
  constructor(reason: string) {
    super(`Crosscode daemon is unavailable: ${reason}`);
  }
}

/**
 * The daemon wraps its replies in `{ ok, data }`. Accept a bare body too: the envelope is
 * the one part of the local API the wire contract does not pin down, and a shape mismatch
 * across workstreams should not take the agent surface down with it.
 */
function unwrap(body: unknown): unknown {
  if (body !== null && typeof body === "object" && "ok" in body) {
    const envelope = body as { ok?: boolean; data?: unknown; error?: string };
    if (envelope.ok === false) throw new Error(envelope.error ?? "the daemon rejected the request");
    return envelope.data;
  }
  return body;
}

class HttpDaemonApi implements DaemonApi {
  constructor(private readonly baseUrl: string, private readonly secret: string) {}

  status(): Promise<SyncStatus> {
    return this.request("GET", DAEMON_ROUTES.status, undefined, syncStatusSchema);
  }

  conflicts(): Promise<Conflict[]> {
    return this.request("GET", DAEMON_ROUTES.conflicts, undefined, z.array(conflictSchema));
  }

  async resolve(request: ResolveConflictRequest): Promise<void> {
    await this.request("POST", DAEMON_ROUTES.resolve, request, z.unknown());
  }

  async pause(request: PauseRequest): Promise<void> {
    await this.request("POST", DAEMON_ROUTES.pause, request, z.unknown());
  }

  // Structural rather than z.ZodType<T>: a schema with defaults has a wider input type than
  // its output, which the nominal form rejects.
  private async request<T>(method: "GET" | "POST", path: string, body: unknown, schema: { parse(value: unknown): T }): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.secret}`,
          ...(body === undefined ? {} : { "content-type": "application/json" })
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000)
      });
    } catch (error) {
      throw new DaemonUnavailableError(error instanceof Error ? error.message : "the request failed");
    }
    const parsedBody = await response.json().catch(() => undefined) as unknown;
    if (!response.ok) {
      const envelope = parsedBody as { error?: string } | undefined;
      throw new Error(envelope?.error ?? `the daemon answered ${response.status}`);
    }
    return schema.parse(unwrap(parsedBody));
  }
}

async function descriptorPath(directory: string): Promise<string> {
  try {
    const { stdout } = await exec("git", [
      "-C", directory, "rev-parse", "--path-format=absolute", "--git-path", "crosscode/daemon.json"
    ]);
    return stdout.trim();
  } catch {
    throw new DaemonUnavailableError("this directory is not a git checkout");
  }
}

/**
 * Connects to the daemon for `directory`. Never starts one: the daemon is `crosscode
 * start`'s job, and an MCP server that silently spawned background processes on tool call
 * is exactly the kind of thing the user did not ask for.
 *
 * `CROSSCODE_DAEMON_URL` / `CROSSCODE_DAEMON_SECRET` override the descriptor, which is how
 * the tests point at a fake daemon.
 */
export async function connectToDaemon(directory = process.cwd()): Promise<DaemonApi> {
  const url = process.env.CROSSCODE_DAEMON_URL;
  if (url) return new HttpDaemonApi(url.replace(/\/$/, ""), process.env.CROSSCODE_DAEMON_SECRET ?? "");

  const path = await descriptorPath(directory);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new DaemonUnavailableError("no daemon is running for this checkout");
  }
  // A descriptor a dying daemon left half-written is one more way of not reaching one, and
  // it has the same answer: a raw SyntaxError or ZodError here reached the agent as "the
  // daemon request failed", without the one hint that fixes it.
  let connection: z.infer<typeof daemonConnectionSchema>;
  try {
    connection = daemonConnectionSchema.parse(JSON.parse(raw));
  } catch {
    throw new DaemonUnavailableError("the daemon descriptor for this checkout is unreadable");
  }
  return new HttpDaemonApi(`http://127.0.0.1:${connection.port}`, connection.secret);
}
