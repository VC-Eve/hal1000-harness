import type http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { HAL_VERSION, type ClientMessage, type ServerMessage } from "../../shared/src/types.js";

export type ClientMessageHandler = (msg: ClientMessage, client: WebSocket) => void;

// Hub for all connected clients. One WS channel carries chat tokens, narration
// entries, session status, and readiness events (KTD: single duplex channel).
export class WsHub {
  private readonly wss: WebSocketServer;
  private readonly handlers = new Set<ClientMessageHandler>();
  private readonly greeters = new Set<(client: WebSocket) => void>();

  constructor(server: http.Server, wsPath = "/ws") {
    this.wss = new WebSocketServer({ server, path: wsPath });
    this.wss.on("error", (err) => console.error(`WS hub error: ${err.message}`));
    this.wss.on("connection", (socket) => {
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

  broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    }
  }

  close(): void {
    this.wss.close();
  }
}
