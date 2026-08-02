import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev mode: the browser opens the Vite dev server; /api and /ws proxy to the
// HAL core. Production: the core serves ui/dist itself (see server/src/app.ts).
const core = `http://localhost:${process.env.HAL_PORT ?? 9000}`;

export default defineConfig({
  plugins: [react()],
  server: {
    fs: { allow: [".."] },
    proxy: {
      "/api": core,
      "/ws": { target: core, ws: true },
    },
  },
});
