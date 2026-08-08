// Provider seam (R8): chat and narration go through this interface so
// Anthropic/OpenAI implementations can slot in without touching features.

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

// Resolved per request so an endpoint settings change applies next-request.
export type ProviderFactory = (endpoint: string) => Provider;
