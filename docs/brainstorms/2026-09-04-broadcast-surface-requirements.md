---
date: 2026-09-04
topic: broadcast-surface
---

# The broadcast surface

## Summary

A third route, `/broadcast`, that renders the open World's video and nothing else. No controls but
fullscreen, no text nodes at any time, and no ability to disturb the show: the server treats its
socket as an observer, so it is never elected the audio authority and its clip reports are refused.
Audio stays with `/live`.

---

## Problem Frame

Running a broadcast today means two `/live` windows, one of them fullscreened onto the output. That
works until something goes wrong, and then the audience sees the rig. The operator's words for it:
*"it will show the proprietary setup and programming for how the whole thing works — kind of a
wizard behind the curtain sort of thing we want to keep secret."*

This is a containment problem, not an ergonomics one. The failure is not "the broadcast page is
cluttered"; it is that the failure modes of `/live` are all authored to be *informative*, and every
one of them is informative to the wrong room. Five leaks exist in shipped code:

| Leak | Where | What the audience reads |
|---|---|---|
| `{failed} would not load` | `ui/src/components/ClipPlayer.tsx` | the clip's file path |
| `{live.fault}` | `ui/src/components/ClipPlayer.tsx` | server fault text |
| "Nothing is assigned to play here yet." | `ui/src/components/ClipPlayer.tsx` | that there is an authoring system |
| `<code>{error.message}</code>` | `ui/src/components/ErrorBoundary.tsx` | a runtime error, plus "This is a fault in HAL" |
| `<title>HAL 1000</title>` | `ui/index.html` | the window title, in the taskbar and OBS's source list |

Three of those live inside the very component the broadcast surface wants to reuse. A sixth exposure
is not a text node at all: leaving fullscreen — by Escape, by a crash, by the browser deciding to —
reveals the whole operator interface underneath, because on `/live` that is what is underneath.

---

## Key Decisions

**A route, not a mode.** A `?broadcast` flag on `/live` leaves every operator component mounted and
one missed conditional away from rendering. The failure mode of a missed conditional is exactly the
thing this feature exists to prevent. A separate route means the state graph, the playlist editor,
the settings drawer and the topbar are *not mounted*, so no bug can put them on screen. This is the
one place where the more separate design is also the cheaper one to trust.

**No text nodes, ever.** Not "friendlier text" and not "text only on errors". The surface renders
video elements and nothing else, so there is no string to audit and no future contributor who has to
remember the rule. Diagnostics are not lost — `/live` keeps rendering all five of them unchanged,
and that window is where the operator is looking.

**Held frame, then black.** A clip that fails holds the last painted frame rather than clearing, and
fades to black if nothing recovers within a few seconds. A one-second hiccup then reads as a slow
cut; a real outage reads as deliberate. Black-on-any-fault was considered and is simpler, but it
turns every transient stumble into a visible dead feed.

**The observer role is enforced by the server, not promised by the client.** The whole point of the
feature is not having to trust what the second window does. Both invariants — never take audio
authority, never advance the state machine — are checks in `server/src/live/`, not conditionals in
React.

**Fullscreen by double-click.** The video-player convention, plus Escape to leave. No glyph: a
visible button is chrome on the projector even when it carries no words, and `/live`'s existing `⤢`
is the thing being escaped from. Double-click rather than single because a stray click during a show
must not toggle the output.

---

## Requirements

**The surface**

R1. `/broadcast` renders the video of the World currently open on the server, and nothing else.

R2. The route mounts no operator component: no state graph, no playlist editor, no transport, no
World picker, no settings, no topbar.

R3. The surface renders no text at any time, in any state, including every failure state.

R4. The page background is black, and the video is fitted to the viewport with no surrounding
chrome, so the surface is a valid capture target without being fullscreened.

R5. The document title on this route is neutral — it must not name HAL or the World.

**Failure behaviour**

R6. A clip that fails to load holds the last painted frame rather than clearing it.

R7. If nothing recovers within a few seconds of a held frame, the surface fades to black.

R8. A recovered or subsequently assigned clip plays normally, without a reload.

R9. A render throw inside the surface results in black, not in the error boundary's message. The
surface either uses a boundary that renders nothing, or none at all.

R10. With no World open, or a World with nothing assigned to play, the surface is black.

R11. A dropped or reconnecting socket does not change what is on screen beyond R6–R7.

**The observer role**

R12. A broadcast client declares itself an observer over the WS contract, in `shared/src/types.ts`.

R13. An observer socket is never elected the audio authority. If it holds the grant when it
declares, the grant is released and re-elected to a non-observer.

R14. The server refuses `report-clip-end` and `report-clip-duration` from an observer socket.

R15. An observer's presence does not change `AudioTransport.attendance`, and therefore does not
change whether the World is treated as attended.

