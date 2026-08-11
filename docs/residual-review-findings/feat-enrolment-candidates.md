# Residual findings — the triage queue for enrolment

Accepted knowingly, 2026-08-07. Builds on
`docs/residual-review-findings/feat-recognition-loop.md`, whose residuals all still stand.

## No expiry — RE-STATED 2026-08-11, and now owed against two pools

**What.** A candidate face persists until the user names it or dismisses it. The brief's R14 specifies
an expiry after a stated age, and it is not built.

**Why it shipped anyway.** A deliberate choice by the user, taken with the trade-off stated: an
expiry checker can be added later without changing the stored shape. The queue is bounded, so it
cannot grow without limit; what it cannot do is empty itself if the user never looks.

**Why the original acceptance no longer covers it.** That acceptance was taken for a queue whose
defining property was that items leave quickly — twenty slots, turning over, with the missing sweep
described as the one gap in an otherwise self-clearing thing. The shelf (below) is a pool designed to
hold faces for as long as the user wants, and R14's absence there is not a gap in a draining store but
the reason the store does not drain at all. The residual is the same unbuilt sweep; the thing it is
being weighed against is different, and it is now owed against two pools rather than one.

**What would discharge it.** R14 — an expiry sweep over both pools, plus the crop-free tally it
requires so an expiry leaves a trace rather than a silent deletion. The tally already exists for
eviction in each pool and would extend directly. A longer clock on the shelf than on the queue was the
shape offered and declined; it remains the cheapest route back if the shelf accumulates rather than
drains.

## HAL keeps a gallery of unrecognised people, and now says so

**What.** Accepted knowingly, 2026-08-11. A Candidate can be set aside: taken out of the active queue
and held — crop, embedding, sighting time — until the user names or dismisses it. Nothing ends it on
its own. The brief rested its privacy position on the opposite property, quoted here so the inversion
is not deniable: *"a pending item expires on its own, so neglect empties the queue rather than turning
it into the gallery of unnamed people this brief refuses to build"*. These are faces of people who did
not consent to being held.

**Why it shipped anyway.** The user was offered a bounded clock — set-aside with expiry measured in
weeks, which is R14 built where it was always specified — alongside indefinite retention, and chose
indefinite retention. The queue-only design forced a decision the user was not ready to make in order
to clear a face off the screen, and the only ways to clear it destroyed the record or created a person.

**What narrows it.** The pool is bounded (25 by default, small on purpose), its bound is stated in the
pane rather than discovered when it bites, its evictions are tallied separately from the queue's, and
the four places that claimed HAL kept no such gallery now describe what it actually does. The
accidental version of this gallery already existed — an unbuilt R14 meant a neglected queue never
emptied — so what changed is that it is deliberate, bounded, visible and documented rather than
undocumented.

**What would discharge it.** R14 over the shelf, which restores the brief's property outright. Failing
that, a bulk dismiss over an age cutoff, so the pool has a drain the user controls rather than only the
one eviction gives them.

## A stranger can be absorbed into a shelved face, and is counted rather than surfaced

**What.** A shelved face stays in the `SAME_FACE = 0.45` duplicate check — it has to, or its owner
re-queues on every visit forever with no expiry to end it. But the shelf does not turn over, so the
comparison pool is permanent and grows: a genuinely different visitor who scores over that line is
folded into somebody else's card and never queued at all. R22 withholds strangers from the feed on the
grounds that the queue is how the user finds out, so an unnoticed match is a person HAL saw and never
mentioned.

**What narrows it.** Two things. A match stamps the shelved face as seen again and takes the arriving
crop when it is wider, so the common case — the same person returning — improves their own card instead
of being discarded. And every match increments `shelfMatches`, reported in the pane in its own words,
so the loss leaves a trace the way eviction already does.

