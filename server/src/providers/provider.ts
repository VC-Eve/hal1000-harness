// Provider seam (R8): chat and narration go through this interface so other
// model servers slot in without touching features.

import type { BackendProtocol } from "../../../shared/src/types.js";
import type { InferenceMetrics, InferenceSource } from "../logging/inference.js";

export type ProviderErrorCode =
  | "provider_unavailable"
  | "model_not_found"
  | "aborted";

export class ProviderError extends Error {
  constructor(
    public readonly code: ProviderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface ModelInfo {
  name: string;
  // How many tokens this model was trained to hold, when the provider says.
  //
  // Absent means "not known", never "unlimited" — a caller that read absence as
  // permission would size a prompt against a window that may be 2,048 tokens.
  // It is also not what may be allocated: a model advertising 262,144 is
  // advertising its training, not what its KV cache may occupy on a card that
  // is already holding another model.
  contextTokens?: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatStreamOptions {
  model: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
  // Provider-specific generation options (e.g. Ollama's num_ctx).
  options?: Record<string, unknown>;
  // Who provoked this call. Carried on the request rather than threaded
  // through the factory because the logging wrapper implements `Provider` and
  // sees nothing else; a call with no source is logged as an unattributed one
  // rather than dropped.
  source?: InferenceSource;
  // Usage as the provider reported it, handed back when the stream ends. The
  // token counts arrive on the provider's final chunk, which a stream of
  // strings has no way to carry — this is the seam that keeps `chatStream`
  // yielding plain text while still letting a caller record what a call cost.
  onMetrics?: (metrics: InferenceMetrics) => void;
  // Text the model must see and the inference log must not keep.
  //
  // The log holds every prompt verbatim and is never pruned — that is a
  // deliberate decision recorded in
  // docs/residual-review-findings/feat-inference-logging-and-concurrent-sessions.md,
  // and it is the right one for narration and chat. It is the wrong one for a
  // character profile: deleting a person is supposed to delete what HAL was
  // told about them, and a copy in an unpruned log makes that promise false.
  //
  // Exact strings rather than a flag on the message, because the sensitive part
  // is a segment inside a system prompt the user also wrote. The caller knows
  // precisely what it inserted, so it can name it.
  redact?: string[];
}

export interface Provider {
  listModels(): Promise<ModelInfo[]>;
  chatStream(opts: ChatStreamOptions): AsyncIterable<string>;
  /**
   * One model's window, for the models `listModels` could not answer for.
   *
   * Separate from `listModels` because it costs a request per model and only
   * the model a Conversation actually uses needs the answer.
   *
   * Optional, and absence is not a gap to fill later. This seam exists so other
   * providers slot in, and they do not all expose a per-model window — so "this
   * provider cannot say" is a real answer with a defined meaning. It collapses
   * into the same path as a null return: unknown, fall back to the conservative
   * window, never to unbounded.
   */
  modelWindow?(model: string): Promise<number | null>;
}

/**
 * Everything needed to reach one model server, with the protocol already
 * decided.
 *
 * A backend is this shape rather than a bare endpoint string because the
 * endpoint is no longer sufficient to build a provider, and because two things
 * downstream compare backends for identity: the queue decides whether an
 * arriving chat job contends with in-flight narration, and the window cache
 * decides whether an answer about a model name applies. Both need one value to
 * compare, and `endpoint` is it.
 *
 * `apiKey` is carried here and nowhere else. It is deliberately absent from
 * what the logging wrapper receives, so a credential cannot reach the inference
 * log by being in scope at the point the record is written.
 */
export interface ResolvedBackend {
  endpoint: string;
  protocol: BackendProtocol;
  apiKey?: string;
}

/**
 * Two endpoints are the same backend when they address the same server.
 *
 * Compared after trimming a trailing slash, because `http://host:11434` and
 * `http://host:11434/` are one server that a settings field will happily hold
 * both spellings of — and a comparison that called them different would abort
 * narration for a chat job on the very same machine.
 */
export function sameBackend(a: string, b: string): boolean {
  return a.trim().replace(/\/+$/, "") === b.trim().replace(/\/+$/, "");
}

/**
 * The one configured endpoint, spoken to over Ollama's native API.
 *
 * What every role did when this seam took a bare endpoint string, named so the
 * places that assume it are countable. Protocol detection and per-role
 * resolution replace each of these call sites in turn.
 */
export function ollamaBackend(endpoint: string): ResolvedBackend {
  return { endpoint, protocol: "ollama" };
}

// Resolved per request so a settings change applies next-request.
export type ProviderFactory = (backend: ResolvedBackend) => Provider;
