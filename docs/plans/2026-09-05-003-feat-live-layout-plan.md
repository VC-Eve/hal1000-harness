---
title: "feat: The /live layout — a hideable stage, draggable seams, and a sidebar you can read"
type: feat
status: active
date: 2026-09-05
origin: docs/brainstorms/2026-09-05-live-layout-requirements.md
reviewed: 2026-09-05
---

# feat: The `/live` layout — a hideable stage, draggable seams, and a sidebar you can read

## Summary

`/live` becomes three columns — stage, graph canvas, sidebar — with a draggable seam between each
pair and both positions remembered in the browser. The stage's video becomes a toggle; hidden, the
`ClipPlayer` unmounts, the playlist editor opens in its place and takes the column, dropping the caps
that only exist because the video takes the height. The sidebar's sections gain the border and
padding the audio and playlist panels already carry, and the nine diagnostic report sections fold
into one collapsible `problems (n)` group. The graph canvas, its nodes, edges and selection model are
untouched.

Hiding the video has one server-visible cost, which is stated rather than hidden: the `<video>` is
the only thing that measures a clip's real length. See KTD4 and R5b.

---

## Problem Frame

See origin. In short: `.graph-side` (`ui/src/styles.css:3131`) is a flex column whose sections are
separated by a 10px gap and a small uppercase heading, and up to nine report sections render there in
exactly the format of the node panel they push off the bottom. `.live-stage` scrolls and
`.playlist-tracks` scrolls inside it at `max-height: 260px` (`ui/src/styles.css:3538`), so a long
playlist is a small window sliding around in a larger one. The `live-playlist` screenshot scene
already records this in a comment — *"The rows sit below the fold at these heights"*
(`scripts/screenshot.mjs:314`) — and works around it with `scrollIntoViewIfNeeded`.

---

## Requirements

Origin states decisions rather than numbered requirements. They are numbered here, and this list is
the scope.

**The stage column**
- **R1.** A control in the World header toggles the video. Not on the player: a control that vanishes
  with the thing it controls cannot bring it back.
- **R2.** Hidden means unmounted. `ClipPlayer` is not rendered, not `display: none`.
- **R3.** Hiding the video opens the playlist editor if it is closed, and the editor fills the column
  with its track list uncapped. With the video shown, the caps stay — they were measured for that
  case.
- **R4.** The track list is not nested inside a second scroller when the video is hidden — counting
  siblings, not only ancestors. Restated after measuring: the original wording was "exactly one
  scrolling region in the column", and a bounded picker with its own scrollbar is not the defect. The
  defect is a list sliding around inside a scrolling column, and it is the column that must stop
  scrolling.
- **R5.** The toggle persists across reloads and across World switches, per browser.
- **R5b.** While the video is hidden, the stage column names any clips in the open World whose
  duration has never been measured, and offers to show the video to measure them.

**The sidebar**
- **R6.** Every section in `.graph-side` is a bordered, padded card.
- **R7.** The nine diagnostic reports render inside one collapsible group, collapsed by default,
  positioned below the parameters and node/transition panels.
- **R8.** The group's header carries a count of the non-empty reports and is absent entirely when the
  count is zero. It returns to collapsed when it goes empty.
- **R9.** Expanding the group reveals the report sections unchanged in content.

**The seams**
- **R10.** The stage/canvas boundary and the canvas/sidebar boundary are draggable dividers with
  `role="separator"`.
- **R11.** Both positions persist per browser, one write per gesture, and a restored geometry is one
  a drag could have reached.
- **R12.** The canvas keeps a minimum share no combination of drags can take from it.
- **R13.** A drag is reversible: dragging a seam out and back leaves the other seam where it started.

**Out of scope**
- **R14.** The graph canvas, `graph-tools`, the SVG, and the selection model are unchanged.
- **R15.** No collapse. Both side columns are always present and only resized.

---

## Key Technical Decisions

**KTD1. The tracks are custom properties the component sets, not inline `grid-template-columns`.**
This is not a preference — it is the exact defect recorded in
`docs/solutions/css-tracks-with-two-sources-of-truth.md`. `LayoutShell` computed its grid tracks in
JS and wrote them as an inline style; inline styles beat stylesheet rules, so the narrow-viewport
media query could not restyle the grid without `!important`, used it, and produced a layout whose CSS
comment asserted the opposite of the rule two lines below it. Nothing failed — tests, typecheck and
build all passed.

So `LivePane` writes `style={{ "--live-cols": tracks }}` on `.live-body` and the stylesheet reads
`grid-template-columns: var(--live-cols)`, exactly as `LayoutShell.tsx:96` does with `--cols`.

