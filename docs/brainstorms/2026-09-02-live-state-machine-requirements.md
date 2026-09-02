---
date: 2026-09-02
topic: live-state-machine
supersedes: docs/brainstorms/2026-09-01-live-scene-worlds-requirements.md
---

# Live: a state machine, not a floorplan

## Summary

Rebuild `/live` as a Unity-style animation state machine and nothing else. A State is a
named node holding one looping clip; a transition is instant and carries AND-ed conditions
plus Has Exit Time; parameters are Bool, Int, Float and Trigger with comparisons. Cameras,
Scenes, Positions and cone coverage are removed. Clips are found by browsing the drive and
copied into the World on pick.

---

## Problem Frame

The shipped `/live` derives States from camera geometry: place a camera, and every Position
its cone reaches becomes a State. The floorplan exists to make that derivation authorable,
and the state machine was crammed into its side panel — a states list, a transition builder,
a condition editor. The surface the author works in is not the surface the work is about.

The geometry earned its place on one claim: it told you a Position needed a clip from each
camera *before* you generated it. That is a real service, and it is the only one. Everything
else the model carried — Scene, Position, Cut, Travel, Pose, struck pairings, screen
direction — exists to support the derivation rather than to describe what the author is
building, which is a machine that decides which video plays next.

The vocabulary is where the cost shows. `CONCEPTS.md` holds nine entries for this
subsystem; six of them (Scene, Position, Coverage, and the three edge kinds) describe the
camera model rather than the machine. An author has to learn all six before authoring
anything, and none of them appear in the mental model they arrived with.

---

## Key Decisions

**Clips live on States, never on transitions.** This is the rule that collapses everything
else. A walk from the couch to the booth is not a transition; it is a `Walk` State whose
clip is the walk, with a transition out of it on exit time. Unity works this way, and it
means "chained animations" is a chain of States rather than a second clip-carrying concept.
The two-clip Cut disappears: an angle change is two States and a transition between them.

**A State is a name and a clip.** Scene and Position dissolve into it. Nothing derives
States any more — the author creates them. This is the trade the whole brief turns on: the
model gets smaller and the surface gets honest, and in exchange nothing predicts a missing
clip before it is needed.

**Parameters are typed now, not later.** Bool, Int, Float and Trigger, with comparison
operators on conditions. Adding a type to a field a World already persists changes what that
field means, and that is the one manifest change a spread-rebuild cannot make safe for a
build that predates it. The cost of doing it up front is an operator control; the cost of
retrofitting is a migration.

**Screen direction goes.** The reversed-Cut check compared the frame edges of a Cut and its
return. A Cut was defined as a Scene change, and Scenes no longer exist. Frame-edge
continuity is still a real property of cut video, so this is a deferral rather than a
rejection — see Scope Boundaries.

**Existing Worlds are re-authored, not migrated.** Scene, Position, Camera and the three
edge kinds leave the manifest. One hand-seeded test World exists and the tool has one user,
so a migration path would cost more than re-authoring. This is a one-way door once a real
World exists.

**Clips are copied into the World on pick.** Browsing reaches anywhere on the drive;
the file that lands in the manifest is a copy inside the World's own `clips/`. A World stays
a folder that can be zipped and moved, and the video route goes on refusing every path
outside it.

---

## Vocabulary

The subsystem keeps four terms. Six are removed.

| Term | Meaning |
|---|---|
| **World** | One project: a folder holding a manifest and a `clips/` directory. Unchanged. |
| **State** | A named node holding one looping clip. The unit the character is in. |
| **Transition** | A way out of a State: conditions, and when it is allowed to fire. |
| **Parameter** | A typed named value that conditions read, and the only thing set from outside. |

Removed: **Scene**, **Position**, **Camera**, **Coverage**, and the **Pose** / **Travel** /
**Cut** edge kinds. A transition has no kind — it is a transition.

---

## Requirements

### States and the graph

- R1. A State has a name and at most one clip, which loops while the State holds.
- R2. A State with no clip is legal, holds silently, and is reported as incomplete.
- R3. Exactly one State is the World's default, and the runtime starts there.
- R4. **Any State** is a source-only node: a transition drawn from it is offered from every
  State. It cannot be a destination and cannot be the default.
- R5. A State's position on the canvas is authored by dragging and persisted with the World.
- R6. The graph draws a node per State, an arrow per transition, and marks the State the
  runtime is currently in.

### Transitions

