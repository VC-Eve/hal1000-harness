# HAL 1000 Harness — agent guide

Local, single-user, HAL 9000-styled LLM harness: chat with persistent history plus a
live HAL-persona narration feed of Claude Code sessions. Speaks two inference
protocols — Ollama's native API and the OpenAI-compatible `/v1` shape, which reaches
llama.cpp, LM Studio, vLLM and hosted APIs. Windows is the primary dev OS;
macOS/Linux are launch targets.

## Commands

- `npm run start` — production mode: core serves the built UI at http://localhost:9000 (`HAL_PORT` overrides)
- `npm run start:recogniser` — the face recogniser sidecar on 127.0.0.1:8100; see `recogniser/README.md`
- `npm run dev:server` + `npm run dev:ui` — dev mode: Vite serves the UI and proxies `/api` + `/ws` to the core
- `npm test` (vitest) — full suite; `npm run typecheck` — both tsconfigs; `npm run build` — UI bundle to `ui/dist`
- Test env overrides: `HAL_DATA_DIR` (storage), `HAL_CLAUDE_PROJECTS_DIR` (watched logs)

## Layout

- `shared/src/types.ts` — the single source of truth for the WS wire contract (every `ClientMessage`/`ServerMessage`) and shared data shapes. All meaningful behavior must be reachable through this protocol, never UI-only (agent-native parity rule).
- `server/src/` — core process. Seams that must stay intact: `providers/provider.ts` (a `ResolvedBackend` in, a `Provider` out; `providers/factory.ts` is the one protocol switch), `watchers/watcher.ts` (codex adapters later), `monitors/monitor.ts` (the runner seam for new acquisition modes). `providers/resolve.ts` is the only route from an inference role to a backend — narration, monitors and vision are pinned to the observation one by construction, and adding a fifth role means adding it there. `providers/queue.ts` enforces chat-preempts-narration **on the same backend only**; narration aborts and re-queues, chat is never aborted by scheduling. Monitors are the second observation role and deliberately do not pass through `watchers/registry.ts`: that class holds one watched session, and a Monitor is configured, plural, and standing.
- `ui/src/` — React client. `store.ts` reducer owns all server-message state; persona copy lives in `persona.ts` keyed by typed `PersonaCopyKey`.
- `recogniser/` — the face recogniser sidecar, a third workspace and its own process. HTTP in, faces
  with boxes, landmarks and embeddings out; it holds no state between calls, so appearance continuity
  stays HAL's job. It is the only workspace with a native dependency (`onnxruntime-node`, ~259MB
  hoisted to the root on install), which is exactly why it is not in `server/`. Nothing in `server/`
  is consumed by server/src/vision/recogniser.ts.
- Tests mirror source: `server/test/**`, `ui/test/**`. Feature behavior gets tests; visual HAL aesthetic is verified by screenshot, not assertions.
- Component tests live in `ui/test/components/**/*.test.tsx` and are the only suite that runs under jsdom (`environmentMatchGlobs` in `vitest.config.ts`); everything else stays in node. Use `ui/test/components/harness.tsx` for state fixtures and a recording `send`. They exist for behavior a reader cannot check by eye — disabled states, what is sent, and **how often an effect runs** — not for appearance. A component must survive an unstable `send`: depending on it in an effect once produced an unbounded request loop.

## Conventions and hard rules

