---
date: 2026-09-06
topic: clip-blending
---

# Clips dissolve into each other

## Summary

A World carries one blend length, and every clip boundary in it becomes a dissolve instead of a
cut. Both clips keep moving through the blend, which the machine pays for by ending each clip
early by that length — so the frames the blend consumes are exactly the boundary frames that do
not line up today. A World that sets nothing keeps the hard cuts it has always had.

---

## Problem Frame

Clips are generated outside HAL and arrive as finished files. Two of them meeting at a boundary
were never cut against each other, so the last frame of one and the first frame of the next do
not agree: a small jump in exposure, grain or subject position that reads as static on the
picture. The machine has no way to soften it, because the machine has never had a transition
with a duration — `docs/brainstorms/2026-09-01-live-scene-worlds-requirements.md` and
`docs/brainstorms/2026-09-02-live-state-machine-requirements.md` both list hard cuts as
something the feature deliberately is, not something it lacks.

A second fault shares the same boundary and has a different cause. `server/src/live/runtime.ts`
does not evaluate what plays next until the current clip has ended, so the browser's second
`<video>` element only begins loading at that instant. The load and decode take however long
they take, and nothing is scheduled to cover them. On a slow read the picture goes black for a
few frames before the next clip appears. A dissolve laid over this would fade to black and back,
which reads worse than the cut.

The most repeated boundary in any World is the one nobody thinks of as a transition: a State
looping a single clip, cutting from that file's last frame to its own first frame, every few
seconds, for as long as the World is open. Whatever the boundary costs is paid there most often.

---

## Key Decisions

**The machine ends every clip early by the blend length.** A dissolve where one clip is frozen
needs no server change, and is not a crossfade — it is a cut with a frozen frame in front of it.
For both clips to move, the incoming one must start before the outgoing one finishes, and the
client cannot do that alone: starting a clip early off the outgoing element's own clock leaves it
already running when the server's timer arms for its full duration, so the client runs a further
blend length ahead at every boundary and the drift compounds. Shortening the machine's wait
instead keeps the two in lockstep permanently. The price is that clip-end evaluates early, so a
Parameter or Trigger landing inside the blend acts on a clip already fading up. That is what a
crossfade is in every editor ever built: the transition consumes handle frames from both sides.

**The blend length lives on the World, not in settings.** `server/src/live/runtime.ts` and
`server/src/live/service.ts` reference `Settings` nowhere — the live subsystem's only input is the
World manifest. A global setting would invent a dependency the architecture has kept out. It would
also be wrong on its own terms: a World is a portable folder that travels with its own clips, and
blend length is a property of that footage's cut style. Copy a World to another machine and a
global number does not go with it.

**Absent means zero means today.** The field is optional and unset reads as a hard cut, following
`atomic` on `WorldState`. Every World written before this plays exactly as it did, and no manifest
version moves.

**Every boundary blends, with no exception for a transition authored as an instant cut.** A World
that dissolves in some places and cuts in others has two grammars and no way for a viewer to tell
which applies. The cost is that "a transition is instant because the clips are" stops being true,
so the two briefs and `AGENTS.md` that say so are corrected rather than the mechanism growing an
exception.

**The blend is also the load budget.** Because the machine evaluates a blend length before the
clip truly ends, the client receives the next clip with that much time still on the current one —
which is exactly the window the load and decode needed and never had. No second message, no
speculative preloading, no mispredict path. A load that overruns the window degrades to what
happens now: the outgoing clip ends, holds its last frame, and the incoming one appears when it
is ready.

**A blend is a hold.** The engine owns exactly two video elements and a blend occupies both, so a
transition firing mid-blend would need a third. Rather than let that be an accident, the machine
evaluates nothing while a blend is in flight — the rule a crossing already carries, extended to
every boundary for a mechanical reason instead of an aesthetic one. A bridge's landing blend is
then one instance of the general rule, not a special case, and the crossing is over when the blend
ends rather than when it starts. This adds no pause the machine did not already have: evaluation
happens once per clip either way.

