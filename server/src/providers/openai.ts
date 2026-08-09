// The OpenAI-compatible provider: `/v1/chat/completions` with SSE.
//
// One implementation reaching many servers. llama.cpp's `llama-server`, LM
// Studio, vLLM, llamafile and KoboldCpp all answer this shape locally, and
// OpenAI, OpenRouter, Groq and Together answer it remotely behind a key — so
// the versatility here is a protocol choice rather than a per-vendor
// integration.
//
// HAL already spoke this protocol before this file existed: `HttpCaptioner`
// posts to the same route. The request construction and the reachable-versus-
// failed error split are mirrored from it rather than reinvented.
//
// What this protocol cannot do is take a context window per request. Ollama's
// `options.num_ctx` has no equivalent here — `llama-server` fixes `n_ctx` when
// it starts and a hosted API does not expose one at all. That is why Ollama
// keeps its native API instead of being routed through its own `/v1` shim, and
// why `modelWindow` reads `/props` rather than asking for a size.

import {
  ProviderError,
  type ChatStreamOptions,
  type ModelInfo,
  type Provider,
} from "./provider.js";

interface Delta {
  choices?: { delta?: { content?: string } }[];
  error?: { message?: string };
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

// Same acceptance-shaped guard `OllamaProvider` uses: a window arriving as NaN,
// a string, or zero must read as "not known" and fall back, rather than slip
// through a negated comparison the way
// docs/solutions/a-threshold-guard-written-as-a-negation-fails-open-on-nan.md
// records happening to a confidence threshold.
function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1;
}

/**
 * Whether `/props` is describing the model that was asked about.
 *
 * Permissive on purpose, and the direction of the permissiveness is the point.
 * A server that names nothing it is serving is `llama-server`, which serves one
 * model — there is nothing to confuse, so its figure is taken. Only when the
 * server does name something and that name disagrees is the answer withheld,
 * because then the number provably belongs to a different model.
 *
 * Matched by suffix rather than by equality: `model_path` is a filesystem path
 * (`/models/qwen3-4b-q4.gguf`) while the id from `/v1/models` is a name
 * (`qwen3-4b`), so the two describe one model without ever being equal. A
 * containment test errs toward trusting the server, which is the same direction
 * as taking an unnamed one at its word.
 */
function servingModel(
  body: { default_generation_settings?: { model?: unknown }; model_path?: unknown },
  model: string,
): boolean {
  const named = [body.default_generation_settings?.model, body.model_path].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  if (named.length === 0) return true;
  const wanted = model.toLowerCase();
  return named.some((n) => {
    const seen = n.toLowerCase().replace(/\\/g, "/");
    return seen.includes(wanted) || wanted.includes(seen.split("/").pop() ?? seen);
  });
}

