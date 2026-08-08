# Residual findings — the triage queue for enrolment

Accepted knowingly, 2026-08-07. Builds on
`docs/residual-review-findings/feat-recognition-loop.md`, whose residuals all still stand.

## No expiry

**What.** A candidate face persists until the user names it or dismisses it. The brief's R14 specifies
an expiry after a stated age, and it is not built.

**Why it shipped anyway.** A deliberate choice by the user, taken with the trade-off stated: an
expiry checker can be added later without changing the stored shape. The queue is bounded, so it
cannot grow without limit; what it cannot do is empty itself if the user never looks.

**What would discharge it.** R14 — an expiry sweep, plus the crop-free tally it requires so an expiry
leaves a trace rather than a silent deletion. The tally already exists for eviction and would extend
directly.

## The bound still discards, it just says so now

**What.** When the buffer fills, the oldest candidate is deleted. The brief's own review flags this as
a P1: R22 withholds strangers from the feed on the grounds that the queue guarantees the user finds
out, and a bound breaks that guarantee.

**What narrows it.** Eviction increments a crop-free count reported to the user — how many faces were
dropped and since when. That converts "the user never learns about someone" into "the user learns
that N someones were missed", which is weaker than R22 promises but strictly better than silence, and
is the same remedy the brief chose for expiry.

**What would discharge it.** Nothing short of an unbounded queue, which trades this for unbounded
disk. The honest position is that the count is the mitigation, not a fix.

## Naming merges by name, and the brief says names are not keys

**What.** Enrolling under a name already on the roster adds the face to that person rather than
creating a second record. The brief explicitly notes two people may share a name and remain distinct.

**Why it shipped anyway.** The alternative was measured in real use and was worse. One person whose
appearances fragmented was named repeatedly and became several records — the live roster held
`Steve x1, Steve x1, Liam x1, Liam x1, Liam x1` — each with a single face, which recognises that
person less well than one record holding five. R16 wants a person accumulating faces, and nothing
reached `addFace` before this.

**What would discharge it.** A roster UI that lets a user pick "add to this person" explicitly, or
merge two records. Until then, genuine namesakes need distinguishable names — which a user would
reach for anyway when two roster rows are indistinguishable.

## Duplicate people already on disk are not migrated

**What.** The merge-by-name behaviour applies to new enrolments. Records already split across
duplicates stay split.

**Why it shipped anyway.** Merging existing records is a data migration on biometric data, and doing
it automatically would silently rewrite what the user enrolled. Deleting the duplicates and naming
once more is a thirty-second manual fix with no ambiguity.

## Verified by unit test, not against the live loop

**What.** The queue's behaviour — dedupe, bound, eviction tally, take, dismiss — is covered by tests
against the real store on a real temp directory. The end-to-end path (a face being queued by the
detection loop, then named from the queue) was **not** confirmed live: nobody was in front of the
camera during the verification window.

**Why it shipped anyway.** The same is true of the appearance-continuity fix in the preceding slice.
Both are the kind of thing that only a person in front of a camera can confirm.

**What would discharge it.** One session at the camera: confirm a face appears in the queue, name it,
and confirm the person is recognised afterwards and the queue shrinks.
