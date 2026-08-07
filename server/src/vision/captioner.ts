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

export interface Captioner {
  caption(jpeg: Buffer, prompt: string, signal?: AbortSignal): Promise<string>;
  probe(): Promise<boolean>;
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
