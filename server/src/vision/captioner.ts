// The captioner: a local vision model, spoken to over the OpenAI-compatible
// chat endpoint that llama.cpp's server exposes.
//
// It is deliberately outside Ollama and outside `ProviderQueue`. Ollama holds
// the chat and narration models on the GPU behind a single lane, and a third
// tenant there would evict one of them on every capture. Because a cycle is
// minutes long the captioner does not need the GPU at all, so keeping it
// separate removes the contest instead of winning it.

export class CaptionerError extends Error {
  constructor(
    message: string,
    readonly kind: "unreachable" | "failed",
  ) {
    super(message);
  }
}

interface ChatCompletion {
  choices?: { message?: { content?: string } }[];
  error?: { message?: string };
}

// What a caller knows about the frame that a captioner does not. Only the
// inference log reads it; `HttpCaptioner` ignores it entirely, which is why it
// is a trailing optional rather than part of the request.
export interface CaptionContext {
  // The retained frame this call describes, when retention kept one.
  frame?: string | null;
}

export interface Captioner {
  caption(jpeg: Buffer, prompt: string, signal?: AbortSignal, context?: CaptionContext): Promise<string>;
  probe(): Promise<boolean>;
  /**
   * What model is answering, for `{model}` in the caption prompt.
   *
   * Optional, and empty when nothing can say. The caption request carries no
   * model field — llama.cpp serves whatever it was started with — so this is
   * the only way to name it, and a server that does not answer `/v1/models`
   * leaves the slot empty rather than failing a capture.
   */
  modelName?(): Promise<string>;
}

// Enough for a couple of sentences about a frame. Left generous rather than
// tight: a truncated caption reads as a confident half-observation, which is
// exactly the failure the narration guardrail cannot catch.
const MAX_TOKENS = 200;

export class HttpCaptioner implements Captioner {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 120_000,
  ) {}

  /**
   * The model this server is running, asked once and remembered.
   *
   * Cached including the failure, because this sits on the capture path and a
   * server that does not answer `/v1/models` would otherwise be asked again
   * every cycle for the rest of the run. A short timeout for the same reason:
   * naming the model is a nicety, and a capture must not wait on it.
   *
   * Never throws. An unreachable or silent server leaves `{model}` empty, which
   * is what an empty slot means everywhere else.
   */
  private cachedModel: string | null = null;

  async modelName(): Promise<string> {
    if (this.cachedModel !== null) return this.cachedModel;
    try {
      const res = await fetch(`${this.trimmed()}/v1/models`, { signal: AbortSignal.timeout(2_000) });
      if (!res.ok) return (this.cachedModel = "");
      const body: unknown = await res.json();
      const first = (body as { data?: { id?: unknown }[] } | null)?.data?.[0]?.id;
      return (this.cachedModel = typeof first === "string" ? first : "");
    } catch {
      return (this.cachedModel = "");
    }
  }

  async caption(jpeg: Buffer, prompt: string, signal?: AbortSignal): Promise<string> {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpeg.toString("base64")}` } },
          ],
        },
      ],
      max_tokens: MAX_TOKENS,
      // Deterministic-ish: the same still scene should not produce a different
      // "change" every cycle purely from sampling noise.
      temperature: 0.1,
    };

    // A captioner on CPU takes tens of seconds, so the deadline is generous;
    // the caller's signal is what actually cancels on shutdown or reconfigure.
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const composed = signal ? AbortSignal.any([signal, deadline]) : deadline;

    let res: Response;
    try {
      res = await fetch(`${this.trimmed()}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: composed,
      });
    } catch (err) {
      if (signal?.aborted) throw new CaptionerError("Capture was cancelled.", "failed");
      // A captioner that is merely slow is not a captioner that is missing.
      // Running the model on CPU takes tens of seconds by design, so reporting
      // a blown deadline as "unreachable" would send the user hunting for a
      // process that is running fine and simply needs longer.
      if (deadline.aborted) {
        throw new CaptionerError(
          `The captioner did not answer within ${Math.round(this.timeoutMs / 1000)}s.`,
          "failed",
        );
      }
      throw new CaptionerError(`The captioner at ${this.trimmed()} is not reachable.`, "unreachable");
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new CaptionerError(`The captioner returned ${res.status}. ${detail.slice(0, 200)}`.trim(), "failed");
    }

    const parsed = (await res.json().catch(() => null)) as ChatCompletion | null;
    if (!parsed || parsed.error) {
      throw new CaptionerError(parsed?.error?.message ?? "The captioner returned an unreadable response.", "failed");
    }
    const text = parsed.choices?.[0]?.message?.content?.trim();
    if (!text) throw new CaptionerError("The captioner returned an empty description.", "failed");
    return text;
  }

  // Cheap liveness check for the readiness leg. `/health` is llama.cpp's own,
  // and a model still loading answers 503 — which is correctly "not ready yet"
  // rather than "absent".
  async probe(): Promise<boolean> {
    try {
      const res = await fetch(`${this.trimmed()}/health`, { signal: AbortSignal.timeout(3_000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  private trimmed(): string {
    return this.baseUrl.replace(/\/+$/, "");
  }
}
