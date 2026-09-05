---
title: Within one act(), timers outrun the effect the rerender scheduled
date: 2026-09-05
category: pattern
tags: [testing, react, vitest, fake-timers, async-timing, blind-spots, test-seams]
module: ui/test/components/BroadcastStage.test.tsx, ui/test/components/harness.tsx
problem_type: test_failure
symptoms:
  - a timer-driven assertion is one advance late, and looks correct if you advance further
  - a timer appears to fire before the cancel that should have preempted it
  - whether the test passes depends on how far you advance, not on the behaviour under test
  - a wait helper resolves instantly, and everything built on it silently races the transition
---

# Within one act(), timers outrun the effect the rerender scheduled

## Context

A fade-and-cancel test: a clip ends, a fade is armed, and a replacement arriving before the fade
completes must cancel it. Getting it right cost three wrong diagnoses in a row — twice the
implementation was blamed, and once changed, when the implementation was correct both times.

Two traps, from one test file. Each looks like ordinary careful test code.

**One: the rerender and the clock in the same `act()`.**

```ts
await act(async () => {
  rerender(view(testLive({ /* the next clip */ })));
  await vi.advanceTimersByTimeAsync(50);
});
```

That reads as "rerender, then let 50 ms pass". It does not run in that order. `rerender` *schedules*
React's commit and its effects; `act()` flushes them at its `await` boundary, and
`advanceTimersByTimeAsync` starts running queued timers immediately — ahead of the effect just
scheduled. The assignment effect had not run, so `element.load()` had not been called, so the
`canplay` it schedules landed in whatever advance came *next*.

Every symptom followed from that: a swap appearing one advance late, a fade timer seeming to fire
"before" the cancel that should have preempted it, and a result that flipped with how far past the
threshold the test happened to advance.

The fix is two blocks:

```ts
await act(async () => {
  rerender(view(testLive({ stateId: "s-booth", generation: 8 })));
});
await act(async () => {
  await vi.advanceTimersByTimeAsync(50);
});
```

**Two: a wait condition already true at mount.** The suite's `showing()` helper waited for an element
carrying the `front` class:

```ts
const front = () =>
  [0, 1].find((i) => screen.getByTestId(`broadcast-video-${i}`).className.includes("front"));
```

Element 0 carries `front` from the first render, before the engine has assigned anything. So the
helper returned index 0 immediately, and every test built on it raced the swap instead of waiting for
it. One test then failed for a reason that had nothing to do with the code it was testing. The fix
waits for what the tests actually mean:

```ts
const showing = async (): Promise<number> => {
  await waitFor(() => {
    const index = front();
    expect(index).not.toBeUndefined();
    expect(screen.getByTestId(`broadcast-video-${index}`).getAttribute("src")).toBeTruthy();
  });
  return front()!;
};
```

## Guidance

1. **Do not put a rerender and a fake-timer advance in the same `act()`** when the timer is meant to
   observe something the rerender's effect schedules. Give the rerender its own block.
2. **A wait helper's condition must be false in the starting state.** If it can be satisfied by the
   initial render, it is not a wait — it is a formality that returns immediately.

## Why This Matters

Both wrong versions read correctly. `act(async () => { rerender(); await advance(); })` reads
left-to-right as a sequence, which is how every other line of JavaScript works; `act`'s contract is
about flushing at the `await`, not about ordering statements against React's scheduler.

And `front()` tracks the swap perfectly — *after* the first swap. It is wrong only at the initial
render, which is the one state every test starts in, and the one a reader skimming the helper is
least likely to picture, because by then they are thinking about the second clip and the third.

The shared quality is what makes both expensive: neither failure looks like a race. Both look like a
wrong value, so the implementation gets blamed first.

## When to Apply

- Any RTL/vitest test combining a state change with `advanceTimersByTimeAsync` in one `act()`, where
  the timer observes something an effect sets up — a `load()`, a fetch, a subscription.
- Any `waitFor` or custom wait whose condition could hold at mount: a class present by default, a ref
  non-null from the start, a default prop already equal to the target.

## How You'd Catch It

Make the assertion depend on the effect having actually run — the element's `src` being non-empty,
not merely the class the swap sets. That fails immediately under the single-`act()` form.

For the helper: check what the condition reads *right after mount with no timers advanced*. If it is
already satisfied, the helper needs a second condition.

And the usual discipline — recombine the `act()` blocks, or narrow `showing()` back to the class
check, and confirm something goes red. Both were verified that way here.

## Related

- `an-async-predicate-handed-to-a-sync-poller-always-passes.md` — the sibling: a test-harness timing
  contract that silently passes when misused.
- `assert-the-effect-not-the-existence.md` — why the element's `src` is the right thing to wait on
  and a class name is not.
- `a-regression-test-must-fail-without-the-fix.md` — the check that caught both of these.
