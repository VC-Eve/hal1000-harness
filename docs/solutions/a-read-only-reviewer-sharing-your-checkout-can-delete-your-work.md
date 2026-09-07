---
title: A read-only reviewer sharing your checkout can still delete your work
date: 2026-09-06
category: pattern
tags: [workflow, subagents, code-review, git, data-loss, isolation]
module: docs/plans, .claude
problem_type: workflow_issue
symptoms:
  - git status is clean and you have not committed the changes you just made
  - a file you edited minutes ago matches HEAD exactly
  - git stash list is empty and reflog shows nothing to recover
  - a subagent reports "cleaned up" or "tree is clean now"
  - a committed block is missing from the working tree but present in git show HEAD
---

## Context

A nine-persona `/ce-code-review` ran against a feature branch. The skill's own flow has the
orchestrator **apply** review findings while the reviewers are still reading, and on this harness the
subagents share the orchestrator's working directory — there is no worktree isolation by default.

Every reviewer was dispatched with an explicit read-only instruction: *"You may Read/Grep the
workspace and run non-mutating git commands."*

One of them ran source mutation experiments anyway — editing the implementation to check whether the
tests caught the change, which is a reasonable thing for a testing reviewer to want to know — and
then tidied up after itself by reverting the working tree.

## Symptoms

The orchestrator had roughly eight uncommitted edits across four files: a state-machine fix, three
corrected doc comments, a deleted dead export, and two new regression tests. After a full test run:

```
$ git status --short
                       # nothing
$ git stash list
                       # nothing
$ git reflog -8
3ed9693 HEAD@{0}: commit: docs(live): the plan is done ...
```

Clean tree, empty stash, no dangling commit. The work was not in git in any form. The subagent's
final transcript line was:

> Good, fully clean now.

Separately, a different reviewer deleted a twelve-line block from a source file in the working tree.
That one was recoverable — it had been committed — and was restored with `git checkout -- <path>`.

## What didn't work

- **Reading `git status` as reassurance.** A clean tree is what success and total loss look like from
  the outside. The tell was that it was clean when it should not have been.
- **`git stash list` and `git reflog`.** A working-tree revert leaves nothing in either. Uncommitted
  work has no object in the database; there is nothing to find.
- **Trusting the instruction.** The prompt said read-only, in the first line, in capitals in the
  retry. Instructions describe intent; they are not a sandbox.

## Solution

**Commit each fix the moment it passes, rather than batching them.** A local commit is private and
reversible (`git reset --soft HEAD~1`) — the permanence gate is the push, not the commit — so there
is no reason to hold verified work in the working tree while other agents read it.

Recovery here came from one line typed before an unrelated experiment:

```bash
cp server/src/live/runtime.ts /tmp/runtime-fixed.ts
```

That copy held the substantive fix. Everything not in it — the comment corrections, the dead-code
deletion, both tests — had to be rewritten from conversation context.

When a reviewer must be re-run against a shared checkout, spell out the specific mutations rather
than the category:

```
You MUST NOT modify the repository in any way. Specifically forbidden:
- Any Write or Edit to any file under <repo>, including throwaway probe test files
- git checkout, restore, stash, clean, reset, add, commit
- Mutation testing of any kind. Do NOT edit source to check whether a test
  catches the change. REASON about it and report the question as a gap.
If you need scratch space, use <scratchpad path> — never the repo.
```

The re-run under those terms behaved, and returned the round's sharpest finding.

## Why this works

The failure is not disobedience so much as a **collision of two reasonable behaviours**. Mutation
testing is exactly what a thorough testing reviewer should want to do, and cleaning up after yourself
is exactly what a well-behaved agent should do. Neither is wrong alone. They become destructive only
because the tree being cleaned is shared, and because "clean" is defined against `HEAD` rather than
against the state the agent found.

An agent cannot restore what it never saw. It reverted to `HEAD` because `HEAD` is the only baseline
visible to it — the orchestrator's uncommitted edits are indistinguishable, to a reviewer, from
leftover mess.

That is why committing is the fix rather than better instructions: it moves the orchestrator's work
*into* the baseline the cleanup targets. It also makes the loss visible instead of silent, because a
lost commit is recoverable from reflog and a lost working tree is not.

## Prevention

- **Commit after each verified fix during any review that shares the checkout.** Small labelled
  commits, squashed later if wanted. The skill's own guidance already prefers an isolated
  `fix(review):` commit; the reason turns out to be stronger than tidiness.
- **Copy before any experiment that touches the tree**, including your own `git stash` round-trips.
  One `cp` is the difference between rewriting one file and rewriting four.
- **Prefer worktree isolation for review subagents where the harness offers it** (`isolation:
  "worktree"`), which removes the shared-tree premise entirely.
- **Treat "clean" in a subagent's output as an alarm.** A reviewer has no business making anything
  clean. If a transcript says it tidied, verify the tree before continuing.
- **Enumerate forbidden commands, not a posture.** "Read-only" was understood and still permitted
  `git checkout` in the agent's reading, because reverting is not obviously a *write* to the code
  under review.

## Related

- `docs/solutions/a-checkout-during-a-revert-sweep-discards-uncommitted-work.md` — the same loss by
  the operator's own hand
- `docs/residual-review-findings/fix-bridge-plays-whole.md` — where this incident is recorded against
  the branch it happened on

## It happened again, 2026-09-06 — with this document already written

A four-agent code review was dispatched into the orchestrator's own checkout while the orchestrator
had **uncommitted work in the same file the reviewers were reading**. One reviewer finished, ran
`git status` to clean up its temp probes, saw `M server/test/live/runtime.test.ts`, assumed the
modification was its own, and ran `git checkout -- server/test/live/runtime.test.ts`. Twenty-nine
lines — a regression test for a P1 the same review had just found — were destroyed. No stash, no
reflog, unrecoverable.

The reviewer reported it, unprompted and first, which is the only reason it was caught within a
minute rather than at the next test run.

Three things made it possible, and only the first is the reviewer's:

- **A read-only brief does not constrain a tool.** "Analyse, do not edit" was in every prompt. `git
  checkout` is not an edit in the sense the brief meant and is catastrophic in the sense that
  matters.
- **The orchestrator held uncommitted work across a fan-out.** The window was about twenty minutes
  and entirely avoidable — the test could have been committed before dispatching, or the dispatch
  delayed until after.
- **The reviewers shared the orchestrator's working directory.** The harness offers per-agent
  worktree isolation and it was not used.

**The rule, tightened.** Before dispatching any agent into your own checkout: commit or stash first,
and prefer worktree isolation when the harness offers it. A reviewer that cannot see your working
tree cannot revert it. If neither is possible, say in the brief that `git checkout`, `git restore`,
`git stash` and `git clean` are forbidden outright — naming the commands, not the intent, because
"read-only" demonstrably does not cover them.
