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
- `npm run tempo:report -- "D:/Music/Drum and Bass"` — measure a folder of **real** music and print,
  per file, the tempo the beat tracker was running at, the tempo chosen, which octave that is, and
  the alternative with its weights (`--limit N`, `--json`). This is the acceptance test for the
  soundtrack brief's R31 — a detector may be used only if it covers 60–200 and says which octave it
  chose — and it is a script rather than a test because the claim is about recordings and this repo
  has none. A synthetic click track measures the generator; see
  `docs/solutions/a-measurement-on-synthetic-variants-measures-your-own-transform.md`. **Until it has
  been run on real drum & bass, R31 is open**, and the brief's stated fallback — ship no detector —
  is still the live alternative.
- Test env overrides: `HAL_DATA_DIR` (storage), `HAL_CLAUDE_PROJECTS_DIR` (watched logs)
- `HAL_CLIP_LIBRARY` — where the clip browser opens before it has been anywhere. After that it opens
  where it last was, remembered in `last-library.json` in the data dir; the env var is the fallback
  for a first run, and the home directory is the fallback for that.
- `HAL_AUDIO_LIBRARY` — the same for the track browser, which opens on a different place on the
  drive. Session-remembered only: unlike the clip root it is not written to disk, because
  `last-library.json` is the World store's file and the audio store has no equivalent yet.

## Layout

- `shared/src/types.ts` — the single source of truth for the WS wire contract (every `ClientMessage`/`ServerMessage`) and shared data shapes. All meaningful behavior must be reachable through this protocol, never UI-only (agent-native parity rule).
- `server/src/` — core process. Seams that must stay intact: `providers/provider.ts` (a `ResolvedBackend` in, a `Provider` out; `providers/factory.ts` is the one protocol switch), `watchers/watcher.ts` (codex adapters later), `monitors/monitor.ts` (the runner seam for new acquisition modes). `providers/resolve.ts` is the only route from an inference role to a backend — narration, monitors and vision are pinned to the observation one by construction, and adding a fifth role means adding it there. `providers/queue.ts` enforces chat-preempts-narration **on the same backend only**; narration aborts and re-queues, chat is never aborted by scheduling. Monitors are the second observation role and deliberately do not pass through `watchers/registry.ts`: that class holds one watched session, and a Monitor is configured, plural, and standing.
- `ui/src/` — React client. `store.ts` reducer owns all server-message state; persona copy lives in `persona.ts` keyed by typed `PersonaCopyKey`.
- `recogniser/` — the face recogniser sidecar, a third workspace and its own process. HTTP in, faces
  with boxes, landmarks and embeddings out; it holds no state between calls, so appearance continuity
  stays HAL's job. It is the only workspace with a native dependency (`onnxruntime-node`, ~259MB
  hoisted to the root on install), which is exactly why it is not in `server/`. Nothing in `server/`
  is consumed by server/src/vision/recogniser.ts.
