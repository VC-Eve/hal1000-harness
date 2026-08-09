// Which backend a role sends to.
//
// The one route from an inference role to a backend, so the rule that keeps
// the unattended roles local is structural rather than a convention four call
// sites have to remember.

import { chatBackendOf, type BackendSettings, type BackendSlot, type Settings } from "../../../shared/src/types.js";
import { usableWindowTokens } from "../../../shared/src/prompts.js";

import { NARRATION_NUM_CTX } from "../narration/coalescer.js";
import type { SettingsStore } from "../storage/settings.js";
import { resolveProtocol } from "./detect.js";
import { sameHost, type Provider, type ResolvedBackend } from "./provider.js";
import { windowFor } from "./windows.js";

/** The four things in this app that call a model. */
export type InferenceRole = "chat" | "narration" | "monitor" | "vision";

/**
 * The slot a role draws from.
 *
 * Narration, Monitors and Vision return `observation` unconditionally, and
 * there is no branch by which they could return anything else. That is the
 * point: the three unattended roles share one destination, so there is exactly
 * one endpoint to check the bill for rather than three nobody is watching.
 *
 * Chat falls back to the observation slot when its own endpoint is blank. That
 * is a repair rather than a feature — settings are hand-editable and an install
 * predating this shape may hold one — and it keeps a blank field from failing
 * every send.
 */
export function slotForRole(role: InferenceRole, settings: Settings): BackendSlot {
  if (role !== "chat") return "observation";
  // The same rule the client reads, from the same place, so the notice it shows
  // cannot describe a request that did not happen.
  return chatBackendOf(settings.backends) === settings.backends.chat ? "chat" : "observation";
}

export function backendSettingsForRole(role: InferenceRole, settings: Settings): BackendSettings {
  return settings.backends[slotForRole(role, settings)];
}

/**
 * The endpoint a role will send to, without resolving a protocol.
 *
 * Separate from `backendForRole` because two callers need the destination and
 * not the provider: the queue compares endpoints to decide whether two jobs
 * contend, and the Off-Machine Acknowledgement asks whether this destination is
 * on this machine. Neither should pay for a probe, and neither should fail when
 * the endpoint is unreachable — "where would this have gone" has an answer even
 * when nothing is listening.
 */
export function endpointForRole(role: InferenceRole, settings: Settings): string {
  return backendSettingsForRole(role, settings).endpoint;
}

/**
 * The context cap in force for one model on one machine.
 *
 * `num_ctx` is a *load-time* parameter: Ollama sizes the KV cache when the
 * runner starts, so a request naming a different window cannot be served by the
 * runner already holding the weights. It tears that runner down and rebuilds
 * it, re-reading identical weights off disk — measured at ~3.2s on a 4B Q4
 * model. It does not reuse a larger runner for a smaller request either; the
 * value has to match exactly rather than merely fit.
 *
 * So the window is a property of the destination, not of the role. Chat asking
 * 8192 and narration asking 4096 for one model on one machine is not two
 * preferences, it is a reload on every alternation — and with Vision on a
 * 30s cadence that lands in front of most chat turns.
 *
 * Deliberately *not* a single global value. Two roles pointed at two machines
 * have two runners and nothing to share, and collapsing them would make the
 * laptop allocate a KV cache sized for the desktop's model. `sameHost` and not
 * `sameDestination`, for the same reason `queue.ts` uses it: two slots on one
 * box with two keys are still one process holding one runner.
 *
 * `ownCap` is the caller's own cap, always included. Chat may run a
 * conversation on a model that is not `chatModel`, and its request still has to
 * carry chat's cap.
 */
export function contextCapFor(endpoint: string, model: string, settings: Settings, ownCap: number): number {
  const observationModel = settings.narrationModel ?? settings.chatModel;
  const targets: { endpoint: string; model: string | null; cap: number }[] = [
    { endpoint: endpointForRole("chat", settings), model: settings.chatModel, cap: settings.chatContextCap },
    { endpoint: endpointForRole("narration", settings), model: observationModel, cap: NARRATION_NUM_CTX },
    { endpoint: endpointForRole("monitor", settings), model: observationModel, cap: NARRATION_NUM_CTX },
    { endpoint: endpointForRole("vision", settings), model: observationModel, cap: NARRATION_NUM_CTX },
  ];

  let cap = ownCap;
  for (const target of targets) {
    if (target.model === model && sameHost(target.endpoint, endpoint)) cap = Math.max(cap, target.cap);
  }
  return cap;
}

/**
 * The `num_ctx` a request should carry: the shared cap, clamped to what the
 * model can actually hold.
 *
 * The clamp is what makes the sharing hold for every model rather than for
 * large ones only. Without it, chat sends `min(window, 8192)` and narration
 * sends `8192` — equal while the window exceeds the cap, and thrashing again
 * the moment someone loads a 4k model. Local models run from 2k to 262k, so
 * "works if your model is big enough" is not a fix.
 */
export async function numCtxFor(
  backend: ResolvedBackend,
  model: string,
  provider: Provider,
  settings: Settings,
  ownCap: number,
): Promise<number> {
  const window = await windowFor(backend.endpoint, model, provider);
  return usableWindowTokens(window, contextCapFor(backend.endpoint, model, settings, ownCap));
}

/**
 * A backend ready to build a provider from, or null when the protocol could not
 * be determined.
 *
 * Null rather than a throw: an endpoint nobody is listening at is a condition
 * readiness reports and a caller degrades on, not an exception. Callers that
 * need a provider turn it into `provider_unavailable` themselves.
 */
export async function backendForRole(role: InferenceRole, store: SettingsStore): Promise<ResolvedBackend | null> {
  const settings = store.get();
  const slot = slotForRole(role, settings);
  const backend = settings.backends[slot];
  // The credential is read from the key store rather than from settings — which
  // do not carry one — and read before the probe rather than after it: a hosted
  // API will not say what it speaks to a caller it does not recognise.
  const apiKey = store.keyFor(slot);
  const protocol = await resolveProtocol(backend.endpoint, backend.protocol, apiKey);
  if (!protocol) return null;
  return { endpoint: backend.endpoint, protocol, ...(apiKey ? { apiKey } : {}) };
}
