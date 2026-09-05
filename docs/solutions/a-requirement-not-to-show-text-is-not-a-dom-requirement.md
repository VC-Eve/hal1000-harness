---
title: A requirement not to show text is not a DOM requirement
date: 2026-09-05
category: pattern
tags: [testing, blind-spots, media, dom, video, information-leak, live]
module: ui/src/components/useClipStage.ts, ui/test/components/BroadcastStage.test.tsx
problem_type: security_issue
symptoms:
  - a surface has a hard no-text rule, an exhaustive DOM test for it, and text still reaches the screen
  - the text was never in the DOM at all, so no walker could have found it
  - a reviewer catches it by reasoning about the medium, and no test could have
---

# A requirement not to show text is not a DOM requirement

## Context

`/broadcast` has one hard requirement: it renders no text, ever. It is pointed at a projector, so a
clip path or a fault message on it is a leak rather than a diagnostic — the whole surface exists to
make that impossible.

The tests enforcing it walk the DOM. A `TreeWalker` over text nodes, plus a sweep of every attribute
that carries prose (`title`, `alt`, `aria-label`, `placeholder`). Both are exhaustive over the tree
and correct as far as they reach.

Neither can reach a `<video>` element's in-band text tracks. The browser draws captions itself,
compositing them over the decoded picture, and nothing about that rendering touches the DOM: no text
node, no attribute, nothing a walker can find. A clip carrying a caption track would put words on
the projector with every DOM-based guard still green.

No test caught it. A reviewer reasoning about how `<video>` actually renders did.

## Guidance

Enumerate what the medium can draw *outside* the DOM before trusting a DOM check to enforce a rule
about what is visible. The fix belongs in the shared engine rather than the surface, so both
consumers get it and neither has to remember:

```ts
function silenceTextTracks(element: HTMLVideoElement): void {
  // jsdom implements no track list at all, and a browser may expose it late.
  const tracks = element.textTracks as TextTrackList | undefined;
  if (!tracks) return;
  for (let i = 0; i < tracks.length; i += 1) {
    const track = tracks[i];
    if (track) track.mode = "disabled";
  }
}
```

Swept when the element is assigned a source, and watched from there on:

```ts
silenceTextTracks(element);
const silence = () => silenceTextTracks(element);
element.textTracks?.addEventListener?.("addtrack", silence);
```

The listener is not padding. Tracks parse out of the container progressively, so one can arrive
mid-playback and start drawing unless something is still watching.

## Why This Matters

"No text in the DOM" *sounds like* "no text on screen", and for every ordinary element the two
coincide. They diverge exactly at what the platform paints for you: media captions, the native
context menu, Picture-in-Picture, browser form-validation bubbles, the document title. None are DOM
nodes.

So a rule written as "no text nodes" is silently narrower than the requirement it was written to
enforce — and the gap is invisible to the very tool that feels most thorough, because a tree walk
cannot report what was never in the tree. The check does not fail. It answers a different question,
confidently.

## When to Apply

Any requirement of the form "nothing of kind X is ever visible" where the surface is not fully
DOM-composited. Media elements above all, but also anything with browser-native UI, and any element
the platform decorates on your behalf.

The trigger question: *does this element show only what I put in the DOM, or does the platform draw
things on top that I never put there?*

## How You'd Catch It

Not with a stronger DOM assertion — this is a wrong-layer problem, not a weak-assertion one. Two
honest options, and it is worth being clear about what each proves:

1. Assert the mitigation: after assignment, every `track.mode` on the element is `"disabled"`. This
   pins that the fix runs. It cannot prove the visual absence, because jsdom implements no track
   list and renders no captions.
2. Prove the visual absence in a real browser — a screenshot or a computed-style read on an actual
   output. That is the only thing that can go red *without* the fix.

Option 1 is what this repo has, and it is worth knowing it is a mitigation test rather than a leak
test. The broader catch is procedural rather than automated: when a requirement says "nothing of
kind X, ever", ask what draws outside the DOM before writing the enforcement.

## Related

- `a-rule-that-is-right-for-the-whole-is-wrong-for-the-part.md` — a symptom-level false cognate,
  recorded here so the next reader does not spend the same ten minutes on it. Its line "a substring
  search over rendered output finds nothing, though the substring is visibly there" reads identically
  to this one, but the mechanism is the opposite: there the assertion was fine and a transformation
  reshaped the data underneath it; here the data was never in reach of the assertion at all.
- `a-flag-nothing-reads-looks-shipped.md` — the same family of miss: a check that is technically true
  and says nothing about the observable requirement.