- The server binds `127.0.0.1` only, and the WS hub accepts a browser origin only on its own port — never widen either. Any loopback port used to be allowed; that stopped being safe once `add-monitor` could schedule shell commands. `HAL_DEV_ORIGIN` adds one origin for a non-standard dev setup; Vite's dev origin is trusted only under the `dev` script. Requests with no `Origin` stay allowed so agents keep protocol access.
- **The WS hub requires a per-boot token before any handler runs, and before any broadcast reaches a socket.** The first message on a connection must be `{"type":"authenticate","token":"…"}`; anything else closes it, and an unadmitted socket receives nothing at all. Agents read the token from `ws-token` in the data dir (`%APPDATA%/hal1000` on Windows) — it is minted fresh each boot, so re-read it after a restart. The browser gets it stamped into the served `index.html`; under `npm run dev:ui` only, the UI falls back to `/api/ws-token`, a route that does not exist in production. The origin check still runs first — the token is a second gate, not a replacement, and it is what closes the hole the origin allowlist leaves open while `dev:ui` is running.
- Client-supplied conversation ids must stay UUID-validated (they become file paths).
- Server relative imports use the `.js` suffix; ui imports are extensionless (works under `moduleResolution: Bundler`; standardize only alongside the shared/-workspace refactor).
- Storage writes go through `storage/atomic.ts` (unique temp + rename with EPERM/EBUSY retry); per-conversation mutations go through the store's internal lock.
- Fire-and-forget async handlers must `.catch` — see `docs/solutions/` for the crash lessons.
- No linter configured yet; typecheck + tests are the gate.
- **A test that resolves a backend must pin the protocol — use `pinnedSettings` from `server/test/settings.ts`.** Stubbing the `ProviderFactory` is not isolation: `backendForRole` resolves a protocol first, and on the default `auto` that is a real 2s HTTP probe to `localhost:11434`. Under a parallel suite it times out, the backend resolves to null, and the assertion fails with an empty string or a zero count rather than anything naming the cause. This was most of the suite's "timing flakiness"; see `docs/solutions/a-stubbed-factory-is-not-isolation-if-something-resolves-first.md`.
- **Wait for a condition, not a duration — `waitFor` from `server/test/wait.ts`.** A fixed sleep before a positive assertion is a guess about how long work takes, and it loses under a parallel suite while blaming the assertion. Polling returns as soon as the work lands, so it is usually faster too. Keep a fixed sleep only before a *negative* assertion ("wait, then check nothing happened" has no condition to poll) or when counting events over a window.
- **A test fixture's `now` is built from local components, never a UTC string.** `clockTime`
  and `entryStamp` in `shared/src/prompts.ts` read local hours, so `new Date("…T18:22:04Z")`
  bakes this machine's offset into every asserted timestamp and the suite fails on a machine
  set to another zone. `new Date(2026, 7, 9, 18, 22, 4)` renders as 18:22:04 everywhere.
- **Tests take temp directories from `server/test/tmp.ts` (`tmpDir`, or `sharedTmpDir` for a `beforeAll` fixture), never from `fs.mkdtemp` directly.** Cleanup rides on creation, so there is no second thing to remember — fifteen files that called `mkdtemp` with no cleanup hook left 46,507 directories in `%TEMP%` in a week. Hygiene rather than a fix: purging them changed the failure rate by nothing. Eighteen other files clean up by hand and still do; new tests use the helper.

## Key documents

- Product/requirements: `docs/brainstorms/2026-08-02-hal-1000-harness-requirements.md`
- Implementation plan (completed): `docs/plans/2026-08-02-001-feat-hal-1000-harness-v1-plan.md`
- System prompts are stored, not hardcoded: `docs/plans/2026-08-06-001-feat-editable-system-prompts-plan.md`
  and its origin brief. Shipped defaults and presets live in `shared/src/prompts.ts`; a stored
  `null` means "never edited" and resolves to the shipped default at read time.
