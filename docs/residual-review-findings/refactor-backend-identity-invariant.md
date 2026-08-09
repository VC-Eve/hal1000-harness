# refactor: Backend identity invariant — accepted residuals

Origin: `docs/brainstorms/2026-08-09-backend-identity-invariant-requirements.md`
Plan: `docs/plans/2026-08-09-002-refactor-backend-identity-invariant-plan.md`

Ten findings came out of the review of the backend split. All ten are fixed —
`ba3cf38`, `110ed6b`, `5d80894`, `81da126`, `a98b087`, `807f695`, and the window
pair below. Nothing from this review shipped knowingly broken.

This file is kept rather than deleted because two of the ten were deferred at
plan time and then discharged, and the reason they were deferred is worth having
on record — as is one finding that was confirmed and is not a defect.

## Discharged: the two window-provenance findings

Both were held back from the identity work deliberately. They are about a
*window's* provenance rather than a *backend's* identity, so bundling them would
have put two mechanisms in one diff; and they wanted doing together, because the
honest fix for the label runs through the same call path as the fix for the
lookup. That turned out to be right — the second fix is what makes the first
one's `"unknown"` branch reachable in practice.

**`windowSource` claimed the server reported a window it never gave.** It
derived from the protocol alone, so any non-Ollama backend returned `"reported"`
unconditionally — including a hosted API that 404s the window route, where
nothing was reported and the conservative default was silently in force. The
`"unknown"` wording existed for exactly that case and was unreachable except
when the backend failed to resolve at all. It now derives from whether a window
was obtained. Ollama still reports `"requested"` regardless, because there the
claim is about who chooses the window rather than about what the server said.

**`modelWindow` ignored its `model` argument.** `/props` describes the server,
not a model. On `llama-server` those are the same thing — one process, one model
— but on a host serving several they are not, and every model in the picker was
labelled with whatever was loaded. The model is now checked against what the
server says it is serving, and a mismatch returns null rather than a number
belonging to something else. A server that names nothing is still taken at its
word, because that is `llama-server` and there is nothing to disambiguate.

Verified against a stub multi-model host: the served model gets its window, the
other gets none, and a host with no `/props` at all yields `"unknown"` rather
than a confident claim about a number that never arrived.

## Not a residual: the queue's single global lane

The review also confirmed that a chat job for one backend waits behind narration
on another, because preemption was narrowed to the same backend while the lane
stayed global. That is deliberate deferred scope named in
`docs/plans/2026-08-09-001-feat-openai-compatible-provider-plan.md`, not an
accepted defect — per-backend queue concurrency is on the roadmap in `AGENTS.md`.
It is recorded here so a reader who meets it through the review does not re-file
something the roadmap already owns.