**What the counter can and cannot tell you.** Added after review, because the first version of this
entry claimed more for it than it can deliver. `shelfMatches` counts occasions, not people: a shelved
regular who walks past every day increments it forever, and that is the case the design *wants*. It is
now gated to at most once per shelved face per day, which removes the within-visit multiplier — a
single visit fragments into several appearances, and each one used to count — but it does not separate a
legitimate return from a stranger absorbed by a false match. So the number does discharge R10: a match
is no longer silent. It does **not** answer the open question it was also built for, "is 0.45 too loose
for a permanent pool", because it climbs monotonically whether the threshold is right or wrong. Reading
it needs context about who is on the shelf and how often they are in the room. A number that could
answer the threshold question would have to record the match *scores*, or count only matches in a
marginal band — both of which mean persisting something not stored today and choosing a second
unmeasured threshold, which is the mistake this project has already made once.

**A false match also migrates the record's identity.** When the arriving capture is wider, it replaces
the stored crop *and the stored embedding*. For the intended case that is the point — the shelved card
improves toward the better photograph. For a false match it means the shelf slowly becomes the
stranger: the embedding that will be compared against tomorrow's arrivals is theirs, not the person the
user thought they were deferring. The pool is small and the bar is 0.45, so this needs a genuine false
match to start; it is recorded here because nothing in the code will announce it.

**Why the threshold was not tightened.** Comparing against a permanent pool probably wants a tighter
number than comparing against a transient queue. Nobody has measured it, and choosing a recognition
threshold by reasoning rather than observation is a mistake this project has already made once. The
tally is the instrument: if it climbs, 0.45 is too loose, and the replacement should be a measured
number.

**What would discharge it.** A measured threshold for shelf comparisons, or a shelf that expires so the
pool stops being permanent.

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

## Duplicate people already on disk — RESOLVED 2026-08-07

The duplicates were consolidated by name, oldest record winning, with a guard that refused the write
if the total face count changed. Five thin records became two — Steve with five faces, Liam with
four — and a backup of the pre-merge file sits beside it. The reasoning below is kept because it
still governs any future migration of this kind, not because the state is still true.

**What it was.** The merge-by-name behaviour applied only to new enrolments. Records already split
across duplicates stayed split.

**Why it was originally left.** Merging existing records is a data migration on biometric data, and
doing it automatically would silently rewrite what the user enrolled. Deleting the duplicates and naming
once more is a thirty-second manual fix with no ambiguity.

## Editing HAL's state files under a running server loses the edit

**What.** The first consolidation attempt was silently undone. The gallery file was rewritten while
HAL was running; `PeopleStore` holds the roster in memory, an enrolment landed moments later, and the
stale cached roster was persisted straight over the merge. Nothing errored, and the file simply read
as though the migration had never happened.

**What it means in general.** Anything that edits state a running HAL owns has to stop it first or go
through the protocol. Two writers, one of which caches, is not a race that announces itself.

**What would discharge it.** A roster-merge action reachable over the protocol, so consolidating
never means touching the file behind the server's back.

## Verified by unit test, not against the live loop

**What.** The queue's behaviour — dedupe, bound, eviction tally, take, dismiss — is covered by tests
against the real store on a real temp directory. The end-to-end path (a face being queued by the
detection loop, then named from the queue) was **not** confirmed live: nobody was in front of the
camera during the verification window.

**Why it shipped anyway.** The same is true of the appearance-continuity fix in the preceding slice.
Both are the kind of thing that only a person in front of a camera can confirm.

**What would discharge it.** One session at the camera: confirm a face appears in the queue, name it,
and confirm the person is recognised afterwards and the queue shrinks.

**Partly discharged for the shelf, 2026-08-11.** A session at a real camera on a second machine set a
face aside, restored it, set it aside again, and dismissed it — so the three verbs, the two pools and
the crop deletion are confirmed against the live loop rather than the fakes.

**What is still open, and it is the important half.** Nobody has yet left the frame and come back. The
one property the whole feature rests on is that a shelved face is still in the duplicate check, so its
owner does not re-queue on their next visit — and that needs a *new appearance*, which means walking
away long enough for the tracker to close the old one. Every test in the suite is blind to it by
construction: `fakeCandidates` now implements the duplicate check, but a fake agreeing with the real
store proves only that they agree. The evidence to look for is the card staying on the shelf, its
caption gaining a `back HH:MM` stamp, and the match notice reading "On 1 day HAL took an arriving face
for one you set aside". If it re-queues instead, the dedupe is not spanning both pools and the feature
is doing nothing while looking correct.
