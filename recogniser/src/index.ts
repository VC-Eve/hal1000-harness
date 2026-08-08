// The recogniser sidecar's entry point.
//
// HAL points at this process by URL and never starts, supervises, or stops it
// (R2) — exactly as it points at Ollama and at the captioner. One mental model
// for "a local model server HAL talks to", one shape of failure, one readiness
// leg each. The cost of that choice is that a fresh install has a third thing
// to start, which is why the startup log says plainly what is running and what
// state each model is in.

import { loadConfig } from "./config.js";
import { Pipeline } from "./pipeline.js";
import { createServer, listen } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const pipeline = new Pipeline(config);

  console.log(`hal1000-recogniser starting; models in ${config.modelsDir}`);
  await pipeline.start();

  const states = pipeline.states();
  console.log(`  detector (yunet): ${states.detector}`);
  console.log(`  embedder (sface): ${states.embedder}`);
  if (states.embedder !== "ok") {
    // R35: a model that could not be fetched or verified says so, rather than
    // leaving the process silently unable to match.
    console.log("  matching is unavailable until sface is present; detection still works.");
  }

  const running = await listen(createServer(config, pipeline), config);
  console.log(`  listening on http://${config.host}:${running.port}`);
}

main().catch((err: unknown) => {
  console.error(`recogniser failed to start: ${(err as Error).message}`);
  process.exit(1);
});
