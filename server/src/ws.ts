import type http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { HAL_VERSION, type ClientMessage, type ServerMessage } from "../../shared/src/types.js";
import { allowsOrigin } from "./origin.js";
import { tokenMatches } from "./token.js";

export type ClientMessageHandler = (msg: ClientMessage, client: WebSocket) => void;

// Hub for all connected clients. One WS channel carries chat tokens, narration
// entries, session status, and readiness events (KTD: single duplex channel).
export class WsHub {
  private readonly wss: WebSocketServer;
  private readonly handlers = new Set<ClientMessageHandler>();
  private readonly greeters = new Set<(client: WebSocket) => void>();
  // Sockets that have presented this boot's token. Membership, not a flag on the
  // socket, so nothing can set it by writing a property on an object we handed
  // out. Entries are removed on close so a long-lived process does not retain
  // one per reconnect.
  private readonly authed = new WeakSet<WebSocket>();

  private readonly server: http.Server;
  private readonly token: string | null;

  constructor(server: http.Server, wsPath = "/ws", token: string | null = null) {
    this.server = server;
    // Null disables the handshake. Only tests construct a hub this way; every
    // production path passes the boot token, and `startApp` mints one
    // unconditionally.
    this.token = token;
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
      // The greeting waits for the handshake.
      //
      // It is not a courtesy — the greeters replay the narration ring, the
      // settings, the people roster and the candidate queue, which is precisely
      // the state the token exists to withhold. Sending it before authenticating
      // would leave the handshake guarding writes while giving reads away.
      if (!this.token) this.admit(socket);

      socket.on("message", (raw) => {
        let msg: ClientMessage;
        try {
          msg = JSON.parse(String(raw)) as ClientMessage;
        } catch {
          this.sendTo(socket, { type: "error", code: "bad_message", message: "I'm sorry, I can't parse that." });
          return;
        }

        if (this.token && !this.authed.has(socket)) {
          // Exactly one message is accepted before the handshake, and anything
          // else closes the socket rather than being ignored. Ignoring would let
          // a caller probe the protocol indefinitely, and a silent drop reads to
          // an honest client as the server having hung.
          if (msg.type === "authenticate" && tokenMatches(this.token, msg.token)) {
            this.admit(socket);
            return;
          }
          this.sendTo(socket, {
            type: "error",
            code: "unauthenticated",
            message: "I'm sorry, I can't accept that without this session's token.",
          });
          socket.close();
          return;
        }

        for (const handler of this.handlers) handler(msg, socket);
      });
    });
  }

  // Greet a socket and let its messages through from here on.
  private admit(socket: WebSocket): void {
    this.authed.add(socket);
    this.sendTo(socket, { type: "hello", app: "hal1000", version: HAL_VERSION });
    for (const greet of this.greeters) greet(socket);
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
  // closing nothing. That rule survives the token: an agent still connects
  // without an Origin, it just reads the token from the data dir first.
  //
  // The origin check runs first and the token second. Order matters for the
  // hole this pair exists to close — while `dev:ui` runs, the Vite origin is
  // trusted, so a page served from that port passes the origin gate. It does not
  // pass the token gate, because it cannot read a file.
  //
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

  // Broadcast reaches admitted sockets only.
  //
  // Gating `onMessage` alone would have been half a gate: an unauthenticated
  // socket sends nothing, but every service pushes state through here
  // unprompted — sessions, readiness, narration, the roster — so it would have
  // received all of it by simply staying connected. The handshake has to hold
  // in both directions or it holds in neither.
  broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const client of this.wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (this.token && !this.authed.has(client)) continue;
      client.send(data);
    }
  }

  close(): void {
    for (const client of this.wss.clients) client.terminate();
    this.wss.close();
  }
}
