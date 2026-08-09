// Connect to a running app the way a real client does.
//
// The handshake is a precondition on every socket now, so a helper is the only
// thing standing between "authenticate here" and thirty copies of it. Tests that
// exercise the gate itself deliberately do NOT use this — see ws-token.test.ts.

import WebSocket from "ws";
import type { App } from "../../src/app.js";

export interface Connected {
  ws: WebSocket;
  /** Everything the server has sent, in order, including `hello`. */
  messages: Record<string, unknown>[];
  close(): void;
}

/** Open a socket, present the token, and resolve once the server says hello. */
export async function connect(app: App, opts: { token?: string } = {}): Promise<Connected> {
  const ws = new WebSocket(`ws://localhost:${app.port}/ws`);
  const messages: Record<string, unknown>[] = [];
  ws.on("message", (raw) => {
    try {
      messages.push(JSON.parse(String(raw)) as Record<string, unknown>);
    } catch {
      // A frame that is not JSON is not something any test asserts on.
    }
  });

  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });

  ws.send(JSON.stringify({ type: "authenticate", token: opts.token ?? app.wsToken }));

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("never admitted: no hello after authenticate")), 2000);
    const check = () => {
      if (messages.some((m) => m.type === "hello")) {
        clearTimeout(timer);
        ws.off("message", check);
        resolve();
      }
    };
    ws.on("message", check);
    check();
  });

  return {
    ws,
    messages,
    close: () => ws.close(),
  };
}

/** Wait until `predicate` sees a matching message, or fail loudly. */
export async function waitFor(
  c: Connected,
  predicate: (m: Record<string, unknown>) => boolean,
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = c.messages.find(predicate);
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error("timed out waiting for a message");
    await new Promise((r) => setTimeout(r, 20));
  }
}
