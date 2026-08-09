// How many tokens a model can hold, cached per endpoint AND model name.
//
// Module-level rather than a service field, following `detect.ts`: the window
// is a property of a model on a machine, not of whichever service happened to
// ask, and all four inference roles now ask. Two caches would be two answers to
// one question, and which one applied would depend on who asked last — the
// shape `docs/solutions/css-tracks-with-two-sources-of-truth.md` warns about.
//
// Keyed by endpoint too, because a window is not a property of a model name.
// Two backends can serve `qwen3` with different windows — one built at 8k, one
// at 128k — and keying on the name alone served the first backend's answer for
// the second.

import type { Provider } from "./provider.js";

// A cached `null` is an answer — "this backend does not report a window" —
// rather than a miss. Read with `??` it would be a miss, and a backend that
// reports nothing would be re-asked on every send, one timeout at a time.
const windows = new Map<string, number | null>();

function key(endpoint: string, model: string): string {
  return `${endpoint.trim().replace(/\/+$/, "")} ${model}`;
}

/** What is already known, or `undefined` when nobody has asked yet. */
export function knownWindow(endpoint: string, model: string): number | null | undefined {
  return windows.get(key(endpoint, model));
}

/** Record an answer that arrived from somewhere other than `windowFor`. */
export function rememberWindow(endpoint: string, model: string, tokens: number | null): void {
  windows.set(key(endpoint, model), tokens);
}

/**
 * The window for one model at one backend, asked once.
 *
 * Never throws: not knowing the window is a degraded answer every caller
 * already handles by falling back to a conservative one, whereas a failure here
 * would take down a send over a number it can do without.
 */
export async function windowFor(endpoint: string, model: string, provider: Provider): Promise<number | null> {
  const at = key(endpoint, model);
  const known = windows.get(at);
  if (known !== undefined) return known;

  let tokens: number | null = null;
  try {
    const listed = (await provider.listModels()).find((m) => m.name === model);
    tokens = listed?.contextTokens ?? (await provider.modelWindow?.(model)) ?? null;
  } catch {
    tokens = null;
  }
  windows.set(at, tokens);
  return tokens;
}

/** Drop every answer. Used when settings are replaced wholesale, and by tests. */
export function forgetWindows(): void {
  windows.clear();
}
