// Synthesis, on a thread of its own, with the model resident.
//
// The model is 325MB and takes seconds to load. It loads once, here, and stays —
// which is what makes an audition cost roughly the length of the line rather
// than a model load, and that is the whole of R18: designing a voice by ear is
// adjust, hear, adjust, and a multi-second wait per iteration destroys it.
//
// It is a thread rather than the event loop because `session.run` is a native
// call that would otherwise block everything HAL does for the length of the
// line. It is a thread rather than a child process because Kokoro's boundary is
// three tensors and a process would mean shipping PCM over a pipe — see KTD1 in
// the plan, which also records the cost that choice accepts.
//
// **This thread is never terminated while a run is in flight.** Doing so aborts
// the whole process — measured on this machine as exit code 3221226505
// (0xC0000409) with no `exit` event, no `terminate()` resolution, and no chance
// for the parent to say anything. So there is no cancellation here and no
// deadline: work is bounded by its *input* instead, because Kokoro caps a
// sequence at 510 tokens and a bounded token count is a bounded run. `synth.ts`
// refuses an over-long sequence before it is ever sent.
//
// Phonemisation deliberately does not happen here. eSpeak holds global state and
// is serialised in `phonemes.ts` on the main thread, where the editor's readout
// reaches it too; moving it here would create a second entry point rather than
// closing the first.

import { parentPort, workerData } from "node:worker_threads";
import * as ort from "onnxruntime-node";

interface Request {
  id: number;
  tokens: number[];
  style: Float32Array;
  speed: number;
}

const modelFile = String((workerData as { model?: unknown } | null)?.model ?? "");

async function main(): Promise<void> {
  // Warnings about graph optimisation go to stderr on every session create, one
  // line per initializer. They are the runtime's, not ours, and they are noise
  // in HAL's log; `logSeverityLevel: 3` keeps errors and drops the rest.
  const session = await ort.InferenceSession.create(modelFile, {
    logSeverityLevel: 3,
    graphOptimizationLevel: "all",
  });

  parentPort?.postMessage({ ready: true });

  parentPort?.on("message", (request: Request) => {
    void (async () => {
      try {
        const tokens = BigInt64Array.from([0n, ...request.tokens.map(BigInt), 0n]);
        const feeds = {
          tokens: new ort.Tensor("int64", tokens, [1, tokens.length]),
          style: new ort.Tensor("float32", request.style, [1, request.style.length]),
          speed: new ort.Tensor("float32", Float32Array.from([request.speed]), [1]),
        };
        const output = await session.run(feeds);
        const audio = output[Object.keys(output)[0]!]!.data as Float32Array;
        // Copied out of the tensor before transfer: the tensor's buffer may be
        // larger than the audio, and a transferred view would carry the rest.
        const copy = Float32Array.from(audio);
        parentPort?.postMessage({ id: request.id, ok: true, audio: copy }, [copy.buffer]);
      } catch (err: unknown) {
        // Reported rather than thrown. An uncaught rejection would arrive as the
        // thread's `error` event, which the parent cannot tell apart from a
        // thread that died — and one of those is recoverable per request while
        // the other costs the resident model.
        parentPort?.postMessage({
          id: request.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  });
}

main().catch((err: unknown) => {
  parentPort?.postMessage({
    ready: false,
    error: err instanceof Error ? err.message : String(err),
  });
});