**KTD2. A pure module owns the geometry, and its exported surface is small.** `ui/src/liveLayout.ts`,
a sibling of `layout.ts`, holds the state shape, the clamps and the load/save pair, under its own
storage key (`hal1000.live-layout`). What justifies the module is `clampLiveLayout` and the
clamp-on-load invariant — the same load-bearing content `layout.ts:38-40` and `:145-177` carry. The
track derivation is a template literal with no branch (there is no collapse, and the video toggle
removes no column), so it is a one-liner and gets one assertion, not the seven-variant sweep
`layout.test.ts:126` runs against a function that genuinely branches.

**KTD3. Five tracks, a floored canvas, and a joint clamp that is reversible.**

*Five, not three.* The dividers are grid items, so `deriveLiveTracks` emits
`minmax(240px, {stage}%) {DIVIDER} minmax(0, 1fr) {DIVIDER} minmax(240px, {side}%)`. `minmax(0, 1fr)`
rather than a bare `1fr`, following `layout.ts:95`'s `FILL` — `.graph-canvas` carries `min-width: 0`
(`styles.css:3120`) so a bare `1fr` is safe today, but the safety would live in the stylesheet rather
than in the derivation, and a future canvas child would re-expose it.

*Defaults are 26 and 25.* Not 34. Today's `34%` at `styles.css:3115` is 34% of `.state-graph`, which
is itself the `1fr` remainder of `.live-body` — at a 1200px body that is ≈298px, ≈24.8% of the body.
A default of 34 would start the sidebar ~110px wider than it is today while claiming to reproduce it.

*The clamp is joint, because CSS cannot do it.* Two independent clamps do not work:
`minmax(240px, 26%)` caps a track at a percentage of the container, and giving the canvas
`minmax(30%, 1fr)` does not rescue it — grid resolves track minimums and then overflows, producing a
125% grid rather than a clamped one. Each dimension is clamped to its own range (stage 15–50, sidebar
15–45), then if `stage + side > 100 - CANVAS_MIN` the seam **not** under the hand gives way.
`CANVAS_MIN` is 30.

*And it must be reversible (R13).* A naive "the other one gives way" is lossy: shove the sidebar from
25 to 20 by dragging the stage right, drag the stage back left, and the sidebar stays at 20 — width
the user never chose to give up, recoverable only by grabbing the other seam.

Built more simply than planned. The plan proposed remembering the pressured seam's value at
`pointerdown` and letting it recover; in the event the drag computes both numbers from where the
*gesture* started rather than from the layout as it stands, and reversibility falls out — at zero
delta the arithmetic returns exactly the two numbers the press began with, so there is nothing to
remember. It also removes a constant the plan would have needed: a percentage grid track resolves
against the container's content box, so a delta in pixels is a delta in percent no matter how much of
the container the four gaps and two bars are using, and there is no gutter figure duplicated between
the stylesheet and the handler. Grabbing a bar off-centre stops making it jump, too.

*The `240px` floors are protecting a measured defect.*
`docs/solutions/a-label-may-be-squeezed-a-control-may-not.md`: a track row is seven items of which
one flexes, so the flexible one absorbs the entire deficit — it already rendered a filename one
character per line at 262px. A drag that can narrow that column is a drag that can reproduce it.

**KTD4. The toggle stays local, and the reason is not the one that first suggested itself.**

The tempting argument — *"collapsing a pane is not behaviour: no observation starts or stops, HAL
says nothing different"*, `layout.ts:11-15` — does not transfer, and the plan would have shipped
asserting it. `ui/src/components/useClipStage.ts:243` is the **only** sender of
`report-clip-duration` in the codebase. It fires from `onLoadedMetadata`, because the clip route
serves only clips the manifest already references and so cannot answer a probe at assignment time
(`shared/src/types.ts:2152-2162`). `/broadcast` cannot cover for it:
`server/src/live/service.ts:548-551` refuses the message from an observer, and that refusal is
load-bearing — "nothing downstream deduplicates a duration, and it is a manifest write".

So with the video hidden, a newly assigned clip's real length reaches the manifest from no surface at
all, and `runtime.ts:512-516` runs it on `DEFAULT_CLIP_MS` — **3 seconds** (`runtime.ts:38`),
whatever the footage. R5 makes the toggle sticky, which makes that a standing condition rather than a
session quirk. That is behaviour.

It still stays local, for a different reason: no *agent-reachable capability* disappears with it. The
World, its clips, the transport and every report remain on the protocol; an agent has no viewport,
cannot want a video hidden, and putting a per-browser render preference on the wire would create a
second authority over what each client mounts. The cost is met by R5b — the column says which clips
are unmeasured and offers to measure them — rather than by pretending there is none.

Global rather than per-World: a preference nobody has hit the friction of yet, and per-World storage
would put a browser preference into a portable folder.

**KTD5. The wrapper stays, with `display: contents`, and `StateGraph` renders its own divider.**

