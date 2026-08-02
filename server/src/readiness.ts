import type { Readiness } from "../../shared/src/types.js";
import type { ProviderFactory } from "./providers/provider.js";
import type { SettingsStore } from "./storage/settings.js";
import type { WsHub } from "./ws.js";

// One probe sequence resolves all three first-run states (R17):
// Ollama reachable -> models present -> Claude Code logs present.
// Session discovery is delegated to the watcher so the jsonl-walk logic
// lives in exactly one place.
export async function probeReadiness(
  providerFactory: ProviderFactory,
  settings: SettingsStore,
  listSessions: () => Promise<unknown[]>,
): Promise<Readiness> {
  const readiness: Readiness = { ollama: "ok", models: "unknown", claudeLogs: "missing" };

  const [modelsLeg, sessionsLeg] = await Promise.allSettled([
    providerFactory(settings.get().providerEndpoint).listModels(),
    listSessions(),
  ]);

  if (modelsLeg.status === "fulfilled") {
    readiness.models = modelsLeg.value.length > 0 ? "ok" : "none";
  } else {
    readiness.ollama = "unreachable";
  }

  if (sessionsLeg.status === "fulfilled" && sessionsLeg.value.length > 0) {
    readiness.claudeLogs = "ok";
  }

  return readiness;
}

export class ReadinessService {
  private cached: Readiness | null = null;

  constructor(
    private readonly hub: WsHub,
    private readonly providerFactory: ProviderFactory,
    private readonly settings: SettingsStore,
    private readonly listSessions: () => Promise<unknown[]>,
  ) {
    hub.onMessage((msg) => {
      if (msg.type === "check-readiness") void this.refresh();
    });
    hub.onConnection((client) => {
      if (this.cached) hub.sendTo(client, { type: "readiness", readiness: this.cached });
    });
  }

  async refresh(): Promise<Readiness> {
    this.cached = await probeReadiness(this.providerFactory, this.settings, this.listSessions);
    this.hub.broadcast({ type: "readiness", readiness: this.cached });
    return this.cached;
  }
}
