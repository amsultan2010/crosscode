import { WebSocket } from "ws";
import { refreshStoredSession, type StoredSession } from "./supabase-client.js";
import {
  changesResponseSchema,
  presenceSchema,
  publishChangesResponseSchema,
  registerSyncReplicaResponseSchema,
  wsSyncServerMessageSchema,
  type Change,
  type ChangesResponse,
  type FileVersion,
  type Presence,
  type SyncDaemonConfig
} from "@crosscode/protocol";

/**
 * The daemon's half of the sync wire contract: four routes and one socket. Nothing here
 * knows what a shadow ref is -- it moves `FileVersion`s and hands back `Change`s.
 *
 * The socket is the fast path, not the only path. Where the service runs as a serverless
 * function it cannot answer a WebSocket upgrade at all, so `/v1/stream` 404s on every
 * attempt and no amount of reconnecting will ever help. Without a fallback that leaves the
 * daemon publishing happily and receiving nothing -- an uploader, not a sync. So a failed
 * stream falls back to polling `/v1/changes?since=`, the same route the daemon already
 * uses to catch up after a restart. Slower, and presence goes quiet because it only exists
 * on the socket, but edits still arrive.
 */

export type SyncStreamHandlers = {
  onChange: (change: Change) => void;
  onPresence?: (peers: Presence[]) => void;
  /** Fired on every (re)subscribe: the daemon catches up from its cursor here. */
  onConnected?: () => void;
  onDisconnected?: () => void;
  /**
   * Fired on each poll while the stream is unavailable. Resolve to report the service was
   * reachable, reject to report it was not; the client reports that as `connected`.
   */
  onPoll?: () => Promise<unknown>;
};

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15_000;
const POLL_INTERVAL_MS = 3_000;
/** Refresh this far ahead of expiry, so a request in flight never crosses the boundary. */
const EXPIRY_MARGIN_MS = 60_000;

export class SyncServiceClient {
  private socket?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private pollTimer?: NodeJS.Timeout;
  private pollActive = false;
  private polling = false;
  private reportedPollFailure = false;
  private backoffMs = INITIAL_BACKOFF_MS;
  private stopped = false;
  private handlers?: SyncStreamHandlers;
  private cursorProvider: () => number = () => 0;

  private session?: StoredSession;
  private refreshing?: Promise<StoredSession>;

  constructor(
    private readonly config: SyncDaemonConfig,
    readonly branch: string,
    private replicaId?: string,
    /** Called with a refreshed session so the caller can persist it for the next start-up. */
    private readonly onSession?: (session: StoredSession) => Promise<void>,
    private readonly pollIntervalMs = POLL_INTERVAL_MS
  ) {
    this.session = config.service.session;
  }

  /** In touch with the service, by either transport -- what `crosscode status` reports. */
  get connected(): boolean {
    return this.streaming || this.polling;
  }

