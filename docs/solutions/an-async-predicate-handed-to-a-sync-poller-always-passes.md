---
title: An async predicate handed to a synchronous poller always passes
date: 2026-09-04
category: pattern
tags: [testing, async, blind-spots, coverage-illusion, typescript, test-seams]
module: server/test/wait.ts, server/test/live/transport.test.ts
problem_type: logic_error
symptoms:
  - a new test passes on the first run and would pass with the feature deleted
  - a `waitFor` returns instantly instead of polling
  - an assertion inside a callback never runs and nothing says so
  - the typechecker catches it and the test run does not
  - the same mistake is invisible in any directory the tsconfig does not include
---

## Context

`server/test/wait.ts` polls a condition rather than sleeping. Its contract is a
**synchronous** predicate:

```ts
export async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
```

Writing a test for the shuffle advance, the thing to assert was a fact that
lives on disk — that a track whose file had gone was marked `unplayable` in the
playlist index. Reading the index is asynchronous, so the predicate was written
asynchronous too:

```ts
await waitFor(async () => {
  const held = await audio.load(list.id);
  return held?.tracks.find((t) => t.name === "c.flac")?.unplayable === true;
}, "the missing track to be marked unplayable");
```

An `async` function returns a `Promise`. A `Promise` is an object. `!object` is
`false`. So `while (!predicate())` exits on the first evaluation, `waitFor`
resolves immediately, and the comparison inside — the only assertion in that
block — is never reached. The test passed. It would have passed with
`markPlayable` deleted, with the file never removed, and with the playlist
empty.

It was caught by `npm run typecheck`, which reported
`Argument of type '() => Promise<boolean>' is not assignable to parameter of
type '() => boolean'`. It was **not** caught by the test run, and there is
nothing a test run could have done: the test did what it was written to do.

## Guidance

**A callback that must return a value is a contract, and `async` silently
changes what it returns.** The failure has nothing to do with polling — it is
that every truthiness test on a `Promise` is true. The same defect appears
wherever a predicate meets an async body:

```ts
items.filter(async (x) => await isReady(x))   // filters nothing out — keeps all
items.every(async (x) => await isValid(x))    // always true
items.some(async (x) => await isBad(x))       // always true, if items is non-empty
if (checkAsync()) { ... }                     // always taken
while (!predicate()) { ... }                  // never entered
```

Each of these runs, returns, and reports success. None of them throws. Grep for
`(async` immediately inside a `filter`, `every`, `some`, `find`, `waitFor` or a
bare `if`/`while` condition — the shape is mechanical enough to search for.

**Do not "fix" it by making the poller async.** Accepting
`() => boolean | Promise<boolean>` and awaiting it would make this call site
work and would make the *next* one — where somebody forgets the `await` inside
their own predicate — fail the same silent way. The synchronous contract is what
makes the type error possible at all. Keep it, and move the asynchrony out of
the predicate:

```ts
// The advance settles before the assertion; there is nothing to poll for.
const after = await audio.load(list.id);
expect(after!.tracks.find((t) => t.name === "c.flac")!.unplayable).toBe(true);
```

Where a genuinely async condition must be waited on, read it into a variable a
synchronous predicate can see, or give the helper a separate, explicitly
async-aware entry point — do not widen the one that exists.

**A green test proves nothing about a test that cannot fail.** The habit that
catches this is the one already recorded for fixes — revert the behaviour and
watch the test fail — applied to *new* tests as well as to regressions. Here the
whole suite went green on the first run, which is exactly the signal that should
have prompted the check: a test written for machinery this intricate passing
first time is more suspicious than a failure.

**What saved this was a type check over the test directory, and that coverage is
not uniform here.** `server/tsconfig.json` includes `test/**`, so the server
suite is typechecked and this error surfaced. `ui/tsconfig.json` includes only
`src/**`, so **nothing typechecks `ui/test/**`** — the identical mistake in a
component test would be invisible from every direction. The same gap let a
`TransportState` fixture in `ui/test/components/StateGraph.test.tsx` sit missing
a required field until a reviewer read it by eye. Closing it is not a one-line
`include` change: jest-dom's matcher types have to be wired into a
test-inclusive config first, and there is at least one other stale fixture
waiting behind it.

## Related

- `tests-that-lock-in-the-bug.md` — the neighbouring failure: there a test
  asserts the implementation's current output, here a test asserts nothing at
  all. Both look like coverage.
- `assert-the-effect-not-the-existence.md` — same family. A control that exists
  and does nothing, and an assertion that runs and checks nothing, are both
  invisible to a suite that only asks whether something is present.
- `a-comment-is-a-claim-and-nothing-runs-it.md` — the predicate's label
  (`"the missing track to be marked unplayable"`) described a wait that never
  happened, and no reader had reason to doubt it.
