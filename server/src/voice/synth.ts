// The synthesis worker's lifecycle and its queue.
//
// One thread, started lazily and kept. Lazily because the model is 325MB and
// most sessions never speak — paying that on every boot would tax the whole
// harness for a feature that may not be used. Kept because the second request
// must not pay it again (R18).
//
// **Nothing here cancels a run.** Terminating a thread during `session.run`
// aborts the process — measured, 0xC0000409, with no `exit` event and no way for
// the parent to report anything. So this is not `withDeadline`'s shape: there is
// no timer, no fallback value, and no `terminate()` on a slow request. A
// synthesis is bounded by its input instead, and `MAX_TOKENS` is that bound.
//
// What it does have is `measureInWorker`'s single-settle discipline from
// `server/src/live/tempo.ts`: every ending — a reply, an `error`, an `exit` —
// goes through one place, so a thread that dies on its own fails the request it
// was holding and every request behind it, rather than leaving the queue waiting
// for a worker that is gone.

import { Worker } from "node:worker_threads";
import { MAX_PHONEME_LENGTH } from "./vocab.js";
import { SAMPLE_RATE, durationMs, trimSilence } from "./wav.js";

/** The model's own cap. A longer sequence is refused before the thread sees it. */
export const MAX_TOKENS = MAX_PHONEME_LENGTH;

/** One rendered piece of speech. */
export interface Rendered {
  samples: Float32Array;
  durationMs: number;
  sampleRate: number;
}

export type SynthState = "idle" | "starting" | "ready" | "failed";

interface Pending {
  request: { id: number; tokens: number[]; style: Float32Array; speed: number };
  resolve: (value: Rendered) => void;
  reject: (reason: Error) => void;
}

/** A synthesis that could not run. Distinct from one that ran and produced nothing. */
export class SynthUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SynthUnavailable";
  }
}

export interface SynthOptions {
  /** Path to `kokoro-v1.0.onnx`. */
  model: string;
  /** Overridable so a test can boot a stub thread. */
  boot?: URL | string;
}

export class Synthesiser {
  private worker: Worker | null = null;
  private state: SynthState = "idle";
  private startup: Promise<void> | null = null;
  private readonly queue: Pending[] = [];
  private inFlight: Pending | null = null;
  /** Settles when the dispatched request does, so `stop()` can wait it out. */
  private inFlightSettled: Promise<void> | null = null;
  private releaseInFlight: (() => void) | null = null;
  private nextId = 1;
  private lastError: string | null = null;
  /** True while `stop()` is tearing the thread down deliberately. */
  private stopping = false;

  constructor(private readonly options: SynthOptions) {}

  /** Whether a thread is up. Readiness reports on the model files, not on this. */
  get status(): SynthState {
    return this.state;
  }

  get error(): string | null {
    return this.lastError;
  }

  /**
   * Render one sequence of tokens.
   *
   * Rejects with `SynthUnavailable` when the thread could not run the work, and
   * with a plain `Error` when the model ran and refused the input. The caller
   * tells those apart: one is a fault to report, the other is a bad line.
   */
  async render(tokens: number[], style: Float32Array, speed: number): Promise<Rendered> {
    if (tokens.length === 0) throw new Error("nothing to synthesise");
    if (tokens.length > MAX_TOKENS) {
      // Refused here rather than bounded by a clock. This is the only thing
      // standing between a pathological line and a long run, because the run
      // cannot be cancelled once it has started.
      throw new Error(`sequence of ${tokens.length} tokens exceeds the model's ${MAX_TOKENS}`);
    }

    await this.start();
    // Starting is awaited, so a `stop()` can land in between — and a request
    // queued against a synthesiser that is no longer running would never be
    // dispatched and never settle. Re-checked here rather than trusted, because
    // the gap is invisible at the call site.
    if (!this.worker || this.state !== "ready") {
      throw new SynthUnavailable(this.lastError ?? "synthesis is not running");
    }
    return new Promise<Rendered>((resolve, reject) => {
      this.queue.push({
        request: { id: this.nextId++, tokens, style, speed },
        resolve,
        reject,
      });
      this.pump();
    });
  }

