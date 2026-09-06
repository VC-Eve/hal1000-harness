# Residual findings — the `/live` layout

What this feature knowingly leaves open. Written at build time rather than
discovered later, and each entry says why it was left rather than only that it
was.

Origin: `docs/brainstorms/2026-09-05-live-layout-requirements.md`.
Plan: `docs/plans/2026-09-05-003-feat-live-layout-plan.md` — its "What the browser said" section holds
the measurements, and is the thing to read before touching this again.

---

## The editor's chrome is now the thing between a playlist and the column

**What.** Uncapping the track list works, and the win scales with the window: measured at 260px with
the video shown and 724px with it hidden in a 1400px-tall window. In a 950px window the same change
buys 14px, because two things sit above the list — the transport, measured at 240px, and about 230px
of the playlist editor's own chrome (header, playlist picker, create row, two name rows, tools row).

**Why it shipped anyway.** About 60px of that 240 is an artifact of the measurement seed:
`audio-unattended`, `audio-enable` and `audio-sound-fault` all render because the seeded tracks do not
decode and no gesture has been given, so a real instance starts with more room than the script sees.
The rest is real, and collapsing the editor's picker half when the video is hidden is a design change
nobody asked for — the brief asked for room, and the cap was what was denying it.

**What is still open, precisely.** Whether the picker, create row and name rows should fold away when
the video is off, on the same reasoning the video itself does: by then the playlist has been chosen
and the tracks are the work. That is the next lever if the column still feels tight in use, and it is
a decision rather than a fix.

---

## `LayoutShell`'s drag still has the three exits `/live`'s no longer does

**What.** `LayoutShell.tsx:57-72` attaches `pointermove`/`pointerup` to `window` and removes them only
from inside its own `up`. Three exits never tear down: a cancelled pointer — and `.divider` has
`touch-action: none` now, which makes that rarer but not impossible — a release outside the viewport,
and unmount mid-drag. `/live`'s seams take the other pattern, the one `StateGraph.tsx:186-196` already
used for node dragging: capture the pointer, listen on the bar, handle `pointercancel`.

**Why it shipped anyway.** Scope. The plan's subject was `/live`, and the body layout's handler has
been in place across every release without anyone reporting a runaway divider — its pane is also not
mounted on a route, so the unmount-mid-drag exit that made this urgent on `/live` does not arise
there.

**What is still open, precisely.** The fix is about six lines and is already written once in this
repo, so this is a copy rather than a design question. The failure it prevents is a bar that follows
the next touch anywhere on the page, silently, until reload. `.divider` is a shared class, so
`touch-action`/`user-select` already reached the body layout with this work.

---

## A trip to the World picker still restarts the clip

**What.** `ClipPlayer` sits inside the World branch (`LivePane.tsx`), so opening the picker unmounts
the engine. Coming back, `useClipStage` is fresh — `held` is `[null, null]`, `front` is 0 — and the
clip plays from the beginning while the server's timer is already partway through it, so it shows the
opening frames and is cut off mid-shot.

**Why it shipped anyway.** It predates this work; the video toggle was originally going to make it
more frequent, and hiding rather than unmounting removed that. `AudioPlayer` solves the equivalent at
`:148-151` with `seekTo.current = transport?.positionMs ?? 0`, and `ClipPlayer` cannot copy it:
`LiveState` (`shared/src/worlds.ts:554-575`) carries `stateId`, `clip`, `generation`, `fault` and
`transitionId` and **no elapsed position**. There is no field to seek to.

**What is still open, precisely.** Adding one is a protocol change — a new field on `LiveState`, set
by the runtime when it issues a clip and advanced by its own clock — and it would also let a second
`/live` window join a World mid-clip correctly, which nothing does today. Deferred as a decision, not
an oversight.

---

## Whether a hidden player really does no decoding is unmeasured

**What.** The video toggle hides `ClipPlayer` with `display: none` rather than unmounting it,
deliberately: see the compound note, and the sibling finding in
`docs/residual-review-findings/feat-broadcast-surface.md` — *"An observer never measures a clip"* —
which is the same mechanism reached from the other side. The saving claimed for `display: none` is
that such an element does not decode, and that claim is `.clip-video.back`'s comment in
`ui/src/styles.css`, not a measurement.

**Why it shipped anyway.** What the probe *does* establish is the part the decision rested on: with
the player hidden, a World holding a real clip recorded at `0` reached `7000` in the manifest, the
player's box measured `0px`, and the element reported `paused: false`, `readyState: 4`. Unmounting
freed no more room and cost the measurement, so hiding is better regardless of the decode question.

**What is still open, precisely.** Whether a hidden-but-playing `<video>` costs meaningful CPU or GPU
on the machine this runs on, which also runs local inference. The honest answer needs a profile. If it
turns out to cost, the next shape to consider is hiding *and* pausing — metadata still loads on
`load()`, so measurement would survive, but the element would then fight the engine's own
assign-and-play on every new clip, which is why it was not done speculatively.

---

## New surface, recorded

**None.** No route, message, or file access changed. This feature touched `ui/`, `scripts/` and docs
only — zero files under `server/` — and added no `ClientMessage` or `ServerMessage`. The layout state,
including whether the video is shown, lives in `localStorage` under `hal1000.live-layout` and never
travels over the WS contract, for the reason `ui/src/layout.ts:11-15` states.
