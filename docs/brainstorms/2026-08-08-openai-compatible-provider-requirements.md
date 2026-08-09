---
date: 2026-08-08
topic: openai-compatible-provider
---

# An OpenAI-compatible provider, and one place that names what HAL talks to

## Summary

Teach HAL a second inference protocol — the OpenAI-compatible `/v1/chat/completions` shape it
already speaks to the Captioner — so the provider seam reaches llama.cpp, LM Studio, vLLM and any
cloud API behind a key, not Ollama alone. Which protocol an endpoint speaks is discovered by probe
rather than declared, with an explicit override for when the probe is wrong. Chat may optionally
point at a second backend while the always-on roles stay on the shared one. The three endpoints HAL
already talks to are gathered into one settings area labelled by the role each serves, rather than
scattered across two.

## Problem Frame

`ProviderFactory` is `(endpoint: string) => Provider` (`server/src/providers/provider.ts:88`), and
`OllamaProvider` is the only implementation. Four call sites resolve a provider per request from one
`Settings.providerEndpoint` string — chat (`server/src/chat.ts:84`), narration
(`server/src/narration/narrator.ts:460`), monitors (`server/src/monitors/narrator.ts:206`), and
Vision's cycle summary (`server/src/vision/service.ts:1129`). The settings UI renders that string as
a bare text input labelled "provider endpoint" (`ui/src/components/SettingsPanel.tsx:452`). Nothing
in the type, the setting, or the label says Ollama, and everything behind them assumes it.

The assumption is not cosmetic. Ollama's wire protocol is its own: `POST /api/chat` returning
newline-delimited JSON, `GET /api/tags` to list models, `POST /api/show` for a per-model window,
`/api/tags` again as the liveness probe. Every one of those is hardcoded in
`server/src/providers/ollama.ts`, and none of them exists on any other model server.

Meanwhile HAL already speaks the protocol that does. `HttpCaptioner` posts to
`/v1/chat/completions` and probes `/health` (`server/src/vision/captioner.ts:72,112`) — the
OpenAI-compatible shape that llama.cpp's `llama-server` exposes, and that LM Studio, vLLM,
llamafile, KoboldCpp, OpenRouter, Groq, Together and OpenAI itself all answer. That capability is
walled inside the Vision seam, reachable only by the Captioner, and cannot serve chat or narration.

So the gap is narrower than "add a provider": HAL knows the second protocol and cannot use it where
it would matter. Widening the seam is what turns one supported backend into most of them.

A second, smaller problem rides along. HAL points at three endpoints — the model provider, the
Captioner, and the Recogniser — and they live in two unrelated settings sections
(`group-provider` and `group-vision`). Knowing what this installation talks to means knowing which
section owns which field. The Off-Machine Acknowledgement pays for that directly: it is evaluated
against `providerEndpoint` in the chat and narration paths and against `recogniserEndpoint` in
`recogniserFrom` (`server/src/vision/service.ts`), because there is no single place where the set of
destinations is visible.

## Key Decisions

**The protocol is discovered, not declared.** The alternative was a kind dropdown beside the
endpoint field — explicit, deterministic, and one more thing to set correctly for a user whose
stated want is versatility. A probe answers the same question from information the endpoint already
publishes: `/api/tags` identifies Ollama, `/v1/models` identifies an OpenAI-compatible server, and
the answer is cached per endpoint rather than re-derived per request. Detection is a convenience
with a failure mode, so it is paired with rather than trusted over an explicit override: a
misdetection is baffling in a way a wrong dropdown never is, and a cloud endpoint needing a key has
to be configured by hand regardless.

**Ollama keeps its native API; HAL does not collapse to one protocol.** Ollama exposes its own
`/v1/chat/completions`, which makes deleting `OllamaProvider`'s chat path look like the elegant
answer. It is not. The OpenAI chat-completions schema has no field for `num_ctx`, and all four call
sites set one (`chat.ts:353`, `narration/narrator.ts:474`, `monitors/narrator.ts:215`,
`vision/service.ts:1146`). Context Level — shipped two days ago — sizes injected context as a share
of a window HAL *requests per request*, and routing Ollama through its own compat layer would lose
that silently, with no error and no visible change until a System Prompt got evicted. Two protocols
is the cost of not breaking a working feature.

