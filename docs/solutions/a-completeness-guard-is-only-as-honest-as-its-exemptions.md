---
category: process
module: server/test/templates/surface.test.ts, shared/src/phrases.ts, server/src/monitors/runner.ts
tags: [completeness, guards, test-design, exemptions, prompts, regression-tests]
symptoms:
  - a test asserts completeness and reports green while the thing it looks for is present
  - every time the guard is sharpened it finds more, and the count never settles
  - a category or allowlist entry says "this one cannot reach X" and the claim is wrong
  - a regression test passes with its own fix reverted
---

# A completeness guard is only as honest as its exemptions

The sequel to [extending a catalogue is not auditing
it](extending-a-catalogue-is-not-auditing-it.md), which ends with the rule "a
completeness claim in a guide needs a test, not a sentence." That rule is right.
This is what it costs.

Measured on 2026-08-10, replacing `AGENTS.md`'s prose claim that no human-chosen
wording reached a model without an editor. The audit had found five instances.
Writing the test found **nine more**, in three waves — and each wave came from
sharpening the guard, not from looking harder at the code.

| Wave | What sharpened | What it found |
|---|---|---|
| Executing the plan | — | 3: the narration and monitor overflow notices, and `" ago at "` with its fallback |
| Scanner saw plain literals | added a third shape | the narration gap sentence, in a file already being scanned |
| Followed one exemption's chain | `not-model-facing` was wrong | 6 in `monitors/runner.ts`, all reaching the chat model |

Fourteen instances against an audit's five. The count never converged because
the guard kept being the limiting factor, and that is the whole lesson.

## Every failure lived in an exemption

Not one was a missed line the scanner walked past. Each was something the guard
had been *told* to skip:

**A category that was factually wrong.** Two Monitor status strings were recorded
as `not-model-facing` with the reason "Never sent to a model." They reach the
chat model: `emit` stamps a `monitorId`, and `monitorRemarksSlot` filters on that
id with no kind filter, so they render into `{monitor_remarks}`. Chasing that one
chain found six more in the Monitor runner.

**A claim about syntax that was true elsewhere.** The scanner skipped plain
string literals, on the stated ground that they are "the shipped Template and
Phrase defaults" — true of `templates.ts` and `phrases.ts`, neither of which was
on the scanned list. The fix was to stop claiming and start asking: walk the
catalogues and skip any literal they actually ship.

```ts
// Not "plain literals are safe because they are defaults" — ask what ships.
function shippedEditableText(): string {
  const out: string[] = [];
  const walk = (v: unknown, d: number): void => {
    if (d > 8) return;
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) for (const x of v) walk(x, d + 1);
    else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x, d + 1);
  };
  walk(promptsModule, 0); walk(PHRASES, 0); walk(SLOT_VOCABULARY, 0);
  return out.join("\n");
}
```

**A file allowlist whose staleness guard used the wrong signal.** Files were
nominated for scanning by "does it call `renderRoleMessage` or `renderPhrase`" —
exactly the signal `coalescer.ts` lacked before the fix. It built its lines and
handed finished strings to someone else, so the guard would not have required the
one file the entire audit existed because of.

## The scanner had three bugs that hid strings

A guard is code, and code you just wrote is untested. All three failed silently —
green test, missing coverage:

- Matching backtick literals **in place** let a pattern run from one literal's
  closing tick to the next one's opening tick, swallowing the code between. Half
  a message handler was reported as one hardcoded string. Fix: *consume* each
  literal as you take it, leaving no gap to span.
- `""` is zero-length, so a one-or-more quote pattern matched *between* two empty
  strings — `inputs.model ?? "", backend: inputs.backend ?? ""` reported the code
  in the middle. Fix: `*`, not `+`, so an empty string is consumed.
- The repo checks out **CRLF** while module values are **LF**, so no multi-line
  shipped default ever matched itself and all nine Template defaults looked
  hardcoded. Fix: normalise both sides — which is also what the template parser
  does first, so it matches production.

## Two regression tests passed against the buggy code

Written for the two pre-existing Monitor bugs, and both were wrong:

- The ordering test put the failure **last** in the batch — where a buffer that
  moves severe events to the end leaves it anyway.
- The `slice(-0)` test asserted on the rendered message, where the render budget
  drops those lines whether or not the bug kept them.

Reverting each fix and re-running is what exposed it. One of the two could not be
made to fail through the public path at all — the defect is real but currently
masked — so it asserts on the buffer directly and says so.

## The rules

**Prove the guard can fail, in the guard.** A test named for what it forbids
should contain the forbidden thing and assert it is caught. Without that, a
scanner that matches nothing looks identical to a codebase that is clean.

**A guard that stops finding things is evidence about the guard.** Fourteen
instances arrived in waves, each after a sharpening. Treat a settled count as
suspicious until the guard has been attacked, not as proof of completeness.

**Audit the exemptions, not the matches.** Every failure here was a skip, not a
miss. The categories, the allowlist, the "this file cannot reach X" claims — that
is where the lies live, because a skip is invisible and a match is not.

**Never let an exemption be granted by shape when one member of that shape is
different.** "Anything in an `error:` field goes only to the client" is true of
every such field here except a Monitor's `problem`, and that single exception was
the mislabel. Name the strings individually and let one written argument cover a
group; the grouping shares the prose, never the scrutiny.

**Leave no category that means "I decided not to decide."** The category list is
deliberately `format | structure | not-model-facing | oracle` with **no**
`wording`: a string that tells a model something gets a Phrase, or the test stays
red. A test with an escape hatch records the very thing it exists to prevent.

**A file left off a list looks the same whether it was considered or forgotten.**
Make exclusions explicit and give each a written reason — and fail on an
exclusion for a file nothing nominates, so the list shrinks when the code does.

**Scope the claim in the prose to what the test actually checks.** `AGENTS.md`
and `CONCEPTS.md` now say what the guard does *not* cover: not every file is
scanned, candidates are nominated by four signals, and the exclusions are part of
the guarantee. An overclaim in a guide is the failure this whole thread began
with.

**Revert the fix and watch the test fail.** See [tests that lock in the
bug](tests-that-lock-in-the-bug.md) and [assert the effect, not the
existence](assert-the-effect-not-the-existence.md). Two of three here passed
against the bug on the first attempt, and sweeping the revert is the only thing
that found it.
