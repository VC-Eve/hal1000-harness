/**
 * The synthesis worker's entry point, and the second hand-written JavaScript
 * file in the server.
 *
 * It exists for the reason `server/src/live/tempo-worker-boot.js` exists, and is
 * a copy of it: `server/` runs from TypeScript source — `tsx src/index.ts`, with
 * no build step — and a worker thread starts a module loader of its own that
 * inherits none of the parent's hooks. A `.ts` entry handed straight to
 * `new Worker` fails with "Unknown file extension", whatever is in `execArgv`.
 *
 * Both halves are registered. The ESM hook is what lets the thread load
 * `server/`, which is a module package; the CJS one is what lets it load
 * `shared/`, which is not — registering only the first worked under `tsx` and
 * failed under the test runner.
 *
 * If the server ever gains a build step, this file and its twin are where that
 * shows up: drop the registration and import the emitted `.js`.
 */
import { register as registerEsm } from "tsx/esm/api";
import { register as registerCjs } from "tsx/cjs/api";

registerEsm();
registerCjs();
await import("./worker.ts");
