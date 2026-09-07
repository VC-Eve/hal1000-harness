---
title: Rebuilding the UI under a running server serves new client code to old server code
date: 2026-08-09
last_updated: 2026-09-06
category: bug
tags: [dev-loop, deployment, wire-contract, verification, blind-spots]
module: ui/dist, server/src/app.ts, ui/src/components/ErrorBoundary.tsx
problem_type: environment
symptoms:
  - the app loads as a black page with nothing in it
  - it worked minutes ago and no code was deployed
  - the settings file on disk is in an older shape than the client expects
  - the server process start time predates the change being blamed
  - a UI change is rebuilt and restarted and the open tab still behaves the old way
---

## Context

`npm run start` serves the built UI out of `ui/dist`. The server reads it from disk per request, so
it has no idea the bundle was replaced underneath it.

During a session that changed the settings wire contract, `npm run build` was run several times to
check the UI. An instance the user had been running since the previous evening was still serving that
directory. The result: a server from *before* the wire change, serving a client from *after* it.

The client read `settings.backends.shared.endpoint`. The old server had never run the migration that
creates `backends`, so it sent `providerEndpoint` and no `backends` at all. React threw on the
undefined, unmounted the whole tree, and the page went black.

## Why it was hard to see

Nothing in the diagnosis pointed at the diff. Tests were green, typecheck was clean, and the code was
correct — both halves of it. Only the *combination* was wrong, and that combination exists only on a
machine where a build outran a restart.

The two facts that identified it, neither of them in the code:

- the server process start time (`Get-Process -Id <pid> | Select StartTime`) predated the work
- `settings.json` on disk still held the old shape, which is only possible if the migration had never
  run

## There is a third version, and it is the one you are looking at

Restarting the server does not reload an already-open tab. So three things must agree, not two:

| version | what changes it | what does not |
|---|---|---|
| the **server process** | a restart | rebuilding, refreshing |
| the **built assets on disk** | `npm run build` | restarting |
| the **page running in the tab** | a refresh | restarting the server |

A later session hit every pairing of this. A UI bundle was rebuilt under a running server (the
original defect above), then the server was restarted while the operator's tab stayed open, then a
tab was refreshed while a `server/` change had not been rebuilt into the process. Each time the
symptom was a feature that "did not work", and each time the code was correct.

The practical rule, for this repo:

- changed `server/` or `shared/` → **restart** (`tsx` compiles at boot and never reloads)
- changed `ui/` only → **`npm run build`, then hard-refresh the tab** — no restart needed, because
  the server reads `ui/dist` from disk per request
- either way → **the open tab is its own version**, and "I restarted" is not "I am looking at the
  new code"

Worth checking rather than assuming, both of which are one command:

```bash
# is the running process older than the change?
Get-Process -Id <pid> | Select-Object StartTime

# is the server serving the bundle that is on disk?
curl -s http://127.0.0.1:9000/ | grep -o 'assets/[^"]*\.js'
ls ui/dist/assets/*.js
```

When those two agree and the behaviour is still wrong, the tab is the remaining suspect — and a
freshly opened page is the cheapest way to tell a stale tab from a real defect. (In one case this
misled the diagnosis: a fresh page *did* behave correctly, which looked like proof of a stale tab,
and the real cause was a CSS rule that only lost the cascade on one of the two surfaces. A fresh
page proves the tab is not the *only* problem; it does not prove the tab is the problem.)

## The rule

**The bundle and the server ship together and deploy separately.** Any build under a live instance
is a deployment of half a version. Either restart after building, or do not build against the
directory a live instance is serving — `scripts/screenshot.mjs` boots its own HAL against a throwaway
data directory precisely so it never has this problem.

Say so before rebuilding when someone else is using the app. The build takes half a second; the black
page took considerably longer to explain.

## The part worth keeping

A version skew is a dev-loop artefact and cannot recur once server and bundle are restarted together.
The *blank page* was the real defect, and it was not specific to this cause at all: React unmounts
the entire tree on any uncaught render error, and there was no error boundary anywhere in `ui/src`.

That is worst exactly where it matters most. The settings panel is where someone goes to fix a fault,
so a settings crash that also blanks the app leaves no way in.

There are now two boundaries — one around the main view, one around the settings modal — so either
surface survives the other failing. The fallback shows the **actual error message**:

> Settings could not be displayed.
> `Cannot read properties of undefined (reading 'shared')`

That string is what identified this in one look. "An error occurred" would have said nothing. The
boundary deliberately depends on no app state, no settings and no persona copy: it renders *because*
something upstream failed, so reading state to describe the failure risks throwing inside the handler
for a throw.

## Related

- [editing-state-a-running-process-caches-loses-the-edit](editing-state-a-running-process-caches-loses-the-edit.md)
  — the same family: a running process holding something a change underneath it invalidated. There it
  was cached JSON; here it is served assets.
- [a-flag-nothing-reads-looks-shipped](a-flag-nothing-reads-looks-shipped.md) — the reverse failure,
  where the data was right and nothing rendered it.
