// Which backend a role sends to.
//
// The one route from an inference role to a backend, so the rule that keeps
// the unattended roles local is structural rather than a convention four call
// sites have to remember.

import type { BackendSettings, Settings } from "../../../shared/src/types.js";
import type { BackendSlot } from "../storage/backend-keys.js";
import type { SettingsStore } from "../storage/settings.js";
import { resolveProtocol } from "./detect.js";
import type { ResolvedBackend } from "./provider.js";

/** The four things in this app that call a model. */
export type InferenceRole = "chat" | "narration" | "monitor" | "vision";

/**
 * The slot a role draws from.
 *
 * Narration, Monitors and Vision return `shared` unconditionally, and there is
 * no branch by which they could return anything else. That is the point: those
 * three run continuously and unattended, so a metered endpoint they reached by
 * inheriting someone else's setting is a meter nobody is watching. Only chat
 * may point elsewhere, and only when it has been configured to.
 *
 * A chat override that is enabled but has no endpoint yet counts as not
 * configured. Failing every chat send because a switch was flipped before a URL
 * was typed would be worse than quietly using the backend that works, and the
 * readiness row for the slot is what makes the half-finished state visible.
 */
export function slotForRole(role: InferenceRole, settings: Settings): BackendSlot {
  if (role !== "chat") return "shared";
  const chat = settings.backends.chat;
  return chat.enabled && chat.endpoint.trim().length > 0 ? "chat" : "shared";
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
  const protocol = await resolveProtocol(backend.endpoint, backend.protocol);
  if (!protocol) return null;
  // The credential is attached here, at the last moment, and read from the key
  // store rather than from settings — which do not carry one.
  const apiKey = store.keyFor(slot);
  return { endpoint: backend.endpoint, protocol, ...(apiKey ? { apiKey } : {}) };
}