**Splitting the backend is opt-in, and only chat may split.** One backend for everything is the
default and the honest case: one destination, one acknowledgement, one readiness answer. The payoff
of a second backend is a cleverer chat model, so chat is the role that may point elsewhere.
Narration, Monitors and Vision are structurally barred from splitting off, because they run
continuously and unattended — on a metered endpoint that is a meter nobody is watching, and the user
would discover it on a bill rather than in the app.

**Endpoints are grouped by location, not flattened into a provider list.** The three slots are not
interchangeable and must not read as though they are. A chat model cannot caption and a vision model
cannot chat, even though both answer `/v1/chat/completions`; the Recogniser is not a model server at
all but a face-detection sidecar with its own contract. Each slot keeps its own fields and its own
role label. What the grouping buys is a reader being able to see, in one place, everything this
installation sends to — which is exactly the question the Off-Machine Acknowledgement asks.

**Degradation is stated in the UI, not discovered from behaviour.** An OpenAI-compatible endpoint
cannot be told what window to use; `llama-server` fixes `n_ctx` at launch and a cloud API does not
expose one. Context Level therefore means something weaker there than it does on Ollama. A control
whose meaning changes with a setting elsewhere, silently, is the shape of the `num_ctx` problem this
project already met once.

## Actors

- **The user**, configuring which backends HAL uses and which model each role runs.
- **The four inference roles** — Chat, Narration, Monitors, Vision's cycle summary — each of which
  resolves a provider per request.
- **The backends** — Ollama, an OpenAI-compatible server (local or remote), the Captioner, the
  Recogniser.

## Key Flows

**Pointing HAL at llama.cpp.** The user replaces the endpoint with their `llama-server` URL and
applies. HAL probes, finds `/v1/models`, records the endpoint as OpenAI-compatible, and repopulates
the model pickers from what that server reports. The next chat request goes to
`/v1/chat/completions` and streams. Context Level's window comes from `/props`, and the control says
where the number came from.

**Pointing chat at a cloud model.** The user enables the chat override, enters an endpoint and a
key, and picks a model. Narration, Monitors and Vision keep running on the local backend untouched.
The first chat send requires the Off-Machine Acknowledgement, because the *chat* role now resolves
to a remote destination; narration does not, and is not gated.

**A backend that answers nothing.** The probe finds neither `/api/tags` nor `/v1/models`. HAL
reports the endpoint as unreachable in the readiness row for that slot and offers the manual
override, rather than reporting a protocol it could not determine.

## Requirements

**The provider seam**

- R1. `Provider` gains a second implementation speaking the OpenAI-compatible protocol:
  `POST /v1/chat/completions` with SSE streaming, `GET /v1/models` for `listModels`, and `/v1/models`
  or `/props` for liveness.
- R2. `ProviderFactory` widens from an endpoint string to a resolved backend configuration carrying
  at least the endpoint, the protocol, and an optional key. Per-request resolution is preserved: a
  settings change applies to the next request and never cuts a stream in flight.
- R3. `OllamaProvider` is unchanged in behaviour, including `num_ctx` on every request and the
  architecture-suffix scan in `modelWindow`.
- R4. Streaming is token-by-token on both protocols. Chat must not regress to a single blob.
- R5. The OpenAI-compatible provider reports usage to `onMetrics` when the endpoint supplies it, and
  reports nothing rather than guessing when it does not.
- R6. `ProviderError` codes carry the same meanings on both protocols: an unreachable server is
  `provider_unavailable`, an unknown model is `model_not_found`, and a cancelled request is
  `aborted`.

**Protocol discovery**

- R7. An endpoint's protocol is determined by probe — `/api/tags` for Ollama, `/v1/models` for
  OpenAI-compatible — and cached per endpoint, not re-derived per request.
- R8. The probe result is visible in the settings UI as what HAL believes the endpoint to be, and is
  overridable to either protocol explicitly.
