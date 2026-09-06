---
title: A stack frame that cannot exist means you are reading the wrong source
date: 2026-09-03
category: workflow
tags: [dev-server, vite, version-skew, reproduction, debugging, stale-cache, migration]
module: ui/src/components/StateGraph.tsx, ui/vite.config.ts, server/src/storage/worlds.ts
problem_type: environment
symptoms:
  - a UI error the author hits on every click and no test can reproduce
  - the data checks out at rest, over the wire, and through the real reducer
  - the reported stack names a line number that holds different code in the file on disk
  - a runtime TypeError that reads exactly like corrupt data
---

The author reported that `/live` died on every click: "The main view could not be
displayed. Cannot read properties of undefined (reading 'replace')." Every node,
every transition.

The message was specific enough to look easy. `reading 'replace'` on `undefined`
means some `x.replace(...)` where `x` is undefined — and on that surface there was
one obvious candidate, `clip.path.replace(/^clips\//, "")` in the clip-set editor.
`clip.path` undefined, rather than `clip` undefined, even fit the wording: a clip
object with no path. The theory wrote itself. The World's manifest must hold a
malformed clip.

It does not. Four checks, each stronger than the last, all clean:

- the manifest on disk — every clip in every sequence, states and transitions, has
  a string `path`;
- the World the *running server* broadcasts, dumped by connecting to it over the WS
  with the boot token and reading the `world` message — `version 4`, `readable`,
  zero malformed clips, `incomplete: []`;
- the edit itself round-tripped: flatten → toggle every link → nest → the real
  `updateState` / `updateTransition` / `cleanClips`, for every owner in the World.
  No pathless member, no lost member;
- the components mounted on the *real* state — every message from the running
  server fed through the real store reducer — then every node and every transition
  clicked, asserting each panel actually rendered. Nothing threw.

That last one is the point at which the investigation should have turned, and did
not. A reproduction that faithfully uses the real data, the real reducer and the
real components, and *still* cannot reproduce, is not a sign that the repro needs
to be more faithful. It is evidence that the code under test is not the code that
crashed.

Instead the search widened, and picked up a wrong deduction on the way. Every
`.replace(` call site in the built bundle was enumerated to prove by elimination
that only `clip.path.replace` was reachable — real work, and worthless, because the
author was on the Vite dev server, where nothing is tree-shaken and the bundle's
call graph does not apply. Evidence gathered from the wrong artefact feels exactly
like evidence.

## What settled it

The console stack, once asked for:

```
StateGraph.tsx:449 Uncaught TypeError: Cannot read properties of undefined (reading 'replace')
    at StateGraph.tsx:449:48
    at Array.map (<anonymous>)
    at NodePanel (StateGraph.tsx:447:21)
```

`NodePanel` maps something at line 447 and calls `.replace` at 449. In the file on
disk, `NodePanel` begins at line 470, and it has not mapped clips directly since
that loop moved into `ClipSetEditor`. **The stack described a file that no longer
exists.** That is not a subtle clue — a frame that cannot exist in the current
source is proof the runtime is holding different source, and it outranks every
theory built by reading the repository.

One command confirmed it:

```bash
curl -s http://localhost:5173/src/components/StateGraph.tsx | grep -c ClipSetEditor   # 0
```

The dev server was serving a `StateGraph.tsx` with no `ClipSetEditor`, no
`flatten`, and two bare `clip.path.replace` sites — the shape of the file several
commits earlier, before clip sequences existed.

## Root cause

Version skew between two halves of one dev setup that update on different schedules:

- the core runs `tsx src/index.ts`, so it is **always** current source, and it sends
  a version 4 World in which `state.clips` holds *sequences*:
  `[{ clips: [{ path, durationMs }] }, …]`;
- the Vite dev server had been running long enough to miss the branch's changes and
  was serving a stale in-memory module graph — UI code from before sequences, which
  maps `state.clips` and reads `clip.path` on a `{ clips: […] }` object.

`undefined.replace` — precisely the reported error, from data that was never
malformed. The migration was correct on both sides. Only the two sides were from
different days.

Confirmed same-directory rather than a second checkout, which is what makes it a
cache problem rather than a worktree mix-up:

```
"node" "C:\GitHub\hal1000-harness\ui\node_modules\.bin\..\vite\bin\vite.js"
```

## The fix

Restart the dev server, clearing its transform cache:

```bash
# kill the vite process, then
rm -rf node_modules/.vite ui/node_modules/.vite
npm run dev:ui
```

Then verify it is serving what you think, rather than assuming the restart worked:

```bash
curl -s http://localhost:5173/src/components/StateGraph.tsx \
  | grep -c -e ClipSetEditor -e commitBound     # was 0, now non-zero
```

A hard reload in the browser does not help. The stale copy is on the server side.

## Prevention

**A stack frame that cannot exist in the file on disk ends the investigation.**
Before theorising about the data, check that the line number holds the code the
stack says it does. When it does not, stop reading the repository and diff what is
being served.

**Reproduction failure is a finding, not a setback.** Once a repro uses the real
data through the real code and still will not fail, spend the next step on the gap
between your runtime and theirs — the served bundle, the process's start time, the
working directory — rather than on a more elaborate repro.

**Version skew mimics data corruption.** Every symptom here pointed at a malformed
clip: a type error reading a field, on one surface, reproducibly. A corruption
theory that survives a clean manifest, a clean broadcast and a clean round trip is
almost certainly a skew theory wearing its clothes.

**Ask for the stack early.** It was one message, and it was the only artefact that
carried the answer. The four clean data checks were rigorous and could not have
found this, because the crashing code was never in the repository at the time.

## The false-evidence trap

While looking for staleness, `grep -c worldReports` was compared between the served
module (2) and the file on disk (3), and the difference read as proof the whole
tree was stale. It is not: the served file is transformed JavaScript, and the third
occurrence lives in a TypeScript `interface` that type erasure removes. The count
still differs against a freshly restarted server.

Do not test freshness by counting occurrences across a transform boundary. Test it
with a **structural marker** — a function or component that must exist in the
current source and cannot exist in the old one. `ClipSetEditor` was that marker
here, and it gave an unambiguous 0.

## Related

- `a-scratch-data-dir-is-safe-until-you-invite-the-user-into-it.md` — the other way
  an agent's process and the author's process quietly diverge, and the same lesson
  about checking which instance you are actually looking at.
- `a-value-frozen-for-one-caller-is-stale-for-the-next.md` — the same shape one
  level down: a cached copy that was correct when it was taken and is read long
  after the source moved.
