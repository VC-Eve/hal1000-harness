---
title: State written out of band needs a reader that can see the write
date: 2026-09-07
category: bug
tags: [react, hooks, effects, dependencies, overlays, deadlock, code-review]
module: ui/src/components/OverlayLayer.tsx
problem_type: logic_error
symptoms:
  - a reset clears state and nothing ever refills it
  - the recompute is keyed on a value that does not change when the reset happens
  - the failure is permanent rather than transient — it waits for an unrelated change to unstick
  - the test written for the reset passes, because it happens to change the recompute's key
---

## Context

`OverlayLayer`'s fade hook keeps two Sets — `shown` (not `hidden`) and `painted` (opacity 1). One
effect is their only writer, and it is deliberately keyed on a serialised summary of the render's
targets:

```ts
const key = JSON.stringify([...targets].map(([k, t]) => [k, t.drawn, t.fadeMs]));
useEffect(() => { /* the only writer of shown and painted */ }, [key]);
```

A review found that the sets survived a World switch, so a reused key could paint one frame of a slot
the new World never asked to draw. The fix added a second writer, out of band:

```ts
useLayoutEffect(() => { setShown(new Set()); setPainted(new Set()); }, [worldId]);
```

`worldId` is not in `key`. Two Worlds carrying the same slot, drawn, with the same fade produce a
**byte-identical** key — so after the reset the recompute did not re-enter, and `painted` stayed
empty for good. `visible()` reads `targets` rather than the hook, so `hidden` stayed false: the
caption held its line of layout, pushed the captions under it, and painted nothing, until some
unrelated clause flapped. On a projector, a caption that never arrives.

The test written alongside the fix passed. It switched to a World whose slot was *not* drawn — which
changes `drawn`, which changes `key`, which hides the defect exactly.

## Guidance

**Two writers of one piece of state need one trigger between them.** If a reset writes state and a
recompute refills it, the recompute's dependency must include whatever caused the reset. Otherwise
the reset is a state the system cannot leave: it has been emptied by something the only refiller
cannot observe.

**A `// eslint-disable-next-line react-hooks/exhaustive-deps` is where this hides.** The suppression
is often right — an effect that is the sole writer of the state it reads would re-enter on every
write it makes. But it also means the linter has stopped checking the one thing that just broke, so
every value the effect's *correctness* depends on has to be in the key by hand, and a second writer
added later is exactly the change that invalidates the hand-maintained list.

**Prefer making the change visible to the existing reader over adding a writer.** The real fix
deleted the reset entirely and put the World id into the slot keys. A switch then produces keys
nothing holds, the effect's own end-of-run sweep retires what is left, and a not-drawn slot is hidden
on the first render because nothing holds its key. One mechanism instead of two, and no ordering
question between a layout effect and a passive one.

**Ordering between a layout effect and a passive effect is not a thing to reason about casually.**
The layout write lands before paint; the passive effect from the same render closes over the
*pre-reset* values and writes after it. Even when the key does change, the reset can be overwritten by
state derived from before it. If the design needs that ordering to be right, it is the wrong design.

**A test for a reset must hold the recompute's key constant.** Otherwise it proves the recompute
works, not the reset. The regression test here switches between two Worlds whose targets serialise
identically and asserts the caption is still painted; it was verified red against the exact
reset-plus-World-blind-key combination.

## Related

- `docs/solutions/a-key-that-omits-what-makes-two-things-differ-merges-them.md` — the other P1 in the
  same commit; the two fixes share a cause and were fixed by the same change.
- `docs/solutions/a-check-can-be-green-on-the-state-it-exists-to-catch.md` — the test that passes for
  the wrong reason, which is how this survived its own fix.
- `docs/solutions/timers-outrun-effects-inside-one-act.md` — the other way effect timing lies in a
  test.
