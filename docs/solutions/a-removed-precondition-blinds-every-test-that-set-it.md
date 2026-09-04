---
title: A change that removes a precondition blinds every test whose setup established it
date: 2026-08-07
category: pattern
tags: [testing, blind-spots, preconditions, fixtures, smoke-test, coverage-illusion]
module: server/src/narration, server/test/narration
problem_type: workflow_issue
component: testing_framework
severity: high
symptoms:
  - every test in the area opens with the same setup call, and that call is what the change made optional
  - the suite is green, typecheck is clean, and the build succeeds on a behaviour change
  - the feature does nothing on a fresh boot but works after any manual action
  - the app reports itself blocked on something that is in fact configured
---

## Context

The concurrent-sessions change made HAL follow every live Claude Code session automatically, instead
of only the one the user had selected. It shipped with 469 passing tests, a clean typecheck, and a
successful production build. It did not work at all.

On a fresh boot with nothing selected, HAL followed every live session, narrated none of them, and
reported its status as `paused-missing-model` — naming a model that had been configured the whole
time. The defect took under a minute to find once the real server was running, and the entire test
suite was structurally incapable of finding it ever.

`NarrationService` holds `stickyModel`: the narration model, resolved once and then held so the
local Ollama process is not made to thrash VRAM between models. It was assigned in exactly two
places — inside `watch(sessionId)`, and in the `update-settings` handler. Before the change that was
*complete* coverage, because narration could only begin after a `watch()`. Every path into `pump()`
had already passed through it.

The change removed that precondition. Narration now happens for auto-followed sessions with nothing
selected, so `pump()` runs without `watch()` ever having been called, finds `stickyModel === null`,
hits the missing-model guard, and returns.

Why no test caught it is the part worth keeping. Every narration test opened like this:

```ts
const svc = new NarrationService(hub, registry, settings, queue, makeProvider([], async () => "ok"), {});
await svc.watch("s1");          // <- the precondition, in every fixture
registry.emit({ kind: "session-events", sessionId: "s1", events: [ev("edited app.ts")] });
```

`await svc.watch(...)` appears **32 times** in `server/test/narration/narration.test.ts`. It was
there because it was the only way to make narration start. The moment the change made it optional,
that same line became the thing stopping every test from reaching the new path. The suite was not
missing an assertion — it was missing an *initial state*. No input could have made it execute the
new branch.

Green tests, in that situation, are measuring the world before the change.

## Guidance

### When a change removes a precondition, grep the fixtures for it

This is mechanical and takes seconds. Identify the setup call the change made optional, then count
it in the suite:

```bash
rg 'svc\.watch\(' server/test/narration/narration.test.ts   # 32 hits
```

Thirty-two tests, none of which could reach the new branch. The count *is* the answer: if every test
in the relevant file performs the now-optional step, coverage of the newly reachable state is zero
no matter what the coverage tool reports — the lines are covered, by tests entering from the old
direction.

Write the new tests in a `describe` block that omits the call entirely. Do not retrofit an existing
test, because the existing setup is the thing under suspicion.

### Test the state the change created, not just the behaviour it changed

The change was described as "follow every live session". The natural tests to write are about
*following*: that several sessions are followed at once, that each coalesces separately, that the
selected one takes priority. All of those were written. All of them passed. All of them called
`watch()` first.

The defect lived in a state the change newly made reachable — a service that has narrated without
ever having been watched. Ask what object states become possible after the change, and construct one
directly, rather than testing the feature through the entry point you already had.

### Smoke the real process when the symptom would be absence

For anything that pumps, polls, tails, or runs in the background, failure is not an exception — it is
nothing happening. Assertions cannot observe nothing happening on a path they never enter.

The backstop that found this, in about two minutes (Git Bash on Windows; adjust paths for
PowerShell):

```bash
# 1. Boot the real server against a throwaway data dir, so nothing touches real user data.
#    Only while nobody else uses this instance — see the caveat below.
HAL_DATA_DIR=/tmp/hal-smoke HAL_PORT=8124 npx tsx server/src/index.ts &

# 2. Drive it over its real transport — the WebSocket at /ws, not a test double.
#    (The root path 400s; the hub is mounted at a path.)
node smoke.mjs        # ad-hoc ~15-line script: sends a settings patch,
                      # listens for narration-entry broadcasts

# 3. Read the filesystem.
find /tmp/hal-smoke -type f
```

**The throwaway data dir is for an unattended smoke only.** It protects the user's data
from the agent; it does nothing to protect data the *user* creates inside that instance.
Hand the URL to a person while this override is set and everything they author lands in a
directory that gets swept, with nothing in the UI to say so. If the instance is going to
be used rather than only driven, drop the override and let it write where their work
belongs — see
[a-scratch-data-dir-is-safe-until-you-invite-the-user-into-it.md](a-scratch-data-dir-is-safe-until-you-invite-the-user-into-it.md),
where exactly that cost a 95MB World.


The tell was **absence**. `observations/` and `inference/session/` were never created. No error, no
exception, no failing assertion — just directories that did not exist. A passing suite cannot show
you a directory that was never made.

## Why This Matters

