# HAL 1000 Harness — agent guide

Local, single-user, HAL 9000-styled LLM harness: Ollama-backed chat with persistent
history plus a live HAL-persona narration feed of Claude Code sessions. Windows is
the primary dev OS; macOS/Linux are launch targets.

## Commands

- `npm run start` — production mode: core serves the built UI at http://localhost:9000 (`HAL_PORT` overrides)
- `npm run dev:server` + `npm run dev:ui` — dev mode: Vite serves the UI and proxies `/api` + `/ws` to the core
- `npm test` (vitest) — full suite; `npm run typecheck` — both tsconfigs; `npm run build` — UI bundle to `ui/dist`
- Test env overrides: `HAL_DATA_DIR` (storage), `HAL_CLAUDE_PROJECTS_DIR` (watched logs)

## Layout

- `shared/src/types.ts` — the single source of truth for the WS wire contract (every `ClientMessage`/`ServerMessage`) and shared data shapes. All meaningful behavior must be reachable through this protocol, never UI-only (agent-native parity rule).
- `server/src/` — core process. Seams that must stay intact: `providers/provider.ts` (Anthropic/OpenAI slot in later), `watchers/watcher.ts` (codex adapters later), `monitors/monitor.ts` (the runner seam for new acquisition modes). `providers/queue.ts` enforces chat-preempts-narration; narration aborts and re-queues, chat is never aborted by scheduling. Monitors are the second observation role and deliberately do not pass through `watchers/registry.ts`: that class holds one watched session, and a Monitor is configured, plural, and standing.
- `ui/src/` — React client. `store.ts` reducer owns all server-message state; persona copy lives in `persona.ts` keyed by typed `PersonaCopyKey`.
- Tests mirror source: `server/test/**`, `ui/test/**`. Feature behavior gets tests; visual HAL aesthetic is verified by screenshot, not assertions.

## Conventions and hard rules

- The server binds `127.0.0.1` only, and the WS hub rejects non-localhost browser origins — never widen either.
- Client-supplied conversation ids must stay UUID-validated (they become file paths).
- Server relative imports use the `.js` suffix; ui imports are extensionless (works under `moduleResolution: Bundler`; standardize only alongside the shared/-workspace refactor).
- Storage writes go through `storage/atomic.ts` (unique temp + rename with EPERM/EBUSY retry); per-conversation mutations go through the store's internal lock.
- Fire-and-forget async handlers must `.catch` — see `docs/solutions/` for the crash lessons.
- No linter configured yet; typecheck + tests are the gate.

## Key documents

- Product/requirements: `docs/brainstorms/2026-08-02-hal-1000-harness-requirements.md`
- Implementation plan (completed): `docs/plans/2026-08-02-001-feat-hal-1000-harness-v1-plan.md`
- System prompts are stored, not hardcoded: `docs/plans/2026-08-06-001-feat-editable-system-prompts-plan.md`
  and its origin brief. Shipped defaults and presets live in `shared/src/prompts.ts`; a stored
  `null` means "never edited" and resolves to the shipped default at read time.
- Ambient log monitors: `docs/plans/2026-08-06-002-feat-ambient-log-monitors-plan.md` and its origin
  brief. Monitor commands cross `cmd.exe` and then PowerShell on Windows — a `\s` written in a
  command loses its backslash on the way and matches a literal `s`, so use character codes instead.
- Accepted review residuals / agreed follow-ups: `docs/residual-review-findings/feat-hal-1000-v1.md`
- Institutional learnings: `docs/solutions/` — flat kebab-case docs with YAML frontmatter (`category`, `module`, `tags`, `symptoms`); relevant when debugging or extending a documented area
- Shared domain vocabulary: `CONCEPTS.md` — entities, named processes, and status concepts

## Deferred roadmap (do not build uninvited)

Anthropic/OpenAI providers; codex/generic watchers; critic + copilot narration stages;
desktop packaging (Electron vs Tauri undecided); voice output; shared/ workspace identity.