- `server/src/live/` — live state machines, the fourth subsystem and the only one that reaches no
  model at all. It is Unity's Animator over video: **States** own a looping clip set, **transitions**
  carry conditions, has-exit-time and an author-set order, and **Any State**, **Triggers** and
  **Mute/Solo** mean what they mean there. A State and a transition each hold a *set* of **sequences**
  and draw one — never the run that just played — so a World does not read as one gesture repeating.
  A sequence is one or more clips played in order; a set whose runs each hold one clip is the flat set
  of version 3, which is what a migrated World holds and why it plays identically. A run whose member
  cannot be played leaves the draw *whole* rather than playing its survivors. A
  transition whose set is empty is the instant cut it always was, and one with clips plays a
  **bridge** and is *in transit* while it does. That bridge carries the subsystem's load-bearing
  invariant: **while a crossing is live, nothing is evaluated at all** — no wake point, no Parameter,
  not Any State. A State can ask for the same rule with its `atomic` switch, off by default and
  absent on a transition, where the invariant is not optional. Suppressing wake points is only half of
  holding: a Parameter set from outside schedules nothing and evaluates on the spot, so `holding` is
  checked in `onTrigger` and `setParameter` exactly as `crossing` is, and cleared in `supersede` so a
  faulted run cannot leave the machine holding forever. Two armed waits is how a clip-end report resolves the wrong one, which
  `docs/residual-review-findings/feat-live-scene-worlds.md` records happening once already. A **World** is a portable folder under
  `worlds/` in the data dir (`world.json` plus `clips/`), so its manifest is untrusted input:
  `storage/worlds.ts` rebuilds a loaded World by spreading the parsed value, confines every clip path
  through `fs.realpath` on both sides, and loads an unparseable manifest read-only rather than letting
  the next mutation overwrite a hand edit. Migration is per set and asks the *members* what shape they
  are rather than trusting the World's one version number, so it stays idempotent — it runs on every
  load and every mutation, and a second wrap would bury the clips a level deeper on each rename. It
  also refuses to *write* a manifest whose `version` is
  not this build's — the camera-era layout parses as a machine with no States, so a version gate is
  the difference between a refusal and a silent erasure.
  The machine is **server-side** (`live/runtime.ts`) and owns its own clock — a clip's end and its
  exit-time wake-ups fire from timers seeded by a duration the browser measured and sent, so a
  Parameter set by an agent drives the machine with nothing watching; a client's clip-end report is a
  resync signal carrying the World, State and generation it was issued for, and anything else is
  discarded. Graph questions — which transition fires, dead ends, unreachable States — are pure and
  live in `shared/src/world-graph.ts` so the server can answer them over the protocol and the graph
  can draw the same result; jsdom implements no SVG layout, so that split is a constraint rather than
  a preference. Clips are chosen by browsing the drive (`live/library.ts`, one folder at a time) and
  **copied into the World** on pick, so a World never names a path outside itself. `/api/live/clip`
  rests on the host check alone (a `<video>` sends no Origin and cannot present the token — the same
  accepted trade as `/api/vision/stream`) and serves only clips the manifest references.
  `/api/live/audio` is the third route on that trade and takes it for the same reason — an `<audio>`
  element sends no Origin either — and serves only tracks some playlist index names. The two media
  routes share one `sendMedia` tail so the range handling and the `no-store`/`nosniff` pair cannot be
  added to one and forgotten on the other; their guards stay separate because the authorities differ,
  a manifest against a playlist index. The token debt this leaves is owed three times now and is
  recorded in `docs/residual-review-findings/feat-live-audio-soundtrack.md`.
  **Exactly one client sounds.** The server elects an audio authority per socket
  and says so in `audio-authority`, which rides on the greeting because a
  connect-time replay is a push by another name; every other client renders the
  transport read-only. The election is checked on the **inbound** transport
  command, the position correction and the failure report as well as on what is
  sent out — a gate that checks one direction is half a gate, and a read-only tab
  would otherwise drive the transport it is only supposed to display. Two states
  are kept apart on purpose: the **clock** keeps running when the authority
  disconnects, because a World unattended must take the same transitions, while
  `audible` drops, because nothing is making a sound — a stale reading served
  confidently is worse than an error. A browser announces itself with `attend`
  and a playlist armed from then on is *held* rather than started, because
  `play()` on an unmuted element needs a user activation; `enable-sound` is the
  gesture, and it starts what was armed and nothing else.
  **Effects** are how a World changes its own Parameters: one operation from the registry in
  `shared/src/effects.ts`, applied on an interval, scoped either to a State (live only while the
  machine is *in* it, and never during a crossing — `stateId` still names the **source** State
  throughout a bridge) or to the World (live wherever the machine is, and silent while it holds a
  fault, because resting loudly beats looping quietly). That registry is the single registration
  point: validation, the panel's offer rule and the runtime all read it, so an eighth operation is an
  edit there and nowhere else, and `bounce` is the only one that moves a value both ways.
  Three rules are load-bearing and each has a test that fails without it. **The machine evaluates
  once a tick, not once a write** — a write that evaluated immediately would let an Effect firing
  faster than a destination's usability check supersede the in-flight transition on every fire and
  starve the move completely, and would let an earlier Effect in an author's list move the machine
  before a later one ran; a write producing the value already held evaluates and broadcasts nothing.
  **An Effect never fires on arrival**, and its key carries a **visit** counter, because `enter()`
  runs once per turn of a State's clip rather than once per visit — an interval measured from `enter`
  restarts on every loop, and a five-second Effect on a three-second clip would never fire at all.
  **The Effect clock is a field beside `pending`**, armed by `start` and cleared by `stop` *only*:
  `supersede` and a re-seat both clear the clip wait, and a clock that went with them would stop the
  moment the machine moved. Every Parameter write — an Effect, the protocol, seeding a default at
  `start` or on a re-seat, lowering a Trigger — goes through one clamped path, and that path had to
  be *built* rather than inherited: three of those wrote the values map directly, so a Parameter
  could hold a value outside its own declared range from the moment the World opened.
