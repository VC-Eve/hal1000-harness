---
date: 2026-09-05
topic: live-layout
---

# The `/live` layout: the stage column and the sidebar

## Summary

`/live` gets three columns instead of two-inside-two: the stage, the graph canvas, and the sidebar,
with a draggable seam between each pair and the widths remembered. The stage's video becomes a
toggle, and turning it off hands the whole column to the playlists, which stop being a 260px window
inside a second scroller. The sidebar's sections become bordered cards, and the nine diagnostic
reports collapse into one group with a count, so the panel you are editing is not pushed off the
bottom by problems you already know about. The graph canvas itself is not touched.

---

## Problem Frame

Everything on `/live` that is not the canvas is stacked. `.graph-side` is a flex column of sections
separated by nothing but a 10px gap and a small uppercase heading: the parameters panel, then the
node or transition you selected, then up to nine report sections — dangling effects, unusable ranges,
long runs, reserved names, unguarded audio conditions, conditions that cannot hold, audio equality,
missing playlist, incomplete clips. On a World with a few authoring mistakes in it, the thing you
clicked a node to edit is somewhere above nine blocks of prose that all look the same. The reports
are worth having; the trouble is that they are formatted exactly like the panel they are burying.

The stage column has the mirror problem. `.live-stage` scrolls, and inside it `.playlist-tracks` is
capped at `max-height: 260px` and scrolls too, so working a long playlist means driving a small
window that is itself sliding around in a larger one. The cap exists because the video above it is
`flex: 1 1 auto` and would otherwise take everything; the video is there because the stage has always
been the top of that column. But a lot of `/live` work is not watching — it is arranging tracks,
naming States, wiring transitions — and during that work the picture is a 26%-wide letterboxed
thumbnail spending the height the playlist needs.

Both problems are the same problem twice: fixed proportions chosen for one task, applied to every
task. What is missing is not more space but the ability to say which task this is.

---

## Key Decisions

**The video is a toggle, and hiding it gives the column to the playlists.** Not a collapse to a
strip, and not a widening of the column. A strip keeps a thumbnail nobody is looking at and costs the
playlist the height that was the point; widening the column would move the seam under the user rather
than letting them move it, now that the seam is draggable. Hidden means hidden: the `ClipPlayer`
unmounts, the playlist editor and the audio surfaces take the column, and if the picture is wanted
again it is one click or one fullscreen away.

The toggle lives in the World header beside `worlds`, not on the player, because a control that
disappears with the thing it controls cannot bring it back.

**The playlist stops being a nested scroller.** With the video gone there is one scrolling region in
the column, and the track list fills it. The `260px` cap is a symptom of the video's `flex: 1 1 auto`
and goes away with it; with the video shown the cap stays, because that is the case it was measured
for. This is the whole of the "not enough room to scroll" complaint — the fix is height, not a
different list widget.

**The sidebar's sections become cards, and the nine reports become one group.** Every section in
`.graph-side` gets the border and padding that `.audio-player` and `.playlist-editor` already carry,
so the boundary between two sections is drawn rather than inferred from a heading. Then the reports
fold into a single collapsible `problems (n)` group, collapsed by default, sitting below the editing
panels. The count is the part that matters: a collapsed group that says `problems (4)` tells you as
much as four expanded sections did, in one line, and leaves the node panel where you left it.

Cards without the grouping was the smaller change and is the wrong one — nine bordered cards are
easier to tell apart and just as good at pushing the editor off-screen. Tabs were the other candidate
and were rejected for hiding, behind a tab, the reports that exist to be noticed.

**Three columns, two seams, dragged and remembered.** The stage/canvas boundary and the
canvas/sidebar boundary both become draggable dividers, and both positions persist. This is a
reversal of a stated design position: `LivePane`'s own comment says it is an alternative to the
three-pane body precisely "so none of the rail and collapse machinery reaches it". That was right when
the alternative was inheriting `LayoutShell`'s collapse rules wholesale. It is not right as a reason
to refuse resizing, because the machinery in question turned out to be a pure module and a
twenty-line pointer handler — `layout.ts` plus `onDividerDown` — and the second use of a proven shape
is not the machinery creep the comment was guarding against.

What `/live` takes from that shape is the shape, not the state: its own module, its own storage key,
its own clamps. It does not take collapse — the sidebar and the stage are always present, only
resized — because collapse brings the last-visible guard and the rail vocabulary with it, and neither
column here has anywhere to collapse *to*.

**Layout stays in the browser.** Widths and the video toggle live in `localStorage`, not in the World
manifest and not on the WS contract. This follows the rule `layout.ts` already states from
`AGENTS.md`: collapsing or resizing a pane is not behaviour — no observation starts or stops, HAL
says nothing different — so it belongs to the browser that draws it. A consequence worth naming: two
browsers pointed at the same World disagree about the layout and agree about everything else, which
is correct.

**The graph canvas is out of scope.** Nodes, edges, the SVG, the `graph-tools` row and the selection
model are all left exactly as they are. The canvas gains room when the sidebar is dragged narrower
and loses it when dragged wider, and that is the only way this work touches it.

---

## Open Questions

- **Does the `problems (n)` group draw attention when it is non-empty?** A count in a muted heading is
  easy to miss, and these reports exist because someone should look at them. A coloured count, or
  auto-expanding the first time a new problem appears, are both defensible; auto-expanding on every
  load is not.

- **What are the drag clamps?** `layout.ts` uses 20–80%. The sidebar has a `240px` minimum today that
  exists so its controls do not squeeze; the stage has a `140px` minimum on the player. Whether the
  clamps are percentages, pixel minimums, or both is a plan-time decision, but a geometry that can be
  restored from storage must be one the drag could have reached — that invariant is already stated in
  `layout.ts` and should hold here too.

- **Does the video toggle survive a World switch?** It is a per-browser preference, so the simple
  answer is yes and it is global. The case against is that a World built for watching and a World
  built for authoring want different answers, which argues for per-World storage. Global unless
  someone hits the friction.

- **Should the audio transport move?** It is mounted above the World/picker switch and renders at the
  top of `.live-pane`, deliberately, so browsing Worlds does not stop the music. Hiding the video
  makes the stage column mostly playlist, which raises the question of whether the transport belongs
  inside that column visually. Any answer must keep the element mounted across the switch — that is a
  fixed bug, not a layout preference.

- **Is a keyboard shortcut wanted for the video toggle?** Nothing on `/live` has one today, so this
  would be the first, and it would need to say what the convention is rather than just pick a key.
