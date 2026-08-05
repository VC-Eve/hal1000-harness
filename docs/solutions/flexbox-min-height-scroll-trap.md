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

## Prevention

Whenever writing `overflow-y: auto` inside a flex or grid layout, add `min-height: 0` to
the same rule reflexively, and check every ancestor between the scroll container and the
fixed-height root. If a scrollbar "doesn't appear," this is the first thing to check.