Missing coverage is visible: a tool reports it and a careful reader notices. This is worse, because
every signal was positive. The suite was green *and* comprehensive *and* directly about the feature
in question. Nothing distinguished it from a suite that had verified the change.

The deeper point is that a fixture's setup is an unwritten precondition assertion. `await
svc.watch("s1")` was never described as "narration requires a watched session" anywhere — but that
is what it encoded, in 32 places. When production code stopped requiring it, the fixtures went on
requiring it, silently, and the suite kept certifying a path that no longer existed in the product.

The same thing happened one level up, in prose: `CONCEPTS.md` defined Sticky Model as the model
resolved "when watching began", and Watched Session as "the single Session HAL is currently
observing. At most one at a time." Both sentences encoded the removed precondition, both survived
the change untouched, and nobody noticed those either — they were corrected only when this document
was written. Prose goes stale the same way fixtures do, and for the same reason: it records a
constraint as though it were a fact.

This compounds with `tests-that-lock-in-the-bug.md`, where a test written *from* the implementation
certifies the defect. Same end state — green suite, wrong behaviour — different mechanism. There the
assertion is wrong; here the assertion is unreachable.

## When to Apply

- A change that **removes or widens a precondition**: an argument becomes optional, a guard is
  deleted, an early return goes away, a step becomes automatic that used to need a user action.
- A change that adds a **second entry point** to code that previously had one. The old entry point's
  tests are now a partial suite that looks total.
- Reviewing a diff that deletes a `require`, an ordering constraint, or an "only after X" comment.
  "Tests still pass" is the *expected* outcome of removing a precondition, not evidence the removal
  was safe.
- Any state-machine or daemon code where the symptom of failure would be silence rather than an
  error.

## Examples

The regression tests deliberately never call `watch()`:

```ts
// Regression: sessions are followed and narrated with nothing selected, but
// the narration model was only resolved by `watch()`. A fresh boot therefore
// observed every live session, narrated none of them, and reported itself
// paused for a model that was configured all along.
describe("NarrationService without a selection", () => {
  it("narrates a followed session when nothing has been selected", async () => {
    const calls: NarratorCall[] = [];
    new NarrationService(hub, registry, settings, queue, makeProvider(calls, async () => "The agent proceeds."), {});
    expect(registry.watchedSessionId()).toBe(null);

    registry.emit({ kind: "session-events", sessionId: "sess-unselected", events: [ev("edited app.ts")] });
    await waitUntil(() => entries(hub).length === 1);
    expect(calls[0]!.model).toBe("chat-m1");
    expect(entries(hub)[0]!.entry.sessionId).toBe("sess-unselected");
    expect(statuses(hub)).not.toContain("paused-missing-model");
  });

  it("still pauses when no model is configured at all", async () => {
    await settings.update({ chatModel: null, narrationModel: null });
    new NarrationService(hub, registry, settings, queue, makeProvider([], async () => "ok"), {});
    registry.emit({ kind: "session-events", sessionId: "sess-unselected", events: [ev("x")] });
    await waitUntil(() => statuses(hub).includes("paused-missing-model"));
  });
});
```

`expect(registry.watchedSessionId()).toBe(null)` is load-bearing documentation: it states, inside
the test, that the absent `watch()` is the point and not an oversight for a future reader to "fix".

The second test is what keeps the fix honest. The easy wrong fix is to delete the guard — the
symptom is a guard firing when it should not. That test proves the guard still fires for the genuine
no-model case, so the change added a path instead of removing a check.

The fix itself, at the top of the `pump()` loop body, immediately before the missing-model guard:

```ts
const coalescer = this.coalescers.get(sessionId)!;
// Resolved here as well as at watch time. Sessions are followed and
// narrated without anything being selected, so a model resolved only
// by `watch()` left a fresh boot observing every live session and
// narrating none of them — silent, and reporting itself as paused for
// a model that was in fact configured.
this.stickyModel ??= this.settings.get().narrationModel ?? this.settings.get().chatModel;
if (!this.stickyModel) {
  this.setStatus("paused-missing-model");
  return;
}
```

That line runs on every iteration of the narration loop, which is why it is `??=` and not `=`:

the first resolution wins and every later pass leaves it alone, so narration still never retargets
mid-session. That is the stickiness the field exists for, preserved.

## Related

- `tests-that-lock-in-the-bug.md` — the adjacent failure: a test written from the implementation
  certifies the defect. There the assertion is wrong; here it is unreachable.
- `session-log-extraction-drops-tool-io.md` — green suite, starved consumer, because every synthetic
  fixture bundled a `text` block and the empty-text path never ran. The same fixture-uniformity
  blind spot in a different subsystem.
- `a-flag-nothing-reads-looks-shipped.md` — the third member of this cluster: shipped, green, and
  invisible to the user. Different mechanism (a produced value nothing consumed), same outer symptom.
- `diagnosing-a-process-that-isnt-your-code.md` — the complementary caution when smoke-testing.
  There the running process turned out not to be your code; here it was, and running it was the only
  thing that found the defect.
- `../residual-review-findings/feat-inference-logging-and-concurrent-sessions.md` — the accepted
  risks of the feature this defect came from.
