---
title: Suppressing an evaluation is half of deferring it — something has to come back
date: 2026-09-06
category: pattern
tags: [state-machine, live, holds, deferral, blind-spots, revert-test]
module: server/src/live/runtime.ts
problem_type: logic_error
symptoms:
  - a value set by a user or an agent is recorded and broadcast, and nothing ever acts on it
  - the machine stops responding to Parameters after the first one set during a hold
  - a guard reads "recorded, not acted on" and no code path exists that later acts on it
  - a hold is added to a machine that already has holds, and the new one behaves differently
---

## Context

The live runtime holds — refuses to evaluate — in three situations: a crossing (`crossing`), a
plays-whole run (`holding`), and now a blend window (`blending`). Every guard reads all three:

```ts
if (this.crossing || this.holding || this.blending) return false;
```

A blend hold was added with that guard and with `setParameter` recording the value and emitting it
so the operator's control would not snap back. The requirement it implemented reads: *a value set
during a blend is recorded and acted on once it ends.*

Only the first half was built. `setParameter` wrote the value, emitted, and returned. The window
closed a few hundred milliseconds later, cleared its flag, and continued — and nothing anywhere
re-offered the evaluation that had been refused. **The machine went deaf from the first Parameter
set inside a window** and stayed that way until the next clip boundary happened to evaluate for
unrelated reasons.

The two pre-existing holds did not have this bug, and the reason is instructive: each of them
*already* evaluates on its own way out. A crossing calls `onTrigger("arrival", 0)` when it lands; a
plays-whole run clears its flag immediately before the run's final clip-end evaluation. Both were
written as "hold, then evaluate", so deferral fell out for free. The new hold was written as "hold,
then stop holding", which looks identical and is not.

## Guidance

**A hold has an exit, and the exit is where the deferred work happens.** Clearing the flag is not
the exit — it is one statement inside it. When adding a hold, write the release path first and ask
what it owes:

```ts
private async closeWindow(generation: number): Promise<number | null> {
  if (!this.blending) return 0;
  await this.wait(generation, this.blendWindowMs, false);
  if (!this.running || this.generation !== generation) return null;
  this.blending = false;
  if (this.pendingArrival) {            // an arrival the window swallowed
    this.pendingArrival = false;
    if (this.onTrigger("arrival", 0)) return null;
  }
  if (this.deferredEvaluation) {        // a value set while it held
    this.deferredEvaluation = false;
    if (this.onTrigger("parameter", 0)) return null;
  }
  return held;
}
```

**Record that something was deferred, rather than re-evaluating unconditionally on every exit.** A
blanket evaluation at the end of every hold fires whether or not anything was set, which
double-evaluates the common case. A flag set by the same branch that does the suppressing keeps
"recorded and acted on" literally true, and keeps the quiet path quiet.

**A new hold beside existing holds is not automatically like them.** Copying the guard line is the
easy half and looks like the whole job. Ask, for each existing hold: what evaluates when *this* one
ends, and does my new one reach that code? Here the answer was "nothing does, because the other two
end inside functions that evaluate next, and mine does not".

**A shared boolean cannot have two overlapping owners.** The same change nearly reused `holding` for
the blend, which would have been worse than a missing release: blends occur *between the members of
a sequence*, and a sequence's members can be inside a plays-whole run — so a window closing would
have cleared that run's hold and made an uninterruptible run interruptible from its second member
on. Three fields and one guard expression, not one field and three meanings.

## When to Apply

- Adding any suppression, hold, freeze, lock, or debounce to a machine that already has one
- Writing a guard whose comment says the value is "recorded", "queued", "deferred", or "honoured
  later" — find the later, or write it
- Reviewing a state machine where a flag is set in one function and cleared in another

## Examples

The test that caught it, and the reason the first version of that test did not:

```ts
// Set inside the window: recorded, broadcast, and not acted on.
r.runtime.setParameter("go", true);
await drain();
expect(r.last().parameters.go).toBe(true);
expect(r.last().stateId).toBe("a");

// Closing the window is what releases it — promptly. Polling on a long
// deadline here would pass on the *ordinary* clip-end evaluation 3750ms
// later, which is a different mechanism and would hide a missing release.
await stepThrough(r);
await drain();
expect(r.last().stateId).toBe("b");
```

The first version asserted only the suppression half and passed with the guard removed entirely —
because the window was still open on the next line either way. The second version asserted the
release and passed for the wrong reason: `waitFor` allowed ten seconds, and the clip's own boundary
arrived at 3750ms and took the transition by a completely different route. Only the third version,
asserting the release happens *within a drain*, actually failed when the release was removed.

Three drafts, two of them green on broken code. The reliable move is not a better first draft — it
is reverting the fix and watching each assertion, every time.

## Related

- `docs/solutions/a-gate-that-checks-one-direction-is-half-a-gate.md` — the same shape of
  incompleteness in a permission check.
- `docs/solutions/tests-that-lock-in-the-bug.md` — why the first two drafts of that test were
  worth nothing.
- `docs/solutions/a-timer-spy-is-blind-in-a-suite-that-leaks-runtimes.md` — the other way a
  runtime assertion passes without exercising anything.
- `CONCEPTS.md` — **Blend**, **In transit**, and **Plays whole** are the three holds this is about.
