---
title: A global timer spy sees every runtime the suite forgot to stop
date: 2026-09-06
category: pattern
tags: [testing, flake, timers, spies, false-pass, isolation]
module: server/test/live/runtime.test.ts, server/src/live/runtime.ts
problem_type: workflow_issue
symptoms:
  - a test asserts on captured setTimeout delays and sees a number it never armed
  - an assertion phrased as a lower bound passes while the defect it guards is present
  - the spy misses the very timer it was installed to catch
  - a test is green and the behaviour it claims to cover was never exercised
  - removing a fix does not make the test fail
---

## Context

`server/test/live/runtime.test.ts` builds a `WorldRuntime` per test through a `rig()` helper. The
runtime owns a timer: a clip's end, and every exit-time wake before it, fire from `setTimeout`.
Nothing tears a rig down unless the test says so.

Counted: **112 rigs created, 7 stopped.** The other hundred-odd keep running for the rest of the
file — their Effect tick, their clip wait, their re-entry on loop — arming timers the whole time.

Two new regression tests needed to know *how long* a wait had been armed for, so they did the
obvious thing:

```ts
const delays: number[] = [];
const scheduled = vi.spyOn(globalThis, "setTimeout");
try {
  r.runtime.setWorld(corrected);
  await drain();
  for (const call of scheduled.mock.calls) delays.push(Number(call[1]));
} finally {
  scheduled.mockRestore();
}
expect(Math.max(...delays, 0)).toBeGreaterThan(12_000);
```

The file already carried a comment recording this exact hazard from an earlier round — *"a spy on
`setTimeout` also sees every other runtime's clip wait and made this test flaky"* — and the tests
were written anyway, in the same session, by the person who had just read it.

## What actually happened

The captured delays were `[29936, 0, 0, 0, 0, 0]`. The five zeros are the drain helper's own
`setTimeout(resolve, 0)` turns. The `29936` is a **thirty-second wait belonging to another runtime**,
still looping from a test that finished long before.

Two independent failures in one array:

- **The assertion passed for the wrong reason.** `Math.max(...delays) > 12_000` is satisfied by that
  stray `29936` whether or not the code under test does anything right. Reverting the fix left the
  test green. A test that cannot fail is worse than no test, because it is counted.
- **The timer it was installed to catch never appeared.** Instrumenting the runtime directly proved
  `rearmCrossing` ran and computed the right value (`clipMs 987654`, `armedAgo 63`), so a
  `setTimeout(987591)` was issued — and the spy did not record it. Whatever the mechanism, the spy
  was not a faithful record of what the runtime armed.

So the instrument was simultaneously picking up signal that was not the subject and dropping signal
that was.

## What didn't work

- **Choosing a distinctive magnitude.** Correcting the value to `987_654` so no sibling test could
  produce it fixed the false-pass but not the miss — the re-armed timer still never reached the spy.
- **Narrowing the spy window.** Installing the spy after the setup and reading it immediately still
  caught the foreign `29936`, because a leaked runtime re-arms on its own schedule and the window
  cannot be made small enough to exclude a hundred of them.
- **Asserting the absence of a value** (`expect(delays).not.toContain(DEFAULT_CLIP_MS)`) is the worst
  form: any leaked runtime pacing an unmeasured clip arms exactly that number, so the assertion
  fails spuriously rather than passing spuriously. Same instrument, opposite damage.

## Solution

**Assert what the machine does, not what it scheduled.** Choose inputs that turn the timing question
into a behavioural one, then assert the behaviour:

```ts
// Correct the member on screen to the shortest length the machine paces
// anything at. Re-timed against that member the crossing lands at once;
// re-timed against the stale one it sits for twelve seconds.
r.runtime.setWorld({ ...w, transitions: [{ ...w.transitions[0]!,
  clips: [{ clips: [clip("one", 12_000), clip("two", MIN_CLIP_MS)] }] }] });

await waitFor(() => r.last().stateId === "b" && r.last().transitionId === null, "the landing", 3000);
```

Without the fix this times out; with it, it lands in about 250ms. Nothing another runtime does can
satisfy it, because the assertion reads *this rig's* broadcast state.

Where a spy really is the only instrument, the surviving form names a value nothing else in the file
uses and asserts its **presence**:

```ts
expect(delays).toContain(12_345);   // only this runtime can produce it
```

A positive assertion on a unique value degrades safely: a stray timer cannot forge it, and a missing
one fails honestly.

## Why this works

A spy on a global is an instrument with the wrong aperture. `setTimeout` is process-wide, and test
isolation in this suite is per-`describe` at best — so the spy's field of view is the whole file's
accumulated debris, while the thing under test is one object. The broadcast state (`r.last()`) is
already scoped to the rig, and the runtime already exposes the seams a test needs (`step()`, `idle`).
Reaching past those to the global is what loses the scoping.

The deeper rule is about **direction of failure**. `Math.max(...) > N` fails open: extra noise makes
it pass. `toContain(unique)` and "did the machine land" fail closed: noise cannot manufacture them.
When an instrument is known to be contaminated, only assertions that fail closed are worth writing.

## Prevention

- **Revert the fix and watch the test fail.** Both tests here were confirmed failing against the
  unfixed runtime, and that is the only check that caught the false-pass. Nothing about reading the
  test suggested it could not fail.
- **Before spying on a global in a suite, count the objects it forgot to stop.**
  `grep -c 'rig(' file` against `grep -c 'runtime.stop()' file` took ten seconds and answered
  112 / 7.
- **Prefer a lower bound only when noise cannot satisfy it.** In a contaminated suite, "greater than"
  is an assertion that the suite is quiet, not that the code is right.
- **A hazard comment in the file is not a fix.** This one was written, read, and then walked into
  during the same session. If a comment names a trap, the trap needs an alternative beside it —
  which is why the surviving spy test now carries the reason it is safe, not just the warning.

## Related

- `docs/solutions/tests-that-lock-in-the-bug.md` — the sibling failure: a test that certifies the bug
- `docs/solutions/assert-the-effect-not-the-existence.md`
- `docs/solutions/timers-outrun-effects-inside-one-act.md`
