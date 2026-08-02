import path from "node:path";
import { fileURLToPath } from "node:url";
import type http from "node:http";
import fs from "node:fs";
import { createHttpServer } from "./http.js";
import { WsHub } from "./ws.js";
import { ensureDataDir } from "./paths.js";
import { ChatService } from "./chat.js";
import type { ProviderFactory } from "./providers/provider.js";
import { ConversationStore } from "./storage/conversations.js";
import { SettingsStore } from "./storage/settings.js";
import { ProviderQueue } from "./providers/queue.js";
import { OllamaProvider } from "./providers/ollama.js";
import { ClaudeCodeWatcher } from "./watchers/claude-code.js";
import { NarrationService } from "./narration/narrator.js";
import { ReadinessService } from "./readiness.js";
import { claudeProjectsDir } from "./paths.js";

export interface App {
  server: http.Server;
  hub: WsHub;
  port: number;
  queue: ProviderQueue;
  settings: SettingsStore;
  close(): Promise<void>;
}

export interface AppOptions {
  providerFactory?: ProviderFactory;
}

export async function startApp(port: number, opts: AppOptions = {}): Promise<App> {
  const dataRoot = ensureDataDir();

  const here = path.dirname(fileURLToPath(import.meta.url));
  const uiDist = path.resolve(here, "..", "..", "ui", "dist");
  const server = createHttpServer({ uiDist: fs.existsSync(uiDist) ? uiDist : null });

  // Bind to loopback only: HAL 1000 is a single-user local tool and must not
  // be reachable from the network. The WS hub attaches after listen succeeds —
  // ws re-emits server errors on the WebSocketServer, which would crash the
  // process on a failed bind.
  await new Promise<void>((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(`Port ${port} is already in use — is another HAL 1000 instance running? Set HAL_PORT to use a different port.`));
      } else {
        reject(err);
      }
    });
    server.listen(port, "127.0.0.1", () => resolve());
  });

  const hub = new WsHub(server);

  const settings = new SettingsStore(dataRoot);
  await settings.load();
  const queue = new ProviderQueue();
  const providerFactory = opts.providerFactory ?? ((endpoint: string) => new OllamaProvider(endpoint));
  new ChatService(hub, new ConversationStore(dataRoot), settings, queue, providerFactory);

  const watcher = new ClaudeCodeWatcher({
    projectsDir: claudeProjectsDir(),
    stateFile: path.join(dataRoot, "watcher-state.json"),
  });
  const narration = new NarrationService(hub, watcher, settings, queue, providerFactory);
  watcher.start();
  await narration.restoreWatch();

  const readiness = new ReadinessService(hub, providerFactory, settings, () => watcher.discoverSessions());
  void readiness.refresh();

  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;

  return {
    server,
    hub,
    port: boundPort,
    queue,
    settings,
    async close() {
      watcher.stop();
      hub.close();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
