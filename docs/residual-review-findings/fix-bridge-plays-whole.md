# Residual findings — a bridge plays what was linked

Accepted knowingly, 2026-09-06, after a nine-reviewer pass over the branch
(`docs/plans/2026-09-06-001-fix-bridge-plays-whole-plan.md`). Everything actionable that pass found
is fixed and committed, each fix with a test confirmed to fail without it; what follows is what was
raised and deliberately not changed, with the reason and what would discharge it.

Two of the fixed findings are worth naming here even though they are discharged, because they are
the shape this subsystem keeps producing: the reviewers found a *second* truncation underneath the
one the branch set out to fix, and a comment that repeated the original error in miniature.

---

## A duration correction can hold the machine for an hour

**What.** `rearmCrossing` re-times the wait in flight against the member's own corrected duration,
bounded by `MAX_CLIP_MS` — an hour. Before this branch it went through `bridgeMs`, which clamped to
`MAX_BRIDGE_MS`, so the same correction could hold the machine for at most thirty seconds. A browser
reporting a bogus measurement for the clip on screen — a bad container, a stream with no real
duration, a hostile client — therefore reaches a hold two orders of magnitude longer than it used to.

Reproduced: one `setWorld` carrying `durationMs: 9_999_999_999` for the crossing clip armed a
**3,599,948 ms** wait, 120× the old ceiling.

**Why it stands.** The brief's decision was *no clamp — the warning is the guard*, taken with the
ten-minute case explicitly in view. A correction is the manifest becoming accurate rather than a
separate kind of event: once recorded, `longBridges` reports the transition like any other. Bounding
corrections but not authored bridges would give `MAX_BRIDGE_MS` two meanings again — an enforcement
bound on one path and a reporting threshold on another — which is the ambiguity this branch removed.

**What would discharge it.** A case where a correction that nothing authored holds a live show, or a
decision that the two paths *should* differ. The fix if so is a cap on the re-armed remainder in
`rearmCrossing` alone, leaving the crossing loop unclamped.

---

## Nothing bounds a bridge's total

**What.** `MAX_CLIP_MS` bounds each member. Nothing sums them, so a set of `MAX_CLIPS_PER_SET` (200)
members is 200 hours of a World that evaluates nothing and refuses every clip-end report.

**Why it stands.** The same decision. The number is not reachable by authoring — a bridge is clips
somebody linked — and the graph names any transition past thirty seconds. A total ceiling would
reintroduce exactly the clamp this branch removed, one level up.

**What would discharge it.** Nothing expected. The doc comment on `MAX_CLIP_MS` now states the real
worst case rather than implying an hour, which was the actual defect here: the *claim*, not the
bound. Recorded because a future reader will do the arithmetic and should find it already done.

---

## A Trigger pressed during a long crossing is shown set, then consumed by the transition already
crossing

**What.** A Trigger set while a bridge plays is broadcast as `true`, held, and cleared on landing by
`consumeTriggers` — spent by the move already under way rather than arming the next one. The
operator sees it go true and sees nothing happen. Pre-existing, and a longer crossing widens the
window it is visible in.

**Why it stands.** "A Trigger is consumed on landing, not on departure" is the authored rule, and it
is what keeps a bridge that faults from spending one. Changing which press a landing consumes is a
change to Trigger semantics, not to this branch.

**What would discharge it.** A brief about what a press during a crossing means. The cheap half is
presentational: the panel could show a Trigger set while `transitionId` is non-null as *held* rather
than as fired.

---

## A client connecting mid-crossing starts its member from zero

**What.** The server is N seconds into a member; a browser that connects now starts that file at
zero, and its clip-end report is refused for the rest of the crossing. The picture holds on the last
frame until the server's timer lands. Pre-existing; bounded by `MAX_BRIDGE_MS` before this branch and
by the member's own length after it.

**Why it stands.** The server's timer is the authority and a crossing refuses reports by design —
that refusal is the uninterruptible rule. Seeking a joining client into the middle of a bridge is a
resync feature the subsystem does not have for State clips either.

**What would discharge it.** Broadcasting elapsed-within-member alongside the clip so a joining
client can seek. Worth it only if someone watches a stream that started mid-crossing.

---

## The UI test tree is never typechecked

**What.** `ui/tsconfig.json` includes only `src/**/*` and `../shared/src/**/*`, so `npm run typecheck`
never reads `ui/test/`. A fixture in `ui/test/store.test.ts` annotated `WorldReports` supplies four of
its fourteen required fields and compiles clean. This branch added the tenth missing field.

**Why it stands.** Pre-existing and repo-wide; adding the test tree to the typecheck would surface
unrelated failures across the UI suite. Out of scope for a bridge fix.

**What would discharge it.** A pass that adds `test/**/*` to the UI tsconfig and fixes what falls out.
Worth doing before the next change that adds a required field to a wire type.

---

## A long crossing multiplies an Effect's broadcasts

**What.** A World Effect on a short interval writes and broadcasts through a crossing — up to ten
full-state broadcasts a second, now for the bridge's length rather than at most thirty seconds.

**Why it stands.** The Effect clock running through a crossing is authored behaviour ("a World Effect
runs wherever the machine is, including through a crossing"), and the rate is the interval floor's
business, not the bridge's.

**What would discharge it.** Evidence that a long crossing plus a fast Effect actually degrades a
watching client. Nothing has measured it.

---

## The testing dimension of the review never reported

**What.** The `ce-testing-reviewer` subagent ran source-mutation experiments in the shared working
tree and then reverted it, destroying the orchestrator's uncommitted fixes; it was stopped before
returning findings. A second read-only agent deleted a committed block from `StateGraph.tsx` in the
working tree. Both were dispatched with read-only instructions.

**Why it is recorded here.** The review was re-run read-only afterwards, but the incident is the
reason every fix in this branch is committed immediately rather than batched: a reviewer sharing the
checkout can take uncommitted work with it, and `git stash list` is empty afterwards.

**What would discharge it.** Worktree isolation for review subagents, or a review flow that never
edits the tree the reviewers are reading.