- **Every message HAL sends is rendered from a template** — `shared/src/templates.ts` is the
  language (slots, conditional blocks, nothing else) and the per-role slot vocabulary; the
  shipped defaults are in `shared/src/prompts.ts`. The four render call sites go through
  `server/src/templates/`. Composition is deliberately NOT in the language: joining surviving
  sections, omitting the preamble when nothing sits under it, and giving back lines to make
  room for a truncation notice all live in slot renderers, because reaching them from a
  template would mean adding expressions. Byte identity with the assembly this replaced is
  the load-bearing property and is pinned three times — golden snapshots of the pre-template
  assembly in `server/test/chat/context-golden.test.ts`, budget sweeps in
  `context-template-parity.test.ts`, and an oracle of what the template era itself renders in
  `server/test/templates/oracle.test.ts`. The third covers every role plus the redaction,
  emitted, degraded and dropped lists, and is the only guard the Monitor source has.
  **Do not re-record those snapshots to make a change pass**; a diff there means every
  existing install would start hearing something different. See
  `docs/solutions/byte-identity-needs-an-oracle-recorded-first.md`.
  A Conversation's own prompt is a template too, but opt-in per thread
  (`promptIsTemplate`): a prompt written before templates is read literally so its braces
  survive — and the parser does not render an unrecognised brace literally, it reports a bad
  name and DROPS the text, which is why the opt-in exists at all.
  Its vocabulary is the whole conversation-context one. That used to be `{context}` and
  `{clock}` only, to stop a reading rendering twice with the second copy outside the budget,
  the gate and the redaction list — but the hazard was two renders with two ledgers, not
  repetition. The two are one pass now (`server/src/templates/merged.ts`): a reading named in
  the prompt and again inside `{context}` is drawn once, charged once, redacted once. Keep
  that property by construction; do not restore the short vocabulary to get it back.
  `{context}` expands as a named GROUP, not a block. A block holds when the slot of its own
  name produced text and a group has no such slot; a block drops only when its body trims to
  empty and a group must drop with a preamble and headings still in it. The group's verdict
  reads the ledger's per-occurrence record, never `emitted` — `emitted` is charge-gated, so a
  repeated reading appears in it once, at the earlier mention, outside the group. That
  decision has now been implemented wrongly three times; see
  `docs/solutions/a-fix-teaches-a-pattern-go-looking-for-it.md`.
  Charging and emitting are different numbers once a reading can repeat. The repeat costs no
  budget but its characters are in the message, so the render also bounds emitted characters
  per source against the same Context Levels.
  The six settings-level prompts are Templates too, each with its own is-template marker —
  two of them inside `VisionSettings`, merged by `mergeVision` and not by `merge`.
  Universal readings (`{clock}`, `{date}`, `{model}`, `{backend}`) reach every role through
  `vocabularyFor(role)`, which is the only place a role's slot list is read. They are
  deliberately NOT on the explicit-vocabulary path phrases use.
  Every message is template-driven and most LINES inside one are a Phrase
  (`shared/src/phrases.ts`). This used to claim there was no human-chosen wording left reaching
  a model without an editor. That was false and had been for some time: the Vision cycle's
  caption line is assembled in `server/src/vision/service.ts` — the `[`, the `] ` and the
  ` and ` have no editor, while every sibling line has a Phrase. Found by a user asking why a
  slot was unavailable, not by a review or a test. See
  `docs/plans/2026-08-10-002-fix-audit-hidden-prompt-wording-plan.md` for the audit, and
  `docs/solutions/extending-a-catalogue-is-not-auditing-it.md` for why prose is the wrong place
  to assert completeness. The syntax sheet lives in `ui/src/components/TemplateHelp.tsx`.
  One case deliberately differs and is named in a test. Phase two (merging the six prompt
  settings into their templates) is not started — see
  `docs/plans/2026-08-09-003-feat-editable-prompt-templates-plan.md` and
  `docs/residual-review-findings/feat-editable-prompt-templates.md`.
- Ambient log monitors: `docs/plans/2026-08-06-002-feat-ambient-log-monitors-plan.md` and its origin
  brief. Monitor commands cross `cmd.exe` and then PowerShell on Windows — a `\s` written in a
  command loses its backslash on the way and matches a literal `s`, so use character codes instead.
- Vision needs a captioner running before it can see: a llama.cpp `llama-server` HAL points at, never
  starts. The install steps and the exact command live in `shared/src/vision.ts` and are rendered in
  the app where the fault appears — change them there, not in a second copy.
- Vision, the third observation role: `docs/brainstorms/2026-08-06-webcam-observation-requirements.md`.
  The captioner is a separate local process outside Ollama and outside `ProviderQueue` — only the
  cycle summary is a queued narration job. Frame capture shells out to ffmpeg; a webcam is an
  exclusive device, so "in use by another application" is a routine path, not an edge case.
- Accepted review residuals / agreed follow-ups: `docs/residual-review-findings/` — one file per shipped
  feature. `feat-ambient-log-monitors.md` covers the origin/command-execution P0: narrowed by the
  own-port allowlist, with a per-boot token handshake still outstanding as the complete fix. Read it
  before touching `server/src/ws.ts` or the monitor command path.
- Institutional learnings: `docs/solutions/` — flat kebab-case docs with YAML frontmatter (`category`, `module`, `tags`, `symptoms`); relevant when debugging or extending a documented area
- Shared domain vocabulary: `CONCEPTS.md` — entities, named processes, and status concepts

## Providers and backends

The OpenAI-compatible provider is **shipped**, so HAL is no longer Ollama-only. Settings carry two
independent backends named for what sends there: `chat`, and `observation` (narration, monitors,
vision). Both are always configured and both default to the same endpoint; neither follows the other,
and `copyFrom` on a patch moves endpoint, protocol and key between them in one server-side move —
server-side because a client is never told a key. An endpoint's protocol is probed rather than
declared, cached per endpoint, and overridable by hand; a failed probe is deliberately not cached so
a server started later is still found. Ollama wins when a server answers both routes, and a test
named for the reason pins it — the OpenAI schema has no `num_ctx`, and Context Level sizes itself
against a window HAL requests per request.

`slotForRole` in `providers/resolve.ts` is the only route from a role to a backend; the three
observation roles return `observation` with no branch that could return anything else.

