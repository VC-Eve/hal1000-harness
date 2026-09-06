---
title: Restoring a fix after a revert sweep with git checkout discards uncommitted work
date: 2026-09-05
category: workflow
tags: [git, regression-tests, revert, data-loss, verification, agent-workflow]
module: shared/src/overlays.ts, ui/src/components/OverlayEditor.tsx
problem_type: workflow_issue
component: development_workflow
severity: high
symptoms:
  - a file that had uncommitted edits is back to its last-committed state with no error
  - the change just verified by the revert-and-watch-it-fail sweep is gone after the sweep
  - git status shows the file clean when work was done on it minutes ago
  - the loss is silent — nothing prompts, warns, or appears in the sweep's own output
  - it recurs on the next file in the same sweep, because the habit that caused it is unchanged
---

## Context

The rule in this repo is that a regression test must fail without its fix. The way to know is to put
the defect back, watch the test go red, and then restore the fix. That sweep is the reason several of
these learnings exist, and it works.

The hazard is in the restore. `git checkout <file>` is the obvious way to undo a hand-made revert,
and it is not an undo — it replaces the file with its last **committed** content. Anything written
since is discarded, whether it was the revert or not. Git prints nothing, because from git's point of
view the operator asked for exactly this.

In one pass through such a sweep it happened twice. The first time it took the optional `image` field
on `ImageSlot` in `shared/src/overlays.ts` and the matching `unfilled` handling in
`ui/src/components/OverlayEditor.tsx` — both written *after* the last commit and unrelated to the
clause being reverted. The second time, minutes later, it took a further edit to the same editor. Each
`git checkout` was aimed at one reverted guard clause and hit the whole file.

Both losses were caught, but by the full suite afterwards, not by anything in the sweep. That is
luck. The lost lines happened to have tests. A revert sweep that touches a file whose uncommitted work
has no test yet — which is the normal state of work in progress — discards it with no signal at all.

## Guidance

Reverting a fix to prove a test catches it, and discarding a file, are different operations and must
not share a command. Any of these does the job:

- **Copy it aside first.** `cp shared/src/overlays.ts /tmp/overlays.bak` before editing, `cp` back
  after. Crude, obvious, and it cannot take anything with it.
- **Stash the hunk** rather than hand-editing it out: `git stash push -p -- <file>`, then
  `git stash pop`. The pop conflicts loudly instead of overwriting quietly.
- **Commit first.** Once the in-flight work is committed, `git checkout <file>` discards nothing,
  because the committed state now includes it.

None of these costs more than `git checkout <file>`. They are the versions that do not have a second,
unrelated meaning.

The same care applies to running the suite: do not run it in the same breath as a restore. A run that
overlaps a half-restored file reports a failure that belongs to the restore, not to the code, and the
next few minutes go into the wrong question.

## Why This Matters

The revert sweep exists to stop a test certifying a bug. It is a good practice, and this is its own
sharp edge: the sweep asks you to break code deliberately and then put it back, over and over, in a
tree that also holds work in progress. Deliberate breakage and accidental loss look identical in a
diff, so the moment when the tree is *supposed* to be wrong is exactly the moment a real loss is
hardest to notice.

`git checkout` is a fine tool for "throw away everything I typed here" and a dangerous one for "put
back the one thing I just took out". It cannot tell those apart, and neither can the person running it
mid-sweep.

## When to Apply

- Verifying a regression test by reverting its fix, on a file that carries other uncommitted edits.
- Any moment where "undo my last edit" and "discard everything since the last commit" are reachable by
  the same command.
- A sweep across several files, where losing one quietly is easy to miss until the suite runs.

## Examples

**Before.** `shared/src/overlays.ts` holds an uncommitted `image?: string` field plus a guard clause
about to be reverted for a test. `git checkout shared/src/overlays.ts` restores the file to HEAD — the
revert goes, and so does the field, which was never part of the experiment.

**After.** `git stash push -p -- shared/src/overlays.ts` sets the fix aside, the revert is made by
hand, the test is watched going red, and `git stash pop` brings the field back, because it was never
asked to leave.

## Related

- `docs/solutions/tests-that-lock-in-the-bug.md` — prescribes the revert sweep this is a hazard of.
- `docs/solutions/a-safeguard-that-worked-by-accident-breaks-when-a-case-is-added.md` — prescribes it
  too, in its Related section, without warning about the restore.
