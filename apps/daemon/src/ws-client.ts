import { WebSocket } from "ws";
import {
  wsFanOutMessageSchema,
  wsSubscribeAckSchema,
  wsSubscribeRequestSchema,
  type DaemonConfig,
  type PresenceUpdate,
  type RemoteOperation
} from "@crosscode/protocol";
import { fetchAccessToken } from "./service-client.js";

export type LiveSyncCallbacks = {
  onOperation: (operation: RemoteOperation) => void;
  onPresence?: (presence: PresenceUpdate) => void;
};

export type LiveSyncOptions = {
  initialBackoffMs?: number;
  maxBackoffMs?: number;
};

const DEFAULT_INITIAL_BACKOFF_MS = 500;
const DEFAULT_MAX_BACKOFF_MS = 15_000;

export class LiveSyncClient {
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private backoffMs: number;
  private socket?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private readonly identity: Pick<DaemonConfig, "workspaceId" | "actorId" | "replicaId">,
    private readonly service: NonNullable<DaemonConfig["service"]>,
    private readonly callbacks: LiveSyncCallbacks,
    options: LiveSyncOptions = {}
  ) {
    this.initialBackoffMs = options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.backoffMs = this.initialBackoffMs;
  }

  start(): void {
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    let accessToken: string;
    try {
      accessToken = await fetchAccessToken(this.service.url, this.identity, this.service);
    } catch {
      this.scheduleReconnect();
      return;
    }
    if (this.stopped) return;
    const socket = new WebSocket(`${wsUrl(this.service.url)}/v1/stream`);
    this.socket = socket;
    let subscribed = false;
    socket.on("open", () => {
      socket.send(JSON.stringify(wsSubscribeRequestSchema.parse({
        type: "subscribe",
        workspaceId: this.identity.workspaceId,
        replicaId: this.identity.replicaId,
        accessToken
      })));
    });
    socket.on("message", (data) => {
      let parsed: unknown;
      try { parsed = JSON.parse(data.toString()); } catch { return; }
      if (!subscribed) {
        const ack = wsSubscribeAckSchema.safeParse(parsed);
        if (!ack.success) { socket.close(); return; }
        subscribed = true;
        this.backoffMs = this.initialBackoffMs;
        return;
      }
      const message = wsFanOutMessageSchema.safeParse(parsed);
      if (!message.success) return;
      if (message.data.type === "operation") this.callbacks.onOperation(message.data.operation);
      else this.callbacks.onPresence?.(message.data.presence);
    });
    socket.on("close", () => {
      if (this.socket === socket) this.socket = undefined;
      this.scheduleReconnect();
    });
    socket.on("error", () => socket.close());
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
    this.reconnectTimer.unref();
  }
}

function wsUrl(httpUrl: string): string {
  const url = new URL(httpUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString().replace(/\/$/, "");
}
