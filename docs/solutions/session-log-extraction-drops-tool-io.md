---
title: A healthy log watcher can still starve its consumer — extract tool targets and outcomes, not just prose
date: 2026-08-05
category: bug
tags: [watcher, claude-code, jsonl, narration, event-extraction, silent-data-loss]
module: server/src/watchers/claude-code.ts, server/src/watchers/watcher.ts, server/src/narration/coalescer.ts
problem_type: integration_issue
component: tooling
severity: high
root_cause: logic_error
resolution_type: code_fix
symptoms:
  - narration describes intent but never names files, commands, or outcomes
  - "most events render content-free: [assistant]  (tools: Read)"
  - a real 185-entry session log yields only 30 events
  - tool failures never reach the narrator, so nothing is ever reported as broken
  - every watcher health signal looks normal — polling, offsets, parse-error counters
---

## Problem

Session observation looked healthy and narrated nothing useful. The watcher's mechanics were
correct and provably so — polling with offset tracking, inode-change re-sync, a stateful
`StringDecoder` for UTF-8 characters split across reads, partial-line buffering that never
counts an unterminated line as malformed, a self-healing parse-error threshold. All tested,
all green. The provider queue, the coalescer and the Ollama model were all fine too.

One layer in, event *extraction* was throwing away nearly everything it read.

## Root cause

`blockText` recognized exactly two block types:

```ts
// before
if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
if (block.type === "tool_use" && typeof block.name === "string") toolUses.push(block.name);
```

Three consequences:

- `tool_use` kept `name` but never `input` — narration knew a tool ran, never on what.
- `tool_result` fell through entirely. A tool-result log entry is `type: "user"` whose content
  is *only* result blocks, so `blockText` returned empty text and `extractEvent` returned
  `null`. Outcomes and errors never reached the narrator at all.
- `thinking` fell through the same way.

Replayed over a real 185-entry session log the extractor produced 30 events, nearly all
rendering as `[assistant]  (tools: Read)`. The narration was vague because it was being fed
content-free lines.

The generalizable form: **an ingestion adapter can pass every liveness check while starving
its consumer of signal.** "Is it running" and "is it extracting meaning" are different
questions, and only the first one is easy to assert.

## Solution

Commit `788efae`. Four changes, in dependency order:

**1. One entry yields many events.** `extractEvent(entry) => SessionEvent | null` structurally
forced a choice between thinking, speaking and calling tools. The fix changed the shape rather
than adding branches:

```ts
export function extractEvents(entry: Record<string, unknown>): SessionEvent[]
```

**2. A tool call carries its target.** `summarizeToolInput` walks a priority list of
identifying arguments (`file_path`, `command`, `pattern`, `url`, …), shortens absolute paths to
their last two segments, and falls back to the first string argument so unknown MCP or plugin
tools still get a label:

```ts
for (const value of Object.values(record)) {
  if (typeof value === "string" && value.trim()) return oneLine(value, TOOL_DETAIL_CLIP);
}
```

Rendered as `Edit(watchers/claude-code.ts)`, `Bash(npm test)`.

**3. Outcomes became a first-class kind, with failures given more room than successes** — a
success only has to say what came back, a failure carries the message HAL must actually report:

```ts
const body = oneLine(result.text, result.ok ? RESULT_OK_CLIP : RESULT_ERROR_CLIP) || "(no output)";
events.push({ at, kind: "tool-result", text: result.ok ? body : `failed: ${body}`, toolUses: [] });
```

**4. The widening happened at the seam, not in the implementation.** `SessionEvent.kind` lives
in `watchers/watcher.ts`, the interface future watchers implement:

```ts
kind: "user" | "assistant" | "thinking" | "system" | "tool-result";
```

Adding kinds there meant auditing consumers that enumerate them. The coalescer's overflow tally
was hardcoded to the old three and would have silently mis-counted the new ones:

```ts
const byKind = { user: 0, assistant: 0, system: 0 };   // before
const byKind = new Map<SessionEvent["kind"], number>(); // after
```

