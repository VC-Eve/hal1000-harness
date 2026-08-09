# refactor: Backend identity invariant — accepted residuals

Origin: `docs/brainstorms/2026-08-09-backend-identity-invariant-requirements.md`
Plan: `docs/plans/2026-08-09-002-refactor-backend-identity-invariant-plan.md`

Ten findings came out of the review of the backend split. Eight are fixed across
`ba3cf38`, `110ed6b`, `5d80894`, `81da126`, `a98b087` and `807f695`. Two shipped
knowingly open, both about a *window's* provenance rather than a *backend's*
identity — which is why they were not bundled into work that had a different
mechanism.

## `windowSource` claims the server reported a window it never gave

**What.** `windowSource` in `server/src/chat.ts` derives from the protocol alone:
anything that is not Ollama returns `"reported"`. On a hosted API
`OpenAICompatibleProvider.modelWindow` GETs `/props`, which the API 404s, so no
window is obtained and both sides fall back to the conservative default — while
ConversationContext renders "the window is fixed by the server, not asked for per
request". The `"unknown"` branch that would say "a cautious default is assumed"
is unreachable except when the backend fails to resolve at all.

**Why it shipped anyway.** The consequence is a label that overstates its
certainty, not a wrong budget: the number the label describes is the conservative
default, and Context Level sizes against that correctly either way. Nobody is
handed a prompt that overflows. Fixing it properly means `windowSource` taking
the window lookup's result rather than the protocol, which crosses into the same
call path as the finding below — so they want doing together rather than one at a
time.

**What would discharge it.** Derive the source from whether a window was actually
obtained: `"reported"` only when a number came back, `"unknown"` when the probe
returned null. The wording already exists for the case; only the branch that
selects it is missing.

## `modelWindow` on the OpenAI-compatible provider ignores its model argument

**What.** The `Provider` interface declares `modelWindow?(model: string)`.
`server/src/providers/openai.ts` implements it taking no parameter and reading
`/props`, which reports the `n_ctx` of whatever the server is currently serving.
On a host running several models — LM Studio, vLLM — every model in the picker is
labelled with one model's window.

**Why it shipped anyway.** Verified `PLAUSIBLE` rather than `CONFIRMED`: the
harm requires a multi-model OpenAI-compatible server that also answers `/props`,
and the common case behind that protocol is either a single-model `llama-server`
(where the answer is right) or a hosted API (where `/props` 404s and the answer
is null, which is handled). No misreport has been observed against a real setup.

**What would discharge it.** Either take the model and ask per model where the
server supports it, or return null when the server cannot answer per model —
which is a defined answer the seam already handles, and is the honest one for a
host serving several. Worth confirming against a real LM Studio or vLLM instance
first: if `/props` is per-request-model rather than per-server there, the finding
dissolves.

## Not a residual: the queue's single global lane

The review also confirmed that a chat job for one backend now waits behind
narration on another, because preemption was narrowed to the same backend while
the lane stayed global. That is deliberate deferred scope named in
`docs/plans/2026-08-09-001-feat-openai-compatible-provider-plan.md`, not an
accepted defect — per-backend queue concurrency is on the roadmap in `AGENTS.md`.
It is recorded here only so a future reader who finds it via the review does not
re-file it.
