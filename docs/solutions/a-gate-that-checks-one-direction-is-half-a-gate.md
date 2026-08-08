---
title: A gate that checks one direction is half a gate
date: 2026-08-08
category: pattern
tags: [security, authorization, websockets, broadcast, blind-spots, testing]
module: server/src/ws.ts
problem_type: security_issue
symptoms:
  - an unauthenticated client receives state it never asked for
  - an authorization check covers requests but not server-initiated pushes
  - the positive-path test passes and the guarantee is still broken
  - a handshake appears to work because nothing rejected is visible
---

## Context

The WS hub gained a per-boot token: the first message on a socket must present it, and anything else
closes the connection. The implementation gated `onMessage` — every inbound message ran through the
check before reaching a handler — and the positive path worked. A socket with the token was admitted;
a socket without one was closed.

It was still wide open. Every service in the app pushes state through `hub.broadcast` unprompted:
sessions, readiness, narration entries, the people roster, the candidate queue. `broadcast` iterated
every open socket and asked only whether it was open. So an unauthenticated client that simply
connected and stayed quiet received all of it, continuously, without ever sending a message.

The gate guarded writes and gave reads away.

## Guidance

**When adding authorization to a duplex channel, enumerate both directions before writing the check.**
A request/response API has one direction and one place to guard. A socket, an SSE stream, a pub/sub
topic, or anything with server-initiated pushes has two, and the second is easy to miss precisely
because nothing calls it — the push originates elsewhere, from code that was written before the gate
existed and does not mention it.

The three places that needed the check here, only one of which was obvious:

```ts
// 1. Inbound — the obvious one.
socket.on("message", (raw) => {
  if (this.token && !this.authed.has(socket)) { /* reject */ }
  for (const handler of this.handlers) handler(msg, socket);
});

// 2. Outbound push — the one that was missed.
broadcast(msg: ServerMessage): void {
  for (const client of this.wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    if (this.token && !this.authed.has(client)) continue;   // <- added after a test caught it
    client.send(data);
  }
}

// 3. The greeting — state replayed on connect, which is a push by another name.
// Previously sent immediately on `connection`; now waits for admission, because
// the greeters replay exactly the state the gate exists to withhold.
```

**The greeting is the subtle one.** A connect-time replay does not look like a broadcast and does not
go through it, but it is the same thing: state leaving the server without the client asking. Anything
that fires on connection — a backlog, a snapshot, a "here is the current view" — belongs behind the
gate.

## Why This Matters

The failure is silent and looks like success from every angle except the one that matters. There is no
error, no rejected request, no log line. The gate is visibly working — you can watch it close an
unauthenticated socket that tries to send something — while the same socket quietly accumulates
everything the server pushes.

It also inverts the usual reasoning about risk. The dangerous client here is the *passive* one. A
client that tries something gets rejected and is easy to notice; a client that does nothing gets
served.

## When to Apply

Any time authorization is added to a channel that can push:

- WebSocket hubs, SSE endpoints, long-poll streams
- Pub/sub topics where the subscription and the publish are separate code paths
- Any "replay on connect" or "greet with current state" behaviour
- Broadcast helpers that were written before the auth existed and take a client list rather than a
  request

The question to ask is not "did I check the request?" but "list every way bytes leave the server for
this client, and check each one."

## Examples

**The test that caught it, and the one that did not.**

The positive-path test passed throughout:

```ts
it("admits a socket that presents the right token", async () => {
  const { messages } = await probe([{ type: "authenticate", token: TOKEN }]);
  expect(messages.some((m) => m.type === "hello")).toBe(true);
});
```

The one that found the hole asserts an **absence**, and needs a hub with something to leak — a hub
with no greeters would pass this trivially and prove nothing:

```ts
beforeAll(() => {
  hub = new WsHub(server, "/ws", TOKEN);
  // A greeter, so "says nothing until admitted" is asserting against a hub that
  // genuinely has state to leak rather than one that is simply quiet.
  hub.onConnection((client) => hub.sendTo(client, { type: "readiness", readiness: {} as never }));
});

it("says nothing at all until the token is presented", async () => {
  const { messages } = await probe([]);   // connect, send nothing, wait
  expect(messages).toEqual([]);
});

it("withholds broadcasts from a socket that has not been admitted", async () => {
  const ws = new WebSocket(url);
  await open(ws);
  hub.broadcast({ type: "session-status", sessionId: "s1", state: "live" } as never);
  await settle(120);
  expect(messages).toEqual([]);
});
```

Both are negative assertions about a client that does nothing. That shape — *connect, stay silent,
assert silence* — is the one worth reaching for whenever a gate is added to a pushing channel.

## Related

- `loopback-binding-is-not-an-origin-check.md` — the same class of reasoning one layer down: a
  property that governs reachability is not a property that governs trust.
- `a-flag-nothing-reads-looks-shipped.md` — the mirror image on the read side, where a value on the
  wire looked shipped because no test asked what consumed it.
