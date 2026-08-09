---
title: A stubbed factory is not isolation if something resolves before it
date: 2026-08-09
category: bug
tags: [testing, flakiness, test-isolation, temp-files, races, blind-spots]
module: server/test/settings.ts, server/test/tmp.ts, server/src/narration/narrator.ts
problem_type: environment
symptoms:
  - the full suite fails a handful of tests, a different set each run
  - every failing file passes in isolation
  - assertions fail with an empty string or a zero count rather than a wrong value
  - the failure rate changes across a session with no code to explain it
  - a change that is correct in production makes the suite much worse
---

## The shape of it

`npx vitest run` failed 3–11 tests per run, a different set each time, always in files that wait on
timers or filesystem events. Every one passed alone. This was written down as a pre-existing timing
flake with the advice *re-run the file alone before blaming your change* — right advice, wrong
diagnosis, and the wrong diagnosis cost two false explanations before the real one.

The unifying clue was in the assertions, not the timings. They failed as `expected '' to contain …`,
`expected 0 to be greater than 0`, `expected 'unreachable' to be 'ok'`. Not *wrong* values — *absent*
ones. Nothing had run at all.

## The cause

`backendForRole` resolves a protocol **before** the provider factory is reached. On the shipped
default of `auto`, that means `detectProtocol` issues a real HTTP probe to `localhost:11434` with a
two-second deadline.

So a unit test that stubs the provider factory has faked the wrong layer. It still depends on whether
a real Ollama answers within two seconds, and under a parallel suite it often does not. The probe
fails, the backend resolves to null, no inference happens, and the assertion fails with nothing in it.

That was latent for as long as the protocol cache held one lucky answer for the whole process — one
probe per run, near enough always successful. Then `SettingsStore.update` was taught to drop the
cache, which is **correct in production**: applying settings is exactly what someone does after
stopping Ollama and starting llama-server on the same port. In the suite it turned one probe per run
into one per settings update.

Measured directly, with the cache-drop gated behind an environment variable:

| | failures per run |
|---|---|
| with the cache drop | 6, 6 |
| without it | 1, 1 |

A correct production change, sixfold worse tests, and no test asserting anything about protocol
detection.

## Two more, found underneath it

**A product race.** `NarrationService.teardownAdapter` awaited `registry.detach()` and cleared the
retry timer afterwards. A timer coming due inside that await runs its callback — which nulls the
handle and calls `pump()` — so the `clearTimeout` below found nothing and a **disabled adapter
narrated anyway**. Cancelling and bumping the epoch before the await closes it. The window widens
with load, which is why it read as flakiness rather than as the bug its own test was named for.

**A racy test.** The same test cleared its provider's failure flag *before* disabling the adapter, so
a retry landing in that gap was legitimate output the assertion read as the bug. Disable first, then
let the provider succeed.

## And a red herring worth naming

The tests had also left **46,507 `hal1000-*` directories** in `%TEMP%` over a week — fifteen files
created one per test and removed none. That looked like the answer: a temp folder that size does slow
`mkdtemp`, the leak grows every run, and one run even surfaced `ENOSPC`.

Purging all 46,507 changed the failure count by nothing. The litter was real, worth fixing, and not
the cause. `server/test/tmp.ts` now attaches cleanup to creation so it cannot regress — but it is
hygiene, not the fix.

## What to take from it

**Fake the layer the code actually reaches, not the one you were thinking about.** A stubbed
`ProviderFactory` looks like full isolation and is not; protocol resolution sits in front of it.

**"Passes in isolation" means resource contention — ask what resource.** Two days of treating that as
a known-flaky workaround, and the answer was one grep away: which shared thing do all the failing
files touch?

**A correct change can be measured wrong.** The rate went from ~1 to ~6 the moment the cache drop
landed, and it was attributed twice to machine load — including in a baseline "measured" by stashing
work that did not include the offending commit. When a rate moves, A/B the suspected cause behind a
flag before believing an environmental story.

**Absent values accuse a different layer than wrong values do.** An empty string where prose was
expected is rarely a logic error in the thing under test; it usually means the thing under test never
ran.

Related: [[test-suite-flakes-under-load]] — the note that carried the wrong diagnosis and the right
advice.
