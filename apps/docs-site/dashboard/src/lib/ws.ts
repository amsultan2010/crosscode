import { wsFanOutMessageSchema, wsSubscribeAckSchema, wsErrorMessageSchema, type WsFanOutMessage } from "@crosscode/protocol";

export type StreamHandlers = {
  onSubscribed?: (cursor: number) => void;
  onMessage: (message: WsFanOutMessage) => void;
  onError?: (message: string) => void;
  onClose?: () => void;
};

export function connectStream(
  serviceUrl: string,
  subscribe: { workspaceId: string; replicaId: string; accessToken: string },
  handlers: StreamHandlers
): WebSocket {
  const wsUrl = new URL("/v1/stream", serviceUrl);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(wsUrl);

  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ type: "subscribe", ...subscribe }));
  });

  socket.addEventListener("message", (event: MessageEvent) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(event.data));
    } catch {
      return;
    }
    const ack = wsSubscribeAckSchema.safeParse(parsed);
    if (ack.success) {
      handlers.onSubscribed?.(ack.data.cursor);
      return;
    }
    const errorMessage = wsErrorMessageSchema.safeParse(parsed);
    if (errorMessage.success) {
      handlers.onError?.(errorMessage.data.message);
      return;
    }
    const fanOut = wsFanOutMessageSchema.safeParse(parsed);
    if (fanOut.success) handlers.onMessage(fanOut.data);
  });

  socket.addEventListener("close", () => handlers.onClose?.());

  return socket;
}
