import type { AdapterId, ClientMessage, Readiness, ServerMessage } from "../../shared/src/types.js";
import type { WebSocket } from "ws";
import type { ProviderFactory } from "./providers/provider.js";
import { backendForRole, slotForRole } from "./providers/resolve.js";
import type { SettingsStore } from "./storage/settings.js";
import { HttpCaptioner } from "./vision/captioner.js";
import { HttpRecogniser, type RecogniserHealth } from "./vision/recogniser.js";

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

// Injected so the probe stays a pure function of its inputs in tests, and so
// readiness never imports the vision service just to reach its client.
async function defaultCaptionerProbe(endpoint: string): Promise<boolean> {
  return new HttpCaptioner(endpoint).probe();
}

async function defaultRecogniserProbe(endpoint: string): Promise<RecogniserHealth> {
  return new HttpRecogniser(endpoint).probe();
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
  probeCaptioner: (endpoint: string) => Promise<boolean> = defaultCaptionerProbe,
  probeRecogniser: (endpoint: string) => Promise<RecogniserHealth> = defaultRecogniserProbe,
): Promise<Readiness> {
  const logsEnabled = adapters.isEnabled(LOG_LEG_ADAPTER);
  const vision = settings.get().vision;
  // Recognition is subordinate to Vision (R1): it does nothing while Vision is
  // off, so there is nothing to be ready for.
  const recognitionWanted = vision.enabled && vision.recognitionEnabled;
  // Chat has a backend of its own only when it is enabled and configured; the
  // resolver is the authority on that, so the readiness row cannot disagree
  // with where a request would actually go.
  const chatIsOwn = slotForRole("chat", settings.get()) === "chat";
  const readiness: Readiness = {
    sharedBackend: "ok",
    chatBackend: chatIsOwn ? "unreachable" : "disabled",
    models: "unknown",
    claudeLogs: logsEnabled ? "missing" : "disabled",
    // Nobody wants a captioner while Vision is off, so its absence is a choice
    // rather than a fault — the same three-valued shape as the log leg.
    captioner: vision.enabled ? "unreachable" : "disabled",
    recogniser: recognitionWanted ? "unreachable" : "disabled",
  };

  const [modelsLeg, sessionsLeg, captionerLeg, recogniserLeg, chatLeg] = await Promise.allSettled([
    backendForRole("narration", settings).then((backend) =>
      backend ? providerFactory(backend).listModels() : Promise.reject(new Error("protocol not determined")),
    ),
    logsEnabled ? adapters.discoverSessions() : Promise.resolve(null),
    vision.enabled ? probeCaptioner(vision.captionerEndpoint) : Promise.resolve(null),
    recognitionWanted ? probeRecogniser(vision.recogniserEndpoint) : Promise.resolve(null),
    chatIsOwn
      ? backendForRole("chat", settings).then((backend) =>
          backend ? providerFactory(backend).listModels() : Promise.reject(new Error("protocol not determined")),
        )
      : Promise.resolve(null),
  ]);

  // Reachability, not model count. A backend answering with an empty list is
  // reachable — the existing `models` leg is what distinguishes "nothing
  // pulled" from "nothing listening", and duplicating that judgement per slot
  // would give one condition two different names.
  if (chatIsOwn && chatLeg.status === "fulfilled") readiness.chatBackend = "ok";

  if (captionerLeg.status === "fulfilled" && captionerLeg.value === true) {
    readiness.captioner = "ok";
  }

  if (recogniserLeg.status === "fulfilled" && recogniserLeg.value) {
    const health = recogniserLeg.value;
    // Three outcomes, not two. The recogniser reports its detector and embedder
    // separately precisely so a failed model fetch stays legible, and a process
    // that can detect but not match is a different thing to tell the user than
    // one that is not running.
    if (!health.reachable) readiness.recogniser = "unreachable";
    else if (health.detector === "ok" && health.embedder === "ok") readiness.recogniser = "ok";
    else readiness.recogniser = "degraded";
  }

  if (modelsLeg.status === "fulfilled") {
    readiness.models = modelsLeg.value.length > 0 ? "ok" : "none";
  } else {
    readiness.sharedBackend = "unreachable";
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