- R7. A transition connects two States and carries a list of conditions that all must hold.
- R8. A transition has a **Has Exit Time** flag. When set, it is offered only once the
  current clip reaches its **Exit Time**, given as a fraction of the clip.
- R9. When a transition has both an exit time and conditions, the conditions are checked
  only after the exit time is reached.
- R10. A transition with no conditions and no exit time is offered whenever the machine
  evaluates.
- R11. Transitions out of a State have an author-visible order, and the first satisfied one
  is taken.
- R12. Transitions from Any State are evaluated before transitions out of the current State.
- R13. A transition can be **muted**, which disables it, or **soloed**, which disables every
  other transition out of that State. Both are authoring aids and both persist.

### Parameters and conditions

- R14. A Parameter has a name and one of four types: Bool, Int, Float, Trigger.
- R15. A Parameter has a default value, and the runtime starts every Parameter there.
- R16. A condition names a Parameter, an operator, and a value. Available operators follow
  the type: `is` / `is not` for Bool, and `>`, `<`, `==`, `!=` for Int and Float.
- R17. A Trigger condition names only the Parameter. The Trigger resets to false as soon as
  a transition consumes it.
- R18. Setting a Parameter is reachable over the WS protocol, with the graph as one caller
  among others.

### The runtime

- R19. The runtime evaluates transitions when a Parameter changes and when the current clip
  reaches an exit time or ends.
- R20. The runtime takes one transition per evaluation and never chains.
- R21. The runtime owns the clock: a World advances with no browser attached.
- R22. A State whose clip cannot be resolved faults and says so, rather than leaving the
  previous clip playing.

### Finding and assigning clips

- R23. Assigning a clip to a State is done by browsing, not by typing a path.
- R24. The browser lists video files under a folder the user chooses, and can be searched by
  filename.
- R25. Picking a clip copies the file into the World's `clips/` directory and references it
  relatively.
- R26. A clip already inside the World is picked without a second copy.
- R27. The browser shows each clip's duration, so a State's timing is visible before it is
  assigned.

### What the graph reports

- R28. A State with no clip is marked on its node.
- R29. A State with no satisfiable transition out, for some allowed Parameter value, is
  marked on its node.
- R30. A State unreachable from the default State, by any path, is marked on its node.
- R31. A clip named by the manifest that cannot be used is reported with the reason.

---

## Key Flows

- F1. Author a loop
  - **Trigger:** A new World and a folder of generated clips somewhere on the drive.
  - **Steps:** Create a State, browse to its idle clip, pick it — the file is copied in.
    Create a second State and a third the same way. Draw a transition from the first to the
    second, set Has Exit Time so it fires when the clip finishes, and repeat around to the
    first. Set the first State as default.
  - **Outcome:** The three clips play in a cycle with nothing driving them.
  - **Covered by:** R1, R3, R7, R8, R11, R23, R25

- F2. Steer it with a Parameter
  - **Trigger:** The loop from F1 is running.
  - **Steps:** Declare `location` as a Bool, or `energy` as a Float. Add a condition to one
    transition. Change the value from the parameters panel and watch the highlighted node
    move.
  - **Outcome:** The machine takes a different path because a value changed, not because
    anything was told where to go.
  - **Covered by:** R14, R16, R18, R19, R20

- F3. A one-shot action from anywhere
  - **Trigger:** A `wave` clip exists and the character should perform it on demand from any
    State.
  - **Steps:** Declare `wave` as a Trigger. Draw one transition from Any State to the wave
    State, conditioned on `wave`. Draw a transition back out on exit time.
  - **Outcome:** Firing `wave` plays it once from wherever the character is, and the Trigger
    clears itself.
  - **Covered by:** R4, R12, R17

---

## Acceptance Examples

- AE1. Exit Time fires mid-clip
  - **Covers R8, R9.**
  - **Given** a State whose clip runs four seconds, and a transition out of it with Has Exit
    Time set to 0.75 and no conditions,
  - **When** the clip has played three seconds,
  - **Then** the transition is taken, rather than at the clip's end.

- AE2. Conditions wait for the exit time
  - **Covers R9.**
  - **Given** the same transition, with a condition that is already true,
  - **When** the clip is one second in,
  - **Then** nothing happens until three seconds, and the condition is checked then.

- AE3. A Trigger is consumed once
  - **Covers R17.**
  - **Given** a Trigger `wave` and one transition conditioned on it,
  - **When** `wave` is set and the transition is taken,
  - **Then** `wave` reads false afterwards, and the transition is not taken a second time
    without setting it again.