  /**
   * Stop the thread, safely whatever it is doing.
   *
   * Safety is by construction rather than by asking callers to be careful: this
   * waits for any dispatched run to settle before terminating, because
   * terminating over the top of one aborts the process (see the file header).
   * An earlier draft documented the hazard and left the caller to avoid it,
   * which is exactly the shape that produces the bug it warns about — the first
   * test written against it hung for two minutes doing the forbidden thing.
   *
   * `stopping` is the second half: `terminate()` fires the thread's own `exit`,
   * and without the flag a deliberate stop would arrive at the same handler as a
   * thread that died and leave the synthesiser `failed`, so the next `render`
   * would report a fault instead of starting a replacement.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    // Wait for the run inside the thread to finish before tearing it down.
    // There is no way to cancel it and terminating over the top of it aborts the
    // process, so the only safe stop is a patient one. Queued work is dropped
    // immediately; only the one already dispatched is waited on, and it is
    // bounded by the token cap that bounds every run.
    const settled = this.inFlightSettled;
    this.dropQueued(() => true);
    if (settled) await settled.catch(() => undefined);

    const worker = this.worker;
    this.worker = null;
    this.startup = null;
    this.state = "idle";
    this.lastError = null;
    this.failAll(new SynthUnavailable("synthesis stopped"));
    try {
      if (worker) await worker.terminate();
    } finally {
      this.stopping = false;
    }
  }

  private start(): Promise<void> {
    // A request arriving mid-stop must not quietly start a replacement thread:
    // the stop is still tearing one down, and the two would race over the same
    // fields. Refused instead, so the caller gets an answer rather than a
    // synthesiser in an unclear state.
    if (this.stopping) return Promise.reject(new SynthUnavailable("synthesis is stopping"));
    if (this.state === "ready" && this.worker) return Promise.resolve();
    if (this.startup) return this.startup;

    this.state = "starting";
    this.startup = new Promise<void>((resolve, reject) => {
      let worker: Worker;
      try {
        worker = new Worker(this.options.boot ?? new URL("./worker-boot.js", import.meta.url), {
          workerData: { model: this.options.model },
        });
      } catch (err: unknown) {
        this.state = "failed";
        this.lastError = err instanceof Error ? err.message : String(err);
        reject(new SynthUnavailable(this.lastError));
        return;
      }

      let settled = false;
      const settle = (run: () => void) => {
        if (settled) return;
        settled = true;
        run();
      };

      worker.on("message", (reply: Record<string, unknown>) => {
        if (reply.ready === true) {
          this.state = "ready";
          this.lastError = null;
          settle(resolve);
          return;
        }
        if (reply.ready === false) {
          this.lastError = String(reply.error ?? "the synthesiser did not start");
          this.state = "failed";
          settle(() => reject(new SynthUnavailable(this.lastError!)));
          return;
        }
        this.onReply(reply);
      });

      // A thread that failed or stopped. Both are the same answer to every
      // request it was holding: this could not run. The next `render` starts a
      // replacement rather than inheriting a dead one.
      const died = (message: string) => {
        // A deliberate stop reaches here too, via `terminate()`'s `exit`. It is
        // not a fault and must not leave the synthesiser `failed`.
        if (this.stopping) return;
        this.lastError = message;
        this.state = "failed";
        this.worker = null;
        this.startup = null;
        this.failAll(new SynthUnavailable(message));
        settle(() => reject(new SynthUnavailable(message)));
      };
      worker.on("error", (err) => died(err.message));
      worker.on("exit", () => died("the synthesis thread stopped"));

      this.worker = worker;
    });
    return this.startup;
  }

  private onReply(reply: Record<string, unknown>): void {
    const pending = this.inFlight;
    if (!pending || reply.id !== pending.request.id) return; // a reply for a request nobody is holding
    this.inFlight = null;
    this.releaseInFlight?.();
    this.releaseInFlight = null;
    this.inFlightSettled = null;

    if (reply.ok === true && reply.audio instanceof Float32Array) {
      const samples = trimSilence(reply.audio);
      pending.resolve({ samples, durationMs: durationMs(samples), sampleRate: SAMPLE_RATE });
    } else {
      pending.reject(new Error(String(reply.error ?? "the synthesiser said nothing")));
    }
    this.pump();
  }

  /**
   * Send the next request, if the thread is free.
   *
   * One at a time. Not for correctness — the model would take concurrent calls —
   * but because the thread is single and a queue that dispatched everything
   * would only move the waiting into the runtime, where it could not be dropped
   * on supersede.
   */
  private pump(): void {
    if (this.inFlight || !this.worker || this.state !== "ready") return;
    const next = this.queue.shift();
    if (!next) return;
    this.inFlight = next;
    this.inFlightSettled = new Promise<void>((done) => {
      this.releaseInFlight = done;
    });
    this.worker.postMessage(next.request);
  }

  /**
   * Drop every request that will never be answered.
   *
   * Including the one in flight: its thread is gone, so no reply is coming, and
   * a promise nobody settles is a request that hangs forever.
   */
  private failAll(reason: Error): void {
    const waiting = [...this.queue];
    this.queue.length = 0;
    if (this.inFlight) waiting.unshift(this.inFlight);
    this.inFlight = null;
    this.releaseInFlight?.();
    this.releaseInFlight = null;
    this.inFlightSettled = null;
    for (const pending of waiting) pending.reject(reason);
  }

  /**
   * Drop queued requests a caller no longer wants.
   *
   * This is what a supersede uses: the sentences of a replaced utterance that
   * have not been sent yet are dropped here, at the moment of the supersede
   * rather than when their results arrive. Only the one already inside the
   * thread is wasted, because that one cannot be recalled.
   */
  dropQueued(predicate: (id: number) => boolean): void {
    for (let i = this.queue.length - 1; i >= 0; i -= 1) {
      const pending = this.queue[i]!;
      if (!predicate(pending.request.id)) continue;
      this.queue.splice(i, 1);
      pending.reject(new SynthUnavailable("superseded"));
    }
  }
}