The first draft had `StateGraph` return a fragment so `LivePane` could put a divider between the
canvas and the sidebar. That is wrong twice over.

*A parent cannot interleave into a child's fragment.* `LivePane` would render
`stage · divider · StateGraph{canvas, side} · divider`, and grid would place five children into five
tracks in DOM order — sidebar into the divider track, trailing divider into the sidebar track. Both
dividers render, so U4's `role="separator"` assertion passes cheerfully; jsdom has no layout, so only
the browser check would catch it.

*And unwrapping breaks eight selectors silently.* `.state-graph` is a scoping ancestor at
`styles.css:3361, 3367, 3373, 3384, 3390, 3395, 3401, 3407` — the crossing transition path, the whole
`.clip-set` run-grouping vocabulary (`in-run`, `run-first`, `run-last`, `button.linked`), and
`broken-clips`. `.clip-set` renders inside `.graph-side`; the others on the canvas. Nothing fails: no
test, no typecheck, no build. That is the same silent class KTD1 exists to prevent.

So: `.state-graph` keeps its element and its class and takes `display: contents`, which makes
`.graph-canvas` and `.graph-side` grid items of `.live-body` while leaving every descendant selector
and the `state-graph` testid (`LivePane.test.tsx:163`) intact. `StateGraph` renders the
canvas|sidebar divider itself, between its two children, taking the pointer handler as a prop.
`LivePane` owns the geometry; `StateGraph` owns its own children's order. `display: contents` must be
confirmed in a browser against the canvas's `overflow: auto` — U5 measures it.

**KTD6. The drag captures the pointer; it does not bind `window`.** `LayoutShell.tsx:57-72` attaches
`pointermove`/`pointerup` to `window` and removes them only from inside `up`. There is no
`pointercancel` handler, no `setPointerCapture`, and no effect cleanup, so three exits never tear
down: a cancelled pointer (a touch-drag on a 6px bar is exactly what a browser claims as a pan
gesture, and `.divider` at `styles.css:208-211` sets no `touch-action`), a release outside the
viewport, and unmount mid-drag. The third is materially worse on `/live` than in `LayoutShell`,
because `App.tsx` mounts `LivePane` on a route and the Back button unmounts the whole pane from
outside the component.

The correct pattern is in the other file this plan opens: `StateGraph.tsx:191` calls
`setPointerCapture`, and its comment reasons about this exact hazard. So the divider captures the
pointer and handles `pointermove` / `pointerup` / `pointercancel` on the element itself, and
`.divider` gains `touch-action: none` and `user-select: none`.

