import {
  ProviderError,
  type ChatStreamOptions,
  type ModelInfo,
  type Provider,
} from "./provider.js";

interface OllamaChatChunk {
  message?: { content?: string };
  done?: boolean;
  error?: string;
  // Usage, present only on the final chunk. Ollama reports durations in
  // nanoseconds.
  prompt_eval_count?: number;
  eval_count?: number;
  total_duration?: number;
}

// Phrased as acceptance rather than as a negated comparison: a window arriving
// as NaN, a string, or zero must read as "not known" and fall back, not slip
// through a `!(x < 1)` guard the way
// docs/solutions/a-threshold-guard-written-as-a-negation-fails-open-on-nan.md
// records happening to a confidence threshold.
function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1;
}

export class OllamaProvider implements Provider {
  constructor(private readonly baseUrl = "http://localhost:11434") {}

  async listModels(): Promise<ModelInfo[]> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
    } catch {
      throw new ProviderError("provider_unavailable", "Ollama is not reachable.");
    }
    if (!res.ok) {
      throw new ProviderError("provider_unavailable", `Ollama returned ${res.status} listing models.`);
    }
    const body = (await res.json()) as { models?: { name: string; details?: { context_length?: number } }[] };
    // `details.context_length` rides along on a request already being made, so
    // the common case costs nothing extra. Models that omit it are filled by
    // `modelWindow` on demand rather than by N more requests here.
    return (body.models ?? []).map((m) => ({
      name: m.name,
      ...(isPositiveInt(m.details?.context_length) ? { contextTokens: m.details!.context_length } : {}),
    }));
  }

  /**
   * One model's window, from the per-model detail endpoint.
   *
   * The key is architecture-prefixed — `deepseek2.context_length`,
   * `qwen35.context_length` — so this scans for the suffix rather than guessing
   * the prefix from a family name that is itself provider-reported. A new
   * architecture must not read as "unknown" purely because nobody added its
   * name here.
   *
   * Every failure path returns null, including an unreachable server: not
   * knowing the window is a degraded answer the caller already handles by
   * falling back to a conservative default, whereas throwing would take a chat
   * send down over a number it can do without.
   */
  async modelWindow(model: string): Promise<number | null> {
    try {
      const res = await fetch(`${this.baseUrl}/api/show`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as {
        details?: { context_length?: number };
        model_info?: Record<string, unknown>;
      };
      if (isPositiveInt(body.details?.context_length)) return body.details!.context_length!;
      for (const [key, value] of Object.entries(body.model_info ?? {})) {
        if (key.endsWith(".context_length") && isPositiveInt(value)) return value;
      }
      return null;
    } catch {
      return null;
    }
  }

  async *chatStream(opts: ChatStreamOptions): AsyncIterable<string> {
    let res: Response;
    // Deadline covers only the header phase — a model can legitimately stream
    // for minutes, but a server that never answers would otherwise wedge the
    // single-lane queue forever.
    let headerTimer: NodeJS.Timeout | undefined;
    const headerDeadline = new Promise<never>((_resolve, reject) => {
      headerTimer = setTimeout(
        () => reject(new ProviderError("provider_unavailable", "Ollama did not respond within 30s.")),
        30_000,
      );
    });
    try {
      res = await Promise.race([
        fetch(`${this.baseUrl}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: opts.model,
            messages: opts.messages,
            stream: true,
            options: opts.options,
          }),
          signal: opts.signal,
        }),
        headerDeadline,
      ]);
    } catch (err) {
      throw this.requestError(err, opts.signal);
    } finally {
      clearTimeout(headerTimer);
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      if (res.status === 404 || /not found/i.test(detail)) {
        throw new ProviderError("model_not_found", `Model "${opts.model}" is not available in Ollama.`);
      }
      throw new ProviderError("provider_unavailable", `Ollama returned ${res.status}.`);
    }
    if (!res.body) {
      throw new ProviderError("provider_unavailable", "Ollama returned an empty response body.");
    }

    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const parsed = JSON.parse(line) as OllamaChatChunk;
          if (parsed.error) {
            if (/not found/i.test(parsed.error)) {
              throw new ProviderError("model_not_found", `Model "${opts.model}" is not available in Ollama.`);
            }
            throw new ProviderError("provider_unavailable", parsed.error);
          }
          const token = parsed.message?.content;
          if (token) yield token;
          if (parsed.done) {
            // Reported before returning so a caller that logs the call has the
            // counts by the time the stream completes. An interrupted stream
            // never reaches this chunk, and so is logged with no metrics —
            // correctly, since Ollama never told us what it spent.
            opts.onMetrics?.({
              promptTokens: parsed.prompt_eval_count,
              outputTokens: parsed.eval_count,
              totalDurationMs:
                typeof parsed.total_duration === "number" ? Math.round(parsed.total_duration / 1e6) : undefined,
            });
            return;
          }
        }
      }
    } catch (err) {
      throw this.requestError(err, opts.signal);
    }
  }

  private requestError(err: unknown, signal?: AbortSignal): ProviderError {
    if (err instanceof ProviderError) return err;
    if (signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
      return new ProviderError("aborted", "Request was interrupted.");
    }
    return new ProviderError("provider_unavailable", "Connection to Ollama lost.");
  }
}
