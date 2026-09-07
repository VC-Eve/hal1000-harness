/**
 * A synthesis thread that speaks no words.
 *
 * The lifecycle in `synth.ts` — lazy start, one request in flight, a queue that
 * drains when the thread dies, a replacement started on the next request — is
 * the part most likely to be wrong and the part the real model tests least well:
 * loading 325MB to check that a queue drains is slow, and the one way to make
 * the real thread die on demand is to terminate it mid-run, which aborts the
 * process. So the lifecycle is exercised here instead, against a thread that
 * answers instantly and dies when asked.
 *
 * Protocol, matching `worker.ts`: post `{ ready: true }`, then reply to each
 * request with `{ id, ok, audio }`. Two token values are commands rather than
 * phonemes, which real tokens never are because ids stop at 177:
 *
 *   9001  exit without replying, as a thread that fell over would
 *   9002  reply with an error, as a model that refused the input would
 *   9003  reply after a delay, so a test can catch a request while it is in
 *         flight — the window a real render occupies for seconds and this stub
 *         would otherwise close instantly
 */
import { parentPort, workerData } from "node:worker_threads";

const samples = Number(workerData?.samples ?? 8);

parentPort.postMessage({ ready: true });

parentPort.on("message", (request) => {
  const command = request.tokens?.[0];
  if (command === 9001) {
    process.exit(1);
  }
  if (command === 9002) {
    parentPort.postMessage({ id: request.id, ok: false, error: "the stub refused" });
    return;
  }
  if (command === 9003) {
    setTimeout(() => reply(request), 150);
    return;
  }
  reply(request);
});

function reply(request) {
  // Loud enough to survive the silence trim, and shaped so a trim that took the
  // wrong end would be visible in the length.
  const audio = new Float32Array(samples);
  for (let i = 0; i < samples; i += 1) audio[i] = i === 0 || i === samples - 1 ? 0 : 0.5;
  parentPort.postMessage({ id: request.id, ok: true, audio }, [audio.buffer]);
}
