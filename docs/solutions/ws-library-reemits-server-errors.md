---
title: ws WebSocketServer re-emits HTTP server errors — attach only after listen succeeds
date: 2026-08-02
category: bug
tags: [websocket, ws, nodejs, EADDRINUSE, crash]
module: server/src/app.ts, server/src/ws.ts
symptoms:
  - "Unhandled 'error' event on WebSocketServer instance"
  - process crash on EADDRINUSE despite an error handler on the http server
  - port-conflict test times out instead of rejecting
---

## Problem

Constructing `new WebSocketServer({ server })` before calling `server.listen()` caused a
failed port bind (EADDRINUSE) to crash the process, even though the http server had a
`once("error")` handler that should have converted it to a rejected promise.

## Root cause

The `ws` library forwards the underlying HTTP server's `error` events and re-emits them
on the `WebSocketServer` instance. Our handler on the http server fired, but the re-emitted
copy on the WebSocketServer had no listener — and an unhandled `error` event on an
EventEmitter throws, killing the process.

## Solution

Two layers (both in place):
1. Attach the `WsHub`/`WebSocketServer` **after** `server.listen()` resolves (`server/src/app.ts`).
2. Keep a `wss.on("error", ...)` listener anyway for runtime errors (`server/src/ws.ts`).

Related hardening from the same incident: bind explicitly to `127.0.0.1` — Windows
dual-stack (`::`) binding made double-bind failures unreliable to detect; loopback-only is
also the correct security posture for this app. And every individual client socket needs
its own `socket.on("error")` — the ws server does not absorb per-connection errors.

## Prevention

Any time an `error` event "should have been handled" but still crashes, check whether a
wrapper library re-emits it on a second emitter. Attach dependent servers/wrappers only
after the underlying listen/bind succeeds.
