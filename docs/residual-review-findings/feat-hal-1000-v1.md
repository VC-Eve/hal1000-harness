# Residual review findings — feat/hal-1000-v1

Source: ce-code-review run `20260802-100330-aa296e08` (7 reviewers, Tier 2), user decision: accept and proceed.
Artifacts: `/tmp/compound-engineering/ce-code-review/20260802-100330-aa296e08/`

## Accepted actionable findings

- P2 `shared/src/types.ts:1` — **shared/ has no workspace identity** (maintainability, 75). Every consumer hand-computes `../` depth (four different depths for one file). Fix direction: promote `shared/` to an `@hal1000/shared` npm workspace or add a tsconfig path alias; touches every import, best done as a standalone mechanical PR.
- ~~P2 `server/test/watchers/claude-code.test.ts:46` — **watcher tests use synthetic log lines, not sanitized fixture files** (project-standards, 75). Plan U6 calls for `server/test/fixtures/*.jsonl` sanitized from real observed logs; current tests synthesize equivalent lines inline. Fix direction: capture sanitized real-session fixtures and point discovery/tail/filter tests at them.~~ **Closed 2026-08-05.** `server/test/fixtures/claude-code-session.jsonl` covers every entry and content-block shape inventoried from 8,872 real entries across 11 logs; the fixture suite asserts on event *content*, not just arrival. Deferring this is what let the extraction defect in `docs/solutions/session-log-extraction-drops-tool-io.md` survive a green suite.
- P3 `server/src/chat.ts:92` — **messages sent to a deleted conversation vanish without acknowledgement** (adversarial, 75, advisory). Multi-tab edge: `appendMessage` returns null and the send is silently dropped. Fix direction: broadcast a `conversation_missing` error on null store returns.

## Notable residual risks (report-only)

- Narration can be starved indefinitely by sustained back-to-back chatting (each chat aborts and requeues the same batch; no attempt counter or backoff).
- Only a header-phase deadline (30s) guards Ollama chat calls; a stream that stalls mid-body still wedges the single-lane queue until preempted.
- `ProviderFactory(endpoint)` conflates connection info with provider selection; adding Anthropic/OpenAI (R8) will widen this signature.
- Claude Code log-format drift remains the largest external dependency risk; tolerant parsing and unreadable-state degradation bound the blast radius but not narration quality. **This came true** — see `docs/solutions/session-log-extraction-drops-tool-io.md`. `server/test/fixtures/README.md` now records the observed shape inventory to re-check drift against.
- Import-extension convention differs between server (`.js` suffix) and ui (extensionless); harmless under `moduleResolution: Bundler`, worth standardizing alongside the shared/ workspace change.

## Operational validation

Local single-user tool; no production deployment surface. Healthy signals: `npm start` prints the operational banner; `/api/health` returns `{ok:true}`; console stays free of `chat handler error` / `narration handler error` / `Unhandled rejection` lines during normal use. Failure signal worth watching: repeated `WS client error` or watcher `unreadable` states on healthy sessions. Rollback: `git revert` of the offending commit; conversations/settings live outside the repo in the per-OS data dir and survive any rollback.