**Playback never breaks on a clip too short to carry the blend.** The blend is clamped per
boundary to half the shorter clip, and the clips that could not carry the World's number are
named in the graph reports beside `longBridges`. A silent clamp alone would leave the manifest's
number no longer describing what is on screen with nothing anywhere saying so.

---

## Requirements

**The blend itself**

R1. A World carries an optional blend length in milliseconds. Absent, or zero, means every
boundary is the hard cut it is today.

R2. The range offered to an author is 0–1000ms. Nothing in the system knows a clip's frame rate,
and the value must be known server-side where no video element exists to ask, so the unit is
milliseconds rather than frames.

R3. During a blend both clips play. One element holds full opacity for the whole blend while the
other moves across it; the two are never faded simultaneously, which over the stage's black
would produce a dark pulse at the midpoint.

R4. The blend applies at every clip boundary: between members of a sequence, when a State redraws
and loops, between members of a bridge, when a transition enters a bridge, when a bridge lands,
and when a transition holding no clips fires.

R5. A State looping a single clip blends that clip into itself, offset by the blend length.

**What the machine does**

R6. The runtime's final wait on each clip is shortened by the effective blend length, so a client
receives the next clip while the current one is still playing.

R7. Clip-end evaluation happens at the shortened point. A Parameter set or Trigger fired inside
the blend window acts on the incoming clip, not the outgoing one.

R8. The effective blend at a boundary is the World's blend length or half the shorter of the two
clips, whichever is less.

R9. The graph reports name the clips too short to carry the World's blend length, alongside the
existing dead-end, unreachable-State and long-bridge reports.

R10. Blending changes nothing about how a clip's duration is measured or corrected. The client
reports the raw duration it observed and the machine applies the blend on top.

R15. While a blend is in flight the machine evaluates nothing — no wake point, no Parameter, not
Any State. A value set during a blend is recorded and acted on once it ends.

R16. A bridge's crossing ends when its landing blend ends, not when the landing is emitted. The
machine is in transit for the whole blend.

R17. An exit-time wake point falling inside the blend window does not fire at its own time. The
boundary evaluation offers that transition instead, so a transition whose exit time falls inside
the window is taken at the boundary rather than skipped.

**What must keep working**

R11. Both surfaces blend identically. The behaviour lives in the shared clip engine, not in
either surface's own code.

R12. During a blend more than one element is on screen, so a single visible-element index no
longer identifies which one. The overlay layer's measurement target and the broadcast surface's
fade-to-black must each name which element they mean rather than inheriting the old assumption.

R13. Clips stay muted. Muting is what allows them to autoplay at all, and playing two at once
must not change it.

R14. A load that outlasts the blend window falls back to current behaviour — the outgoing clip
holds its last frame until the incoming one is ready. The blend degrades, never faults.

---

## Acceptance Examples

AE1. **Covers R1, R4.** A World with no blend length set plays every boundary as a hard cut, and
its manifest is byte-identical to what it was before this shipped.

AE2. **Covers R6, R7.** A World with a 250ms blend and a 4000ms clip: the machine's wait for that
clip is 3750ms. A Trigger fired at 3900ms into the clip is evaluated against the clip that is
fading up, not the one fading out.

AE3. **Covers R8.** A boundary between a 300ms clip and a 4000ms clip in a World set to 250ms
blends at 150ms. The same World's boundary between two 4000ms clips blends at 250ms.

AE4. **Covers R9.** A World set to 250ms containing a 300ms clip reports that clip as unable to
carry the blend, naming the clip and its duration.

AE5. **Covers R3.** Sampled at the midpoint of a blend between two clips of equal brightness, the
picture is not darker than either clip alone.

AE6. **Covers R5.** A State holding one 3000ms clip and set to a 250ms blend shows two decoding
elements playing the same file at different positions across the loop seam.

AE7. **Covers R14.** A clip whose bytes take longer than the blend length to decode ends the
outgoing clip on a held frame and swaps when ready, with no black frame and no fault.

AE8. **Covers R15.** A Trigger fired during a blend does not transition until the blend ends. No
moment exists at which a third clip would need an element.

