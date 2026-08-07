import { ProviderError, type ChatStreamOptions, type ModelInfo, type Provider, type ProviderFactory } from "../providers/provider.js";
import type { CaptionContext, Captioner } from "../vision/captioner.js";
import { CaptionerError } from "../vision/captioner.js";
import { newInferenceId, type InferenceLog, type InferenceMetrics, type InferenceSource } from "./inference.js";

// Instrumentation, applied to the two seams every inference in the app passes
// through: the text `Provider` and the vision `Captioner`.
//
// Wrapping rather than logging inside the implementations keeps the recording
// in one place instead of four call sites, keeps `OllamaProvider` and
// `HttpCaptioner` about talking to their servers, and leaves a test that
// injects a fake provider factory unlogged and unchanged.

/**
 * Wraps a provider factory so every `chatStream` is recorded.
 *
 * The record is written when the stream ends, on every path: completion,
 * provider failure, and abort. Abort is the one that matters most — chat
 * preempts narration constantly, and a wrapper that only logged clean
 * completions would silently omit exactly the calls that were cut short.
 */
export function withInferenceLogging(factory: ProviderFactory, log: InferenceLog): ProviderFactory {
  return (endpoint: string) => new LoggedProvider(factory(endpoint), endpoint, log);
}

class LoggedProvider implements Provider {
  constructor(
    private readonly inner: Provider,
    private readonly endpoint: string,
    private readonly log: InferenceLog,
  ) {}

  listModels(): Promise<ModelInfo[]> {
    // Not an inference: no prompt, no completion, nothing to analyse later.
    return this.inner.listModels();
  }

  async *chatStream(opts: ChatStreamOptions): AsyncIterable<string> {
    const started = Date.now();
    const at = new Date().toISOString();
    const id = newInferenceId();
    let output = "";
    let metrics: InferenceMetrics | undefined;
    let outcome: "ok" | "error" | "aborted" = "ok";
    let error: { code: string; message: string } | undefined;

    try {
      const stream = this.inner.chatStream({
        ...opts,
        // Chained, not replaced: a caller with its own metrics interest keeps
        // it. Nothing does today, and silently dropping it later would be a
        // bug that only shows up in a log nobody is watching.
        onMetrics: (m) => {
          metrics = m;
          opts.onMetrics?.(m);
        },
      });
      for await (const token of stream) {
        output += token;
        yield token;
      }
    } catch (err) {
      if (err instanceof ProviderError) {
        outcome = err.code === "aborted" ? "aborted" : "error";
        error = { code: err.code, message: err.message };
      } else {
        outcome = "error";
        error = { code: "unknown", message: err instanceof Error ? err.message : String(err) };
      }
      throw err;
    } finally {
      // In `finally` so a consumer that stops iterating early — a `break`, or
      // the generator being discarded — still produces a record of what ran.
      const system = opts.messages.find((m) => m.role === "system")?.content ?? null;
      void this.log.append({
        id,
        at,
        source: opts.source ?? { kind: "chat", id: null, label: "unattributed" },
        model: opts.model,
        endpoint: this.endpoint,
        system,
        input: opts.messages.map((m) => ({ role: m.role, content: m.content })),
        output,
        outcome,
        ...(error ? { error } : {}),
        durationMs: Date.now() - started,
        outputChars: output.length,
        ...(metrics ? { metrics } : {}),
      });
    }
  }
}

/**
 * Wraps a captioner factory so every frame description is recorded.
 *
 * The image itself is never written into the record — a base64 JPEG per line
 * would make the log unreadable and duplicate what `vision-frames/` already
 * holds. `frameFor` supplies the retained frame's filename instead, so a
 * caption can still be read back against its picture when retention kept one.
 */
export function withCaptionLogging(
  make: (endpoint: string) => Captioner,
  log: InferenceLog,
): (endpoint: string) => Captioner {
  return (endpoint: string) => new LoggedCaptioner(make(endpoint), endpoint, log);
}

class LoggedCaptioner implements Captioner {
  constructor(
    private readonly inner: Captioner,
    private readonly endpoint: string,
    private readonly log: InferenceLog,
  ) {}

  probe(): Promise<boolean> {
    return this.inner.probe();
  }

  async caption(jpeg: Buffer, prompt: string, signal?: AbortSignal, context?: CaptionContext): Promise<string> {
    const started = Date.now();
    const at = new Date().toISOString();
    const source: InferenceSource = { kind: "vision-caption", id: null, label: "vision captioner" };
    const frame = context?.frame ?? null;
    try {
      const text = await this.inner.caption(jpeg, prompt, signal, context);
      void this.log.append({
        id: newInferenceId(),
        at,
        source,
        model: "captioner",
        endpoint: this.endpoint,
        system: null,
        input: [{ role: "user", content: prompt }],
        output: text,
        outcome: "ok",
        durationMs: Date.now() - started,
        outputChars: text.length,
        ...(frame ? { frame } : {}),
      });
      return text;
    } catch (err) {
      const code = err instanceof CaptionerError ? err.kind : "unknown";
      void this.log.append({
        id: newInferenceId(),
        at,
        source,
        model: "captioner",
        endpoint: this.endpoint,
        system: null,
        input: [{ role: "user", content: prompt }],
        output: "",
        outcome: "error",
        error: { code, message: err instanceof Error ? err.message : String(err) },
        durationMs: Date.now() - started,
        outputChars: 0,
        ...(frame ? { frame } : {}),
      });
      throw err;
    }
  }
}
