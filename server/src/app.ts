import path from "node:path";
import { fileURLToPath } from "node:url";
import type http from "node:http";
import fs from "node:fs";
import { createHttpServer } from "./http.js";
import { WsHub } from "./ws.js";
import { ensureDataDir } from "./paths.js";
import { generateToken, writeToken } from "./token.js";
import { ChatService } from "./chat.js";
import type { RecentSighting } from "../../shared/src/prompts.js";
import type { ProviderFactory } from "./providers/provider.js";
import { ConversationStore } from "./storage/conversations.js";
import { SettingsStore } from "./storage/settings.js";
import { ProviderQueue } from "./providers/queue.js";
import { makeProvider } from "./providers/factory.js";
import { ClaudeCodeWatcher } from "./watchers/claude-code.js";
import { AdapterRegistry } from "./watchers/registry.js";
import { NarrationService } from "./narration/narrator.js";
import { MonitorService } from "./monitors/service.js";
import { MonitorNarrator } from "./monitors/narrator.js";
import { MonitorStore } from "./storage/monitors.js";
import { WorldService } from "./live/service.js";
import { WorldStore } from "./storage/worlds.js";
import { AudioStore } from "./storage/audio.js";
import { VisionService } from "./vision/service.js";
import { FrameStore } from "./vision/frames.js";
import { PeopleStore } from "./vision/people.js";
import { CandidateStore } from "./vision/candidates.js";
import { VisionTimeline } from "./vision/timeline.js";
import { ReadinessService } from "./readiness.js";
import { claudeProjectsDir } from "./paths.js";
import { InferenceLog } from "./logging/inference.js";
import { withCaptionLogging, withInferenceLogging } from "./logging/instrument.js";
import { ObservationLog } from "./storage/observations.js";
import { flushJsonl } from "./storage/jsonl.js";
import { HttpCaptioner } from "./vision/captioner.js";

export interface App {
  server: http.Server;
  hub: WsHub;
  port: number;
  queue: ProviderQueue;
  settings: SettingsStore;
  // This boot's handshake token. Exposed so a test can connect the same way a
  // real client does — reading it, rather than bypassing the gate.
  wsToken: string;
  close(): Promise<void>;
}

export interface AppOptions {
  providerFactory?: ProviderFactory;
}