The narrator prompt now documents the tag vocabulary (`[user]`, `[thinking]`, `[tool-result]`,
`(tools: Name(target))`) instead of leaving the model to infer it.

Same log after the fix: 98 events with real content.

## Prevention

**The tests were green the whole time the extractor was starving.** They were not bad tests;
they tested the wrong axis. Every synthetic assistant fixture bundled a `text` block alongside
`tool_use`, so the empty-text-returns-`null` path never ran, and no fixture contained a
`tool_result` block at all — the largest category of real traffic had zero coverage. The suite
asserted the parser's mechanics and never the informational value of its output. `toolUses`
equalling `["Bash"]` passes identically whether or not `Bash` ran on anything.

This was foreseen. `docs/residual-review-findings/feat-hal-1000-v1.md` carries an accepted P2
finding that the watcher tests use synthetic lines instead of the sanitized `*.jsonl` fixtures
the plan called for, and a risk note that tolerant parsing bounds the blast radius of log-format
drift "but not narration quality." Both were right. **That residual is still open** — this fix
was verified by a one-off replay, not by committed fixtures.

Expect this failure mode in any adapter whose consumer is a human or an LLM rather than another
program: nothing crashes, nothing is red, the output is merely empty of meaning.

### For the next watcher (codex/generic is on the roadmap)

Anything implementing `LogWatcher` and emitting `SessionEvent` should, before writing a test:

1. **Dump the real log first.** Tally distinct entry `type` values and, inside structured
   content, distinct block `type` values with counts. Whatever dominates by volume is what the
   extractor must handle well; a block type never seen in a real file is the one that gets
   silently dropped.
2. **Replay before asserting.** Run the extractor over that real file, render through
   `eventLine`, and read it as the narrator will. Count how many lines are content-free — that
   number, not the event count, is the health metric.
3. **Test every real block type including the negative shapes** — empty result, error result,
   list-form content, and an entry whose content is *only* a result. The v1 gap existed
   precisely because no fixture had a result-only entry.
4. **Reuse the seam's vocabulary.** Map onto `thinking` and `tool-result` rather than inventing
   parallel names, or the narrator prompt and the coalescer tally drift apart.
5. **Grep for consumers that enumerate kinds** before adding one. The coalescer tally is the
   template for what silently breaks.
6. **Finish with one live model call** on a real drained batch. That is the only check that
   answers "is the narration grounded." Here it moved the output from generic filler to
   "It ran typecheck and test first; both came back green…".

Plan U6's acceptance criterion — "attach to a real running session and observe parsed events
arriving near-live" — measures arrival, not content, so a starved extractor passes it cleanly.
Assert on content when writing the next one.

### Environment facts and scope limits

- **Claude Code persists `thinking` blocks redacted** — signature present, `thinking` string
  empty. Across two real logs, 0 of 145 thinking blocks carried content. The kind is wired end
  to end but will essentially never fire on current Claude Code; the code guards for it
  deliberately rather than emitting empty events. Don't debug missing thinking events.
- **Sidechain (subagent) traffic is still skipped**, unchanged by this fix — `extractEvents`
  returns `[]` for `entry.isSidechain === true`, so delegated work stays invisible to narration.
  Known v1 limitation.
- `tool_use`/`tool_result`/`thinking` are content blocks *inside* user and assistant entries,
  not new entry types — the fix does not loosen the plan's rule about which entry types feed
  narration.

## Related

- `../residual-review-findings/feat-hal-1000-v1.md` — the synthetic-fixtures residual this bug
  is the direct consequence of, and the log-drift risk note that predicted it.
- `../plans/2026-08-02-001-feat-hal-1000-harness-v1-plan.md` — U6's fixture requirement and its
  arrival-only verification criterion.
- `./ws-library-reemits-server-errors.md` — same subsystem, opposite failure class: a pipeline
  that dies loudly, versus one that stays alive delivering nothing.
