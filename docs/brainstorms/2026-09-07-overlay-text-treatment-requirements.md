---
date: 2026-09-07
topic: overlay-text-treatment
---

# Outlines and shadows on text overlays

## Summary

Every text slot may carry an optional **outline** — a colour and a thickness — and an optional
**shadow** — a colour, an opacity, an angle, a distance and a blur. Both are authored per slot in
the `/live` overlay editor, both are absent by default, and a slot carrying neither draws exactly
what it draws today. The two replace the unauthored `backing` enum: a `backing` already on disk is
read as the authored values equivalent to what it currently draws, and the band it also named
survives as its own on/off.

---

## Problem Frame

A text slot's look is three fields — font, size, colour — so every caption on the picture is flat.
There is nothing wrong with what it draws; there is simply no way to ask for a coloured border or a
cast shadow, which is the ordinary vocabulary of titling and the thing that makes a caption look
placed rather than typed.

The codebase is half-way there already, in a way that is worth naming before anything is built.
`TextSlot` carries an optional `backing: "shadow" | "band"` (`shared/src/overlays.ts:87`), the layer
turns it into a class (`ui/src/components/OverlayLayer.tsx:501`) and the stylesheet draws it as a
fixed four-offset black ring or a fixed black plate (`ui/src/styles.css:3987`). No control writes it.
The editor has no idea it exists, so the only way to reach it is to hand-edit a manifest, and no
World authored through the UI has one. It was added for the `speech` source's legibility problem and
shipped without its authoring half.

The original text-overlay plan deferred exactly this work by name — *"Text treatment beyond font,
size and colour: shadow, outline, backing band"*
(`docs/plans/2026-09-05-001-feat-video-text-overlays-plan.md:505`). This is that deferral coming due,
and it arrives as a request for reach rather than a rescue: nothing fails today.

---

## Key Decisions

**Replace `backing` rather than sit beside it.** A slot gains an outline and a shadow it can
author, and `backing` stops being a concept. Adding authored fields alongside it would leave two
ways to put a shadow on one slot and force the layer to decide which wins — the double meaning the
rest of `shared/src/overlays.ts` argues against in its own comments. Replacement is close to free
here precisely because the field was never authorable: there is no body of Worlds using it, only
whatever a hand edit wrote. A stored value is still honoured (R16), so nothing on disk changes what
it draws.

**One outline and one shadow per slot.** Not a stack of shadows, and no named presets. The pair
covers coloured borders, drop shadows and glows, which is the whole of what was asked for; stacking
turns a slot into a list of lists in both the manifest and the editor, and a preset list is a thing
to maintain and to argue about. Both are recorded as deferrals rather than refusals.

**Angle and distance, not x and y.** A shadow is authored as a direction in degrees and a distance,
which is how a drop shadow is described everywhere outside CSS, and which makes *no direction* a
value on the same dial rather than a second mode: distance 0 casts evenly and is what a glow is.
Two signed offsets would have matched the CSS property exactly and been harder to author by eye.

**Off is the absence of a key, not a stored `false`.** The idiom `opacity`, `kind`, `backing`,
`states`, `conditions` and `fadeMs` all keep: absent means the old behaviour, so no World gains a
key on its next save and every manifest written before this loads unchanged.

**Measured against the slot's own type size.** Thickness, distance and blur are shares of the
slot's font size, never pixels — the same reason `size` is a percentage of picture height. That is
what makes the small player on `/live` and a fullscreened `/broadcast` draw the same proportions,
which is the property the whole layer is built around.

**An outline sits outside the letterform.** A stroke centred on the glyph edge eats into the
letter as it thickens, so at any usable weight the type gets heavier and the counters close up.
The requirement is the appearance, not the mechanism: raising thickness must not change the shape
of the letter it surrounds.

**Text only.** A picture slot gains nothing. Neither field means anything for an image, and
carrying them so one guard could serve both kinds would be two dead keys on every picture — the
reasoning `ImageSlot` already records for font and colour.

---

## Requirements

**The outline**

- **R1.** A text slot may carry an outline: a colour and a thickness. Absent means no outline.
- **R2.** Thickness is a share of the slot's own type size, within a bounded band. Zero draws
  nothing and is the same as absent.
- **R3.** The outline is drawn outside the letterform. Raising thickness thickens the border and
  never thins the glyph.
- **R4.** The outline colour is authored as a canonical `#rrggbb`, the form every other overlay
  colour takes, picked with the control the editor already uses for a slot's colour.

**The shadow**

- **R5.** A text slot may carry a shadow: a colour, an opacity, an angle, a distance and a blur.
  Absent means no shadow.
- **R6.** The angle is the direction the shadow is cast, in degrees, measured clockwise from
  straight up — 135° is down and to the right, 180° straight down.
- **R7.** The distance is a share of the slot's own type size, within a bounded band. Distance 0
  casts evenly in every direction: a glow is a shadow at no distance, not a third field.
- **R8.** The blur is a share of the slot's own type size, within a bounded band. Zero is a hard
  edge.
- **R9.** The shadow's opacity is a percentage, in the vocabulary a picture slot's `opacity`
  already uses. Colours are stored without an alpha channel, so the opacity is its own field.

**The two together**

- **R10.** A slot may carry either, both, or neither. They are independent: setting one says
  nothing about the other.
- **R11.** Drawn in the order shadow, outline, fill — the shadow behind everything, the outline
  behind the letter it surrounds.
- **R12.** A slot carrying neither renders exactly the markup and computed style it renders today.
- **R13.** Every measurement scales with the slot's type size, so a slot draws the same
  proportions on `/live` and on `/broadcast`.
- **R14.** Both take part in a slot's fade and its `when` conditions the way the words do: a slot
  fading in fades in treated, and a hidden slot draws neither.