- R9. An explicit override always wins and is never revised by a later probe.
- R10. An endpoint that answers neither probe is reported as unreachable for that slot, not as an
  undetermined protocol.

**Backends and roles**

- R11. One backend serves all four roles by default. This is the state of a fresh install and of any
  installation that does not opt in.
- R12. Chat may optionally resolve to a second backend, configured independently including its own
  model and key.
- R13. Narration, Monitors and Vision's cycle summary always resolve to the shared backend. There is
  no per-role override for them.
- R14. With the chat override off, behaviour is identical to today at every one of the four call
  sites.

**Keys**

- R15. An OpenAI-compatible backend may carry an API key, sent as a bearer credential.
- R16. A key is stored server-side and never returned to a client in full. The UI is told whether a
  key is set, and may replace or clear it.
- R17. A key never reaches the inference log, the narration feed, or any error message surfaced to
  the user.

**Consequences that must not be silent**

- R18. Under an OpenAI-compatible backend there is no per-request context window. The window is
  taken from `/props` `n_ctx` where the server reports it, and is otherwise unknown and falls back to
  the conservative default — never to unbounded.
- R19. Context Level states, in the UI, which window it is sizing against and where that number came
  from: requested per-request (Ollama), reported by the server (`/props`), or unknown and assumed.
- R20. `ProviderQueue` preemption fires only when the arriving chat job and the in-flight narration
  job resolve to the same backend. Chat on a different backend from narration must not abort it.
- R21. The Off-Machine Acknowledgement is evaluated against the backend the *sending role* resolved
  to, at send time. A local narration backend is not gated because chat is remote, and a remote chat
  backend is gated even though narration is local.
- R22. Readiness reports one row per configured slot rather than the single `ollama` field. The row
  names the role it serves.
- R23. The model pickers remain usable against an endpoint reporting hundreds of models.

**The settings area**

- R24. One settings area holds every endpoint HAL talks to — the shared backend, the optional chat
  backend, the Captioner, and the Recogniser — each labelled by the role it serves.
- R25. Each slot keeps its own fields. The slots are not rendered as a uniform list of
  interchangeable providers.
- R26. Moving the Captioner and Recogniser fields changes where they are configured and nothing
  about what they do. Vision's behaviour, defaults and acknowledgement gating are untouched.

## Acceptance Examples

- AE1. Endpoint left at `http://localhost:11434` on an existing install. The probe finds Ollama,
  every role behaves exactly as before, `num_ctx` is still set, and Context Level reports a
  requested window. Covers R3, R7, R14, R19.
- AE2. Endpoint changed to a running `llama-server`. Models repopulate from `/v1/models`, chat
  streams token by token, and Context Level reports the window as server-reported. Covers R1, R4,
  R7, R18, R19.
- AE3. Endpoint pointed at a URL with nothing listening. The slot's readiness row says unreachable,
  not "unknown protocol". Covers R10, R22.
- AE4. An endpoint that answers `/v1/models` but is manually overridden to Ollama. The override
  holds across restarts and is not revised. Covers R8, R9.
- AE5. Chat override on and remote, shared backend local. A narration job is in flight when the user
  sends a chat message. Narration is not aborted, and both run. Covers R12, R20.
- AE6. Same configuration, first chat send. The acknowledgement is required for chat. A narration
  remark about a Session in the same minute is not gated. Covers R21.
- AE7. Chat override on and remote, with someone in the *stated* band in view. Their Character
  Profile is withheld from the chat request until the acknowledgement is given, and Vision's own
  local summary is unaffected. Covers R21.
- AE8. A key is set, then the settings panel is reopened. The UI shows a key is present and does not
  show its value. The inference log for a call made with it records the endpoint and no credential.
  Covers R16, R17.
- AE9. Captioner endpoint changed from the new settings area. Vision captions from the new endpoint
  on the next cycle, and nothing else about Vision changes. Covers R24, R26.
- AE10. An OpenAI-compatible endpoint reporting no window at all. Context Level falls back to the
  conservative default and says the window is unknown. It never treats absence as unlimited. Covers
  R18, R19.

## Scope Boundaries

**Deferred for later**

