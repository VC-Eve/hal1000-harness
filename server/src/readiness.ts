import { promises as fs } from "node:fs";
import path from "node:path";
import type { Readiness } from "../../shared/src/types.js";
import type { ProviderFactory } from "./chat.js";
import type { SettingsStore } from "./storage/settings.js";
import type { WsHub } from "./ws.js";

// One probe sequence resolves all three first-run states (R17):
// Ollama reachable -> models present -> Claude Code logs present.
export async function probeReadiness(
  providerFactory: ProviderFactory,
  settings: SettingsStore,
  projectsDir: string,
): Promise<Readiness> {
  const readiness: Readiness = { ollama: "ok", models: "unknown", claudeLogs: "missing" };

  try {
    const models = await providerFactory(settings.get().providerEndpoint).listModels();
    readiness.models = models.length > 0 ? "ok" : "none";
  } catch {
    readiness.ollama = "unreachable";
  }

  try {
    const projectDirs = await fs.readdir(projectsDir);
    for (const slug of projectDirs) {
      const entries = await fs.readdir(path.join(projectsDir, slug)).catch(() => []);
      if (entries.some((e) => e.endsWith(".jsonl"))) {
        readiness.claudeLogs = "ok";
        break;
      }
    }
  } catch {
    readiness.claudeLogs = "missing";
  }

  return readiness;
}

export class ReadinessService {
  private cached: Readiness | null = null;

  constructor(
    private readonly hub: WsHub,
    private readonly providerFactory: ProviderFactory,
    private readonly settings: SettingsStore,
    private readonly projectsDir: string,
  ) {
    hub.onMessage((msg) => {
      if (msg.type === "check-readiness") void this.refresh();
    });
    hub.onConnection((client) => {
      if (this.cached) hub.sendTo(client, { type: "readiness", readiness: this.cached });
    });
  }

  async refresh(): Promise<Readiness> {
    this.cached = await probeReadiness(this.providerFactory, this.settings, this.projectsDir);
    this.hub.broadcast({ type: "readiness", readiness: this.cached });
    return this.cached;
  }
}
