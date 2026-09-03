---
date: 2026-09-02
topic: parameter-effects
---

# Effects: a World changes its own Parameters over time

## Summary

An **Effect** applies one named operation to one Parameter on an interval it sets
itself. Effects attach to a State, where they run only while that State is current,
or to the World, where they run whatever the machine is doing. The operation comes
from a small vocabulary with a single registration point, so adding one is a change
in one file rather than in every consumer.

---

## Problem Frame

Every Parameter today is written from outside: an agent over the protocol, or the
author moving a control. The machine itself already advances on its own clock — an
exit time and a clip end both fire from the server's timer with nothing watching, and
a State's set is drawn afresh on every loop. What no World can do is change a
*Parameter* with time. So nothing that conditions read, that reports inspect, or that
another region of the graph can respond to is able to express "because time passed".

That distinction is what this feature is for, and it is narrower than "the machine
cannot move on its own". A character alternating between two decks is authorable
today as two States and a pair of exit-time transitions. What that cannot give is a
*value* several unrelated parts of the graph read and respond to.

The case that surfaced it is a character at a DJ booth. `dj_swing` is an Int saying
which deck they are at, and it should drift up and down so the character works the
left and right decks without an agent nudging them. That is one instance of a
general shape — a value that changes on its own, and a graph authored to respond —
and the mechanism is what is being built. `dj_swing` is its first user, not its
scope.

The subsystem already has the two hard parts. It owns a clock, so a value can change
with nothing watching; and it has an invariant about when the machine may be
evaluated, which anything that writes a value has to respect.

---

## Key Decisions

**An operation is named, and named in one place.** The vocabulary is a closed union
— `set`, `add`, `multiply`, `random`, `copy`, `toggle`, `bounce` — registered once,
so validation, the panel, the reports and the runtime all learn a new op from the same
edit. Not an expression language: `shared/src/templates.ts` is the repo's one
language and its design note is specifically about *not* growing expressions, and a
second evaluator would be a second sandbox to be wrong about. The shape leaves an
`expression` op addable later as one more kind, if the named ops ever run out.

**`bounce` is what makes a value drift both ways.** Every other numeric op moves in
one direction, so `add 1` against a declared range pins the value at the top and
leaves it there — the motivating drift would stop after two steps. `bounce` reflects
at the Parameter's declared bounds instead of clamping: 0, 1, 2, 1, 0, 1, 2. It is
the one op whose behaviour depends on a range existing, which is why the range lives
on the Parameter rather than on each Effect.

**Two scopes, because they answer different questions.** A **State Effect** runs
only while its State is current and loaded — it is about being somewhere. A **World
Effect** runs from the moment the World starts until it stops — it is about time
passing. Neither is expressible as the other: a World Effect written as a State
Effect would have to be copied onto every State and would still stop during a
crossing.

**A Parameter declares its own range, and every write is clamped to it.** An Int or
Float gains an optional min and max. The clamp applies wherever the write came from
— an Effect, an agent over the protocol, the panel, and the seeding of defaults at
start — so `dj_swing` declared 0..2 cannot hold 7 no matter who wrote it. A range on
the Parameter rather than on each Effect means two Effects driving one value cannot
disagree about what it may hold. A per-Effect `clamp` op stays available as a later
addition for an Effect that wants a tighter limit than the Parameter's own; nothing
here needs it yet.

**Effects keep firing while the machine is in transit, and are acted on when it
lands.** A crossing evaluates nothing at all — that is the subsystem's load-bearing
invariant — but writing a value is not evaluating one. An Effect that fires during a
bridge or an atomic run records its write and broadcasts it, exactly as a Parameter
set from outside already does, and the machine evaluates once on landing. Time keeps
passing for the World even while the character is mid-move, and no second rule is
introduced.

**The machine evaluates once a tick, not once a write.** This is the safety rule, and
it replaces a cascade depth cap as the primary mechanism. Every Effect due on a tick
applies its write; the machine is then evaluated once. A write that produces the value
the Parameter already holds does not evaluate at all.

