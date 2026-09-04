/**
 * The worker's entry point, and the one hand-written JavaScript file in the
 * server.
 *
 * It exists because `server/` runs from TypeScript source — `tsx src/index.ts`,
 * with no build step — and a worker thread starts a module loader of its own
 * that inherits none of the parent's hooks. A `.ts` entry handed straight to
 * `new Worker` fails with "Unknown file extension", whatever is in `execArgv`.
 * So the thread boots into plain JavaScript, registers the same loader the rest
 * of the process is already running under, and only then imports the worker.
 *
 * If the server ever gains a build step this file is where that shows up: drop
 * the registration and import the emitted `.js`.
 */
import { register as registerEsm } from "tsx/esm/api";
import { register as registerCjs } from "tsx/cjs/api";

// Both halves. The ESM hook is what lets the thread load `server/`, which is a
// module package; the CJS one is what lets it load `shared/`, which is not —
// and without it a `.js` specifier in shared source resolves as a literal file
// that is not there. Registering only the first worked under `tsx` and failed
// under the test runner, which was the whole difference between the two.
registerEsm();
registerCjs();
await import("./tempo-worker.ts");
