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
}

export interface Provider {
  listModels(): Promise<ModelInfo[]>;
  chatStream(opts: ChatStreamOptions): AsyncIterable<string>;
}

// Resolved per request so an endpoint settings change applies next-request.
export type ProviderFactory = (endpoint: string) => Provider;
