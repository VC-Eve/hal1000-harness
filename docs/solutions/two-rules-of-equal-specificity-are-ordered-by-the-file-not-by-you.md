---
title: Two rules of equal specificity are ordered by the file, and the file orders them differently per surface
date: 2026-09-06
category: pattern
tags: [css, specificity, two-surfaces, live, broadcast, blind-spots]
module: ui/src/styles.css, ui/src/components/ClipPlayer.tsx, ui/src/components/BroadcastStage.tsx
problem_type: ui_bug
symptoms:
  - identical markup behaves differently on /live and /broadcast
  - a state class is applied in the DOM and the property it sets does not take effect
  - a transition never runs, and devtools shows the element holding its previous value
  - an element that should be fading stays fully opaque and then disappears in one frame
---

## Context

`/live` and `/broadcast` mount the same clip engine and receive the same state. A blend applies two
classes to the element fading out — `front` (which it keeps, because it is still on screen) and
`blending-out` (which fades it). The stylesheet had:

```css
.clip-video.front      { opacity: 1 }   /* line 3037 */
.clip-video.blending-out,
.broadcast-video.blending-out { opacity: 0; z-index: 2; transition-property: opacity }  /* 3072 */
...
.broadcast-video.front { opacity: 1 }   /* line 3882 */
```

Every one of those selectors is specificity `0,2,0`. At equal specificity the later rule wins, so:

- `.clip-video` — the blend rule is **below** `.front`, wins, element fades. Correct.
- `.broadcast-video` — the blend rule is **above** `.front`, loses, element stays at `opacity: 1`.

On `/broadcast` the fading element therefore kept full opacity *and* `z-index: 2`, covering the
clip arriving for the whole window, then dropped its class and vanished in one frame. To an
operator: a freeze, then a teleport. On `/live`, a correct crossfade. Same components, same engine,
same broadcast state, same class names — opposite outcomes, decided entirely by which line of one
stylesheet came last.

The blend rule was written as a shared, comma-joined selector precisely so the two surfaces could
not drift. Sharing the declaration did not share the ordering, and that is the whole trap: a
comma-joined selector looks like one rule and is two, each landing in a different place relative to
whatever else matches the same elements.

## Guidance

**When a rule must beat another rule that matches the same element, say so with specificity, not
with position.** Name every class the element will actually be wearing:

```css
/* not `.blending-out` — the element also has `.front`, which sets opacity 1 */
.clip-video.front.blending-out,
.broadcast-video.front.blending-out { opacity: 0; ... }
```

`0,3,0` beats `0,2,0` from anywhere in the file. The rule is now order-independent, and moving
either block cannot silently break it.

**A shared comma-joined selector shares its declarations, not its cascade position.** In a
stylesheet with per-surface sections, a shared rule sits inside exactly one of them and is
early-or-late relative to the others by accident of where it was pasted. If two surfaces are meant
to behave identically, either put the shared rule after every section it must beat, or — better —
make it win on specificity so the question never arises.

**A state class that is additive needs its base class in the selector.** Any pattern where an
element accumulates classes (`front` + `blending-out`, `active` + `disabled`, `open` + `closing`)
has this shape. The later-added class is not automatically the winning one; nothing about "this
class was added second" reaches the cascade.

## When to Apply

- Adding a state class to an element that already carries a state class setting the same property
- Writing a comma-joined selector spanning two surfaces or two components with their own sections
- Debugging any "the class is in the DOM and nothing happens" report — check the computed value
  first, not the class list
- Any behaviour that differs between `/live` and `/broadcast` despite the shared engine: the
  components are thin and the stylesheet is where they actually diverge

## Examples

The symptom is distinctive once you know it. The class list is correct, the inline
`transitionDuration` is correct, the engine's own numbers are correct — and the computed `opacity`
never leaves `1`. Every check that reads DOM or JS state passes; only reading the *computed style*
of the element mid-window shows it.

That is also why it survived a browser check: the check asserted the composite never darkened,
which an element frozen at full opacity satisfies perfectly. See
`docs/solutions/a-check-can-be-green-on-the-state-it-exists-to-catch.md`.

Guard for the fix, in `scripts/blend-check.mjs`:

```js
fadingActuallyFades: windows.every((w) => {
  const o = w.frames.map((f) => (w.fadingIndex === 0 ? f.a.opacity : f.b.opacity));
  return Math.max(...o) > 0.5 && Math.min(...o) < 0.2;
}),
```

Reverting the specificity fix turns that false on `/broadcast` and leaves it true on `/live`,
reproducing the reported asymmetry exactly.

## Related

- `docs/solutions/a-property-declared-twice-keeps-the-last-value-and-the-first-comment.md` — the
  same cascade rule biting within one block rather than across two.
- `docs/solutions/css-tracks-with-two-sources-of-truth.md` — the other way this stylesheet has
  let two places disagree about one value.
- `docs/solutions/a-requirement-not-to-show-text-is-not-a-dom-requirement.md` — another case where
  `/live` and `/broadcast` needed the same guarantee and the DOM was the wrong place to look for it.
