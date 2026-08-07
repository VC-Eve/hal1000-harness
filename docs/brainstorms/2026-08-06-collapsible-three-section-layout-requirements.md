---
date: 2026-08-06
topic: collapsible-three-section-layout
---

# Collapsible three-section layout

## Summary

Split the app body into three independently collapsible sections: Conversation and a new
webcam placeholder stacked in a left column, Session Observation on the right. Each section
collapses to a labeled 24px edge rail that clicks to restore, and the arrangement is
remembered across reloads. The webcam section ships as an empty framed box — a home for
later work, not the work itself.

---

## Problem Frame

The body is a two-column grid with a draggable divider (`ui/src/App.tsx`,
`ui/src/styles.css`). The split is clamped to 30–80%, so neither Conversation nor Session
Observation can ever get out of the way of the other. When the narration feed is the thing
worth reading, a third of the window is still spent on a chat thread nobody is typing in,
and the divider stops the feed from ever running to the left edge.

That constraint also blocks growth. Webcam analysis needs somewhere to live, and there is
no free space to put it — a third section on a fixed two-column grid means every section
gets smaller, permanently. Making sections collapsible is what buys the room for a third
one.

---

## Key Decisions

**Collapsed sections leave a rail, not nothing.** A hidden section collapses to a ~24px
vertical strip on its own edge carrying its name and an expand arrow. The alternative —
zero width plus a floating overlay button — buys a genuinely full-width Session Observation
at the cost of an affordance that overlaps content and is easier to lose. The rail keeps
every section one click from returning and keeps the restore control where the section was.

**Layout state is browser-local.** Which sections are collapsed and where the dividers sit
persist in the browser, not in stored settings, and not over the WS protocol. This is a
carve-out from the agent-native parity rule in `AGENTS.md`, taken because collapsing a pane
changes what this browser shows and nothing about what HAL does — no observation starts or
stops, no narration changes. An agent has no reason to drive it.

**The webcam section is a frame, not a feature.** It renders a titled, empty section and
nothing else. Its eventual subject — watching the user at the desk, presence and attention —
is recorded here as direction only. No capture, no permissions, no vocabulary in
`CONCEPTS.md`, and no decision yet on whether it becomes a third observation role alongside
the Watched Session and Monitors.

**The left column owns the vertical stack.** Conversation sits above the webcam section in a
single left column, so the horizontal divider between them is internal to that column. The
existing vertical divider continues to separate left column from Session Observation, and
disappears entirely when the left column is fully collapsed.

---

## Requirements

**Collapse and restore**

- R1. Each of the three sections — Conversation, Webcam, Session Observation — has a control
  that collapses it.
- R2. A collapsed section renders as a ~24px rail on its own edge, showing its name and an
  expand affordance; activating the rail restores the section.
- R3. The collapse control of the last remaining visible section is disabled, so the body is
  never empty.
- R4. All three sections render simultaneously when none are collapsed.

**Layout geometry**

- R5. Conversation and Webcam occupy a left column stacked vertically, with Conversation on
  top; Session Observation occupies the right column.
- R6. The vertical divider between the left column and Session Observation is draggable, and
  is present only when at least one left-column section is expanded.
- R7. When both left-column sections are collapsed, the left column is the rail strip alone
  and Session Observation fills the remaining width with no divider and no dead space.
- R8. The horizontal divider between Conversation and Webcam is draggable, and is present
  only when both are expanded.
- R9. When Session Observation is collapsed, the left column fills the remaining width and
  keeps its own internal stacking.

**Persistence and defaults**

- R10. Collapsed/expanded state for all three sections persists across reloads and restarts,
  stored in the browser.
- R11. Divider positions persist on the same terms as R10.
- R12. On a first load with nothing stored, all three sections are visible.

**Webcam placeholder**

- R13. The webcam section renders a title and an empty body styled consistently with the
  other two sections.
- R14. The webcam section carries no capture, device access, or permission prompt.

**Narrow viewports**

- R15. Below the existing narrow breakpoint, the three sections stack vertically in one
  column and the draggable dividers are inert; collapse, restore, and persistence still work.

---

## Acceptance Examples

- AE1. Collapse both left sections
  - **Covers R2, R3, R7.**
  - **Given:** all three sections visible.
  - **When:** the user collapses Conversation, then Webcam.
  - **Then:** the left edge shows two stacked rails, no vertical divider is rendered, and
    Session Observation occupies everything to the right of the rails.

- AE2. Last section cannot be collapsed
  - **Covers R3.**
  - **Given:** Conversation and Webcam are collapsed, leaving only Session Observation.
  - **When:** the user looks at Session Observation's collapse control.
  - **Then:** it is present but disabled.

- AE3. Layout survives a reload
  - **Covers R10, R11.**
  - **Given:** the user collapsed Webcam and dragged the vertical divider left.
  - **When:** the page is reloaded.
  - **Then:** Webcam is still collapsed to its rail and the divider is where it was left.

- AE4. Restoring from a rail
  - **Covers R2, R6.**
  - **Given:** Conversation is collapsed and Webcam is expanded.
  - **When:** the user activates the Conversation rail.
  - **Then:** Conversation expands above Webcam and the horizontal divider between them
    appears.

---

## Scope Boundaries

- Webcam capture, device permissions, frame analysis, and any narration derived from it.
- Deciding whether webcam observation becomes a third observation role, and any resulting
  `CONCEPTS.md` vocabulary.
- Exposing layout state over the WS protocol or in stored settings.
- Reordering sections, moving a section between columns, or detaching one into a window.
- Any redesign of the narrow-viewport experience beyond keeping R15 true.

---

## Dependencies / Assumptions

- The existing narrow breakpoint in `ui/src/styles.css` stays the responsive strategy; three
  sections extend the current stacked fallback rather than replacing it.
- Rail width is stated as ~24px for scale, not as a pinned value — the real number is
  whatever fits a legible vertical label in the existing type scale.

---

## Outstanding Questions

**Deferred to planning**

- Whether the collapsed rail label reads vertically or as an icon plus tooltip, given the
  HAL type treatment already in `ui/src/styles.css`.
- Whether the three collapse controls also appear in the topbar as a secondary path, or the
  rails are the only restore route.
- How the left column apportions height when only one of its two sections is expanded —
  full height is the obvious answer, but the stored divider position needs a defined
  behavior on restore.

---

## Sources / Research

- `ui/src/App.tsx` — current two-column grid, `--split` state clamped 30–80%, pointer-driven
  divider.
- `ui/src/styles.css` — `.layout` grid template, `.divider`, and the narrow-viewport
  fallback that switches to stacked rows.
- `AGENTS.md` — agent-native parity rule (all meaningful behavior reachable over the WS
  contract in `shared/src/types.ts`), the constraint the browser-local decision carves out of.
- `CONCEPTS.md` — establishes exactly two observation roles today, Watched Session and
  Monitor; the webcam section's eventual relationship to them is undecided.
- `docs/solutions/flexbox-min-height-scroll-trap.md` — the scroll failure this pane structure
  has hit before; nested flex columns in the new left column are the same hazard.
