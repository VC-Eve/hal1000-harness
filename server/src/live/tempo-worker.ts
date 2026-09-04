import { parentPort, workerData } from "node:worker_threads";
import { beatsOf, decodeToMono, intervalsOf } from "./tempo.js";

/**
 * One track's measurement, on a thread of its own.
 *
 * Everything expensive about a measurement — the WASM decoder, the decoded PCM,
 * the plain JS array `music-tempo` needs because no typed array has `concat`,
 * and the onset analysis itself — happens here rather than on the event loop.
 * That is what makes `MEASURE_DEADLINE_MS` mean anything: the analysis is
 * synchronous, so on the main thread nothing could have run to notice it had
 * overrun, and the parent's timer could not have fired until the work it was
 * bounding had already finished. Here the parent terminates the thread instead.
 *
 * Only the inter-beat intervals go back — a few hundred numbers. Reconciliation
 * is pure arithmetic and stays with the caller, so the megabytes never cross the
 * boundary and never outlive this thread.
 */
const file = String((workerData as { file?: unknown } | null)?.file ?? "");

decodeToMono(file)
  .then((audio) => intervalsOf(beatsOf(audio)))
  .then((intervals) => parentPort?.postMessage({ ok: true, intervals }))
  .catch((err: unknown) => {
    // Reported rather than thrown: the parent tells "will not decode" apart
    // from "took too long", and an uncaught rejection here would arrive as the
    // worker's `error` event with no way to say which it was.
    parentPort?.postMessage({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  });
