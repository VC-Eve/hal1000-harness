---
date: 2026-09-05
topic: video-text-overlays
---

# Video text overlays

## Summary

Text drawn over the video on `/live` and `/broadcast` from one shared layer. The words come from a
stream title on the World, a header description on the playlist, and a description on each track.
The look comes from a list of overlay slots on the World, each naming a position, a text source, and
its own font, size and colour. The build ships with three slots that match the brief: title at top
centre, playlist header and track description stacked bottom left.

---

## Problem Frame

A show today is video and sound with nothing on the picture to say what it is or what is playing.
The operator wants the output to carry its own label, and wants each track to introduce itself as
it starts, without a second tool compositing text over a window capture. The words are the
operator's: what a track is called on the output is copy they write for the audience, not the
filename it was imported under.

The shipped `/broadcast` brief made the opposite promise for a good reason. Its third requirement
is that the surface renders no text at any time, because every string `/live` can show — a clip
path, a fault, an error boundary — is a leak on a projector. That brief deferred overlays by name.
This feature is that deferral coming due, and it has to add authored text without re-opening the
door to unauthored text.

---

## Key Decisions

**Only authored text.** The broadcast rule is restated rather than dropped: `/broadcast` renders
only text an operator typed into a title or description field. Diagnostics stay banned. The test
that today searches the rendered DOM for any text node becomes an allowlist of the overlay slots,
so the five leaks the earlier brief closed keep their guard and a future string outside a slot still
fails the test.

**Data with the playlist, look with the World.** The header and per-track descriptions are stored
in the playlist, because they are facts about the tracks and a playlist belongs to no World. How
that text is drawn is stored in the World, because the World is the show. Two Worlds naming the
same playlist can present it differently, and a playlist carried to another World brings its copy
with it.

**Slots, not two hard-wired positions.** The World holds a short list of overlay slots. A slot has a
position from a fixed set, a text source from a fixed set, and a style. The brief's two areas are
three default slots. A fourth kind of caption later is a new source name, not a new feature. The
alternative — a title field plus two fixed style groups — was smaller by one list and would have
made every later position a fresh code path.

**Static, whole-track presence.** The bottom-left block appears when a track starts, stays through
pauses, changes when the next track starts, and clears when the transport empties. A fade-in
lower-third that leaves after a few seconds was considered and cut: a latecomer never sees it, and
the audience should always be able to read what they are hearing.

**Each line stands alone.** The header shows whenever the held playlist has one and the track line
shows whenever the held track has one. Neither depends on the other being set.

**Names stay internal.** Track names and playlist names never reach the output. They are picker
labels and rename targets, and using them as output copy would make authoring the show a matter of
renaming files.

**One layer, both routes.** The overlay is one component drawn over the clip stage, mounted by
both surfaces, so the two cannot drift.

---

## Requirements

**The data**

- R1. A World carries an optional stream title. Empty means no title is drawn.
- R2. A playlist carries an optional header description. Empty means no header is drawn.
- R3. Each track in a playlist carries an optional description. Empty means no track line is
  drawn for that track.
- R4. Descriptions are properties of the playlist and survive reordering, shuffle, rename of the
  track or playlist, and the track becoming unplayable.
- R5. A World, a playlist and a track written before this feature load unchanged and draw nothing
  new.

**The slots**

- R6. A World carries an ordered list of overlay slots. Each slot names one position, one text
  source, and one style.
- R7. Positions are a fixed set that includes at least top centre and bottom left. The set is
  extensible without changing what an existing World means.
- R8. Text sources are a fixed set: stream title, playlist header, track description, and fixed
  text typed into the slot itself.
- R9. A style is a font family, a size, and a colour, set per slot. Size is expressed relative to
  the rendered height of the video, not in screen pixels.
- R10. A new World, and a World written before this feature, starts with three slots: the stream
  title at top centre, and the playlist header stacked directly above the track description at
  bottom left.
- R11. Slots can be added, removed, reordered and edited. Removing every slot is allowed and draws
  nothing.
- R12. Two slots at the same position stack in list order.

**Rendering**

- R13. Both `/live` and `/broadcast` draw the open World's slots over the video, from the same
  layer, with the same rules.
- R14. A slot whose source resolves to empty text draws nothing and takes no space.
- R15. The playlist header and track description resolve from the playlist and track the
  transport is holding, not from what the playlist editor is showing.
- R16. The bottom-left text stays drawn while the track is held, including while paused, and
  changes on the next track start.
- R17. When the transport holds no playlist, the header and track sources resolve to empty.
- R18. Overlay text scales with the video box so the proportions on the `/live` player and on a
  fullscreened `/broadcast` are the same.
- R19. Overlay text is drawn over the picture and never changes the fit, size or position of the
  video itself.

**The broadcast rule**

- R20. `/broadcast` renders no text other than the resolved content of the open World's slots. The
  earlier brief's five diagnostic leaks stay impossible.
- R21. The broadcast no-text test becomes an allowlist: every text node on the route must belong
  to an overlay slot.
- R22. A fault, a held frame, a fade to black, an empty World and a dropped socket do not add,
  change or reveal any text. Slots draw over black exactly as they draw over video.

**Authoring and parity**

- R23. The stream title and the slots are edited from `/live`, on the World.
- R24. The header description and each track's description are edited from `/live`, in the
  playlist editor.
- R25. Every edit in R23 and R24 is reachable over the WS contract, so an agent can set a title,
  a description or a slot style without the UI.
- R26. An observer socket learns enough to draw the slots: the resolved text for the held track
  and playlist reaches it without the observer needing to load the playlist index.

---

## Key Flows

