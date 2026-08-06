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
import { AdapterRegistry } from "./watchers/registry.js";
import { NarrationService } from "./narration/narrator.js";
import { MonitorService } from "./monitors/service.js";
import { MonitorNarrator } from "./monitors/narrator.js";
import { MonitorStore } from "./storage/monitors.js";
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

  const registry = new AdapterRegistry(hub, settings, [
    {
      id: "claude-code",
      label: "Claude Code",
      watcher: new ClaudeCodeWatcher({
        projectsDir: claudeProjectsDir(),
        // Namespaced per adapter: tail offsets are per-watcher state, and a
        // second adapter sharing one file would clobber the first's.
        stateFile: path.join(dataRoot, "watcher-state-claude-code.json"),
      }),
    },
  ]);
  const narration = new NarrationService(hub, registry, settings, queue, providerFactory);
  registry.start();
  await narration.restoreWatch();

  // The second observation role. Monitors deliberately do not pass through the
  // adapter registry: that class holds one watched session, and a Monitor is
  // configured, plural, and standing. They share the feed and the provider
  // queue, so chat still preempts everything.
  const monitors = new MonitorService(hub, new MonitorStore(dataRoot), new MonitorNarrator(narration, settings, queue, providerFactory));
  await monitors.start();

  // The registry itself is the probe's adapter view: it answers which adapters
  // are enabled, so a disabled one's log leg reads "disabled" rather than as a
  // fault and its discovery is never run (R11).
  const readiness = new ReadinessService(hub, providerFactory, settings, registry);
  // Enabling or disabling an adapter changes what the log leg means, so the
  // probe re-runs without waiting for a check-readiness message.
  registry.onChanged(() => {
    readiness.refresh().catch((err: unknown) => {
      console.error(`readiness refresh error: ${err instanceof Error ? err.message : String(err)}`);
    });
  });
  readiness.refresh().catch((err: unknown) => {
    console.error(`readiness probe error: ${err instanceof Error ? err.message : String(err)}`);
  });

  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;

  return {
    server,
    hub,
    port: boundPort,
    queue,
    settings,
    async close() {
      monitors.stop();
      registry.stop();
      hub.close();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
