import type { ClientMessage, ServerMessage } from "../../shared/src/types";

export type ConnectionState = "connecting" | "open" | "lost";

// WS client with auto-reconnect. On every (re)open the app re-syncs state via
// the initial request batch; the server replays the narration backlog itself.
export class WsClient {
  private ws: WebSocket | null = null;
  private closed = false;
  private retryMs = 500;
  private token: string | null = null;

  constructor(
    private readonly onMessage: (msg: ServerMessage) => void,
    private readonly onState: (state: ConnectionState) => void,
  ) {}

  /**
   * This boot's handshake token.
   *
   * Served inside the document by the core, so in production it is already here
   * before any script runs. Under `npm run dev:ui` the document comes from Vite
   * instead, and the core exposes the token on a route that only answers while
   * it is running under its own dev script. Cached after the first read: the
   * token is per boot, and a reconnect storm should not become a request storm.
   */
  private async handshakeToken(): Promise<string | null> {
    if (this.token) return this.token;
    const injected = (window as unknown as Record<string, unknown>).__HAL_WS_TOKEN__;
    if (typeof injected === "string" && injected) {
      this.token = injected;
      return this.token;
    }
    try {
      const res = await fetch("/api/ws-token", { cache: "no-store" });
      if (!res.ok) return null;
      const body = (await res.json()) as { token?: unknown };
      if (typeof body.token === "string" && body.token) this.token = body.token;
      return this.token;
    } catch {
      return null;
    }
  }

  connect(): void {
    this.onState("connecting");
    const proto = location.protocol === "https:" ? "wss" : "ws";
    this.ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws.onopen = () => {
      this.retryMs = 500;
      // The socket is open but not yet usable: the server sends nothing and
      // accepts nothing else until the handshake lands. State flips to "open"
      // when `hello` arrives, which is the server's own signal that it admitted
      // us — reporting "open" here would show a connected UI that cannot talk.
      void this.authenticate();
    };
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data)) as ServerMessage;
      // `hello` is the server confirming it admitted this socket. Until then the
      // connection exists but carries nothing.
      if (msg.type === "hello") this.onState("open");
      this.onMessage(msg);
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

  private async authenticate(): Promise<void> {
    const socket = this.ws;
    const token = await this.handshakeToken();
    // The socket can have been replaced while the token was in flight — a
    // reconnect during a slow fetch. Authenticating the wrong one would leave
    // the live socket unadmitted and silent.
    if (!socket || socket !== this.ws || socket.readyState !== WebSocket.OPEN) return;
    if (!token) {
      // Nothing to present. Closing drives the existing retry loop rather than
      // leaving a socket the server will never answer.
      console.error("HAL: no session token available; cannot authenticate.");
      socket.close();
      return;
    }
    socket.send(JSON.stringify({ type: "authenticate", token } satisfies ClientMessage));
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
