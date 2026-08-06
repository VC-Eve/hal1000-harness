---
date: 2026-08-05
topic: session-observation-lens-and-adapter-theming
---

# Session observation: composing lens and adapter theming

## Summary

Put a pulsing red lens at the tail of the session-observation feed that animates while HAL composes
an observation and yields its place to the finished text. Make adapters a first-class thing in
settings — switchable on and off, each with its own text colour drawn from a HAL-safe palette. Give
the chat pane separate colours for the user's messages and HAL's replies.

## Problem Frame

Narration arrives atomically. HAL watches, thinks for several seconds on a local model, and an
observation appears fully formed. During that wait the feed is inert — nothing distinguishes "HAL is
composing" from "the session is quiet" or "narration is paused." The one status signal is a small
text badge in the pane header, far from where the text lands and easy to miss.

Separately, the Claude Code watcher is the only way HAL observes anything, and it is wired in as if
it were the product rather than one source among several. There is no way to stop it short of
detaching a session, and nothing in the feed says where an observation came from — a question that
only has one answer today and will have several soon.

## Key Decisions

**Colour marks provenance, not recency.** An adapter's colour applies to observations about that
adapter's sessions. HAL's gap notices and status reports keep HAL's own red, because they are HAL
talking about himself rather than about anything he is watching. This keeps a colour meaning "this
came from there" instead of "this arrived while that was attached."

**Off means stopped, not hidden.** Disabling an adapter detaches its session and ends its polling.
The alternative — keep watching, hide the output — would spend inference on text nobody sees.

**Attribution is assigned when an entry is created.** Colouring by whatever is currently attached
would recolour history the moment the user switches adapters, and would get it wrong again after a
reload replays the feed backlog.

**Palette first, custom second.** The pane background is near-black and HAL's look is a narrow red
identity. A curated set of hues makes the common path unmissable; a custom picker stays available for
the case the palette doesn't cover.

**The registry ships now; the second adapter does not.** The watcher seam already anticipates other
log sources. Building the toggle and colour surface against a one-entry registry is cheap and stops
the Claude Code adapter from calcifying into the product.

## Requirements

**Composing lens**

R1. While HAL is composing an observation, a lens renders at the tail of the feed and animates until
the observation lands.

R2. When the observation is ready, its text takes the lens's position in the feed.

R3. The lens is absent when HAL is not composing, including when narration is paused or the provider
is unreachable — a paused narrator must not look busy.

R4. Composing and working through a backlog are visually distinguishable.

R5. When the feed is scrolled away from the bottom, the pane header carries the composing signal,
because the lens is off-screen exactly when the user has stopped watching it.

R6. The lens reuses the existing HAL eye's visual language so the app reads as one object with one
temperament.

**Adapters**

R7. Settings lists every registered adapter with an on/off control; Claude Code is the only entry at
launch.

R8. Disabling an adapter detaches any session it is watching and stops its discovery and tailing.

R9. Disabling an adapter leaves the observations it already contributed in the feed.

R10. Re-enabling an adapter does not resume watching automatically; the user chooses a session.

R11. When no adapter is enabled, the session-observation pane says so in HAL's voice, and readiness
stops reporting that adapter's missing prerequisites as a fault.

R12. Adapter state is reachable through the client-server protocol, not the UI alone — an agent can
enumerate adapters and toggle them.

**Colour**

R13. Each adapter carries a text colour that applies to observations attributed to it.

R14. Every observation records which adapter produced it at the moment it is created.

R15. Gap and status entries render in HAL's own colour regardless of which adapter is attached.

R16. Colours are chosen from a curated palette tuned for the dark background, with a custom option
alongside it.

R17. A custom colour is held to a readability floor against the pane background.

R18. The chat pane has independently settable colours for the user's messages and HAL's replies.

R19. Colour choices persist with the rest of settings and apply to every connected client.

## Key Flows

F1. **Composing an observation.** **Trigger:** the watcher emits events and the narrator begins
inference. The lens appears at the feed tail and animates. Inference completes; the observation
renders in its adapter's colour where the lens sat. The lens goes absent until the next batch.

F2. **Disabling the only adapter.** **Trigger:** the user switches Claude Code off in settings. Its
watched session detaches and its polling stops. Existing observations stay in the feed. The pane
reports that nothing is being observed, and readiness no longer flags the absent log directory.

## Acceptance Examples

AE1. **Covers R5.** The user scrolls up mid-session. HAL begins composing. The tail lens is
off-screen; the header shows the composing state until the observation lands.

AE2. **Covers R3.** No narration model is selected and narration is paused. The watcher emits
events. No lens appears.

AE3. **Covers R14.** The user watches a Claude Code session, later switches to a different adapter,
then reloads the page. Each observation still renders in the colour of the adapter that produced it.

AE4. **Covers R17.** The user picks a near-black custom colour. The applied colour clears the
readability floor rather than rendering as invisible text.

AE5. **Covers R8, R9.** The user disables Claude Code while it is watching a live session. Narration
stops immediately and the log is no longer polled; the observations already in the feed remain
readable.

## Scope Boundaries

- A second adapter. This ships the registry, the toggle, and the colour seam — a Codex or generic
  log watcher remains separate work.
- Streaming narration text token by token. The lens signals that an observation is being composed;
  partial text would replace that signal rather than complement it.
- General theming: light mode, background and surface colours, font choices, per-entry colour
  overrides.

## Dependencies / Assumptions

- Narration completes atomically, so the lens keys off the narrator's reported status rather than a
  token stream. If narration is ever streamed, R1 and R2 need revisiting.
- The narration status the server already broadcasts is sufficient to drive the lens without new
  signalling.
- Settings already propagate to every connected client, so colour and toggle state need no separate
  distribution mechanism.

## Outstanding Questions

**Deferred to planning**

- Whether a dormant lens should sit at the feed tail when HAL is idle, as an anchor, or whether the
  tail should be empty. A taste call best made against a running build.
- Whether adapter colour extends beyond feed text to the session picker and session badges.
- Whether the backlog animation in R4 differs by intensity alone or by a distinct motion.

## Sources / Research

- `ui/src/components/HalEye.tsx`, `ui/src/styles.css` — the existing eye and its idle, active, and
  flicker animations; the visual language R6 reuses.
- `ui/src/components/NarrationPane.tsx` — the feed, its scroll-lock and jump-to-latest behaviour that
  R5 depends on, and the header badges.
- `ui/src/components/SettingsPanel.tsx` — the settings surface the adapter and colour controls join.
- `shared/src/types.ts` — the wire contract; narration status, narration entries, and settings all
  cross it, and R12 and R14 extend it.
- `server/src/watchers/watcher.ts` — the log-watcher seam the adapter registry formalises.
- `AGENTS.md` — agent-native parity rule behind R12; the deferred-roadmap note that keeps the second
  adapter out of scope.