- F1. Authoring a show
  - **Trigger:** Operator opens a World on `/live` and arms a playlist.
  - **Steps:** Types a stream title on the World. Opens the playlist editor, types a header for the
    playlist and a description on some tracks. Adjusts the bottom-left slot's font and size.
  - **Outcome:** Both windows show the title at top and, as each track starts, the header and that
    track's description at bottom left. Tracks with no description show only the header.
  - **Covers:** R1–R3, R9, R13–R16.

- F2. Reusing a playlist in a second World
  - **Trigger:** A second World names the same playlist.
  - **Steps:** Operator opens the second World and gives its bottom-left slot a different colour
    and size.
  - **Outcome:** The same descriptions appear in the second World's style. The first World is
    unchanged.
  - **Covers:** R4, R6, R9.

- F3. Clip fails mid-show
  - **Trigger:** A clip 404s with `/broadcast` fullscreened.
  - **Steps:** The frame holds, then fades to black.
  - **Outcome:** The overlay keeps drawing the title and the held track's lines over black. No
    path, fault or message appears.
  - **Covers:** R20, R22.

- F4. Agent sets copy
  - **Trigger:** An agent sends a description for a track and a new title for the World over the
    socket.
  - **Outcome:** Every connected window, including `/broadcast`, redraws with the new text.
  - **Covers:** R25, R26.

---

## Acceptance Examples

- AE1. **Covers R14, R15.** Playlist has a header, track 3 has no description, track 4 has one.
  Track 3 held: bottom left shows the header only, sitting where the header alone sits. Track 4
  starts: header, then the description directly beneath it.
- AE2. **Covers R16.** A track with a description is paused for a minute. Its description stays on
  screen throughout.
- AE3. **Covers R17.** The transport is emptied. Bottom left clears. The title at top stays.
- AE4. **Covers R1, R14.** The World's title is blank. Nothing is drawn at top centre and the top
  slot takes no space.
- AE5. **Covers R18.** The same World on the `/live` player and on a 1080p fullscreened
  `/broadcast`: the title's height as a fraction of the video height is the same on both.
- AE6. **Covers R20, R21.** Search the `/broadcast` DOM for text nodes: every one is inside an
  overlay slot, and each equals the resolved text of that slot. Add a stray string outside a slot
  in a test build: the test fails.
- AE7. **Covers R22.** Kill the clip file with `/broadcast` fullscreened. Frame holds, then
  black, with the overlay text still drawn and unchanged.
- AE8. **Covers R5.** Open a World and a playlist saved before this feature. Both load. The World
  has the three default slots and draws nothing because no text is set.
- AE9. **Covers R4.** Turn shuffle on. The description drawn always belongs to the track that is
  sounding, not to the position in the authored order.
- AE10. **Covers R12.** Two slots at bottom left, fixed text first and track description second.
  They stack in that order.

---

## Scope Boundaries

**In scope.** The three fields, the slot list and its three defaults, per-slot font, size and
colour, editing on `/live` and over the socket, the shared overlay layer on both routes, and the
restated broadcast rule with its allowlist test.

**Deferred for later.** Animation of any kind, including fade-in lower-thirds and transitions
between tracks. Backing bands, outlines, shadows or other text treatments beyond font, size and
colour. Images and logos. Per-slot alignment or offset beyond the named positions. Clocks, timers or
any generated text. Track and playlist names as a source.

**Outside this feature.** Any change to what `/broadcast` does with sound or with the state
machine. Any text on either surface that an operator did not type.

---

## Dependencies / Assumptions

- The transport state already tells every client, observers included, which playlist and which
  track are held, by index and path, and is re-sent as the track changes. Verified in
  `shared/src/types.ts`.
- A track's identity for the description is its store-relative path, which is what the transport
  and the playlist index both carry, so shuffle and reorder do not move a description off its
  track. Verified in `shared/src/audio.ts`.
- The clip engine is already shared between the two surfaces, and the broadcast surface goes
  fullscreen on its container rather than on a video element, so a layer over the container is
  fullscreened with it. Verified in `ui/src/components/useClipStage.ts` and
  `ui/src/components/BroadcastStage.tsx`.
- The World manifest is versioned, and the version is bumped only when a key changes meaning;
  optional keys are added without one and older manifests load with them absent. Verified in
  `shared/src/worlds.ts`.
- The agent-native parity rule in `AGENTS.md` requires every edit here to be a WS message. R25 is
  that rule applied.
- Assumed: the browser's own font list is enough for the font control. The build does not need to
  ship or load fonts.

---

## Outstanding Questions

**Deferred to Planning**

- Whether the resolved slot text travels to observers inside the transport state or as its own
  message. R26 states the need, not the shape.
- The exact position set beyond top centre and bottom left, and whether the defaults include the
  other corners from the start.
- How size is expressed and clamped, and what the three default styles are.
- Where on `/live` the slot editor lives: with the World's other settings, or beside the player.

---

## Sources

- `docs/brainstorms/2026-09-04-broadcast-surface-requirements.md` — the no-text rule this feature
  restates, and the explicit deferral of overlays.
- `docs/solutions/a-requirement-not-to-show-text-is-not-a-dom-requirement.md` — why the
  allowlist test must also keep the engine's in-band caption silencing.
- `shared/src/audio.ts` — playlist and track shapes the descriptions join.
- `shared/src/worlds.ts` — the World manifest the title and slots join.
- `shared/src/types.ts` — the transport state and the WS contract R25 and R26 extend.
- `ui/src/components/BroadcastStage.tsx`, `ui/src/components/ClipPlayer.tsx`,
  `ui/src/components/useClipStage.ts` — the two surfaces and their shared engine.
- `ui/src/components/PlaylistEditor.tsx` — where R24's fields land.