- Codex and Claude Code as CLI-subprocess providers. Both CLIs are present on the dev machine
  (`codex-cli 0.144.5`, `claude 2.1.226`) and both have headless modes — `codex exec --json -m
  <model>`, `claude -p`. The reason to want them is that they bill against an existing subscription
  rather than a metered key, which is real value but a different kind: they are agent surfaces, not
  completion endpoints. They have no model list, no messages array, agent behaviour to suppress
  (working directory, sandbox, `AGENTS.md` loading, session persistence), and no URL for
  `isLocalEndpoint` to reason about. Revisit once the widened seam has proven out.
- Per-backend queue lanes. R20 fixes the preemption bug that split backends create; it does not make
  the queue concurrent. Two roles on two backends still serialise.
- Moving the Captioner onto `ProviderQueue`, or onto the widened `Provider` seam. It stays its own
  path for the reason recorded in `shared/src/vision.ts`.
- Per-role overrides for Narration, Monitors and Vision.
- A fallback chain — HAL switching backends automatically when one is down. This was raised and
  distinguished from the provider picker; it is a separate feature.

**Outside this feature's identity**

- Vendor-specific providers. The point of this work is one protocol reaching many backends. An
  Anthropic-native or Gemini-native implementation reintroduces exactly the per-vendor integration
  this replaces, and both are reachable through OpenAI-compatible proxies.

## Dependencies / Assumptions

- Assumed: the OpenAI-compatible servers in scope stream via SSE on `/v1/chat/completions` and list
  via `/v1/models`. Verified for llama.cpp by HAL's own Captioner, which already uses both. Not
  verified against LM Studio or vLLM in this repo.
- Assumed: `llama-server` exposes `n_ctx` on `/props`. Not verified here — R18's fallback path is
  what makes the assumption safe to hold, since an absent window is already a defined answer.
- Assumed: cloud endpoints do not report a context window through `/v1/models`, so they take the
  conservative fallback. Same safety argument.
- The Off-Machine Acknowledgement's existing machinery carries over unchanged. `isLocalEndpoint`
  parses a URL hostname and treats an unparseable endpoint as remote, which remains correct for
  every backend in scope. This is a property of having stayed with HTTP; the deferred CLI route
  would have required rewriting it.
- `readiness.ollama` is a typed field in the shared wire contract (`shared/src/types.ts:660`), so
  R22 is a breaking protocol change. Internal only — one server, one UI, one repo.

## Outstanding Questions

- What the probe should do about an endpoint that answers *both* `/api/tags` and `/v1/models` —
  Ollama itself does. Native must win for the `num_ctx` reason in Key Decisions, so probe order is
  load-bearing and should be pinned by a test rather than left to implementation order.
- Whether the shared backend and the chat backend may point at the same endpoint with different
  models. Cheap to allow and probably useful — a big model for chat and a small one for narration on
  one `llama-server` — but it makes "same backend" in R20 a question about the endpoint rather than
  the slot.
- Whether an endpoint's cached protocol should be re-probed on a schedule or only when the endpoint
  string changes. Only-on-change is simpler and wrong if a server is restarted into a different mode.

## Sources / Research

- `server/src/providers/provider.ts`, `server/src/providers/ollama.ts`, `server/src/providers/queue.ts`
- `server/src/vision/captioner.ts` — the OpenAI-compatible client HAL already has
- `server/src/chat.ts:84,353`, `server/src/narration/narrator.ts:460,474`,
  `server/src/monitors/narrator.ts:206,215`, `server/src/vision/service.ts:1129,1146` — the four
  roles and their `num_ctx`
- `server/src/origin.ts` — `isLocalEndpoint` and the acknowledgement's local/remote rule
- `shared/src/types.ts:465-608,660` — `Settings`, `VisionSettings`, `readiness.ollama`
- `ui/src/components/SettingsPanel.tsx:46-68,448-478,589-700` — the settings nav clusters and the
  two sections that own endpoints today
- `codex exec --help` and `claude --version` on the dev machine, for the deferred CLI route
- `CONCEPTS.md` — Off-Machine Acknowledgement, Context Level, Chat Preemption, Captioner, Recogniser
