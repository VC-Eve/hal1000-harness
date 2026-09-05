import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import type { WebSocket } from "ws";
import { WsHub } from "../src/ws.js";

/**
 * The real observer membership, rather than a test double's version of it.
 *
 * Every other observer test in this repo runs against a `FakeHub` that
 * reimplements `observe` and `isObserver` in its own three lines — so what was
 * covered was the double, not the code. Two independent implementations, one of
 * them exercised. This exercises the other one.
 *
 * No listening socket is needed: membership is a `WeakSet` keyed on object
 * identity, so any object stands in for a connection.
 */
let hub: WsHub | null = null;
let server: http.Server | null = null;

function makeHub(): WsHub {
  server = http.createServer();
  hub = new WsHub(server);
  return hub;
}

const socket = (id: string) => ({ id }) as unknown as WebSocket;

afterEach(() => {
  hub?.close();
  server?.close();
  hub = null;
  server = null;
});

describe("observer membership", () => {
  it("remembers the socket that declared, and only that one", () => {
    const h = makeHub();
    const declared = socket("declared");
    const other = socket("other");

    h.observe(declared);

    expect(h.isObserver(declared)).toBe(true);
    expect(h.isObserver(other)).toBe(false);
  });

  it("answers false for a socket that never declared", () => {
    const h = makeHub();

    expect(h.isObserver(socket("fresh"))).toBe(false);
  });

  it("answers false rather than throwing when there is no socket", () => {
    // The internal-call path: a message with no connection behind it. Callers
    // ask this before refusing, so an exception here would be a crash on a path
    // that is meant to be ordinary.
    const h = makeHub();

    expect(h.isObserver(undefined)).toBe(false);
  });

  it("accepts a second declaration on the same socket", () => {
    // Re-sent on every reconnect by design, so a repeat must be ordinary.
    const h = makeHub();
    const declared = socket("declared");

    h.observe(declared);
    h.observe(declared);

    expect(h.isObserver(declared)).toBe(true);
  });
});