- AE4. Any State loses to nothing
  - **Covers R12.**
  - **Given** a transition from Any State and a transition out of the current State, both
    satisfied on the same evaluation,
  - **When** the machine evaluates,
  - **Then** the Any State transition is taken.

- AE5. Solo isolates one transition
  - **Covers R13.**
  - **Given** a State with three transitions out, one of them soloed,
  - **When** the machine evaluates that State,
  - **Then** only the soloed transition is considered, and the other two are ignored until
    the solo is cleared.

- AE6. Picking a clip copies it in
  - **Covers R25.**
  - **Given** a video file outside the World's folder,
  - **When** it is picked for a State,
  - **Then** a copy exists in the World's `clips/`, the manifest names it relatively, and
    zipping the World folder carries the clip with it.

- AE7. An unreachable State is visible
  - **Covers R30.**
  - **Given** a State with transitions out but none in, and which is not the default,
  - **When** the graph draws,
  - **Then** that State is marked unreachable — the machine can never arrive there.

---

## Scope Boundaries

### Deferred for later

- **Frame-edge continuity.** Recording which edge of frame a clip leaves and enters through,
  and warning when a pair reads as the character turning around. A real property of cut
  video; it returns as a State property rather than a Cut property when it does.
- **Sub-state machines.** Grouping nodes into a collapsible child machine. Worth having once
  a World outgrows one canvas; nothing before that.
- **Layers.** More than one machine running at once over one character.
- **Interruption sources.** Unity's rules for which transitions may interrupt an in-flight
  one. The runtime already supersedes on a Parameter change; the fine-grained policy is not
  needed until it misbehaves.
- **HAL driving Parameters** from narration, vision or monitors. Unchanged from the original
  brief: the engine ships before HAL touches it.

### Outside this feature's identity

- **Not a 3D engine, and now not a floorplan either.** Nothing spatial is modelled. Where a
  camera stood is a fact about the footage, not about the machine.
- **Hard cuts.** No transition duration, no blending, no crossfade. A transition is instant
  because the clips are.
- **No clip generation.** Clips arrive as finished files, as before.
- **Worlds are never shared or merged.**

---

## Dependencies and Assumptions

- Clips are produced outside HAL and are visually consistent with each other. Unchanged.
- Copying a picked clip gives HAL a capability it does not have today: reading a file from
  an arbitrary path the user names and writing it into its own data directory. Every path
  the app touches now is one it owns.
- The existing runtime, clip route, WS service and store survive in shape. What changes is
  the manifest they carry, not the fact that the server owns the clock or that the route
  refuses paths outside a World.
- Exit Time as a fraction requires the runtime to fire partway through a clip, which its
  current timer does only at the end.

---

## Outstanding Questions

### Resolve before planning

- None.

### Deferred to planning

- Whether the clip browser reads a folder the user picks each time, or a remembered library
  root stored in settings.
- How a State's clip duration is learned now that the browser shows it — the existing path
  measures it in the player at first play.
- Whether Any State transitions are stored on a pseudo-State or as a flag on the transition.
- What the graph does with a World holding more nodes than fit on one canvas, before
  sub-state machines exist.

---

## Sources and Research

- Supersedes `docs/brainstorms/2026-09-01-live-scene-worlds-requirements.md`; the shipped
  implementation is `docs/plans/2026-09-01-001-feat-live-scene-worlds-plan.md` on branch
  `feat/live-scene-worlds`.
- `docs/residual-review-findings/feat-live-scene-worlds.md` — ten accepted residuals for the
  shipped version. Most survive this change; the coverage-related ones do not.
- Unity Manual, [Transition settings](https://docs.unity3d.com/2020.3/Documentation/Manual/class-Transition.html)
  — Has Exit Time, Exit Time as normalized time, conditions AND-ed and checked after exit
  time, one transition active at a time.
- Unity Manual, [Animation Parameters](https://docs.unity3d.com/2020.3/Documentation/Manual/AnimationParameters.html)
  — the four types, and that a Trigger is "reset by the controller when consumed by a
  transition".
- Unity Manual, [Animation States](https://docs.unity3d.com/Manual/class-State.html) — the
  Motion on a state, the default state, and Solo / Mute on transitions.
- `CONCEPTS.md` — the nine entries for this subsystem; six are removed by this brief.
- `AGENTS.md` — the storage cache-rebuild rule that makes typed Parameters cheaper now than
  later, and the origin/token rules the clip route rests on.