- Tests mirror source: `server/test/**`, `ui/test/**`. Feature behavior gets tests; visual HAL aesthetic is verified by screenshot, not assertions.
- Component tests live in `ui/test/components/**/*.test.tsx` and are the only suite that runs under jsdom (`environmentMatchGlobs` in `vitest.config.ts`); everything else stays in node. Use `ui/test/components/harness.tsx` for state fixtures and a recording `send`. They exist for behavior a reader cannot check by eye — disabled states, what is sent, and **how often an effect runs** — not for appearance. A component must survive an unstable `send`: depending on it in an effect once produced an unbounded request loop.

## Conventions and hard rules

- The server binds `127.0.0.1` only, and the WS hub accepts a browser origin only on its own port — never widen either. Any loopback port used to be allowed; that stopped being safe once `add-monitor` could schedule shell commands. `HAL_DEV_ORIGIN` adds one origin for a non-standard dev setup; Vite's dev origin is trusted only under the `dev` script. Requests with no `Origin` stay allowed so agents keep protocol access.
- **The WS hub requires a per-boot token before any handler runs, and before any broadcast reaches a socket.** The first message on a connection must be `{"type":"authenticate","token":"…"}`; anything else closes it, and an unadmitted socket receives nothing at all. Agents read the token from `ws-token` in the data dir (`%APPDATA%/hal1000` on Windows) — it is minted fresh each boot, so re-read it after a restart. The browser gets it stamped into the served `index.html`; under `npm run dev:ui` only, the UI falls back to `/api/ws-token`, a route that does not exist in production. The origin check still runs first — the token is a second gate, not a replacement, and it is what closes the hole the origin allowlist leaves open while `dev:ui` is running.
- Client-supplied conversation ids must stay UUID-validated (they become file paths).
- Server relative imports use the `.js` suffix; ui imports are extensionless (works under `moduleResolution: Bundler`; standardize only alongside the shared/-workspace refactor).
- Storage writes go through `storage/atomic.ts` (unique temp + rename with EPERM/EBUSY retry); per-conversation mutations go through the store's internal lock.
- **A store that caches its file writes that cache back, so its read path is a write path.** Rebuild a
  loaded shape by spreading the parsed value and then re-adding only the fields needing a default —
  never by naming every field, because a key the file carries and the literal forgets is deleted on the
  next write, silently and permanently. Optional fields make it legal and the compiler says nothing.
  Adding a persisted field means a test that reopens the store *and then writes again*; see
  `docs/solutions/rebuilding-a-cache-field-by-field-turns-a-read-into-a-delete.md`.
