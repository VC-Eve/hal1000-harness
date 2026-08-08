# Residual findings — the vision timeline and recognition weight

Accepted knowingly, 2026-08-08. Covers the work in
`docs/plans/2026-08-08-002-feat-vision-timeline-and-weight-plan.md`, units U1 to U6. Builds on
`feat-recognition-identity-and-profiles.md`, whose deferred chat seam this feature is the substrate
for and does not itself discharge.

## Weight decides nothing, and only a test keeps it that way

**What.** Recognition weight is recorded and shown and reads on nothing. Four call sites take the
per-frame band — identity rendering, the output check, profile delivery, and the uncertain-match
queue — and each is a plausible place to substitute weight while wiring something adjacent.

**Why it shipped anyway.** The whole point of this slice is to collect the counterfactual before
acting on it. `weightedBand` on every check records what weight *would* have chosen against the
thresholds in force at the time, so promoting weight later is a measurement rather than a hunch.

**What narrows it.** `server/test/vision/timeline-events.test.ts` carries a test named "changes
nothing HAL says": a person accumulating weight past 0.5 whose current frame reads 0.55 is still
hedged, and the narration broadcast is unmoved. The module header of `server/src/vision/weight.ts`
names the four call sites explicitly.

**What would discharge it.** Reading the counterfactual against real sessions and deciding — promote
weight into banding, or delete the feature. Both are successful outcomes of the measurement.

## The growth and decay rates are guesses

**What.** `weightGain` 0.35 and `weightHalfLifeSeconds` 120 were not measured against anything. They
produce a weight that crosses 0.5 in four or five confident sightings and falls to nothing over
roughly twenty minutes of absence, which is a plausible shape and no more than that.

**Why it shipped anyway.** Both identity thresholds needed correcting against real readings, and
there was no reason to expect these to be different. They are settings for exactly that reason, and
nothing is decided by them.

**What would discharge it.** A session's worth of recorded weights read back against what a person
watching the room would have said. Until then the numbers are defaults, not findings.

## What the first real session showed

**Added 2026-08-08, after the feature ran against a live camera.** Two of the residuals below moved,
and one defect surfaced that no test had.

**The record was carrying the wrong confidence entirely.** Every check reported the reading the
appearance opened on, because it read the tracker's frozen identity decision rather than the frame's
own. Fifteen consecutive "Creator 61%" while the user moved around. Fixed, with the mechanism
recorded in `docs/solutions/a-value-frozen-for-one-caller-is-stale-for-the-next.md`. Everything the
residuals below say about weight was measured AFTER that fix; anything observed before it described
a constant.

**"Not verified against a real camera" is discharged.** A 150-second run produced readings from 51.1%
to 68.4%, dropping to unrecognised on turns away and to nobody when the room emptied. Weight rose
across the visit and held through short gaps rather than collapsing on a single bad frame.

**The counterfactual is not showing nothing.** The risk the plan recorded was that per-frame and
weighted banding would never disagree, making weight redundant. They disagreed on nearly every
hedged frame: the operator's face sits close enough to the statement threshold that per-frame banding
flickers, while weight stayed confident it was them. That is the first real argument for promoting
weight — and it is only half an argument. The case that would decide it is whether weight also says
"stated" about a stranger, which needs a second person in front of the camera and has not been run.

## The counterfactual reuses the identity thresholds

**What.** `weightedBand` bands the weight against `confidenceThreshold` and `statementThreshold` —
the same two numbers that band a per-frame confidence. A weight and a cosine similarity are not the
same quantity, and there is no reason a boundary calibrated for one is right for the other.

**Why it shipped anyway.** A second pair of thresholds is two more settings nobody can set well, for
a value nobody has read yet. Reusing the pair makes the disagreement between `band` and
`weightedBand` legible immediately, which is what the record is for.

**What would discharge it.** Real readings. If the counterfactual disagrees constantly or never, the
thresholds are the first thing to suspect before the mechanism.

## Only matched people carry weight in a check

**What.** A check records weight for the faces it matched. Someone known to the gallery but absent
from the frame has a weight that is decaying, and the record does not say so — it is implicit in the
elapsed time since their last event.

**Why it shipped anyway.** Recording every known person on every check writes the roster to disk
every few seconds, and decay is a pure function of elapsed time, so the value is recoverable exactly
rather than approximately. Nothing is lost; it is derived rather than stored.

**What would discharge it.** A reader that needs "everyone's weight right now" cheaply — a roll-up,
or the chat seam injecting presence. `lastSeen` plus `decayWeight` answers it today at the cost of a
tail read per person.

## The pane's collapse hides a shape the record keeps

**What.** Consecutive checks that found nobody render as one row with a count and a span. Anything
else breaks the run, so a caption every minute fragments a long absence into a row per minute.

**Why it shipped anyway.** The alternative — letting captions float out of order, or dropping them
inside a run — makes the pane disagree with itself about when things happened, which is the exact
confusion this feature exists to remove.

**What would discharge it.** Nothing needs to. The record on disk is complete; this is a rendering
choice, and a reader wanting the raw stream has it.

## Volume is accepted rather than solved

**What.** Roughly 5,700 events a day at a fifteen-second detection interval, most of them recording
that nobody was found. Nothing expires, and nothing is compacted.

**Why it shipped anyway.** JSONL at that rate is a few megabytes a day, day-stamped and read as a
bounded tail — a year of watching costs the same read as a day of it. Everyone in the gallery has
consented to being held; the constraint is that the record does not leave the machine.

**What would discharge it.** Nothing, unless the rate changes by an order of magnitude. If it does,
the shape to reach for is a roll-up beside the raw log, not expiry of it.

## Not verified against a real camera — DISCHARGED 2026-08-08

**What it was.** Every claim was verified through the service against a fake recogniser, and the pane
by screenshot against a seeded record. No check had been written by a real face in front of a real
webcam.

**What discharged it.** A live session: the timeline filled, readings varied across the measured
range, and the pane stayed readable at the real detection rate. It also immediately exposed a defect
every test had missed — see "What the first real session showed" above, and note which way that cuts.
A fake gallery returning one constant match cannot distinguish a fresh reading from a frozen one, so
the entire suite was blind to the bug by construction. The one thing still unverified is behaviour
with a second person in frame.
