import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["server/test/**/*.test.ts", "ui/test/**/*.test.ts"],
    environment: "node",
    testTimeout: 15000,
  },
});
