import type { ClientMessage, ServerMessage } from "../../shared/src/types";

export type ConnectionState = "connecting" | "open" | "lost";

// WS client with auto-reconnect. On every (re)open the app re-syncs state via
// the initial request batch; the server replays the narration backlog itself.
export class WsClient {
  private ws: WebSocket | null = null;
  private closed = false;
  private retryMs = 500;

  constructor(
    private readonly onMessage: (msg: ServerMessage) => void,
    private readonly onState: (state: ConnectionState) => void,
  ) {}

  connect(): void {
    this.onState("connecting");
    const proto = location.protocol === "https:" ? "wss" : "ws";
    this.ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws.onopen = () => {
      this.retryMs = 500;
      this.onState("open");
    };
    this.ws.onmessage = (event) => {
      this.onMessage(JSON.parse(String(event.data)) as ServerMessage);
    };
    this.ws.onclose = () => {
      if (this.closed) return;
      this.onState("lost");
      setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 5000);
    };
    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }
}
