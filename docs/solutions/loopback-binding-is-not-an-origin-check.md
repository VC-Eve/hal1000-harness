---
title: Binding to 127.0.0.1 is not an origin check
date: 2026-08-06
category: bug
tags: [security, dns-rebinding, origin, host-header, loopback, http, websocket]
module: server/src/http.ts, server/src/origin.ts, server/src/ws.ts
symptoms:
  - a local-only route serves sensitive data to any page the user happens to visit
  - one surface in the process validates Origin and a newer one does not
  - a security argument rests on the server being bound to 127.0.0.1
---

# Binding to 127.0.0.1 is not an origin check

`GET /api/vision/stream` served live webcam video with no `Host` or `Origin` validation. The
WebSocket hub in the same process validated origin; the new HTTP route did not. It was written on
the assumption that a loopback bind is the security boundary.

It is not.

## Why the bind does not save you

DNS rebinding: an attacker registers a hostname that resolves to `127.0.0.1`. The browser connects
to *your* local port and sends *their* hostname as `Host`. The bind did its job — it refused
connections from other machines — and the attack never needed one.

Two details make this worse than it first sounds:

- An `<img>` load is a no-CORS request that still renders. The same-origin policy stops the page
  *reading* the bytes; it does not stop the user's camera being displayed to a remote page, and
  `multipart/x-mixed-replace` renders in an `<img>` perfectly well.
- The user does not have to do anything unusual. Any page open in any tab is enough.

## The fix

A shared predicate, `server/src/origin.ts`, exporting `allowsOrigin()` and `allowsHost()`. The route
checks both and returns 403 otherwise:

```ts
const host = req.headers.host;
const origin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin;
if (!server || !allowsHost(server, host) || !allowsOrigin(server, origin)) {
  res.writeHead(403, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "forbidden" }));
  return;
}
```

`allowsHost` is the half that closes rebinding. The attacker controls what the hostname *resolves*
to; they do not control what the browser *sends*. Requiring `Host` to name a loopback address on the
port this server is actually bound to makes a rebound hostname fail even though the packets arrived
at the right IP.

`allowsOrigin` covers the separate case: a page served from a different local port.

## Why it is one module and not two checks

`ws.ts` already had an origin check. The route was written without one. Two surfaces enforcing the
same rule from two copies is how they drift, and the copy that lags is the one that leaks — so the
predicate moved out and both call it. `ws.ts` keeps only its refusal logging, because only the hub
can explain a blank page to a user.

## The part worth sitting with

This was not a new class of mistake in this codebase. One feature earlier,
`docs/residual-review-findings/feat-ambient-log-monitors.md` recorded an accepted P0 of exactly this
shape — *"any page on any localhost port could schedule a shell command"* — narrowed it with an
origin allowlist on the WS hub, and wrote down that the complete fix is a per-boot token.

The next feature added a new unauthenticated local surface and inherited none of it.

An accepted residual is not a closed one. When a documented risk names a class of decision, the
question to ask of every new surface is whether it repeats the class — not whether it repeats the
file.

## Prevention

- Route every new HTTP or WS surface through `allowsHost` / `allowsOrigin` rather than writing an
  ad hoc check.
- Treat "it is bound to loopback" as a statement about network reachability, never about trust.
- The mitigation is still partial. A per-boot token remains owed — see
  `docs/residual-review-findings/feat-ambient-log-monitors.md` for the fix direction, and
  `docs/residual-review-findings/feat-vision.md` for the camera-route instance.

## A testing gotcha

`fetch` treats `Host` as a forbidden header name and silently drops it, so a `fetch`-based test
sends the real host and proves nothing while appearing to pass. Use `node:http`:

```ts
const req = http.request(
  { host: "127.0.0.1", port, path: "/api/vision/stream", headers: { host: "camera.evil.example" } },
  (res) => { res.resume(); resolve(res.statusCode ?? 0); },
);
```

Covered in `server/test/vision/stream-route.test.ts`, alongside the foreign-`Origin` refusal and the
no-`Origin` case that must keep working so protocol clients retain access.