export async function startApp(port: number, opts: AppOptions = {}): Promise<App> {
  const dataRoot = ensureDataDir();

  const here = path.dirname(fileURLToPath(import.meta.url));
  const uiDist = path.resolve(here, "..", "..", "ui", "dist");
  // Resolved lazily: the HTTP server must exist before the WS hub, and the
  // vision service after both, so the preview route asks for the camera at
  // request time rather than holding a reference from boot.
  let vision: VisionService | null = null;
  // Minted and persisted before `listen`, so no connection can arrive while the
  // token a client would need to present does not yet exist on disk.
  const wsToken = generateToken();
  await writeToken(dataRoot, wsToken);
  // Built before the HTTP server rather than beside the other stores: the clip
  // route reads it, and it is the store the route needs, not the service —
  // which is what keeps the route free of any dependency on the World service.
  const worlds = new WorldStore(dataRoot);
  const audio = new AudioStore(dataRoot);
  const server = createHttpServer({
    uiDist: fs.existsSync(uiDist) ? uiDist : null,
    camera: () => vision?.cameraSource() ?? null,
    worlds: () => worlds,
    wsToken,
  });

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

  const hub = new WsHub(server, "/ws", wsToken);

  const settings = new SettingsStore(dataRoot);
  await settings.load();
  const queue = new ProviderQueue();

  // Every inference the app runs is recorded, with its input and its output,
  // under `inference/<kind>/<id>/<date>.jsonl`. Applied by wrapping the two
  // seams every model call passes through rather than by logging at the four
  // call sites, so a feature added later is logged by construction.
  const inferenceLog = new InferenceLog(dataRoot);
  const providerFactory = withInferenceLogging(opts.providerFactory ?? makeProvider, inferenceLog);

  // The gallery and the vision timeline are named here rather than inline
  // because chat reads them too: a conversation that opted in is told who is in
  // view and what the last look showed.
  const people = new PeopleStore(dataRoot);
  const visionTimeline = new VisionTimeline(dataRoot);

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
  const observations = new ObservationLog(dataRoot);
  const narration = new NarrationService(hub, registry, settings, queue, providerFactory, {
    observations,
  });
  registry.start();
  // Before the watch is restored: the stored feed is older than anything this
  // run produces, including a gap notice a re-attach may emit.
  await narration.restoreHistory();
  await narration.restoreWatch();

  // The second observation role. Monitors deliberately do not pass through the
  // adapter registry: that class holds one watched session, and a Monitor is
  // configured, plural, and standing. They share the feed and the provider
  // queue, so chat still preempts everything.
  const monitors = new MonitorService(
    hub,
    new MonitorStore(dataRoot),
    new MonitorNarrator(narration, settings, queue, providerFactory),
    () => settings.get().phrases,
  );

  // The third observation role. Like Monitors it stands outside the registry
  // and shares the feed; unlike either, only its summarising half touches the
  // provider queue — the captioner runs in its own process, off Ollama's card.
  vision = new VisionService(
    hub,
    settings,
    new FrameStore(dataRoot),
    narration,
    queue,
    providerFactory,
    // The gallery of enrolled people. It deliberately outlives the Vision
    // toggle: switching Vision off releases the camera and purges the rolling
    // frame window, but a roster that emptied itself with the toggle could
    // never be built up.
    people,
    // Faces waiting to be named. Persists until triaged — naming enrols,
    // dismissing deletes, and nothing about an un-named face survives either.
    new CandidateStore(dataRoot),
    // The vision timeline: recognition checks and captions as timestamped
    // events. A sibling of the observation log rather than part of it — that
    // one records what HAL said, this one what it saw.
    visionTimeline,
    // The captioner is a second model on a second endpoint, so it needs its
    // own wrapper: the provider one never sees it.
    withCaptionLogging((endpoint) => new HttpCaptioner(endpoint), inferenceLog),
  );
  vision.start();

  // Constructed after Vision because it reads from it. Everything here is read
  // per request rather than captured: the roster can be renamed, the camera
  // switched off, and the watched session cleared between two messages in one
  // thread, and a conversation must see the world as it is at send time.
  // Refreshed whenever the roster changes, which is the only time a label can.
  const monitorLabels = new Map<string, string>();
  const refreshMonitorLabels = async (): Promise<void> => {
    for (const m of await monitors.list().catch(() => [])) monitorLabels.set(m.id, m.label);
  };
  void refreshMonitorLabels();

  new ChatService(hub, new ConversationStore(dataRoot), settings, queue, providerFactory, {
    presence: () => vision!.presence(),
    newestCaption: () => visionTimeline.newestCaption(),
    recentCaptions: (limit: number) => visionTimeline.recentCaptions(limit),
    people: () => people.list(),
    recentObservations: (limit) => observations.recent(limit),
    // Derived from the record of checks rather than from the live set, which is
    // the whole point: presence empties when somebody leaves, and a thread
    // could otherwise see a room without ever learning who had just been in it.
    // Newest first, one entry per person — a visit is thousands of checks and
    // the question is when each person was last seen, not how often.
    recentlySeen: async (limit) => {
      const events = await visionTimeline.recent(limit);
      const newest = new Map<string, RecentSighting>();
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const event = events[i]!;
        if (event.kind !== "check") continue;
        for (const face of event.faces) {
          if (!face.name || !face.band || face.band === "unrecognised") continue;
          if (newest.has(face.name)) continue;
          newest.set(face.name, {
            name: face.name,
            confidence: face.confidence ?? null,
            band: face.band,
            at: event.at,
          });
        }
      }
      return [...newest.values()];
    },
    // Labels are cached from the last list rather than awaited per line: the
    // remark lines render synchronously inside a budget loop, and a Monitor
    // that has just been renamed is not worth an await per entry.
    monitorLabel: (id) => monitorLabels.get(id) ?? "a log",
    identityThresholds: () => ({
      recognition: settings.get().vision.confidenceThreshold,
      statement: settings.get().vision.statementThreshold,
    }),
  });

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

  // The live scene-worlds runtime. It stands outside every observation role:
  // nothing here reaches a model, and a World advances on its own clock whether
  // or not a browser is watching.
  const live = new WorldService(hub, worlds, audio);
  await live.start();

  // Started last, and awaited: its first poll establishes "the present" for
  // every stored monitor. Every hub subscriber is registered by now, so a
  // client connecting during that window still gets readiness and adapters.
  await monitors.start();

  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;

  return {
    server,
    hub,
    port: boundPort,
    queue,
    settings,
    wsToken,
    async close() {
      vision?.stop();
      live.stop();
      monitors.stop();
      registry.stop();
      // The inference and observation logs are written fire-and-forget so a
      // slow disk never stalls a stream or the feed. Shutdown is where that
      // debt is settled: without this, the last few records of a session are
      // lost to the exit.
      await flushJsonl();
      hub.close();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
