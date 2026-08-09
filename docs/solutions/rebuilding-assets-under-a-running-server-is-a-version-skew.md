---
title: Rebuilding the UI under a running server serves new client code to old server code
date: 2026-08-09
category: bug
tags: [dev-loop, deployment, wire-contract, verification, blind-spots]
module: ui/dist, server/src/app.ts, ui/src/components/ErrorBoundary.tsx
problem_type: environment
symptoms:
  - the app loads as a black page with nothing in it
  - it worked minutes ago and no code was deployed
  - the settings file on disk is in an older shape than the client expects
  - the server process start time predates the change being blamed
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
