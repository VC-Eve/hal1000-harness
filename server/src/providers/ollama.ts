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
    const body = (await res.json()) as { models?: { name: string }[] };
    return (body.models ?? []).map((m) => ({ name: m.name }));
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
          if (parsed.done) return;
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