R16. Opening or closing a broadcast window does not interrupt playback, sound, or the state machine
on `/live`.

---

## Key Flows

**Ordinary show.** Operator opens `/live`, opens a World, arms a playlist. Opens `/broadcast` in a
second window, double-clicks it onto the output display. `/live` retains the audio grant because the
broadcast socket is never a candidate for it. Both windows show the same clips; only `/live` makes
sound.

**Clip fails mid-show.** The clip 404s. `/broadcast` holds the frame, then fades. `/live` shows
`hal-idle-03.mp4 would not load` in its fault line. The operator fixes it on `/live`; the next clip
plays on both.

**Broadcast opened first.** The broadcast window connects before `/live` exists. It declares itself
an observer, so the election finds no candidate and the grant goes spare. `/live` connects later and
is elected normally — no `take`, no dead transport buttons.

**Broadcast crashes.** A render throw blanks the surface to black. The show continues: the server
owns the state machine, and the broadcast client was never reporting anything to it. Reloading the
window rejoins mid-clip.

---

## Acceptance Examples

- Kill the clip file mid-loop with `/broadcast` fullscreened: the frame holds, then black. No path,
  no message, no HAL wordmark appears at any point.
- Open `/broadcast` before `/live`: `/live`'s transport controls are live on arrival, not read-only.
- Open `/broadcast` alongside `/live` and let a clip run to its end: the state machine advances
  exactly once, not twice.
- Press Escape out of fullscreen on `/broadcast` during a show: what is revealed is a black page with
  the video in it, not an interface.
- Search the route's rendered DOM for any text node: there are none.

---

## Scope Boundaries

**In scope.** The route, the observer declaration and its two server-side refusals, the held-frame
failure behaviour, double-click fullscreen, and a neutral title.

**Deferred for later.** Any broadcast-specific presentation — overlays, lower-thirds, transitions,
letterboxing choices, a holding card with in-world art. A holding card was considered for the
failure state and cut: it is design surface, and every pixel of design surface is a thing that could
one day say something.

**Outside this feature.** Audio on `/broadcast` in any form. Multiple simultaneous broadcast windows
showing different Worlds — `WorldService.openId` is server-global and this feature does not change
that. Any change to what `/live` shows or how it behaves, except that it must keep the audio grant
it would have had anyway.

---

## Dependencies / Assumptions

- `WorldService.openId` is server-global, so the broadcast surface needs no World selection of its
  own. Verified in `server/src/live/service.ts`.
- WS admission is a message (`authenticate`), not a URL query parameter, so the observer declaration
  is naturally a second message rather than a connection-string flag. Verified in `server/src/ws.ts`.
- `AudioService.elect()` grants to `attending[0]` and every admitted socket is attended on
  connection, which is the mechanism R13 has to change. Verified in `server/src/live/audio-service.ts`
  and `server/src/live/service.ts`.
- Verified: `WorldRuntime.reportClipEnd` in `server/src/live/runtime.ts` already discards a duplicate
  report — it checks the full triple against what is playing and clears the pending wait on the first
  accepted one, and its own comment names "two open tabs" as the case it guards. So R14's clip-end
  half is defence in depth, not the only guard.
- Verified, and the opposite: `report-clip-duration` has no such guard. `server/src/live/service.ts`
  applies it unconditionally, and it is a manifest write. Two windows measuring the same clip both
  write it. The writes are convergent — same file, same decoder, same duration — so this is churn
  rather than a correctness bug, but it is two disk writes and two broadcasts per clip. R14's
  duration half is therefore the one doing real work.
- The agent-native parity rule in `AGENTS.md` requires the observer distinction to live in the WS
  contract rather than in a React component. R12 is that rule applied.

---

## Outstanding Questions

- How long is "a few seconds" before a held frame fades (R7)? A value between two and five seconds
  is likely right; it wants to be picked against a real clip, not argued about here.
- Should an observer socket be told anything it currently is not — or told *less*? It presently
  receives every broadcast including World names and fault text. Nothing renders them, so this is not
  a leak today, but a surface that receives less is a surface that can leak less.
- Should `/live` offer a link or button that opens `/broadcast` in a new window, or is typing the URL
  fine? Not needed for the feature to work.

---

## Sources

- `ui/src/components/ClipPlayer.tsx` — the reused player, and three of the five leaks.
- `ui/src/components/ErrorBoundary.tsx` — the fourth leak.
- `ui/src/route.ts` — the two-route parser this extends.
- `server/src/live/audio-service.ts` — `attend`, `elect`, `takeAuthority`, `leave`.
- `server/src/live/transport.ts` — the `attendance` states and the unattended-plays rule (R25).
- `server/src/live/service.ts` — connection-path attendance, `openWorld`.
- `AGENTS.md` — the agent-native parity rule.
