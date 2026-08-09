// Which protocol an endpoint speaks, worked out rather than declared.
//
// The user's stated want is versatility — point HAL at a model server and have
// it work. A dropdown beside the endpoint field would answer the same question
// by asking, and asking is one more thing to get wrong. So the endpoint is
// probed for what it already publishes, and the manual override exists for when
// the probe is wrong rather than as the primary route.

import type { BackendProtocol } from "../../../shared/src/types.js";

/**
 * What the settings hold: a protocol, or "work it out".
 *
 * Distinct from `BackendProtocol`, which is a decided answer. Keeping the
 * preference and the decision as different types is what stops "auto" being
 * handed to a factory that has to switch on it.
 */
export type ProtocolPreference = "auto" | BackendProtocol;

// Positive detections only. A failure is deliberately not remembered — see
// `detectProtocol`.
const detected = new Map<string, BackendProtocol>();

// In-flight probes, so concurrent callers for one endpoint issue one probe
// rather than racing. Chat, narration and readiness can all ask within the same
// tick on a cold start.
const inFlight = new Map<string, Promise<BackendProtocol | null>>();

/**
 * The endpoint as a cache key.
 *
 * Normalised the same way `sameBackend` compares, so `http://host:11434` and
 * `http://host:11434/` are one entry rather than two answers to one question.
 */
function key(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, "");
}

async function answers(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Probe an endpoint, remembering only a successful answer.
 *
 * Ollama is tried first and that order is load-bearing: Ollama serves both its
 * native `/api/tags` and its own `/v1/models`, and routing it through the
 * OpenAI-compatible path would lose `options.num_ctx` — which every request in
 * this app sets and which Context Level sizes its budgets against. A test pins
 * the order for that reason.
 *
 * A failure is not cached. Booting HAL before Ollama would otherwise strand it
 * on "unreachable" until someone changed a setting they had no reason to
 * change, whereas readiness already re-probes on its own and will find the
 * server the moment it comes up. Only a positive answer is worth remembering,
 * because only a positive answer is stable.
 */
export async function detectProtocol(endpoint: string): Promise<BackendProtocol | null> {
  const at = key(endpoint);
  const known = detected.get(at);
  if (known) return known;

  const running = inFlight.get(at);
  if (running) return running;

  const probe = (async (): Promise<BackendProtocol | null> => {
    if (await answers(`${at}/api/tags`)) return "ollama";
    if (await answers(`${at}/v1/models`)) return "openai";
    return null;
  })().then(
    (result) => {
      if (result) detected.set(at, result);
      inFlight.delete(at);
      return result;
    },
    (err: unknown) => {
      inFlight.delete(at);
      throw err;
    },
  );

  inFlight.set(at, probe);
  return probe;
}

/**
 * The protocol to use for an endpoint, honouring an explicit choice.
 *
 * An override short-circuits before any request and is never written to the
 * cache. Caching it would mean clearing the override fell back to a value
 * nobody chose rather than to a fresh probe, which is a stale answer wearing
 * the authority of a measurement.
 */
export async function resolveProtocol(
  endpoint: string,
  preference: ProtocolPreference = "auto",
): Promise<BackendProtocol | null> {
  if (preference !== "auto") return preference;
  return detectProtocol(endpoint);
}

/** Drop one endpoint's answer, so the next resolve probes again. */
export function forgetProtocol(endpoint: string): void {
  const at = key(endpoint);
  detected.delete(at);
  inFlight.delete(at);
}

/** Drop every answer. Used when settings are replaced wholesale, and by tests. */
export function forgetAllProtocols(): void {
  detected.clear();
  inFlight.clear();
}
