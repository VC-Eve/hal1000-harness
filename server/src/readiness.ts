import type { AdapterId, ClientMessage, Readiness, ServerMessage } from "../../shared/src/types.js";
import type { WebSocket } from "ws";
import type { ProviderFactory } from "./providers/provider.js";
import type { SettingsStore } from "./storage/settings.js";

// Structural hub interface so tests can fake it; WsHub satisfies this.
export interface ReadinessHub {
  broadcast(msg: ServerMessage): void;
  onMessage(handler: (msg: ClientMessage, client: WebSocket) => void): void;
  onConnection(greet: (client: WebSocket) => void): void;
  sendTo(client: WebSocket, msg: ServerMessage): void;
}

// The probe's view of the adapter registry. `AdapterRegistry` satisfies it
// structurally, and it is small enough to fake with an object literal.
export interface ReadinessAdapters {
  isEnabled(id: AdapterId): boolean;
  discoverSessions(): Promise<unknown[]>;
}

// The log leg is still one-adapter-shaped (`Readiness.claudeLogs`); generalizing
// readiness into a per-adapter probe is deferred until a second adapter lands.
// This constant is the single place that coupling is written down.
const LOG_LEG_ADAPTER: AdapterId = "claude-code";

// One probe sequence resolves all three first-run states (R17):
// Ollama reachable -> models present -> Claude Code logs present.
// Session discovery is delegated to the registry so the jsonl-walk logic
// lives in exactly one place. A disabled adapter's prerequisites are not a
// fault (R11): the leg reports "disabled" and its discovery is skipped
// outright rather than run and ignored.
export async function probeReadiness(
  providerFactory: ProviderFactory,
  settings: SettingsStore,
  adapters: ReadinessAdapters,
): Promise<Readiness> {
  const logsEnabled = adapters.isEnabled(LOG_LEG_ADAPTER);
  const readiness: Readiness = {
    ollama: "ok",
    models: "unknown",
    claudeLogs: logsEnabled ? "missing" : "disabled",
  };

  const [modelsLeg, sessionsLeg] = await Promise.allSettled([
    providerFactory(settings.get().providerEndpoint).listModels(),
    logsEnabled ? adapters.discoverSessions() : Promise.resolve(null),
  ]);

  if (modelsLeg.status === "fulfilled") {
    readiness.models = modelsLeg.value.length > 0 ? "ok" : "none";
  } else {
    readiness.ollama = "unreachable";
  }

  if (sessionsLeg.status === "fulfilled" && sessionsLeg.value !== null && sessionsLeg.value.length > 0) {
    readiness.claudeLogs = "ok";
  }

  return readiness;
}

export class ReadinessService {
  private cached: Readiness | null = null;

  constructor(
    private readonly hub: ReadinessHub,
    private readonly providerFactory: ProviderFactory,
    private readonly settings: SettingsStore,
    private readonly adapters: ReadinessAdapters,
  ) {
    hub.onMessage((msg) => {
      if (msg.type === "check-readiness") {
        this.refresh().catch((err: unknown) => {
          console.error(`readiness refresh error: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    });
    hub.onConnection((client) => {
      if (this.cached) hub.sendTo(client, { type: "readiness", readiness: this.cached });
    });
  }

  async refresh(): Promise<Readiness> {
    this.cached = await probeReadiness(this.providerFactory, this.settings, this.adapters);
    this.hub.broadcast({ type: "readiness", readiness: this.cached });
    return this.cached;
  }
}