**The band, and what was there before**

- **R15.** The band survives as an on/off on a text slot, and gains a control for the first time.
- **R16.** A stored `backing: "shadow"` is read as the authored values that produce what it draws
  today — black, at its current offsets and blur. A stored `backing: "band"` is read as the band
  switched on. Neither is ever written back, so the key leaves the manifest on the next save of
  that World and nothing it drew changes in the meantime.
- **R17.** A malformed or unknown treatment refuses the slot rather than being dropped to none —
  the rule an unknown `kind` and an unknown `backing` already follow. A value outside a band is
  refused rather than clamped, for the reason `cleanSlot` already records: a size of 30 is not a
  size, and clamping draws something nobody asked for.

**Authoring**

- **R18.** The controls live behind a per-slot panel that is collapsed by default, the shape the
  `when` panel already uses. A slot's existing rows are unchanged, so an operator who wants none of
  this sees no more than they see now.
- **R19.** The editor writes no treatment keys for a slot whose treatment is off.
- **R20.** A picture slot offers none of it.
- **R21.** Everything here is reachable over the WS protocol and is not UI-only, per the
  agent-native parity rule in `AGENTS.md`.

**Evidence**

- **R22.** The claim that a treatment is drawn, at the right scale, and outside the letterform, is
  settled in a real browser on both surfaces — jsdom applies no stylesheet, so a component test can
  assert an attribute and nothing about what an operator sees. This follows the
  `scripts/overlays-check.mjs` and `scripts/conditions-check.mjs` precedent, and the measurement
  that matters is the computed treatment on `/live` and `/broadcast` agreeing as a share of the
  slot's type size.

---

## Acceptance Examples

**A title with a hard black border.** A `title` slot at 5% of picture height, white, gains an
outline of black at a small thickness and no shadow. On both surfaces the words carry an even black
border; the letterforms are the same shape they were before the outline was added, only bordered.
The World's manifest gains one key on that slot and nothing else.

**A neon caption.** A `text` slot in a bright cyan gains a shadow of the same hue at distance 0,
a wide blur and a reduced opacity. It reads as a glow around the words with no direction to it. Its
distance stays 0 and there is no separate glow field anywhere in the editor.

**A drop shadow that survives a fade.** A `speech` slot with a 400ms fade gains a black shadow at
135° and a short distance. Arriving, the words and their shadow fade in together as one element;
there is no moment where the shadow is present and the words are not.

**A World written before this feature.** A World whose slots carry no treatment loads, draws and
saves exactly as it did, gaining no keys. A hand-edited World carrying `backing: "shadow"` draws the
same ring it drew yesterday, and after its next edit the manifest carries an authored outline
instead and still draws the same ring.

---

## Scope Boundaries

**In scope.** One outline and one shadow per text slot, authored in the `/live` editor and over the
protocol; the band as a toggle; the read of a stored `backing`; the browser verification.

**Deferred to follow-up work.**
- Stacked shadows — several drawn in order on one slot.
- Named presets that fill the fields in one click.
- Copying a look from one slot to another, or a named style several slots share.
- An authored colour or opacity for the band, which stays fixed black here (see Outstanding
  Questions).
- Any treatment on a picture slot, and any animation of a treatment.
- Gradient or textured fills, and anything that changes the letterform itself.

**Outside this feature.** What text is drawn, where it may sit, and which sources exist. Any change
to sound, to the state machine, or to what `/broadcast` is permitted to render.

---

## Dependencies and Assumptions

- **Unverified until measured:** that the rendering engine will paint a stroke outside the fill for
  live text at the weights this asks for. R3 states the appearance, and R22 is where it is settled;
  if it cannot be had directly, the fallback is the ring of offsets the current `backing: "shadow"`
  already draws, authored rather than fixed. This is a decision for planning, made against a
  measurement rather than against documentation.
- The build ships no font files and this adds none. A treatment is applied to whatever family the
  browser resolved.
- The whole-list `set-world-overlays` write still has no staleness check
  (`docs/residual-review-findings/feat-overlay-when.md`), and this feature adds more per-slot
  editing across more round trips to a window that is already open. Pre-existing, not caused here,
  and unchanged by this work.
- An older build that edits overlays strips fields it does not know, so it will drop a treatment —
  the property every optional field this codebase has added shares. Recorded, not fixed.

---

## Outstanding Questions

- **What does "on" look like before anything is authored?** Switching a treatment on has to write
  some starting values. A black outline at a modest thickness is the safe answer for an outline; a
  shadow needs five. The alternative is that switching on writes nothing visible until a field is
  touched, which reads as a broken control.
- **Should the band be authored too?** It is the one thing left drawing a fixed black once
  everything beside it is authored, and a colour plus an opacity would be two fields. Left fixed
  here because nobody asked for it; worth deciding rather than drifting.
- **Nine fields on twenty slots.** Authoring the same look on three slots means typing it three
  times. Deferred above, but if that friction shows up in the first hour of real use, a shared
  named style is the shape to reach for, not a copy button.

---

## Sources

- `shared/src/overlays.ts` — the overlay vocabulary, `TextSlot`, `backing`, and the guard rules
  this feature copies.
- `ui/src/components/OverlayLayer.tsx:501` — where a backing becomes a class today.
- `ui/src/styles.css:3987` — the fixed shadow and band, and the `em`-not-`px` reasoning.
- `ui/src/components/OverlayEditor.tsx` — the slot rows, and the `when` panel this borrows its
  shape from.
- `docs/plans/2026-09-05-001-feat-video-text-overlays-plan.md:505` — the deferral this answers.
- `docs/plans/2026-09-06-003-feat-live-character-speech-plan.md:506` — why `backing` exists.
- `docs/residual-review-findings/feat-overlay-when.md` — the two hazards this inherits.
