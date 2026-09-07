import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Needed for the JSX in component tests. Harmless for the node-environment
  // suites, which import no .tsx.
  plugins: [react()],
  test: {
    include: [
      "server/test/**/*.test.ts",
      "ui/test/**/*.test.ts",
      "ui/test/components/**/*.test.tsx",
      "recogniser/test/**/*.test.ts",
    ],
    // Node stays the default. Server tests open sockets, spawn processes, and
    // touch the filesystem — running those under jsdom would be slower and
    // would quietly shadow globals like fetch.
    environment: "node",
    // Only component tests get a DOM, matched by directory rather than by file
    // extension so the boundary is visible in the tree.
    environmentMatchGlobs: [["ui/test/components/**", "jsdom"]],
    testTimeout: 15000,
    env: {
      // No suite may reach for the 353MB Kokoro download. `speak` starts a fetch
      // when the models are absent, which is the ordinary state on a test
      // machine, so without this every run that exercised the refusal path would
      // hit GitHub — the live-network-in-an-isolated-test shape that
      // docs/solutions/a-stubbed-factory-is-not-isolation-if-something-resolves-first.md
      // records as most of this suite's old flakiness.
      HAL_VOICE_FETCH_MODELS: "0",
    },
  },
});
