import { startApp } from "./app.js";

const port = Number(process.env.HAL_PORT ?? 9000);

startApp(port)
  .then((app) => {
    console.log(`HAL 1000 operational. I am completely operational, and all my circuits are functioning perfectly.`);
    console.log(`  http://localhost:${app.port}`);
  })
  .catch((err: Error) => {
    console.error(`HAL 1000 failed to start: ${err.message}`);
    process.exit(1);
  });