A depth cap alone would not have worked. Each tick is a fresh evaluation starting at
depth one, so two States whose Effects drive each other cycle forever without the cap
ever tripping. Evaluating once a tick bounds the machine to one move per tick, which
is a rate a person can see. It also closes two other holes at the same time: an Effect
firing faster than a destination's usability check can no longer supersede an in-flight
transition on every write and starve the move entirely, and an ordered list of Effects
can no longer have its own intermediate value take a transition half way through.

A cap on cascade depth *within* one evaluation is still worth having, because an
arrival can legitimately satisfy the next transition. It is a second-order guard now
rather than the mechanism the design rests on.

**One ticker, shaped so exact timers could replace it.** A single repeating tick
walks every live Effect and fires the ones whose interval has elapsed. The runtime
has exactly one pending wait today, and every timing bug this subsystem has had came
from more than one wait being armed at once; N independent timers would multiply
that surface by the number of Effects. Its lifecycle is therefore stated rather than
assumed: exactly one tick per running runtime, armed by `start`, cleared by `stop`,
and untouched by `supersede`, `setWorld` and a fault — Effects survive a transition,
so the thing that abandons a clip must not abandon the clock. Intervals quantise to
the tick, which is invisible for a drift. Effects stay pure data that the tick reads,
so a per-Effect timer could replace the tick later without the manifest or the ops
moving.

**The manifest version does not move.** Both new fields are additions, not changes of
meaning, and the manifest's own rule is that the version bumps for the latter. The
store rebuilds a loaded World by spreading what it parsed, so a build without Effects
carries them through untouched rather than deleting them. An older build ignores
Effects and plays the World as it would have before — which is the same degradation
an older build already gives for any newer key.

---

## Requirements

**The Effect**

- R1. An Effect names one Parameter, one operation, the operand that operation needs,
  and an interval in milliseconds.
- R2. The operations are `set`, `add`, `multiply`, `random`, `copy`, `toggle` and
  `bounce`, defined in one place that every consumer reads.
- R3. An operation that cannot apply to a Parameter's type is not offerable and is
  ignored if a hand-edited manifest carries it — `toggle` on a Float changes nothing
  rather than coercing it.
- R4. A result the target Parameter cannot hold is discarded rather than coerced, and
  reported: `multiply` by 1.5 on an Int, or an `add` that reaches infinity, leaves the
  value untouched. Silently doing nothing is the failure this rules out.
- R5. `copy` takes its value from another Parameter, and is offerable only between
  Parameters of the same type. `random` draws within the target Parameter's declared
  range and is offerable only on a Parameter that declares one. `bounce` likewise
  requires a declared range — it is defined by the bounds it reflects at.
- R6. An Effect may target a Trigger, raising it. A value that changes on its own and
  a one-shot that fires on its own are the same mechanism.
- R7. An interval that is not a finite positive number is replaced by a default, and
  one below the floor is raised to the floor. Stated as a positive test rather than a
  comparison against the floor, because a comparison written as a negation passes NaN
  straight through.
- R8. A World declares at most a bounded number of Effects. The interval floor limits
  how often one Effect fires and says nothing about how many there are.

**Scope and timing**

- R9. A State's Effects run while the machine is *in* that State. Entering means
  arriving from somewhere else; a State re-drawing its own run at the end of a pass,
  and a re-seat caused by an unrelated edit, are not arrivals and do not restart an
  interval. Without this a State looping a three-second clip would never fire a
  five-second Effect at all.
- R10. No State Effect fires while a crossing is live, whatever the machine still
  names as its State. During a bridge the runtime's `stateId` is the *source* State,
  so reading "current" from it would run the source's Effects throughout the move.
- R11. The World's Effects run from start to stop, except while the World holds a
  fault. A fault leaves the machine resting deliberately; Effects that kept writing
  would re-enter the failing transition on every interval and replace one clear fault
  with a stream of them.
- R12. On one tick, the World's Effects apply first, then the current State's, each in
  the order the author put them. The machine is evaluated once, after every write on
  that tick.
- R13. A write that produces the value the Parameter already holds changes nothing and
  evaluates nothing.
- R14. An Effect fires while a bridge crosses or an atomic run plays; the write is
  recorded and broadcast, and evaluated when the machine next evaluates anything.

