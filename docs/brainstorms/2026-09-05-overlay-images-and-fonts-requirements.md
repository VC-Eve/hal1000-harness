---
date: 2026-09-05
topic: overlay-images-and-fonts
---

# Overlay images, and a font list

## Summary

An image can be an overlay slot. A World's slot list gains a second kind of member — a picture placed
on the same nine-cell grid, sized the same way text is, drawn as a layer beneath every text slot. The
operator picks the file with a browse-and-import button that copies it into the World. At the same
time the text slot's font stops being a typed string and becomes a list to choose from.

---

## Problem Frame

The overlays that shipped put the operator's words on the picture. They cannot put a mark on it. A
show has no channel bug, no logo, and no plate behind the caption at bottom left — so the two things
an operator reaches for after captions are both missing, and getting either still means compositing
the window in a second tool, which is the thing the overlay work existed to stop.

The font control has a narrower problem. It is a free text field over a family name the browser
resolves, so a typo draws in the page's own font with nothing said. The operator is asked to know
what is installed and to spell it, and gets silence when they are wrong.

The earlier brief deferred images by name — its Scope Boundaries list "Images and logos" beside
animation and text treatments. This is that deferral coming due, and the constraint it set is the one
to hold: the slot list was built so that a new kind of thing over the picture is an entry in a set,
not a second feature beside the first.

---

## Key Decisions

**An image slot is a kind, not a source.** The list holds two shapes: a text slot exactly as today,
and an image slot naming a position, a file, a size and an opacity. Each carries only fields that
mean something for it. The alternative was a fifth source name, which is the smaller change and is
what the earlier brief's extension seam invites — but every slot must carry a font and a colour to be
valid, so an image slot would carry two inert fields to satisfy a guard, and resolving a slot would
stop meaning "the words this slot says." A third option, a separate image list on the World, was cut
for doubling the surface: two nouns, two guards, two budgets and two editors for what the operator
experiences as one list of things over the picture.

**A stored slot with no kind is a text slot.** Every slot written before this feature reads as text,
so no World is rewritten and no migration runs. The same absent-means-default rule `overlays` and
`shuffle` already keep.

**Images draw behind text, always.** Not by list order — by kind. Every image slot is drawn beneath
every text slot regardless of where either sits in the list, so a plate behind a caption works without
changing what list order means for text. List order still decides which image is in front of which
image. The cost is accepted: an image can never overlap text, so a logo sitting on top of a title is
not possible.

**Size means one thing.** An image slot reuses `size` unchanged — a percentage of the picture's
rendered height, in the same band, under the same guard. Width follows the file's own aspect ratio. A
backing band is authored as a wide, short file and given a height. The consequence is that reshaping a
band is an image-editor round trip rather than a slot edit, and one band file cannot serve two caption
widths. Taken anyway, because a second number relative to a second dimension is a control most image
slots would never touch and every operator could misread.

**Images live with the World.** The slot list is stored on the World, so the pictures it names are
too: the selector copies the chosen file into that World's own folder and the slot stores a
World-relative name. This is the rule clips already keep, and it keeps a World a folder that can be
zipped and moved, and lets the route that serves the file go on refusing every path outside it. The
cost is duplication — the same logo in five Worlds is five copies, and changing it is five imports.

**Animation the file carries is allowed; animation HAL drives is still deferred.** An animated GIF,
APNG or WebP plays as the browser plays it, looping, with no control over speed or play count. The
earlier brief's deferral of "animation of any kind" narrows rather than falls: fades, transitions and
entrances remain out, because those are movement HAL would have to author.

**Opacity is an image control only.** An image slot may be drawn partly transparent; a text slot may
not. A plate that is not see-through hides the video it sits on, which is most of what a plate is for.
Text keeps font, size and colour alone — faded type over moving video is the unreadable-overlay
mistake, and the earlier brief deferred text treatments on purpose.

**A missing image draws nothing.** The rule that a slot resolving to empty text draws nothing and
takes no space extends to a file that is absent or unreadable. This is a `/broadcast` rule as much as
a tidiness one: an image element that fails to load renders its alternative text as visible words on
the picture, which is the leak the surface's no-text rule exists to prevent.

**The font list is a choice, not a promise.** The control becomes a list of families the build names.
A family already stored that is not on the list stays selected and stays stored — the same leniency
the slot loader already applies to a hand-edited manifest — rather than being reset to the default
without saying so.

---

## Requirements

**The slot list**

- R1. An overlay slot is one of two kinds: text, as today, or image.
- R2. An image slot names a position from the existing set, an image, a size, and an opacity.
- R3. A stored slot that does not say which kind it is, is a text slot. A World written before this
  feature loads unchanged and draws exactly what it drew.