- Fire-and-forget async handlers must `.catch` — see `docs/solutions/` for the crash lessons.
- No linter configured yet; typecheck + tests are the gate.
- **A test that resolves a backend must pin the protocol — use `pinnedSettings` from `server/test/settings.ts`.** Stubbing the `ProviderFactory` is not isolation: `backendForRole` resolves a protocol first, and on the default `auto` that is a real 2s HTTP probe to `localhost:11434`. Under a parallel suite it times out, the backend resolves to null, and the assertion fails with an empty string or a zero count rather than anything naming the cause. This was most of the suite's "timing flakiness"; see `docs/solutions/a-stubbed-factory-is-not-isolation-if-something-resolves-first.md`.
  A test that boots the whole app cannot take a store from that helper, so it pins by calling
  `pinnedSettings(dataDir)` **before** `startApp` — the app then loads settings that already name a
  protocol. `chat-service.test.ts` was the one file doing neither and was failing about two runs in
  three under load, at ten seconds a test.
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
  (`shared/src/phrases.ts`). **Completeness is asserted by `server/test/templates/surface.test.ts`
  and nowhere else.** It scans for strings a person wrote — interpolated literals, literal joins,
  and prose — and requires each to be named as a format, structure, not-model-facing, or an oracle.
  There is deliberately no "wording" category: a string that tells a model something gets a Phrase
  or the test fails. Add a hardcoded line to a render path and it names the file.
  Which files are scanned is itself guarded: four signals nominate candidates (renders, requests,
  reports, feeds) and each must be scanned or excluded with a written reason, because a file left
  off a list looks the same whether it was considered or forgotten. The `reports` signal exists
  because a Monitor's `problem` becomes a status entry and reaches the CHAT model through
  `{monitor_remarks}` — the one field where "it only goes to the client" is false, and the
  assumption that mislabelled two strings the first time round.
  This paragraph used to make that claim in prose instead, and the claim was false when it was
  written. The Vision caption line was assembled in `server/src/vision/service.ts` with no editor
  while every sibling line had a Phrase — and the vision-user slot note said the lines were "bare",
  so the help surface denied the injection it was carrying. Found by a user asking why
  `{vision_faces}` was unavailable, not by a review or a test; the audit that followed found four
  more, and executing it found three the audit had missed. That ratio is the argument for the test.
  See `docs/plans/2026-08-10-002-fix-audit-hidden-prompt-wording-plan.md`,
  `docs/solutions/extending-a-catalogue-is-not-auditing-it.md`, and — before changing that test or
  adding an exemption to it — `docs/solutions/a-completeness-guard-is-only-as-honest-as-its-exemptions.md`,
  which records that all fourteen instances found so far sat in an exemption rather than in a line
  the scanner walked past. Where the line between wording and
  formatting falls, and why the Session label sits on the formatting side, is in `CONCEPTS.md` under
  Wording and Format. The syntax sheet lives in `ui/src/components/TemplateHelp.tsx`.
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
  before touching `server/src/ws.ts` or the monitor command path. `feat-live-clip-sets-and-bridges.md` records what the
  clip-set and bridge pass left. Clip checks are bounded by `server/src/deadline.ts`, and the two
  callers answer differently on purpose: the runtime plays a clip it could not ask about, the
  confinement pass reports nothing about one — silence is not evidence a file is missing.
  `feat-live-scene-worlds.md` records
  the accepted residuals for the World subsystem, including why `/api/live/clip` rests on the host
  check alone, what "confined to its own World" does and does not cover, and what browsing the
  user's drive over the protocol deliberately exposes.
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

A candidate has a third outcome besides naming and dismissing: **set aside**. It is a flag
(`setAsideAt`) on the same collection, so the two pools share one file, one corruption guard, one
`count()` and — deliberately — one duplicate check, which is what stops a deferred face re-queueing on
every visit. Each pool has its own bound, its own eviction tally, and the shelf has a third counter for
arrivals it absorbed. HAL therefore keeps a bounded, indefinite pool of unnamed faces, chosen over a
bounded clock; `docs/residual-review-findings/feat-enrolment-candidates.md` records the trade, and the
copy that states each bound lives in the Vision pane.

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
