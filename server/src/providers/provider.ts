// Provider seam (R8): chat and narration go through this interface so
// Anthropic/OpenAI implementations can slot in without touching features.

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
}

export interface Provider {
  listModels(): Promise<ModelInfo[]>;
  chatStream(opts: ChatStreamOptions): AsyncIterable<string>;
}