- R4. Image slots and text slots share one list, one position set, one ordering and one bound on how
  many a World may hold.
- R5. A slot can be added, removed, reordered and edited without regard to its kind. A list of only
  image slots, and a list of none, are both allowed.

**Images on the picture**

- R6. Every image slot is drawn beneath every text slot, whatever the list order.
- R7. Two image slots at one position layer in list order.
- R8. An image slot's size is a percentage of the video's rendered height, in the same band as a text
  slot's size. Width follows the image's own aspect ratio.
- R9. An image wider than the picture is clipped at the picture's edge. An overlay never changes the
  fit, size or position of the video.
- R10. An image slot carries an opacity. Unset means fully opaque, and a World written before this
  feature has it unset.
- R11. A text slot has no opacity.
- R12. An animated image plays as the browser plays it. The build offers no control over its speed,
  its play count, or whether it runs.
- R13. An image slot whose file is missing or unreadable draws nothing and takes no space. No
  filename, alternative text, error or broken-image mark reaches the picture.

**Choosing an image**

- R14. The operator picks an image by browsing to a folder and choosing a file, the way a clip is
  chosen.
- R15. The chosen file is copied into the World that will draw it, and the slot refers to it by a name
  relative to that World.
- R16. A World stays self-contained: a World folder carries the images its slots name.
- R17. Two Worlds naming the same picture each hold their own copy, and editing one does not change
  the other.
- R18. The browser opens at the folder last browsed, which is remembered across Worlds.
- R19. A file that is not an image HAL can draw is refused when it is chosen, with a reason.
- R20. An imported name that collides with one already in the World is made unique rather than
  overwriting.

**Fonts**

- R21. A text slot's font is chosen from a list of families the build names, not typed.
- R22. A stored font that is not on the list stays selected and stays stored. Changing another
  property of that slot does not rewrite its font.
- R23. The font control has no effect on an image slot and is not shown for one.

**The broadcast rule**

- R24. `/broadcast` renders no text other than the resolved content of the open World's text slots.
  Adding images does not add a string to the surface.
- R25. The existing allowlist test still passes unchanged: an image slot contributes no text node.
- R26. A fault, a held frame, a fade to black, an empty World and a dropped socket do not reveal any
  text. Image slots draw over black exactly as they draw over video.

**Authoring and parity**

- R27. Image slots are added, edited, reordered and removed from `/live`, in the same editor as text
  slots.
- R28. Choosing an image, setting a slot's opacity, and setting a slot's font are each reachable over
  the WS contract, so an agent can do all three without the UI.
- R29. An observer draws image slots with what it already receives, without loading anything the
  operator's window loads.

---

## Key Flows

- F1. Putting a mark on the show
  - **Trigger:** Operator opens a World on `/live` and wants a channel logo.
  - **Steps:** Adds a slot, makes it an image, browses to the folder holding the logo and picks it.
    Sets the position to top right, a small size, and a partial opacity.
  - **Outcome:** The logo appears in the top right of both windows, and stays there across tracks,
    pauses and clip faults.
  - **Covers:** R1, R2, R8, R10, R14, R15, R27.

- F2. A plate behind the caption
  - **Trigger:** The bottom-left text is hard to read over a bright clip.
  - **Steps:** Adds an image slot at bottom left, picks a wide translucent band, sets its size so the
    band covers both lines.
  - **Outcome:** The band draws beneath the header and the description, which go on stacking in list
    order as they did.
  - **Covers:** R4, R6, R8, R10.

- F3. Carrying a show to another machine
  - **Trigger:** Operator zips a World folder and opens it elsewhere.
  - **Outcome:** The slots draw the same, because the pictures they name travel in the folder.
  - **Covers:** R15, R16.

- F4. Agent dresses the picture
  - **Trigger:** An agent adds an image slot and sets its opacity over the socket.
  - **Outcome:** Every connected window, `/broadcast` included, redraws with the picture. No text
    appears on `/broadcast` that was not already there.
  - **Covers:** R24, R28, R29.

---

## Acceptance Examples

- AE1. **Covers R3.** Open a World saved before this feature. Its three slots draw as they did, and
  none of them has become an image.
- AE2. **Covers R6.** A World has an image slot listed last and a text slot listed first, both at
  bottom left. The image draws behind the text — not in front of it, and not below it in a column.
- AE3. **Covers R7.** Two image slots at top right. The second in the list draws over the first.
- AE4. **Covers R8.** The same World on the `/live` player and on a 1080p fullscreened `/broadcast`:
  the image's height as a fraction of the video height is the same on both.
- AE5. **Covers R9.** A very wide, short band at the top of the size band on a 1080p output. It is
  clipped at the picture's edge, and the video's position and size are unchanged.
- AE6. **Covers R10, R11.** An image slot at a partial opacity draws the video through it. No text
  slot offers an opacity control.