**Parameters**

- R15. An Int or Float Parameter carries an optional min and max.
- R16. Every write to that Parameter is clamped to its range, whatever the source —
  including the seeding of declared defaults when a World starts and when its manifest
  is re-seated. Those paths write the value map directly today and would otherwise let
  a Parameter hold an out-of-range value from the moment the World opens.
- R17. Narrowing a range under a running World re-clamps the live value.
- R18. A range that is not usable — a non-finite bound, or a min above its max — is
  treated as no range at all and reported. A World that arrived from another machine
  can carry one, and a min above a max would otherwise pin the Parameter to a single
  value with nothing saying why.
- R19. A Parameter with no declared range behaves exactly as it does today.

**Safety and reporting**

- R20. Exactly one ticker exists per running runtime: armed by start, cleared by stop,
  and left alone by a supersede, a re-seat and a fault.
- R21. A cascade within one evaluation is bounded, and past the bound the machine stops
  and faults naming the State it gave up in. This is a second-order guard; R12 and R13
  are what bound a runaway World.
- R22. A World whose Effects name a Parameter that no longer exists reports it rather
  than failing silently.

**Authoring**

- R23. The panel edits both scopes: a State's Effects on its own panel, the World's
  alongside its Parameters. A Parameter's range is editable wherever the Parameter is.
- R24. A control the author is editing is not overwritten by a value an Effect wrote.
  The Parameters panel binds its number input straight to the live value today, which
  is harmless while writes are rare and destroys an in-progress edit once a Parameter
  ticks.
- R25. Every operation the panel can perform is reachable over the protocol.

---

## Acceptance Examples

- AE1. **Covers R1, R9.** Given a State with the Effect "every 2000ms, add 1 to
  dj_swing" and a clip shorter than that interval, when the machine holds in that State
  for five seconds, then dj_swing has been raised twice — the clip looping in the
  meantime does not restart the interval.
- AE2. **Covers R9.** Given the same State, when the machine leaves it and returns,
  then the first rise comes a full interval after the arrival.
- AE3. **Covers R10.** Given that State and a six-second bridge out of it, when the
  transition is taken, then dj_swing does not rise during the crossing.
- AE4. **Covers R11, R14.** Given a World Effect adding 1 to dj_swing every 2000ms and
  a bridge that runs 6000ms, when the transition is taken, then dj_swing has risen
  three times by the landing, and the machine evaluates once when it lands.
- AE5. **Covers R11.** Given a World holding a fault, when an interval elapses, then
  nothing is written and no second fault is emitted.
- AE6. **Covers R2, R5.** Given dj_swing declared 0..2 and a `bounce` Effect adding 1,
  when it has fired six times, then the values seen are 1, 2, 1, 0, 1, 2 — the
  character works both decks without a second State.
- AE7. **Covers R15, R16.** Given dj_swing declared 0..2 and an `add 1` Effect, when it
  has fired five times, then dj_swing is 2.
- AE8. **Covers R16.** Given dj_swing declared 0..2, when an agent sets it to 7 over the
  protocol, then it holds 2.
- AE9. **Covers R16.** Given a Parameter declared 0..2 whose stored default is 7, when
  the World starts, then it holds 2 rather than 7.
- AE10. **Covers R12.** Given two Effects on one State — set to 0, then add 1 — when
  they fire, then the Parameter holds 1, and it holds 1 even when a transition is
  conditioned on the intermediate 0.
- AE11. **Covers R13.** Given an Effect writing the value a Parameter already holds,
  when it fires, then no transition is evaluated and no broadcast is sent.
- AE12. **Covers R12, R13.** Given two States whose Effects each drive the other's entry
  condition, when they fire, then the machine moves at most once per tick rather than
  looping within one.
- AE13. **Covers R18.** Given a Parameter whose manifest carries min 2 and max 0, when
  the World is opened, then the Parameter behaves as though it declared no range, and
  the World reports it.
- AE14. **Covers R19.** Given a World authored before this change, when it is opened,
  then no Parameter has a range, nothing fires, and it behaves exactly as it did.