AE9. **Covers R17.** A World set to a 250ms blend, with a 4000ms clip and a transition whose exit
time is 0.99, does not fire at 3960ms. It is offered at the 3750ms boundary and taken there. It is
never skipped: a transition that fired before this shipped still fires after it.

---

## Scope Boundaries

**Deferred for later**

- Per-transition and per-State blend lengths. The resolution seam is a transition's own value
  falling back to the World's, and the World's field is shaped so it can be added without moving
  anything.
- Blend curves. The blend is linear; ease-in-out and the other shapes an editor offers are a
  later authoring surface, not a mechanism change.
- Blends other than a dissolve — wipes, dips to black or white, additive blends.
- A fade in when a World opens and a fade out when it closes. Adjacent and cheap, but a boundary
  between a clip and nothing is a different case from a boundary between two clips.

**Outside this feature's identity**

- No audio crossfade. Clips are muted by construction and the soundtrack is a separate transport
  with its own authority. Nothing about this reaches it.
- No re-encoding, inspection or generation of clips. HAL still consumes finished files, and a clip
  that blends badly is replaced upstream.
- Not a compositor. Two elements and an opacity are the whole mechanism; there is no filter graph,
  no shader and no frame buffer.

---

## Dependencies and Assumptions

- Two `<video>` elements playing simultaneously for the blend's duration cost more decode than one
  playing and one paused. On a machine also running vision, the recogniser and inference this is
  assumed acceptable at the blend lengths offered, and is unverified.
- The browser is assumed to keep both elements decoding while one is at zero opacity, which is what
  the current stacked-element swap already depends on.
- The claim that a hard cut currently produces a black flash is the operator's observation and has
  not been reproduced under instrumentation. The mechanism proposed closes the window that would
  cause it; if the flash survives a non-zero blend length, its cause is elsewhere and is a separate
  investigation.
- `AGENTS.md`, `CONCEPTS.md` and the two prior briefs describe hard cuts as a property of the
  machine. `CONCEPTS.md` is the flattest: its Transition entry ends "There is never a blend."
  Shipping this makes those statements false, and they are corrected as part of the work — the
  vocabulary is not updated ahead of the mechanism.

---

## Outstanding Questions

**Deferred to planning**

- Where the blend hold is expressed. A crossing and a plays-whole run already suppress evaluation
  through one mechanism; whether a blend reuses it or needs its own is a planning question, not a
  behavioural one.

- Whether the effective blend is computed once per boundary in the runtime and sent, or derived
  independently on both sides from values each already holds.
- How a blend interacts with the broadcast surface's existing fade to black on a fault, which is
  its own opacity transition on an ancestor of the elements being blended.
- Whether the clamp reads the manifest's recorded duration or the effective duration the machine
  actually waits on.
- Whether a clip at or below twice the blend length should blend at all. Clamping keeps it on
  screen, but such a clip fades up and immediately back down without ever being seen alone, so
  the report may not be the whole answer.

---

## Sources

- `ui/src/components/useClipStage.ts` — the shared clip engine: two elements, one visible, swapped
  on `canplay`. The per-element `loaded` record and the `held` same-source guard are what a blend
  has to keep working.
- `server/src/live/runtime.ts` — `playThrough` and its final wait, which is the line the blend
  shortens; `wakePoints` and `onTrigger`, which is where early evaluation lands.
- `ui/src/styles.css` — the existing opacity swap on both surfaces, and the comments recording why
  it is opacity rather than display.
- `shared/src/worlds.ts` — `WorldState.atomic` as the precedent for an optional field whose absence
  reproduces the old behaviour, and `effectiveDuration` as the one answer to how long a clip is
  waited on.
- `docs/brainstorms/2026-09-01-live-scene-worlds-requirements.md` and
  `docs/brainstorms/2026-09-02-live-state-machine-requirements.md` — the two briefs that name hard
  cuts as an identity boundary this reverses.
- `docs/residual-review-findings/fix-bridge-plays-whole.md` — the most recent work on clips being
  cut short by the machine's own budgeting, and the reasoning this brief's clamp follows.