`list-models` answers **per backend** — one `models` message per slot, carrying `slot`. A model list
belongs to a server, so a flat list meant the narration picker offered chat's models: invisible while
both slots named one machine, wrong as soon as they did not. Windows and `windowSource` ride only on
chat's message, because Context Level sizes a conversation's request. Each model picker lives inside
its backend's card for the same reason.

API keys live in `backend-keys.json`, never in `settings.json`, because settings are broadcast whole
on every connection — there is nothing to redact rather than a redaction to remember. `hasKey` is
derived from the key store, so a client cannot assert a key exists by sending the flag.

`readiness.ollama` is gone; it is `observationBackend` plus `chatBackend`, both always probed. One
probe when the two name the same **destination** — endpoint, resolved protocol and key presence, not
endpoint alone. That distinction is `sameDestination` vs `sameHost` in `providers/provider.ts`, and
both readiness and `list-models` reach it only through `providers/probe.ts`, which is the one place
that asks whether two slots share a destination. Do not compare backends anywhere else. The queue
deliberately keeps `sameHost`: contention is about which machine is busy, and a test is named for
that reason so the asymmetry does not read as an oversight. The `models` leg reports on both slots —
a reachable backend listing nothing is `none` whichever slot it serves. See
`docs/plans/2026-08-09-001-feat-openai-compatible-provider-plan.md` and
`docs/plans/2026-08-09-002-refactor-backend-identity-invariant-plan.md`.

## Deferred roadmap (do not build uninvited)

Codex/Claude Code as CLI-subprocess providers (both CLIs are installed and have headless modes;
the draw is subscription billing rather than protocol coverage, and they are agent surfaces with no
model list, no messages array and no URL — see the plan's Scope Boundaries); per-backend queue
concurrency beyond the preemption fix; an automatic fallback chain when a backend is down;
codex/generic watchers; critic + copilot narration stages;
desktop packaging (Electron vs Tauri undecided); voice output; shared/ workspace identity.
For Vision: a change gate ahead of the captioner, and correlated narration across all three
observation roles. The seams are cut (R20, R21); nothing is started.
Face recognition is **shipped and running**, not deferred: the `recogniser/` sidecar, plus HAL-side
readiness leg, settings, detection loop, appearance continuity, gallery, and a triage queue for
naming faces later. `VisionObservation.identity` now carries one of three banded forms rather than
the hedge only — see Identity Band in `CONCEPTS.md`. The gallery is editable (rename with
merge-on-collision, prune one face, add a face from a picture) and people carry a Character Profile,
with one markable as the Operator. The biometric purge is built.
The vision-to-chat seam is **shipped**: a Conversation carries two context switches — what HAL can
see, and what it has been saying about the Watched Session — assembled per request and never written
to `conversations/*.json`. A level is a share of the model's window rendered as characters, because
installed models span 2k to 262k tokens and one fixed count cannot mean the same thing on both;
`num_ctx` is now set on chat requests the way every narration path already set it. The off-machine
acknowledgement is built and checked at the **send**, not at the toggle. See
`docs/plans/2026-08-08-003-feat-conversation-context-injection-plan.md`.

R10 is **discharged**: the acknowledgement gates the recogniser too, at the one point all three
senders pass through (`recogniserFrom` in `server/src/vision/service.ts`) — the detection loop,
enrolling from the camera, and enrolling from a file. Do not add a fourth sender that bypasses it.

Still deferred: correcting a wrong match, and expiry of a queued face. Chat replies get no
band-aware output check: the reply streams token by token, so a post-hoc check cannot unsay what
already rendered, and input gating carries it instead.
See `docs/residual-review-findings/feat-recognition-identity-and-profiles.md`. See
`docs/brainstorms/2026-08-07-vision-face-recognition-requirements.md`, the two plans dated
2026-08-07, and — before changing any of it — the three residual files
`feat-recognition-loop.md`, `feat-enrolment-candidates.md`, and `feat-vision.md`.

The Vision Timeline is shipped too: every check and every caption on disk under `vision-timeline/`,
read by the Vision pane. Recognition Weight rides on it and **decides nothing** — banding,
narration, profile delivery and the candidate queue all read the current frame's confidence, and
each check records the band weight *would* have chosen so promoting it later is a measurement. Four
call sites make swapping weight in look natural; a test named "changes nothing HAL says" is the
guard. See `docs/plans/2026-08-08-002-feat-vision-timeline-and-weight-plan.md`.

Two constants in `server/src/vision/appearances.ts` are measured, not chosen: live same-person
similarity across independent captures is 0.53–0.78, so the continuity bars sit under that floor.
A test pins the range. Do not raise them without re-measuring — the first attempt used synthetic
variants and fragmented one visitor into seventeen appearances.