export class OpenAICompatibleProvider implements Provider {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string,
  ) {}

  async listModels(): Promise<ModelInfo[]> {
    let res: Response;
    try {
      res = await fetch(`${this.trimmed()}/v1/models`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new ProviderError("provider_unavailable", `${this.trimmed()} is not reachable.`);
    }
    if (!res.ok) {
      throw new ProviderError("provider_unavailable", `${this.trimmed()} returned ${res.status} listing models.`);
    }
    const body = (await res.json().catch(() => null)) as { data?: { id?: string }[] } | null;
    // No `contextTokens` here on purpose: `/v1/models` reports an id and little
    // else. The window is asked for per model by `modelWindow`, and a server
    // that will not say leaves it unknown rather than assumed.
    return (body?.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
      .map((name) => ({ name }));
  }

  /**
   * One model's window, from llama.cpp's `/props`.
   *
   * `n_ctx` is what the server was launched with, which is the honest answer to
   * "how much can this hold" — unlike a model's advertised training window, it
   * describes what is actually allocated.
   *
   * `/props` describes the **server**, not a model, and that is the whole
   * difficulty. On `llama-server` the two are the same thing: one process, one
   * model, so the server's `n_ctx` is that model's window. On a host serving
   * several — LM Studio, vLLM — they are not, and answering every model with one
   * server's figure labels a 4k model with a 128k window. Context Level then
   * sizes a prompt that overflows and silently loses its front, which is where
   * the user's own system prompt sits.
   *
   * So the model is checked against whatever the server says it is serving, and
   * a mismatch returns null rather than a number belonging to something else. A
   * server that names nothing is taken at its word — that is `llama-server`,
   * where there is nothing to disambiguate.
   *
   * Every failure path returns null, including a 404 from a server that has no
   * `/props` at all — which is every hosted API. Not knowing the window is a
   * degraded answer the caller already handles by falling back to a
   * conservative one; throwing would take a send down over a number it can do
   * without.
   */
  async modelWindow(model: string): Promise<number | null> {
    try {
      const res = await fetch(`${this.trimmed()}/props`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as {
        default_generation_settings?: { n_ctx?: unknown; model?: unknown };
        n_ctx?: unknown;
        model_path?: unknown;
      };
      if (!servingModel(body, model)) return null;
      if (isPositiveInt(body.n_ctx)) return body.n_ctx;
      const nested = body.default_generation_settings?.n_ctx;
      if (isPositiveInt(nested)) return nested;
      return null;
    } catch {
      return null;
    }
  }

  async *chatStream(opts: ChatStreamOptions): AsyncIterable<string> {
    let res: Response;
    // Deadline covers only the header phase, exactly as the Ollama provider
    // does: a model can legitimately stream for minutes, but a server that
    // never answers would otherwise wedge the single-lane queue forever.
    let headerTimer: NodeJS.Timeout | undefined;
    const headerDeadline = new Promise<never>((_resolve, reject) => {
      headerTimer = setTimeout(
        () => reject(new ProviderError("provider_unavailable", `${this.trimmed()} did not respond within 30s.`)),
        30_000,
      );
    });
    try {
      res = await Promise.race([
        fetch(`${this.trimmed()}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", ...this.headers() },
          body: JSON.stringify({
            model: opts.model,
            messages: opts.messages,
            stream: true,
            // Usage is opt-in on this protocol. Servers that do not know the
            // field ignore it, and the stream simply ends without usage — which
            // reports no metrics rather than zeroes.
            stream_options: { include_usage: true },
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
      if (res.status === 404 || /model.*(not found|does not exist)|unknown model/i.test(detail)) {
        throw new ProviderError("model_not_found", `Model "${opts.model}" is not available at ${this.trimmed()}.`);
      }
      throw new ProviderError("provider_unavailable", `${this.trimmed()} returned ${res.status}.`);
    }
    if (!res.body) {
      throw new ProviderError("provider_unavailable", `${this.trimmed()} returned an empty response body.`);
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let metrics: { promptTokens?: number; outputTokens?: number } | null = null;
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        // Buffered across network reads rather than parsed per chunk: an SSE
        // event is split wherever the socket happens to divide it, and a parser
        // that assumed one chunk was one event would drop tokens under exactly
        // the conditions that are hardest to reproduce.
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const raw of lines) {
          const line = raw.trim();
          // Blank lines separate events and lines beginning `:` are keep-alive
          // comments. Both are part of the protocol, not noise to fail on.
          if (!line || line.startsWith(":")) continue;
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") {
            if (metrics) opts.onMetrics?.(metrics);
            return;
          }
          let parsed: Delta;
          try {
            parsed = JSON.parse(payload) as Delta;
          } catch {
            // A fragment that is not JSON is not a reason to fail a stream that
            // is otherwise delivering. Skipping it loses at most one event.
            continue;
          }
          if (parsed.error) {
            throw new ProviderError("provider_unavailable", parsed.error.message ?? "The provider reported an error.");
          }
          if (parsed.usage) {
            metrics = {
              ...(isPositiveInt(parsed.usage.prompt_tokens) ? { promptTokens: parsed.usage.prompt_tokens } : {}),
              ...(isPositiveInt(parsed.usage.completion_tokens) ? { outputTokens: parsed.usage.completion_tokens } : {}),
            };
          }
          const token = parsed.choices?.[0]?.delta?.content;
          if (token) yield token;
        }
      }
      // The stream ended without `[DONE]`. Whatever was reported still counts:
      // the alternative is discarding a usage report because the server was
      // untidy about closing.
      if (metrics) opts.onMetrics?.(metrics);
    } catch (err) {
      throw this.requestError(err, opts.signal);
    }
  }

  private headers(): Record<string, string> {
    return this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {};
  }

  private requestError(err: unknown, signal?: AbortSignal): ProviderError {
    if (err instanceof ProviderError) return err;
    if (signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
      return new ProviderError("aborted", "Request was interrupted.");
    }
    return new ProviderError("provider_unavailable", `Connection to ${this.trimmed()} lost.`);
  }

  private trimmed(): string {
    return this.baseUrl.replace(/\/+$/, "");
  }
}
