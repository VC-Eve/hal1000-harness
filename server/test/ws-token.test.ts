// The per-boot handshake (U1, R37/R38).
//
// These tests deliberately do NOT use the `connect` helper — the helper exists
// to satisfy the gate, and the gate is what is under test here. Every socket is
// opened raw.
//
// Most of this runs against a bare `WsHub` on a bare http server rather than a
// booted app. The gate lives in the hub, so that is where it is cheapest and
// most directly tested; booting apps here made the whole suite flaky by loading
// it with servers these assertions never needed.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { WsHub } from "../src/ws.js";
import { startApp, type App } from "../src/app.js";
import { TOKEN_FILE, generateToken, tokenMatches } from "../src/token.js";

const TOKEN = generateToken();

let server: http.Server;
let hub: WsHub;
let port: number;

// Collect frames for a beat, then report what arrived and whether the socket
// survived. Most assertions here are about absence, and an absence needs a
// bounded wait to mean anything.
async function probe(
  send: unknown[],
  opts: { headers?: Record<string, string>; port?: number; settleMs?: number } = {},
): Promise<{ messages: Record<string, unknown>[]; closed: boolean }> {
  const ws = new WebSocket(
    `ws://localhost:${opts.port ?? port}/ws`,
    opts.headers ? { headers: opts.headers } : undefined,
  );
  const messages: Record<string, unknown>[] = [];
  let closed = false;
  ws.on("message", (raw) => {
    try {
      messages.push(JSON.parse(String(raw)) as Record<string, unknown>);
    } catch {
      /* not JSON, not asserted on */
    }
  });
  ws.on("close", () => {
    closed = true;
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  for (const msg of send) ws.send(typeof msg === "string" ? msg : JSON.stringify(msg));
  await new Promise((r) => setTimeout(r, opts.settleMs ?? 120));
  if (!closed) ws.close();
  return { messages, closed };
}

describe("ws handshake", () => {
  beforeAll(async () => {
    server = http.createServer();
    hub = new WsHub(server, "/ws", TOKEN);
    // A greeter, so the "says nothing until admitted" test is asserting against
    // a hub that genuinely has state to leak rather than one that is simply
    // quiet. Without this the test would pass on an empty hub and prove nothing.
    hub.onConnection((client) => hub.sendTo(client, { type: "readiness", readiness: {} as never }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    port = typeof address === "object" && address ? address.port : 0;
  });

  afterAll(async () => {
    hub.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("says nothing at all until the token is presented", async () => {
    // The negative that matters. The greeters replay narration, settings, the
    // roster and the candidate queue — if `hello` arrives before the handshake,
    // so does all of that, and the gate would be guarding writes while giving
    // reads away.
    const { messages } = await probe([]);
    expect(messages).toEqual([]);
  });

  it("withholds broadcasts from a socket that has not been admitted", async () => {
    // Gating inbound messages alone would be half a gate: every service pushes
    // state through `broadcast` unprompted, so an unauthenticated socket would
    // receive all of it by simply staying connected. This failed on the first
    // implementation and is why `broadcast` checks admission too.
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    const messages: Record<string, unknown>[] = [];
    ws.on("message", (raw) => messages.push(JSON.parse(String(raw)) as Record<string, unknown>));
    await new Promise<void>((resolve) => ws.once("open", () => resolve()));
    hub.broadcast({ type: "session-status", sessionId: "s1", state: "live" } as never);
    await new Promise((r) => setTimeout(r, 120));
    expect(messages).toEqual([]);
    ws.close();
  });

  it("delivers broadcasts once admitted", async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    const messages: Record<string, unknown>[] = [];
    ws.on("message", (raw) => messages.push(JSON.parse(String(raw)) as Record<string, unknown>));
    await new Promise<void>((resolve) => ws.once("open", () => resolve()));
    ws.send(JSON.stringify({ type: "authenticate", token: TOKEN }));
    await new Promise((r) => setTimeout(r, 80));
    hub.broadcast({ type: "session-status", sessionId: "s1", state: "live" } as never);
    await new Promise((r) => setTimeout(r, 120));
    expect(messages.some((m) => m.type === "session-status")).toBe(true);
    ws.close();
  });

  it("admits a socket that presents the right token", async () => {
    const { messages, closed } = await probe([{ type: "authenticate", token: TOKEN }]);
    expect(messages.some((m) => m.type === "hello")).toBe(true);
    expect(closed).toBe(false);
  });

  it("closes a socket that presents a wrong token", async () => {
    const { messages, closed } = await probe([{ type: "authenticate", token: generateToken() }]);
    expect(messages.some((m) => m.type === "hello")).toBe(false);
    expect(messages.some((m) => m.type === "error" && m.code === "unauthenticated")).toBe(true);
    expect(closed).toBe(true);
  });

  it("closes a socket whose first message is not the handshake", async () => {
    // Not merely ignored. A silent drop reads to an honest client as a hang, and
    // lets a dishonest one probe the protocol for as long as it likes.
    const { messages, closed } = await probe([{ type: "list-people" }]);
    expect(messages.some((m) => m.type === "vision-people")).toBe(false);
    expect(closed).toBe(true);
  });

  it("closes a socket that sends no token at all", async () => {
    const { closed } = await probe([{ type: "authenticate" }]);
    expect(closed).toBe(true);
  });

  it("accepts a connection with no Origin, so agent access survives", async () => {
    // AGENTS.md protects this path deliberately: a protocol client is not a
    // browser and has no Origin. The token is what it presents instead.
    const { messages } = await probe([{ type: "authenticate", token: TOKEN }]);
    expect(messages.some((m) => m.type === "hello")).toBe(true);
  });

  it("refuses a foreign origin before the token is even considered", async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`, { headers: { origin: "https://evil.example" } });
    const outcome = await new Promise<string>((resolve) => {
      ws.once("open", () => resolve("open"));
      ws.once("error", () => resolve("rejected"));
    });
    expect(outcome).toBe("rejected");
  });
});

describe("token comparison", () => {
  // timingSafeEqual throws on a length mismatch, so the guard in `tokenMatches`
  // is what keeps a short token from taking the process down rather than merely
  // being refused.
  it("refuses a token of the wrong length without throwing", () => {
    expect(() => tokenMatches(TOKEN, "short")).not.toThrow();
    expect(tokenMatches(TOKEN, "short")).toBe(false);
  });

  it("refuses a non-string token", () => {
    expect(tokenMatches(TOKEN, { nested: true })).toBe(false);
    expect(tokenMatches(TOKEN, undefined)).toBe(false);
    expect(tokenMatches(TOKEN, 12345)).toBe(false);
  });

  it("accepts only the exact token", () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(tokenMatches(TOKEN, TOKEN.toUpperCase())).toBe(false);
  });

  it("mints a different token each time", () => {
    expect(generateToken()).not.toBe(generateToken());
    expect(generateToken().length).toBeGreaterThanOrEqual(32);
  });
});

describe("token wiring in a booted app", () => {
  // One booted app, for the wiring the bare hub cannot show: that the token
  // reaches disk where a protocol client reads it, and that production does not
  // serve it over HTTP.
  const DATA_DIR = `${process.env.TEMP ?? "/tmp"}/hal1000-token-wiring-${process.pid}`;
  let app: App;
  let previousDataDir: string | undefined;

  beforeAll(async () => {
    previousDataDir = process.env.HAL_DATA_DIR;
    process.env.HAL_DATA_DIR = DATA_DIR;
    app = await startApp(0);
  });

  afterAll(async () => {
    await app.close();
    // Restored rather than deleted: other suites in this worker set it too, and
    // leaving ours behind would point them at a directory we are about to remove.
    if (previousDataDir === undefined) delete process.env.HAL_DATA_DIR;
    else process.env.HAL_DATA_DIR = previousDataDir;
    await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
  });

  it("leaves the token where a protocol client can read it", async () => {
    const onDisk = await fs.readFile(path.join(DATA_DIR, TOKEN_FILE), "utf8");
    expect(onDisk).toBe(app.wsToken);
    expect(onDisk.length).toBeGreaterThanOrEqual(32);
  });

  it("forbids caching the document that carries the token", async () => {
    // The bundle is content-hashed and may be cached forever; index.html is the
    // one file that must always come from the server, because it now holds this
    // boot's token. A cached copy carries a previous boot's — or none at all if
    // it predates the handshake — and the only symptom is a socket that opens
    // and is immediately closed, with nothing to point at the cause.
    const res = await fetch(`http://localhost:${app.port}/`);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("stamps the token into the document it serves", async () => {
    const html = await fetch(`http://localhost:${app.port}/`).then((r) => r.text());
    expect(html).toContain(app.wsToken);
  });

  it("does not serve the token over HTTP outside the dev script", async () => {
    // In production the token travels inside the served document. A route that
    // answered here would hand it to anything already passing the origin check,
    // which is the set the handshake exists to add a second gate for.
    const res = await fetch(`http://localhost:${app.port}/api/ws-token`);
    expect(res.status).toBe(404);
  });

  it("admits a real client that presents the booted app's token", async () => {
    const { messages } = await probe([{ type: "authenticate", token: app.wsToken }], { port: app.port });
    expect(messages.some((m) => m.type === "hello")).toBe(true);
  });
});
