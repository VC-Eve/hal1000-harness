---
title: A test written from the implementation certifies the bug instead of catching it
date: 2026-08-06
last_updated: 2026-08-08
category: pattern
tags: [testing, review, blind-spots, test-seams, coverage-illusion]
module: server/src/monitors, server/test/monitors
problem_type: workflow_issue
symptoms:
  - review finds a defect in code that has a passing test covering that exact line
  - a test asserts the current output rather than the intended behaviour
  - a test passes because its fixture never reached the code it claims to cover
  - a guarantee on another system's output is tested only on inputs you constructed
  - coverage looks complete but a whole failure mode has no test at all
  - the test suite is green and the feature is wrong
---

## Context

A code review of the ambient-log-monitors feature found several defects in code that already had
tests. The tests were not absent or weak in any way a coverage tool would show — they passed, they
asserted specific values, and they sat right next to the code they failed to protect.

The common cause was writing each test after the implementation, by reading the implementation.
That produces a test that describes what the code does. If what the code does is wrong, the test
makes the wrong behaviour permanent and adds confidence on top of it.

Three instances from one feature, each a different shape of the same mistake.

## Guidance

### Do not derive the assertion from the code's current output

`severityFromLevel()` returned `"routine"` for any word it did not recognise. The test read:

```ts
it("does not guess from an unrecognised level vocabulary", () => {
  expect(severityFromLevel("catastrophe")).toBe("routine");
});
```

That is what the function did. It was not what it should do. A caller used
`severityFromLevel(x) === null` as a "was a level even stated?" guard, and because the function never
returned null the guard was dead code — every log line containing two tabs was parsed as a structured
record and had its severity suppressed. The test named the right concern ("does not guess") and then
asserted the opposite of it.

Write the assertion from the requirement, then run it. A test that has never failed has never been
shown to test anything.

### One call is not a test of behaviour that only appears on repetition

The missing-file case was covered:

```ts
await fs.rm(file);
const gone = await r.poll();
expect(gone.problem).toMatch(/cannot read/i);
```

One poll, one problem reported — correct. But the narrator emitted a feed entry for every poll that
reported a problem, so a file missing for an hour produced ~120 identical entries and evicted real
narration from a bounded ring. The single-poll test could not see it, because the defect only exists
in the second call onward.

When behaviour is scheduled or repeated, test the repetition. Ask what the tenth call does, not just
the first.

### A seam added for testability must not become the only thing tested

`MonitorService.pollNow()` was added so tests could trigger a poll deterministically instead of
sleeping past a 30-second interval. Reasonable. But then every service test used it, and the real
`setInterval` wiring — the thing that actually makes monitors run — had no coverage at all. The seam
made the tests fast and made them prove less than they appeared to.

A test seam is a way to reach the behaviour, not a substitute for it. If a seam bypasses the
production path, something still has to cover that path.

### A fixture that another feature filters out never reaches the code under test

A later instance, 2026-08-07, from the triage queue's eviction tests. The queue is bounded, so
offering three faces with a cap of two must drop the oldest. The test offered three and asserted two
remained:

```ts
for (const angle of [0, 40, 80]) await store.offer(vec(angle), CROP, 2);
expect(await store.list()).toHaveLength(2);   // green
```

Green, and proving nothing. The same store deduplicates by similarity, and `cos(40°) = 0.766` is
above that bar — so the second face was rejected as "already waiting", only two were ever queued, and
**nothing was ever evicted.** The assertion held because the count happened to match for an unrelated
reason. The sibling assertion that the eviction *tally* incremented is what failed and exposed it.

The general shape: when the code under test sits behind a filter, guard, or dedupe, a fixture chosen
without regard to that gate may never arrive. The test then measures the gate.

Two habits that catch it:

- **Assert a side effect that only the target path produces.** Here that was `overflow().dropped`,
  which cannot increment unless an eviction actually happened. A count of survivors can be right by
  coincidence; a record of what was destroyed cannot.
- **Name the constraint in the fixture.** The corrected version says why its inputs are what they
  are, so the next person cannot quietly reintroduce the problem:

```ts
// Far enough apart to be three different people: cos(80) = 0.17 and
// cos(160) = -0.94, both well under the same-face bar. Using closer angles
// here made the eviction tests pass without ever evicting anything.
const THREE_DISTINCT = [0, 80, 160];
```

### A guarantee tested on the shape you send, not the shape you get back

The sharpest instance yet, 2026-08-07, and it was written hours after the section above.

`enforceIdentityHedge` is a guarantee on what an LLM produces: no bare enrolled name reaches the feed.
Its tests covered the bare name, every occurrence, word boundaries, regex metacharacters, unicode, and
the already-hedged case:

```ts
it("leaves an already-hedged mention alone", () => {
  const already = "someone who looks like Dave is at the desk.";
  expect(enforceIdentityHedge(already, ["Dave"])).toBe(already);
});
```

Lowercase. The model is **handed** that string and naturally capitalises it at a sentence start —
`"Someone who looks like Dave..."` — which the lowercase-only lookbehind did not match, producing
`"Someone who looks like someone who looks like Dave"`. The single most likely real input had no test.

The same matcher was case-sensitive on the name, so a model writing an enrolled `"sw"` as `"SW"`
shipped a bare name: the exact failure the function exists to prevent, untested because every fixture
used the enrolled spelling.

The rule this adds: **when the code under test guards the output of another system, derive the
fixtures from what that system actually emits, not from what you passed it.** For an LLM that means
capitalisation, whitespace, and re-casing at minimum — it is a generative process, not an echo. Where
possible, capture one real output and use it as a fixture.

## Why This Matters

These defects survived implementation *and* self-review, and were caught only by independent
reviewers reading the code against its stated intent. The tests actively worked against discovery:
each one made the surrounding code look verified.

That is the specific danger. Missing coverage is visible — a tool reports it, and a careful reader
notices. A test that certifies wrong behaviour looks exactly like a test that certifies right
behaviour, and it takes an outside perspective to tell them apart.

This compounds with the lesson in `session-log-extraction-drops-tool-io.md`, which was about tests
asserting arrival rather than content. Both are the same failure at different levels: the test
resembles the code closely enough to be useless as a check on it.

### Postscript: a fourth shape, and the harness that closes it

A later defect in the same feature was a mount effect that listed an unstable
`send` in its dependencies, re-running on every render and issuing requests at
render speed. No test could see it — the repo had no way to render a component
at all, so "how many times does this effect run" was unaskable.

`ui/test/components/` now exists for exactly that question. The first test
written against it repeated this document's own mistake in miniature: the
harness handed out a *stable* `send`, so the assertion passed whether or not the
bug was present. The fix was to supply a deliberately unstable one and confirm
the test failed with the bug reintroduced before keeping it.

The rule that catches this: **reintroduce the bug and watch the test fail.** A
new regression test that has only ever been green has not been shown to test
anything.

## When to Apply

Whenever writing a test after the code, especially:

- Any function whose return value has a "no opinion" case (`null`, `undefined`, an empty result)
  distinct from a real value — the distinction is exactly what a code-derived test will flatten.
- Scheduled, retried, or polled work, where the second and subsequent iterations differ from the
  first.
- Any test helper or method added specifically to make testing easier.

## Examples

The corrected form of the first case states the requirement and explains why the naive answer is
wrong, so the next reader cannot re-flatten it:

```ts
it("reports no opinion for an unrecognised level vocabulary", () => {
  // Not "routine": an unknown word is not a level, and treating it as one
  // would suppress keyword severity for every tab-containing line.
  expect(severityFromLevel("catastrophe")).toBeNull();
});

it("falls back to text when the stated level is not a level at all", () => {
  expect(classify("FATAL: allocation refused", "some-component")).toBe("severe");
});
```

The repetition case, which the single-poll version could not express:

```ts
it("reports a source problem once, not once per poll", async () => {
  for (let i = 0; i < 5; i += 1) await n.ingest(m, { events: [], problem });
  expect(entries).toHaveLength(1);

  await n.ingest(m, { events: [] });
  expect(entries).toHaveLength(2); // recovery is its own single entry
});
```