**KTD7. One write per gesture.** `LayoutShell` calls `setLayout` on every `pointermove`, and its
`useEffect(…, [layout])` therefore runs `JSON.stringify` + `localStorage.setItem` every frame. The
write is cheap; the re-render is not. `LivePane`'s subtree is `ClipPlayer` + `OverlayLayer` +
`PlaylistEditor` + `StateGraph` — an SVG of every node and every transition curve — reconciled at
pointer rate while two `<video>` elements decode. Nothing in it re-subscribes on a bare re-render
(`useClipStage`'s source effect is keyed `[key, worldId]`, the `videos` tuple is memoised,
`OverlayLayer`'s `ResizeObserver` has empty deps), so this is jank rather than a race — but the house
rule already exists at `StateGraph.tsx:103`: *"One write per drag, on release, rather than one per
pointer move."* Live geometry during the drag is a ref driving `--live-cols`; state and storage are
written on release.

**KTD8. The percentage maths subtracts the gutters.** `.layout` (`styles.css:193-198`) declares no
gap, so `LayoutShell`'s `(clientX - rect.left) / rect.width` is accurate to within a bar's width.
`.live-body` has `gap: 12px` (`styles.css:2981`), and five tracks means four gaps — 48px belonging to
no percentage track while the drag measures against the full `rect.width`. Subtract the fixed gutters
before dividing. The sidebar seam additionally measures from the right edge,
`(rect.right - clientX) / usable * 100`, since the stored value is the sidebar's own width; getting
that backwards gives a divider that runs from the pointer, which is
`docs/solutions/a-perpendicular-reverses-when-the-edge-does.md`.

**KTD9. Every new scroll container gets `min-height: 0` at each level — and the sibling matters.**
`.playlist-list` and `.playlist-tracks` are one selector (`styles.css:3538`) and both render inside
one `.playlist-editor` (`PlaylistEditor.tsx:299` and `:508`), with `.audio-browser` optionally
between them. Uncapping both under `.no-video` gives two uncapped `overflow-y: auto` siblings in a
`min-height: 0` flex column with no basis — they size to content, the editor overflows, and whether
anything scrolls depends on which rule wins. That is `flexbox-min-height-scroll-trap.md` one level
below where KTD9 first looked. So the track list is the one that takes the column
(`flex: 1 1 auto; min-height: 0`) and the picker keeps a cap; R4 counts scrollable elements *within*
`.live-stage`, not only ancestors of one node.

**KTD10. The remount restarts the clip, and that is an accepted cost.** Coming back from a hidden
video, `useClipStage` is fresh: `held` is `[null, null]`, `front` is 0, and the clip starts from the
beginning while the server's timer is already partway through it — so it plays the opening frames and
is cut off mid-shot. `AudioPlayer` solves the equivalent at `:148-151` with
`seekTo.current = transport?.positionMs ?? 0`; `ClipPlayer` cannot, because `LiveState`
(`shared/src/worlds.ts:554-575`) carries `stateId`, `clip`, `generation`, `fault` and `transitionId`
and **no elapsed position**. There is no field to seek to.

Adding one is a protocol change and is out of this plan. It is named here so it is not discovered in
a browser, and it is the second entry for the residuals file. Note this is a *worsening of frequency*
rather than a new fault: `ClipPlayer` already sits inside the World branch (`LivePane.tsx:130`), so
every trip to the picker tears the elements down mid-playback today.

**KTD11. The audio transport does not move.** It is mounted above the World/picker switch in
`LivePane` and renders at the top of `.live-pane`, deliberately: the comment at
`ui/src/components/LivePane.tsx:146-160` records that mounting it inside the World branch stopped the
music on every trip to the picker *and* left the server waiting out a grace period for an `ended` no
element would send. Hiding the video makes it tempting to tuck the transport into the stage column.
Not in this plan — and U2 carries a test that `AudioPlayer` survives the toggle, so it cannot become
collateral.

**KTD12. The problems group renders nothing when there is nothing to report,** and returns to
collapsed when it empties. Not a header saying `problems (0)` — each report section is already
conditional on its list being non-empty, and a World with no faults should show no fault chrome. The
count is the number of non-empty **reports**, not findings across them: nine categories is the axis
that makes the sidebar unreadable, and `47` says less than `4`. Amber (`--hal-amber`), because a
count in `#5c5c58` is a count nobody reads. No auto-expand: knowing whether a problem is *new* means
persisting what was seen.

The reset in R8 is not tidiness. `open` would live in `StateGraph`, which does not unmount, while the
group is behind `problems.length > 0` — so fixing the last fault leaves `open` true, and a fault
introduced an hour later renders the group already expanded, contradicting "collapsed by default".
Extracting a `<ProblemsGroup>` with its own state inverts the bug rather than fixing it: a momentary
empty payload would then collapse the group under the reader mid-sentence. An effect keyed on the
group going empty is the fix, and it is asserted.

**KTD13. Report sections keep their own `data-testid`s, and the group collapses with `hidden`.**
The group wraps the sections; it does not replace them. Existing assertions address
`dangling-effects`, `unusable-ranges` and the rest by testid and must keep working, with the group
expanded first. `hidden` rather than CSS, so a collapsed report is genuinely absent from the
accessibility tree — `docs/solutions/an-index-based-query-couples-a-test-to-unrelated-components.md`
records that Testing Library's role queries default to `hidden: false` and short-circuit on
`element.hidden`. No new assertion here may use `getAllByRole(...)[n]`.

**That covers role queries and not testid queries, which is the trap.**
`getByTestId` finds hidden elements. All nine existing report assertions use it, so every one of them
kept passing against a collapsed group — asserting content no reader could reach, which is the same
as not asserting it. Two consequences, both carried into U3: those assertions must open the group
first, and the assertion that actually proves `hidden` was chosen over CSS has to be `toBeVisible` or
a role query, never `queryByTestId(...)` being null. The first draft of this plan specified the
`queryByTestId` version, and it would have passed against an implementation that never hid anything
at all.

---

## High-Level Technical Design

```
LivePane                         (owns liveLayout; renders the stage seam)
├─ AudioPlayer                   (above the switch — unchanged, KTD11)
└─ .live-world
   ├─ .live-header  [ name ] [ worlds ] [ video off ]        ← R1
   └─ .live-body   style={{ "--live-cols": tracks }}         ← KTD1
      ├─ .live-stage[.no-video]
      │    ├─ ClipPlayer                    (omitted when hidden — R2)
      │    ├─ .stage-unmeasured             (video hidden only — R5b)
      │    └─ PlaylistEditor                (opened by the toggle — R3/R4)
      ├─ .divider  role=separator                            ← stage | canvas
      └─ StateGraph  .state-graph { display: contents }      ← KTD5
           ├─ .graph-canvas                 (untouched — R14)
           ├─ .divider  role=separator                       ← canvas | sidebar
           └─ .graph-side
                ├─ .side-card  parameters
                ├─ .side-card  node / transition / clip browser
                └─ .side-card  ▸ problems (4)                ← R7/R8, hidden-collapsed
```

Five grid children, five tracks. `LivePane` derives the track list and owns both seams' geometry;
`StateGraph` renders the second divider because it owns its children's order.

```ts
// ui/src/liveLayout.ts
export interface LiveLayoutState {
  stage: number;   // percent of the body
  side: number;    // percent of the body
  video: boolean;  // is the clip player mounted
}
export const defaultLiveLayout = (): LiveLayoutState => ({ stage: 26, side: 25, video: true });
export function clampLiveLayout(next: LiveLayoutState, dragged: "stage" | "side" | null): LiveLayoutState;
export function deriveLiveTracks(state: LiveLayoutState): string;
export function loadLiveLayout(): LiveLayoutState;
export function saveLiveLayout(state: LiveLayoutState): void;
```

`dragged` is required rather than optional, because `loadLiveLayout` must state its own tiebreak:
storage is hand-editable, `null` means no hand is on a seam, and the sidebar gives way. `layout.ts:158`
re-clamps on load for exactly this reason.

---

## Implementation Units

### U1. The geometry, as a pure module

**Files:** `ui/src/liveLayout.ts` (new), `ui/test/liveLayout.test.ts` (new)

Write the module above, modelled on `ui/src/layout.ts` — lazy read, a `try/catch` around
`localStorage` because it throws outright under some privacy settings, shape validation on load, and
the clamp shared between the drag and the load path. Brace `saveLiveLayout`'s call site in the
component: an effect must not return anything but a function, and a bare arrow body would if the
signature ever stopped being `void`.

**Tests** — pure, no DOM:
- defaults are 26 / 25 / video on, and 25 is asserted **against the arithmetic**, not against `34`:
  today's sidebar is 34% of the `1fr` remainder of a 26%-stage body
- each dimension clamps to its own range
- the joint clamp: with `dragged: "stage"`, pushing past the limit moves the sidebar and leaves the
  canvas at `CANVAS_MIN`; with `dragged: "side"` it moves the stage
- with `dragged: null` — the load path — the sidebar gives way
- a stored geometry outside the clamps is clamped on load (`layout.ts:38`'s invariant, inherited)
- missing / non-JSON / wrong-shape stored payloads each yield the default
- `deriveLiveTracks` puts both percentages in the string and emits five tracks — **one** assertion,
  not a variant sweep; the function has no branch

### U2. The video toggle, the column it hands over, and what that column costs

**Files:** `ui/src/components/LivePane.tsx`, `ui/src/components/useClipStage.ts`,
`ui/src/styles.css`, `ui/test/components/LivePane.test.tsx`

`LivePane` seeds `useState(loadLiveLayout)` lazily so the first paint is the layout the user left.

Header gains one button beside `worlds`, `data-testid="toggle-video"`, labelled `video off` while
showing and `video on` while hidden — the label says what the press does, matching `open-playlists`'
`playlists` / `close playlists`.

**Hiding the video sets `editing` true.** `PlaylistEditor` renders only when `editing`
(`LivePane.tsx:139`), so without this the toggle produces a 26%-wide column containing one button —
and R15 forbids collapsing it away. Showing the video does not close the editor; the toggle opens,
it does not own.

**R5b, the unmeasured-clips notice.** With the video hidden, `.live-stage` renders a line naming
clips in the open World whose `durationMs` is 0, with a button that shows the video. This is KTD4's
mitigation and it is the honest content for a column that would otherwise be empty. The count comes
from the World already in the store; no new message.

CSS under `.live-stage.no-video`:
- `.playlist-editor { flex: 1 1 auto; min-height: 0; }`
- `.playlist-tracks { flex: 1 1 auto; min-height: 0; max-height: none; }`
- `.playlist-list` keeps a cap — KTD9, two uncapped siblings is the trap
- `.live-stage.no-video { overflow-y: visible; }` — the column stops being a scroller

**Also in this unit, two lines in `useClipStage`:** an unmount cleanup that calls `pause()` and clears
`src` on both elements. The engine already pauses on `blank` (`:141-145`) and on demotion
(`:173-177`) because "a hidden `<video>` keeps playing and keeps firing events"; unmount is the one
exit where that discipline is not applied, and R2 turns unmount from a rare event into a gesture.

**Tests:**
- `toggle-video` unmounts `clip-player`, and pressing again remounts it
- the toggle opens the playlist editor when it was closed
- the label reads `video off` when showing and `video on` when hidden
- the choice survives a remount (write storage, mount, assert) — R5
- **`AudioPlayer` stays mounted across the toggle** — KTD11's guard rail
- the unmeasured notice names a clip with `durationMs: 0` and is absent when every clip is measured

Query by testid throughout (KTD13). Dropped from the first draft: *"survives a trip to the picker"* —
`picking` only chooses which value `body` takes and `LivePane` never unmounts, so it would assert that
React preserves state across a re-render.

### U3. The sidebar becomes cards, and nine reports become one group

**Files:** `ui/src/components/StateGraph.tsx`, `ui/src/styles.css`,
`ui/test/components/StateGraph.test.tsx`

*Cards.* One rule on `.graph-side > section`, carrying the border and padding `.audio-player` and
`.playlist-editor` already use. A child selector rather than a class at nine call sites, so a section
added later gets the treatment without anyone remembering; `styles.css:3159` is existing precedent
for the shape. `.parameters-panel` (`StateGraph.tsx:455`), `.node-panel` (`:633`),
`.transition-panel` (`:1253`), `.graph-hint` (`:295`) and `.clip-browser` (`ClipBrowser.tsx:54`) are
all `<section>` roots and direct children of `.graph-side`, and none carries a border today.

While in the file: `.graph-side h4` appears at `styles.css:3150` and again at `:3305` as part of
`.transition-order h4, .graph-side h4`, with a byte-identical body. This is a redundant selector, not
the "second value silently wins under the first comment" defect the first draft cited — the fix is to
drop `.graph-side h4` from the grouped selector at `:3305`, and it is housekeeping, not a finding.

*The group.* The nine conditional sections (`StateGraph.tsx:301-410`) move behind one wrapper:

```tsx
// ui/src/components/StateGraph.tsx
const problems = [
  { id: "dangling-effects", count: reports?.danglingEffects.length ?? 0, render: () => … },
  …
].filter((p) => p.count > 0);

// KTD12: the group's own emptiness resets it, because `open` outlives the section.
useEffect(() => { if (problems.length === 0) setOpen(false); }, [problems.length]);

{problems.length > 0 && (
  <section className="side-card problems-group" data-testid="problems-group">
    <button aria-expanded={open} onClick={() => setOpen(!open)} data-testid="toggle-problems">
      problems <span className="problems-count">({problems.length})</span>
    </button>
    <div hidden={!open}>{problems.map((p) => p.render())}</div>
  </section>
)}
```

**Tests:**
- with no reports, `problems-group` is absent
- with three non-empty reports the header reads `problems (3)`
- collapsed, `dangling-effects` is not in the tree (`queryByTestId` is null) — the assertion that
  proves `hidden` rather than CSS
- `toggle-problems` reveals every non-empty report, each addressable by its own testid
- `aria-expanded` tracks the state
- **expand, then dispatch reports that empty the group, then dispatch a new fault — the group renders
  collapsed** (KTD12; this one fails without the effect)
- existing report assertions updated to expand first, and not by index

### U4. The seams

**Files:** `ui/src/components/LivePane.tsx`, `ui/src/components/StateGraph.tsx`,
`ui/src/styles.css`, `ui/test/components/LivePane.test.tsx`

`.state-graph` keeps its element and takes `display: contents`; its `grid-template-columns`,
`flex` and `min-height` go (KTD5). `StateGraph` renders a `.divider` between `.graph-canvas` and
`.graph-side` and takes the pointer handler as a prop.

The handler follows `StateGraph.tsx:186-196`, not `LayoutShell.tsx:57-72` (KTD6): capture the pointer
on the divider, handle `pointermove` / `pointerup` / `pointercancel` on the element, measure against
`rect.width` minus the fixed gutters (KTD8), sidebar seam from the right edge, live geometry into a
ref that drives `--live-cols`, one `setLayout` + one write on release (KTD7). Two dividers,
`role="separator"`, `aria-orientation="vertical"`, `data-testid="live-divider-stage"` and
`live-divider-side`. `.divider` gains `touch-action: none` and `user-select: none`.

**Tests** — jsdom has no layout, so these assert stored numbers and attributes, never pixels:
- both dividers render with `role="separator"`
- `pointerdown` + `pointermove` + `pointerup` on the stage divider writes a clamped value
- **exactly one write per gesture** — spy on the storage write across a multi-move drag (KTD7)
- **`pointercancel` tears the drag down** — a subsequent `pointermove` with nothing pressed changes
  nothing (KTD6; this fails against the `LayoutShell` shape)
- dragging past the joint limit moves the other seam, not the canvas below `CANVAS_MIN`
- **drag out and back returns the pressured seam to where it started** — R13
- `--live-cols` is set on `.live-body` and no inline `grid-template-columns` is (KTD1 — asserting the
  absence is what stops the regression the solution doc describes)
- `state-graph` is still in the tree (`LivePane.test.tsx:163` keeps passing — KTD5)

### U5. Prove it in a browser

**Files:** `scripts/live-layout-check.mjs` (new), `scripts/screenshot.mjs`, `AGENTS.md`

jsdom implements no layout, so every claim about *room* is unproven by the suite above.
`a-label-may-be-squeezed-a-control-may-not.md` is the case in point: the component test passed while
the click target it added measured zero pixels wide. A screenshot cannot be diffed on a width either.
So this measures and prints numbers, in the style of `scripts/overlays-check.mjs`.

Its own script rather than a fold-in, for a reason worth writing down: `overlays-check.mjs` seeds
through `ffmpeg` and throws on a non-zero exit, so folding a layout check in there would make a check
that needs no media depend on `ffmpeg`; and `screenshot.mjs`'s `SCENES` carry only
`seed`/`setup`/`widths` and its `main()` writes PNGs, with no seam for printing numbers. The cost is
~100 lines of duplicated boot and teardown — the server spawn, the readiness poll
(`overlays-check.mjs:230-237`) and the win32 `taskkill` (`:301-305`). Lift the `/live` navigation from
`overlays-check.mjs:263-283`, which already opens the route and clicks `open-playlists`. Reuse the
`live-playlist` seed from `screenshot.mjs:248-300` — undecodable placeholder files, deliberately, so
no `ffmpeg`.

| measurement | claim |
|---|---|
| `.playlist-tracks` client height, video on vs off | R3 |
| its `scrollHeight` vs `clientHeight` in both modes | that it scrolls, and that a real playlist overflows |
| count of scrollable elements **within `.live-stage`** | R4 — siblings included, per KTD9 |
| computed `border-*` on each `.graph-side > section` | R6 |
| `.live-body` computed `grid-template-columns` before and after a synthetic drag | R10/R12 |
| `.graph-side` and `.graph-canvas` computed widths, and that both are grid items of `.live-body` | KTD5 — `display: contents` verified rather than assumed |
| a `.clip-set li.in-run` still resolves its `run-first` styling | KTD5 — the eight descendant selectors still match |

Dropped from the first draft's table: "`.clip-player` present?" and "no inline
`grid-template-columns`". Both are jsdom's job and both are already assertions in U2 and U4.

Then a `live-novideo` scene in `screenshot.mjs` (same seed, plus a press of `toggle-video`) at 1440
and 900. Kept despite being reviewable-by-eye only, because `AGENTS.md` puts the HAL aesthetic under
screenshot review and U3's cards have no other reviewer.

Run `npm run build` **first**: `screenshot.mjs:19-22` is explicit that the server serves `ui/dist` and
does not build, and that a UI change was once verified this way while not being in the picture at all.

`AGENTS.md` gains the command beside `overlays-check.mjs`, and its `ui/src/` bullet gains a sentence
on `/live` carrying its own layout module.

---

## Scope Boundaries

**In:** the stage column, the sidebar's presentation and grouping, the two seams, their persistence,
and the browser measurement that proves the heights.

**Out:**
- The graph canvas, its SVG, `graph-tools`, node dragging, the selection model (R14).
- Collapsing either column to a rail (R15).
- Moving the audio transport (KTD11).
- An elapsed-position field on `LiveState` (KTD10). It would fix the restart-from-zero, and it is a
  protocol change.
- Fixing `LayoutShell`'s pointer handler. KTD6 says it has the same three exits unhandled; `/live`
  gets the better pattern, and the body layout keeps what it has until someone reports it. Worth a
  residual.
- A keyboard shortcut for the toggle. The first one on `/live` would need to establish a convention.
- Per-World layout preferences (KTD4).
- Narrow-viewport behaviour below 900px. `--live-cols` makes a media query possible without
  `!important`; writing one is not in this plan.

---

## Risks & Dependencies

**Everything that fails here fails silently.** The eight `.state-graph` descendant selectors, the
inline-style trap, the two-siblings scroll trap, `display: contents` — none of them breaks a test, a
typecheck or a build. Four of U5's seven measurements exist for exactly these, which is why **U5 is
not optional polish and must not be the unit dropped if the work runs long.**

**The regression discipline.** House rule: a test that covers a defect must fail without the fix. It
holds by construction for U1, U2, U3 and U4 — including the two written specifically to fail against
the shapes the first draft proposed (the `pointercancel` teardown, and the problems-group reset). It
does not hold for the card borders or any height claim; U5 is the substitute.

**`display: contents` is the one unverified assumption.** It is the load-bearing mechanism of KTD5 and
neither I nor the reviewer ran it against `.graph-canvas`'s `overflow: auto`. If it misbehaves, the
fallback is `LivePane` rendering `.graph-canvas` and `.graph-side` itself — which costs the
encapsulation and the eight selectors, so lifting `selectedNode`, `selectedTransition`, `connecting`,
`browsingFor` and `dragging` out of `StateGraph.tsx:58-67` would be the real price. Check it first, in
U4, before writing the rest of the unit.

**Dependencies:** U1 before U2 and U4. U3 is independent. U4 needs KTD5 confirmed. U5 last.

---

## Sources & Research

**Origin:** `docs/brainstorms/2026-09-05-live-layout-requirements.md`

**Code verified while planning:**
- `ui/src/components/LivePane.tsx` — the switch, the header, `{editing && <PlaylistEditor …>}` at
  `:139`, and the transport comment at `:146-160` that KTD11 rests on
- `ui/src/components/useClipStage.ts:221-244` — the sole sender of `report-clip-duration`
- `server/src/live/service.ts:543-553` — the observer refusal; `server/src/live/runtime.ts:38, 512-516`
  — `DEFAULT_CLIP_MS`
- `shared/src/worlds.ts:554-575` — `LiveState`, which has no elapsed position (KTD10)
- `ui/src/components/StateGraph.tsx:103` (one write per drag) and `:186-196` (pointer capture) — the
  patterns KTD6 and KTD7 adopt
- `ui/src/components/LayoutShell.tsx:46-72` — the shape the first draft copied, and its three
  unhandled exits
- `ui/src/layout.ts` — the pure-module pattern, the clamp-on-load invariant, `FILL`, the
  `localStorage` discipline
- `ui/src/styles.css:193-198` (`.layout`, no gap), `:208-211` (`.divider`), `:2975` (`.live-body`,
  `gap: 12px`), `:3112-3118` (`.state-graph`), `:3120` (`.graph-canvas min-width: 0`), `:3131`
  (`.graph-side`), `:3150`/`:3305` (the redundant `h4`), `:3361-3407` (the eight descendant
  selectors), `:3452` (`.live-stage`), `:3538` (the caps)
- `ui/src/components/PlaylistEditor.tsx:291, 299, 508` — one section, two lists
- `scripts/screenshot.mjs:19-22, 245-315`; `scripts/overlays-check.mjs:230-237, 263-283, 301-305`
- `ui/test/layout.test.ts:126`; `ui/test/components/LivePane.test.tsx:163`

**Learnings applied:**
- `docs/solutions/css-tracks-with-two-sources-of-truth.md` → KTD1, KTD5
- `docs/solutions/flexbox-min-height-scroll-trap.md` → KTD9, U2
- `docs/solutions/a-label-may-be-squeezed-a-control-may-not.md` → KTD3, U5
- `docs/solutions/an-index-based-query-couples-a-test-to-unrelated-components.md` → KTD13, U3
- `docs/solutions/a-perpendicular-reverses-when-the-edge-does.md` → KTD8
- `docs/solutions/a-property-declared-twice-keeps-the-last-value-and-the-first-comment.md` → U3,
  cited as *not* applying

## What the browser said

U5 run at 1440×950 and 1440×1400, `.screenshots/live-layout/results.json`:

| | video on | video off |
|---|---|---|
| track list, 950px window | 260px | 274px |
| track list, 1400px window | 260px | **724px** |
| scrolling elements in the column | `live-stage`, `playlist-tracks` | `playlist-tracks` |

The cap was the whole of it: capped, the list was 260px in a small window and 260px in a large one,
which is what made a long playlist a sliding window regardless of screen. Uncapped it takes the
column, and the column takes the window.

The 950px row is the honest one to read twice. The gain there is 14px, because two things sit above
the list: a transport measured at 240px, and about 230px of editor chrome. Sixty of the transport's
240 are artifacts of the synthetic seed — `audio-unattended`, `audio-enable` and `audio-sound-fault`
all render because the seeded tracks do not decode and no gesture has been given — so a real instance
starts with more room than this. The remaining chrome is real, and is the obvious next lever if the
column still feels tight.

Two defects the browser found that no test could:

- **The playlist picker was being squeezed to four pixels, with a scrollbar.** As `flex: 0 1 auto`
  among six sized siblings it absorbed the whole deficit — the same mechanism as
  `a-label-may-be-squeezed-a-control-may-not.md`, on a different control. It was also the second
  scroller R4 forbids. Fixed by refusing to shrink it and capping it at 120px.
- **`.live-body` was not the problem it looked like.** The column measured 575px in a 950px window,
  which read as a stretch failure; the ancestor chain showed the grid row was 575px because that is
  what was left. Measuring upward is what separated the two.

`display: contents` is confirmed rather than assumed: the wrapper computes `contents`, and the canvas
and sidebar measure 634px and 354px against tracks of `368 6 634 6 354`. The drag reads
`minmax(240px, 50%) ... minmax(240px, 20%)` at full stretch and returns to `26%` / `25%` on the way
back, so reversibility holds against a real grid. No inline `grid-template-columns` at any point.

---

**Review:** three reviewers (simplicity, architecture, frontend races) on the first draft, 2026-09-05.
Every finding folded in was re-verified against the source before being encoded here, per
`docs/solutions/`-adjacent practice; the duplicate-`h4` finding is the one that was checked and
downgraded.
