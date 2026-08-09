// Which backend a role sends to.
//
// The one route from an inference role to a backend, so the rule that keeps
// the unattended roles local is structural rather than a convention four call
// sites have to remember.

import { chatBackendOf, type BackendSettings, type BackendSlot, type Settings } from "../../../shared/src/types.js";

import type { SettingsStore } from "../storage/settings.js";
import { resolveProtocol } from "./detect.js";
import type { ResolvedBackend } from "./provider.js";

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
