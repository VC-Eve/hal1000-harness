# Residual review findings — overlay text treatment

Nine reviewers read the outline/shadow/band change on 2026-09-07 (correctness,
adversarial, testing, maintainability, project-standards, api-contract,
agent-native, frontend-races, learnings). Three findings were fixed on the spot
and are in commit `fix(review)`; the rest are recorded here rather than fixed,
each with the reason.

Fixed and not listed below: the lossy `backing` translation on an authored edit
(P1, found independently by correctness and adversarial), the panel throwing on
a stored `outline: null` (P1), the missing regression test for the legacy-key
delete (P1, found by reverting the fix and watching all 46 tests still pass),
and a docstring in `ui/src/textTreatment.ts` that described a verification
method the script had already abandoned.

## Rejected

**A contradiction between two comments about `backing`.** Correctness read
`shared/src/overlays.ts:77` ("translated on read and never written back") as
contradicting `cleanTreatment`'s ("the key leaves the manifest on that World's
next save"). They say the same thing from the two ends.

**Re-keying the fade on a treatment edit.** Adversarial notes that every
treatment nudge changes `slotKeys`' `JSON.stringify(slot)`, so authoring a
shadow on a slot that carries a fade makes it fade out and in. True, and
deliberate: narrowing that key to a field list is exactly the defect
`docs/solutions/a-key-that-omits-what-makes-two-things-differ-merges-them.md`
records, and the same re-key already happens for a colour, a size or a word.

## Recorded, not fixed

**`backing: "shadow"` does not draw precisely what it drew.** The old ring was
four blurred offsets; the translation is a 3%-of-type-size black border, which
is the nearest thing the new vocabulary can spell. KTD7 in the plan says so and
the brief's R16 does not — R16's "nothing it drew changes" is the sentence that
overstates it. The exposure is a hand-edited manifest, because the field never
had a control. Nothing in the repo carries one any more:
`scripts/speech-check.mjs` was the last caller and now sends `band: true`.

**The migration is not among the claims the browser settles.**
`scripts/treatment-check.mjs` seeds no legacy `backing` slot, so the translation
is proved by unit tests and by reading, never on a screen.

**The treatment panel's display reads props, not `current()`.** Every control in
this editor does — position, source, font, size — and `write` sets a ref rather
than state, so a re-render arriving before the broadcast can snap a just-ticked
box back off and collapse the reveal. Frontend-races rates it a flicker, not
data loss, and the writer side is correct. Fixing it properly means local
display state cleared by the same effect that clears `latest`, which is a change
to the whole panel's shape rather than to this feature.

**`WhenField`'s states and conditions still have the bug the treatment patch
fixed.** Their `onChange` handlers build the next array from the props-derived
cleaned slot, so two quick edits before the round trip drop the earlier one.
Pre-existing, out of this diff, and the same shape one panel over — the sibling
worth fixing next.

**`OverlayEditor.tsx` crossed 1,000 lines** (853 → 1,185), because
`TreatmentField` copies `WhenField`'s disclosure, open-set and panel markup
rather than sharing them. The plan directed the copy. There are now three
index-addressed panels (`openWhen`, `openTreatment`, `picking`) with duplicated
toggle logic and duplicated reset-on-move and reset-on-remove pairs; a fourth
would be four edits. The extraction is a refactor of the whole editor.

**A refused slot is still dropped by the editor and refuses an agent's whole
list.** The lenient-load/strict-write tension the write filter manages, now
reachable through four more numbers. Unchanged by this feature and already
recorded for the fields before it.

**A width-0 outline is not DOM-identical to no outline** — it still writes a
stroke colour and a paint order. Harmless, and the guard keeps a stored 0 on
purpose so the editor's own field can hold it while a number is being typed.

**A maximum outline overflows the band's fixed padding.** The combination is
never measured at its ends. `treatment-check.mjs` draws both together but at
mid-range values.

**The treatment vocabulary is not in `CONCEPTS.md`.** Sibling concepts of
similar weight are (Fade, a slot's When, Drawn, Unfilled). The field it replaces
was never documented there either, so this is a gap the feature inherited rather
than opened.

## Testing gaps left open

- No test drives the editor through a *received* World mid-sequence, so the
  props-versus-`current()` boundary is verified on the write side only.
- `cleanShadow`'s missing-colour case is covered only through the shared
  malformed-shape sweep, never on its own.
- `treatment-check.mjs`'s `kept > 0.7` threshold is reasoned rather than
  calibrated against a deliberately broken build.