---

## Scope Boundaries

- An expression language. The op shape leaves room for one as a named op; nothing
  here needs it.
- A per-Effect clamp. The Parameter's range is the invariant worth having first.
- Effects on transitions ("when this move is taken, set position to 2"). A real
  moment, deliberately not in this pass — the interval-and-scope model is what the
  motivating case needs, and transitions would add a third scope to reason about.
- Effects that read the clock, the vision system, or anything outside the World. A
  World is self-contained and portable; an Effect that read the outside would make it
  not.
- Mute and solo on an Effect. Worth having for authoring, and cheap to add later
  against the same shape.
- Attribution — showing the author *which* Effect last wrote a Parameter. Genuinely
  useful for debugging a World with several Effects on one value, and deliberately not
  in this pass; R22's reporting covers the case that silently does nothing.

---

## Dependencies / Assumptions

- The runtime is the timing authority and owns its own clock, so an Effect fires with
  nothing watching. This is the property that makes the feature possible at all.
- Parameter writes do **not** all funnel through one method today. `setParameter` is
  the protocol path, but the runtime also seeds values directly in `start()` and
  `setWorld()` from `defaultValueOf`, and `consumeTriggers()` lowers a Trigger by
  writing the map. A single clamp point is therefore something this work has to build,
  not something it inherits.
- Each fire broadcasts, so interval and Effect count together set a broadcast rate.
  R7 and R8 bound both halves; whether several Effects firing on one tick should
  coalesce into a single broadcast is an open question below.
- A `random` Effect makes two runs of one World differ. The runtime already injects its
  random source so a test can assert a draw rather than a distribution, and an Effect's
  randomness needs the same seam or its acceptance examples cannot be written.
- The manifest version does not move; both fields are additive and the store's rebuild
  already carries unknown keys through.

---

## Outstanding Questions

**Resolve before planning**

- Whether a State's Effect fires once on entry as well as on its interval. AE2 asserts
  it does not. It decides whether an arrival can begin a cascade at all, and so what
  R21's second-order cap is actually guarding.
- Whether a Trigger raised by an Effect that no transition consumes should be lowered
  again. Nothing lowers a Trigger except a transition consuming it, so an Effect-raised
  Trigger stays armed and behaves as a permanently-true Bool rather than a one-shot.

**Deferred to planning**

- The tick period, the interval floor, the Effect count bound, and the cascade cap's
  number. Constants that want measuring against a real World rather than choosing on
  paper.
- Whether several Effects firing on the same tick produce one broadcast or several.
- Whether removing a Parameter should strip the Effects that write it or only report
  them. Removing a Parameter already strips conditions naming it, so the two halves of
  the system would otherwise answer the same action differently.

---

## Sources

- `shared/src/worlds.ts` — `Parameter`, `ParameterValue`, `PARAMETER_TYPES`,
  `WorldState`, `World`, and the note on when `WORLD_VERSION` moves.
- `server/src/live/runtime.ts` — `setParameter`, `onTrigger`, `take`, `cross`,
  `playThrough` (which calls `enter` once per loop, not once per visit), `start` and
  `setWorld` seeding values directly, `consumeTriggers`, the `crossing` and `holding`
  guards, the single `pending` wait and the generation guard.
- `server/src/storage/worlds.ts` — `rebuild`'s spread, `declareParameter`,
  `entries()` passing `parameters` through with only an object check.
- `shared/src/world-graph.ts` — `valueFits`, and the NaN note on threshold guards.
- `ui/src/components/StateGraph.tsx` — `ParametersPanel`, whose number input binds
  directly to the live value.
- `docs/solutions/a-threshold-guard-written-as-a-negation-fails-open-on-nan.md`.
- `docs/residual-review-findings/feat-live-scene-worlds.md` — "Resting loudly beats
  looping quietly", the rule R11 preserves.
- `CONCEPTS.md`, "Live state machines" — Parameter, Trigger, Bridge, In transit.
- `docs/brainstorms/2026-09-02-clip-sequences-requirements.md` — the previous pass over
  this subsystem, and the atomic-run rule this one has to respect.