  /** The socket specifically. Presence exists only here, so it asks this and not `connected`. */
  get streaming(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  get id(): string | undefined {
    return this.replicaId;
  }

  async register(): Promise<{ replicaId: string; cursor: number }> {
    const data = await this.request("POST", "/v1/replicas", { projectId: this.config.projectId, branch: this.branch });
    const response = registerSyncReplicaResponseSchema.parse(data);
    this.replicaId = response.replicaId;
    return response;
  }

  async publish(versions: FileVersion[]): Promise<number> {
    const data = await this.request("POST", "/v1/changes", {
      projectId: this.config.projectId,
      branch: this.branch,
      replicaId: this.requireReplicaId(),
      versions
    });
    return publishChangesResponseSchema.parse(data).cursor;
  }

  async changes(since: number, limit = 200): Promise<ChangesResponse> {
    const query = new URLSearchParams({
      projectId: this.config.projectId,
      branch: this.branch,
      since: String(since),
      limit: String(limit)
    });
    return changesResponseSchema.parse(await this.request("GET", `/v1/changes?${query}`));
  }

  async presence(paths: string[], actor: string, head?: string): Promise<void> {
    if (!this.streaming) return;
    const message = { type: "presence" as const, peers: [presenceSchema.parse({ replicaId: this.requireReplicaId(), actor, branch: this.branch, paths: paths.slice(0, 50), ...(head ? { head } : {}) })] };
    this.socket!.send(JSON.stringify(message));
  }

  /** Opens the stream and keeps it open, with backoff. `cursor` is read at each subscribe. */
  start(handlers: SyncStreamHandlers, cursor: () => number): void {
    this.handlers = handlers;
    this.cursorProvider = cursor;
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.polling = false;
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
  }

  private async connect(): Promise<void> {
    if (this.stopped || !this.replicaId) return;
    // A refresh can fail -- a revoked or rotated-away refresh token -- and that must not
    // take the daemon down from a reconnect timer. Falling through to polling is the
    // honest outcome: it fails the same way, and reports `connected: false`.
    const authorization = await this.authorization().catch(() => undefined);
    if (this.stopped) return;
    const socket = new WebSocket(`${streamUrl(this.config.service.url)}/v1/stream`, authorization ? { headers: { authorization } } : {});
    this.socket = socket;
    socket.on("open", () => {
      socket.send(JSON.stringify({
        type: "subscribe",
        projectId: this.config.projectId,
        branch: this.branch,
        replicaId: this.replicaId,
        since: this.cursorProvider()
      }));
      this.backoffMs = INITIAL_BACKOFF_MS;
      this.stopPolling();
      this.handlers?.onConnected?.();
    });
    socket.on("message", (data) => {
      let parsed: unknown;
      try { parsed = JSON.parse(data.toString()); } catch { return; }
      const message = wsSyncServerMessageSchema.safeParse(parsed);
      if (!message.success) return;
      if (message.data.type === "change") this.handlers?.onChange(message.data.change);
      else if (message.data.type === "presence") this.handlers?.onPresence?.(message.data.peers);
      else process.stderr.write(`Crosscode stream error: ${message.data.message}\n`);
    });
    socket.on("close", () => {
      if (this.socket === socket) this.socket = undefined;
      this.handlers?.onDisconnected?.();
      this.scheduleReconnect();
      // The socket is down for an unknown length of time -- one dropped frame, or a host
      // that will never serve one. Polling covers both, and stops as soon as one opens.
      this.startPolling();
    });
    socket.on("error", () => socket.close());
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
    this.reconnectTimer.unref();
  }

  /**
   * Self-scheduling rather than an interval, so a slow catch-up never overlaps itself.
   * `pollActive` is separate from `pollTimer` because the timer is unset while a tick is in
   * flight, and the socket fails often enough -- once per backoff -- that starting a second
   * loop in that window would be the normal case, not the rare one.
   */
  private startPolling(): void {
    if (this.pollActive || this.stopped || !this.handlers?.onPoll) return;
    this.pollActive = true;
    const tick = async () => {
      this.pollTimer = undefined;
      if (this.stopped || this.streaming) { this.stopPolling(); return; }
      try {
        await this.handlers?.onPoll?.();
        this.polling = true;
        this.reportedPollFailure = false;
      } catch (error) {
        // Unreachable by either transport, which is what `connected: false` should mean.
        // Reported once per run of failures rather than every 3s: a cursor that stops
        // advancing is otherwise completely silent, and `connected: false` on its own does
        // not say whether the service is down or a change cannot be applied.
        if (!this.reportedPollFailure) {
          this.reportedPollFailure = true;
          process.stderr.write(`Crosscode: sync poll failed: ${error instanceof Error ? error.message : String(error)}\n`);
        }
        this.polling = false;
      }
      if (this.stopped || this.streaming) { this.stopPolling(); return; }
      this.pollTimer = setTimeout(() => void tick(), this.pollIntervalMs);
      this.pollTimer.unref();
    };
    void tick();
  }

  private stopPolling(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    this.pollActive = false;
    this.polling = false;
  }

  private requireReplicaId(): string {
    if (!this.replicaId) throw new Error("This replica is not registered yet");
    return this.replicaId;
  }

  /**
   * The bearer header, refreshed if it is about to expire. Supabase access tokens last an
   * hour; a daemon is expected to outlive that, so every authenticated call goes through
   * here rather than reading the token that was written at sign-in.
   *
   * Concurrent callers share one refresh via `refreshing`: the socket reconnecting and a
   * publish landing at the same moment would otherwise each spend the refresh token, and
   * Supabase rotates it, so the second would be spending one that no longer exists.
   */
  private async authorization(): Promise<string | undefined> {
    const session = this.session;
    if (!session) return undefined;
    if (Date.parse(session.expiresAt) - Date.now() > EXPIRY_MARGIN_MS) return `Bearer ${session.accessToken}`;
    this.refreshing ??= refreshStoredSession(session)
      .then(async (refreshed) => {
        this.session = refreshed;
        await this.onSession?.(refreshed);
        return refreshed;
      })
      .finally(() => { this.refreshing = undefined; });
    return `Bearer ${(await this.refreshing).accessToken}`;
  }

  private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const authorization = await this.authorization();
    const response = await fetch(new URL(path, this.config.service.url), {
      method,
      headers: {
        ...(authorization ? { authorization } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" })
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000)
    });
    const envelope = await response.json().catch(() => undefined) as { ok?: boolean; data?: unknown; error?: string } | undefined;
    if (!response.ok || !envelope?.ok) throw new Error(envelope?.error ?? `Sync service request failed with status ${response.status}`);
    return envelope.data;
  }
}

function streamUrl(httpUrl: string): string {
  const url = new URL(httpUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString().replace(/\/$/, "");
}
