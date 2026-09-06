---
title: Hiding a media element keeps what unmounting throws away
date: 2026-09-05
category: pattern
tags: [react, media, video, unmount, measurement, layout, verification, blind-spots]
module: ui/src/components/LivePane.tsx, ui/src/components/useClipStage.ts, ui/src/styles.css
problem_type: logic_error
symptoms:
  - a feature to "hide" something is built by unmounting it, and something unrelated quietly stops working
  - clip or track durations stay at their default long after the file has been on screen
  - the machine advances on its fallback interval whatever the media actually is
  - nothing fails; no test, no typecheck, no build, and the surface still looks right
---

## Context

`/live` gained a control to put the video away and give the room to the playlist. The obvious reading
of "hide the video" is to stop rendering the component, and that is how it shipped: `{layout.video &&
<ClipPlayer …/>}`. It looked like the honest choice — the repo's own engine comments warn repeatedly
that *"a hidden `<video>` keeps playing and keeps firing events"*, so absence seemed safer than
concealment.

It was the wrong reading, and the reason has nothing to do with rendering.

The `<video>` is the only thing in this system that ever measures a clip. `useClipStage` sends
`report-clip-duration` from `onLoadedMetadata`, because the clip route serves only clips the manifest
already references and so cannot answer a probe at assignment time; `/broadcast` cannot stand in
because it connects as an observer and the server refuses the report from one. A player that is not in
the tree is therefore a World whose newly assigned clips never get a real length, and the runtime plays
them at `DEFAULT_CLIP_MS` — three seconds — whatever the footage is.

Unmounting also discarded the playhead. A re-mounted engine starts from `held: [null, null]`, so
turning the picture back on played a clip from the beginning while the server's timer was already
partway through it, and cut it off mid-shot. `LiveState` carries no elapsed position to seek to.

Measured rather than argued, with a real seven-second clip recorded at `durationMs: 0`:

| | player unmounted | player `display: none` |
|---|---|---|
| duration in the manifest after six seconds | `0` | `7000` |
| the player's box in the column | absent | `0px` |
| element state while hidden | — | `paused: false`, `readyState: 4` |

## Guidance

**Ask what else the element is doing before you take it out of the tree.** A media element is not only
a picture. It is a decoder, a clock, a source of metadata, and — as here — sometimes the only reporter
of a fact the rest of the system depends on. "Hide" is a statement about what a person sees; unmounting
is a statement about what the program does, and they are not the same statement.

**`display: none` frees exactly the same room.** This is the part that makes the trade one-sided. A
`display: none` element is out of the layout entirely, so nothing about the column's height or the
grid's tracks differs between the two. Unmounting bought no space at all — it only cost the
measurement and the playhead.

**The cost of hiding was already documented, one rule away.** `.clip-video.back` in `ui/src/styles.css`
uses `opacity: 0` rather than `display: none` *because a display:none element does not decode*, and the
back element must decode ahead of the swap. Read the other way round, that same comment says hiding is
cheap where decoding is the thing you want to avoid. The answer to "is hiding expensive?" was in the
stylesheet before the question was asked.

**Keep the unmount cleanup anyway, and capture the elements when the effect runs.** Other paths still
unmount this engine — a trip to the World picker does — so pausing on the way out still earns its
place. But React detaches refs *before* a passive cleanup runs on unmount, so reading `ref.current`
inside the cleanup gets `null` and the whole thing is a silent no-op that reads as covered:

```ts
useEffect(() => {
  // Captured now, not read in the cleanup: refs are already detached by then.
  const elements = videos.map((video) => video.current);
  return () => {
    for (const element of elements) element?.pause?.();
  };
}, [videos]);
```

**Do not also clear `src` in that cleanup.** It is the tempting extra line — it releases the decoder and
any in-flight range request — and it breaks StrictMode. StrictMode invokes a mount effect twice,
mount/cleanup/mount, and the cleanup runs in the middle; clearing the source there leaves `held` still
recording it as assigned, so the second invocation takes its "same file, do not reassign" branch and the
element ends up holding nothing. The engine's own StrictMode tests catch this. A paused element that
keeps its source is the whole of what the exit owes.

**What is still unmeasured.** That a hidden player does *no* decoding is the stylesheet's claim, not a
profile. The probe establishes only that the element keeps playing and keeps reporting. If it ever
matters, take a profile rather than adding another comment — and note that hiding *and* pausing would
keep measurement (metadata loads on `load()`, not on `play()`) while fighting the engine's own
assign-and-play on every new clip.

## Related

- `docs/residual-review-findings/feat-broadcast-surface.md` — *"An observer never measures a clip"* is
  the same mechanism reached from the other side: the observer refusal is load-bearing, which is why
  `/broadcast` cannot cover for a missing `/live` player.
- `docs/solutions/a-comment-is-a-claim-and-nothing-runs-it.md` — the `.clip-video.back` comment was
  right and load-bearing; it just was not where anyone was looking.
- `docs/plans/2026-09-05-003-feat-live-layout-plan.md` — KTD4 and the "What the browser said" section
  carry the numbers.
