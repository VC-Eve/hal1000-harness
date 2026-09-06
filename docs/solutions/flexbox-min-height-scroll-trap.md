---
title: min-height:auto stops overflow-y:auto working in flex/grid children
date: 2026-08-04
category: bug
tags: [css, flexbox, grid, overflow, scroll, layout]
module: ui/src/styles.css
symptoms:
  - long content pushes siblings (composer, buttons) off-screen instead of scrolling
  - overflow-y:auto set but no scrollbar ever appears
  - layout looks fine until content grows past the viewport
---

## Problem

The chat messages pane had `flex: 1; overflow-y: auto;` but long conversations grew the
pane past the viewport, shoving the input box and send button off-screen with no scrollbar.

## Root cause

Flex and grid children default to `min-height: auto` (and `min-width: auto`), which means
they refuse to shrink below their content size. The scroll container therefore never
becomes smaller than its content, so `overflow-y: auto` never activates — the overflow
happens at the parent instead. The bug existed latently in four containers (messages,
sidebar, narration feed, session picker); only the one with the longest content surfaced it.

## Solution

Add `min-height: 0` to every flex/grid child that owns a scrollbar, at **each level** of
the nesting chain down to the scroll container (`.chat-main` needed it as a grid child,
`.messages` as its flex child). Same rule applies horizontally with `min-width: 0` for
text-truncation containers.

## The sibling variant — 2026-09-05

The chain can be right and the layout still wrong, because this rule is usually met one level above
where it bites. Uncapping `/live`'s playlist meant `.playlist-editor` became `flex: 1 1 auto;
min-height: 0` and its track list the same — a correct chain, ancestor by ancestor. But the editor holds
*two* `overflow-y: auto` lists, and uncapping both put two scrollers with no flex basis in one
`min-height: 0` column. They sized to content, the editor overflowed, and which of them scrolled
depended on which rule won.

So the check has a second half: **after fixing the chain, look sideways.** Name the one child that takes
the room and hold every sibling to its content size.

```css
.live-stage.no-video .playlist-tracks { flex: 1 1 auto; min-height: 0; max-height: none; }
.live-stage.no-video .playlist-list   { flex: 0 0 auto; max-height: 120px; }
```

A diagnostic that walks only *ancestors* cannot see this — a sibling scroller is invisible to it. Count
scrollable elements *within* the column instead:

```js
[stage, ...stage.querySelectorAll("*")]
  .filter((el) => ["auto", "scroll"].includes(getComputedStyle(el).overflowY)
                  && el.scrollHeight > el.clientHeight + 1)
  .map((el) => el.dataset.testid ?? el.className)
// video on:  ["live-stage", "playlist-tracks"]   <- the nested-window complaint
// video off: ["playlist-tracks"]
```

## Prevention

Whenever writing `overflow-y: auto` inside a flex or grid layout, add `min-height: 0` to
the same rule reflexively, and check every ancestor between the scroll container and the
fixed-height root. If a scrollbar "doesn't appear," this is the first thing to check.
