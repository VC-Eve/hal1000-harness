import type http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { HAL_VERSION, type ClientMessage, type ServerMessage } from "../../shared/src/types.js";
import { allowsOrigin } from "./origin.js";

export type ClientMessageHandler = (msg: ClientMessage, client: WebSocket) => void;

// Hub for all connected clients. One WS channel carries chat tokens, narration
// entries, session status, and readiness events (KTD: single duplex channel).
export class WsHub {
  private readonly wss: WebSocketServer;
  private readonly handlers = new Set<ClientMessageHandler>();
  private readonly greeters = new Set<(client: WebSocket) => void>();

  private readonly server: http.Server;

  constructor(server: http.Server, wsPath = "/ws") {
    this.server = server;
    this.wss = new WebSocketServer({
      server,
      path: wsPath,
      verifyClient: ({ origin }: { origin?: string }) => this.allowsOrigin(origin),
    });
    this.wss.on("error", (err) => console.error(`WS hub error: ${err.message}`));

    this.wss.on("connection", (socket) => {
      // Unhandled 'error' on an individual socket would throw and kill the
      // process (EventEmitter contract).
      socket.on("error", (err) => console.error(`WS client error: ${err.message}`));
      this.sendTo(socket, { type: "hello", app: "hal1000", version: HAL_VERSION });
      for (const greet of this.greeters) greet(socket);
      socket.on("message", (raw) => {
        let msg: ClientMessage;
        try {
          msg = JSON.parse(String(raw)) as ClientMessage;
        } catch {
          this.sendTo(socket, { type: "error", code: "bad_message", message: "I'm sorry, I can't parse that." });
          return;
        }
        for (const handler of this.handlers) handler(msg, socket);
      });
    });
  }

  onMessage(handler: ClientMessageHandler): void {
    this.handlers.add(handler);
  }

  // Called for each new connection after hello — used to replay state
  // (feed ring buffer, session status, readiness) so reloads don't lose it.
  onConnection(greet: (client: WebSocket) => void): void {
    this.greeters.add(greet);
  }

  sendTo(client: WebSocket, msg: ServerMessage): void {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(msg));
  }

  // Which browser origins may drive the hub.
  //
  // "Any loopback origin" was safe while the protocol could only read
  // conversations and change settings. It stopped being safe when `add-monitor`
  // began scheduling shell commands: a page served from any other local port —
  // another dev server, a local tool's web UI — could connect and obtain code
  // execution. The allowlist is now the port this server is actually on, which
  // in practice means HAL's own UI and nothing else.
  //
  // A request with no Origin is not a browser, and a local process already has
  // execution, so refusing it would cost agent-native access (AGENTS.md) while
  // closing nothing.
  //
  // This narrows the window; it does not shut it. The complete fix is a per-boot
  // token in the handshake — see docs/residual-review-findings/feat-ambient-log-monitors.md.
  // The predicate itself lives in `origin.ts` so the camera preview route
  // enforces the identical rule from the same code. Refusal logging stays here,
  // because only the hub can explain a blank page.
  private allowsOrigin(origin?: string): boolean {
    if (allowsOrigin(this.server, origin)) return true;
    if (origin) this.refuse(origin);
    return false;
  }

  // Logged, because a refused connection is otherwise a silent blank page — and
  // the likeliest cause is a dev setup on an unexpected port, not an attack.
  private refuse(origin: string): void {
    console.error(
      `WS connection refused from origin ${origin}. Only HAL's own origin is accepted; set HAL_DEV_ORIGIN to allow another.`,
    );
  }

  broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    }
  }

  close(): void {
    for (const client of this.wss.clients) client.terminate();
    this.wss.close();
  }
}
