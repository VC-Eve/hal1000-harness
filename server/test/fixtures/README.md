# Watcher fixtures

`claude-code-session.jsonl` is the reference sample of the Claude Code session-log format the
watcher parses. It closes the accepted P2 residual in
`docs/residual-review-findings/feat-hal-1000-v1.md` (watcher tests previously synthesized log
lines inline, which is how the extraction gap in `docs/solutions/session-log-extraction-drops-tool-io.md`
survived a green suite).

## Provenance

Sanitized by construction, not by scrubbing: the entry types, key sets, and content-block shapes
were inventoried from 8,872 real entries across 11 local session logs, then re-authored with
synthetic paths, ids, prompts, and outputs. No real prompt text, path, or tool output is present,
so the file is safe to commit and to share.

Observed at the time of capture (Claude Code 2.x, 2026-08-05):

| Shape | Real-world frequency | In fixture |
| --- | --- | --- |
| `tool_result` with string content | 1765 | yes |
| `tool_result` with list-of-blocks content | 139 | yes |
| `tool_result` with `is_error: true` | 78 | yes |
| `tool_result` with empty content | present | yes |
| `thinking` block with content | **0 of 1010** — persisted redacted | yes, empty (as observed) |
| `system` with a `content` string | 49 of 193 | yes |
| `system` metadata-only (`isMeta`, subtype) | 144 of 193 | yes |
| `isSidechain: true` | **0** — never observed | yes, defensively |

Two entries are deliberately *not* representative of the sample, and are here to pin behavior the
real logs cannot currently exercise:

- the **sidechain** entry — no local log has ever contained one, but the filter exists and must
  keep working if subagent traffic starts landing in the main log
- the **`mcp__demo__lookup`** tool call — takes no argument from the known-key priority list, so it
  pins the fallback that gives unknown MCP and plugin tools a usable label

## Refreshing

Re-inventory before assuming this still matches reality — the log format is the largest external
dependency risk in the project. Count entry types and content-block types across real logs under
`~/.claude/projects/*/`, compare against the table above, and add any new shape here **with a test**
rather than only handling it in the parser. A shape that exists in real logs but not in this file is
exactly the blind spot that caused the original defect.
