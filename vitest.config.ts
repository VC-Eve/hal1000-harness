import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Needed for the JSX in component tests. Harmless for the node-environment
  // suites, which import no .tsx.
  plugins: [react()],
  test: {
    include: ["server/test/**/*.test.ts", "ui/test/**/*.test.ts", "ui/test/components/**/*.test.tsx"],
    // Node stays the default. Server tests open sockets, spawn processes, and
    // touch the filesystem — running those under jsdom would be slower and
    // would quietly shadow globals like fetch.
    environment: "node",
    // Only component tests get a DOM, matched by directory rather than by file
    // extension so the boundary is visible in the tree.
    environmentMatchGlobs: [["ui/test/components/**", "jsdom"]],
    testTimeout: 15000,
  },
});