- AE7. **Covers R13, R24, R25.** Delete an image file from a World's folder while `/broadcast` is
  fullscreened. The slot draws nothing, the other slots are unmoved, and a search of the DOM for text
  nodes still finds only text slots.
- AE8. **Covers R17.** Import the same logo into two Worlds. Replace the file in one. The other is
  unchanged.
- AE9. **Covers R19, R20.** Choose a file that is not an image: refused, with a reason. Import a
  second file whose name matches one already in the World: both are present afterwards, under
  different names.
- AE10. **Covers R22.** Hand-edit a slot's font to a family the list does not offer, reopen the
  editor, and change that slot's colour. The font is still the hand-edited one, in the control and on
  disk.
- AE11. **Covers R12.** An animated image slot loops while a track plays, keeps looping while paused,
  and keeps looping over black after a clip fault.

---

## Scope Boundaries

**In scope.** Image slots with position, file, size and opacity; the image layer beneath the text
layer; browse-and-import into the World; a curated font list on text slots; both routes drawing from
the same layer; the broadcast rule restated for images.

**Deferred for later.** Per-track artwork, and any image that resolves from what the transport is
holding. Full-frame plates, and anything that covers the picture rather than sitting on the grid.
Animation HAL drives: fades, transitions, entrances, and any control over how a file's own animation
runs. A width or stretch control on image slots. Opacity, or any other treatment, on text. A shared
image library across Worlds, and any way to update a logo in every World at once. Per-slot alignment
or offset beyond the named positions. Shipping or serving font files.

**Outside this feature.** Any change to what `/broadcast` does with sound or with the state machine.
Any text on either surface that an operator did not type. Any change to how text slots resolve their
words.

---

## Dependencies / Assumptions

- Overlay slots are stored on the World and guarded there, so image slots have somewhere to live with
  no new storage location. Verified in `shared/src/overlays.ts` and `server/src/storage/worlds.ts`.
- Copying a chosen file into the World, making its name safe, and suffixing a collision are built and
  in use for clips. Verified in `server/src/live/library.ts`.
- Browsing a folder a level at a time is built, bounded, and gates on the same extension set the
  serving route uses, so what the browser offers and what the route will draw cannot drift. Verified
  in `server/src/live/library.ts`.
- The folder last browsed is remembered at the worlds root rather than per World, so R18 needs no new
  storage. Verified in `server/src/storage/worlds.ts`.
- A route that serves a World's own file by query parameter, refusing every path outside the World,
  exists and already has two callers. Verified in `server/src/http.ts`.
- The size band and its guard are shared, so R8 inherits both. Verified in `shared/src/overlays.ts`.
- The overlay layer is one component mounted by both surfaces, so R6 and R9 hold on both without a
  second implementation. Verified in `ui/src/components/OverlayLayer.tsx`.
- The agent-native parity rule in `AGENTS.md` requires every meaningful behaviour to be reachable over
  the WS contract. R28 is that rule applied.
- Assumed: the browser's own installed families are enough for R21, and the build ships no font files.
  This carries the earlier brief's assumption forward unchanged.
- Assumed: a still image and an animated one need no different handling to draw, so R12 costs nothing
  to allow.

---

## Outstanding Questions

**Deferred to Planning**

- Which families the font list names, and whether it is one list or grouped.
- Which image formats are accepted, and whether the set is stated by extension or by inspecting the
  file.
- How opacity is expressed and what its bound is.
- How an image reaches an observer's window — whether the existing route is enough, or the picture
  needs its own message.
- Whether the editor shows a thumbnail of the chosen image, and whether an image already in the World
  can be picked again without browsing.
- What happens to a World's copy of an image when the last slot naming it is removed.

---

## Sources

- `docs/brainstorms/2026-09-05-video-text-overlays-requirements.md` — the slot list this extends, and
  the explicit deferral of images and of animation.
- `docs/plans/2026-09-05-001-feat-video-text-overlays-plan.md` — how the shipped slots were built.
- `docs/residual-review-findings/feat-video-text-overlays.md` — what that work left open.
- `shared/src/overlays.ts` — the slot shape, its guards, and the size band.
- `server/src/live/library.ts` — browsing a folder and importing a file into a World.
- `server/src/storage/worlds.ts` — where slots are stored, and where the last-browsed folder is kept.
- `server/src/http.ts` — the route that serves a World's own files.
- `ui/src/components/OverlayEditor.tsx` — the editor the image controls and the font list join.
- `ui/src/components/OverlayLayer.tsx` — the one layer both surfaces draw.
- `scripts/overlays-check.mjs` — the browser measurement that is the only evidence for R8.
- `CONCEPTS.md` — the Overlays entry, which today defines a slot as text and must change.
