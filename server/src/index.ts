import { startApp, type App } from "./app.js";

const port = Number(process.env.HAL_PORT ?? 9000);

// Backstops for a long-running local process: log, don't die, on stray
// rejections; exit only on truly unknown synchronous throws.
process.on("unhandledRejection", (reason) => {
  console.error(`Unhandled rejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
});
process.on("uncaughtException", (err) => {
  console.error(`Uncaught exception: ${err.stack ?? err.message}`);
  process.exit(1);
});

startApp(port)
  .then((app: App) => {
    console.log(`HAL 1000 operational. I am completely operational, and all my circuits are functioning perfectly.`);
    console.log(`  http://localhost:${app.port}`);
    const shutdown = () => {
      console.log("HAL 1000 shutting down. This mission is too important to leave things running.");
      void app.close().then(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  })
  .catch((err: Error) => {
    console.error(`HAL 1000 failed to start: ${err.message}`);
    process.exit(1);
  });
