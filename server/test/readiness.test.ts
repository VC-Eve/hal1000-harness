import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import type { WebSocket } from "ws";
import type { ClientMessage, ServerMessage } from "../../shared/src/types.js";
import { probeReadiness, ReadinessService, type ReadinessHub } from "../src/readiness.js";
import { SettingsStore } from "../src/storage/settings.js";
import { ProviderError, type Provider } from "../src/providers/provider.js";
import { AdapterRegistry, type AdapterHub } from "../src/watchers/registry.js";
import type { LogWatcher, SessionInfo, WatcherNotification } from "../src/watchers/watcher.js";

let dir: string;
let settings: SettingsStore;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hal1000-ready-"));
  settings = new SettingsStore(dir);
  await settings.load();
});

const provider = (models: string[] | "down"): (() => Provider) => () => ({
  async listModels() {
    if (models === "down") throw new ProviderError("provider_unavailable", "unreachable");
    return models.map((name) => ({ name }));
  },
  async *chatStream() {
    yield "";
  },
});

// The probe's adapter view, with a call counter so a test can assert that a
// disabled adapter's discovery is skipped rather than run and ignored.
function adapters(opts: { enabled?: boolean; sessions?: number; fails?: boolean } = {}) {
  return {
    enabled: opts.enabled ?? true,
    discoverCalls: 0,
    isEnabled(): boolean {
      return this.enabled;
    },
    async discoverSessions(): Promise<unknown[]> {
      this.discoverCalls += 1;
      if (opts.fails) throw new Error("discovery failed");
      return Array.from({ length: opts.sessions ?? 0 }, (_, i) => ({ id: String(i) }));
    },
  };
}

describe("probeReadiness", () => {
  it("reports all green when everything is present", async () => {
    const r = await probeReadiness(provider(["llama3"]), settings, adapters({ sessions: 2 }));
    expect(r).toEqual({ ollama: "ok", models: "ok", claudeLogs: "ok", captioner: "disabled" });
  });

  it("distinguishes Ollama-down from zero-models", async () => {
    const down = await probeReadiness(provider("down"), settings, adapters({ sessions: 1 }));
    expect(down.ollama).toBe("unreachable");
    expect(down.models).toBe("unknown");

    const empty = await probeReadiness(provider([]), settings, adapters({ sessions: 1 }));
    expect(empty.ollama).toBe("ok");
    expect(empty.models).toBe("none");
  });

  it("reports missing Claude logs when an enabled adapter finds no sessions or fails", async () => {
    const none = await probeReadiness(provider(["m"]), settings, adapters({ sessions: 0 }));
    expect(none.claudeLogs).toBe("missing");

    const failed = await probeReadiness(provider(["m"]), settings, adapters({ fails: true }));
    expect(failed.claudeLogs).toBe("missing");
  });

  it("clears a failure state on re-probe after the condition is fixed", async () => {
    const before = await probeReadiness(provider([]), settings, adapters({ sessions: 0 }));
    expect(before.models).toBe("none");
    expect(before.claudeLogs).toBe("missing");
    const after = await probeReadiness(provider(["pulled-now"]), settings, adapters({ sessions: 1 }));
    expect(after.models).toBe("ok");
    expect(after.claudeLogs).toBe("ok");
  });

  it("reports the log leg disabled, not missing, when the adapter is off (R11)", async () => {
    const off = adapters({ enabled: false, sessions: 0 });
    const r = await probeReadiness(provider(["m"]), settings, off);
    expect(r.claudeLogs).toBe("disabled");
    // The other legs are untouched by the adapter's state.
    expect(r).toEqual({ ollama: "ok", models: "ok", claudeLogs: "disabled", captioner: "disabled" });
  });

  it("does not invoke a disabled adapter's discovery at all", async () => {
    const off = adapters({ enabled: false, sessions: 3 });
    await probeReadiness(provider(["m"]), settings, off);
    expect(off.discoverCalls).toBe(0);

    // ...and the same fake does get called once it is enabled, so the counter
    // is proving a skip rather than a broken fake.
    off.enabled = true;
    const on = await probeReadiness(provider(["m"]), settings, off);
    expect(off.discoverCalls).toBe(1);
    expect(on.claudeLogs).toBe("ok");
  });

  it("reports disabled even when the Ollama leg is down", async () => {
    const r = await probeReadiness(provider("down"), settings, adapters({ enabled: false }));
    expect(r.ollama).toBe("unreachable");
    expect(r.claudeLogs).toBe("disabled");
  });
});

// --- The toggle -> refresh path, wired as `app.ts` wires it. -----------------

class FakeWatcher implements LogWatcher {
  private listeners = new Set<(n: WatcherNotification) => void>();
  sessions: SessionInfo[] = [];

  async discoverSessions(): Promise<SessionInfo[]> {
    return this.sessions;
  }
  async attach(): Promise<void> {}
  async detach(): Promise<void> {}
  watchedSessionId(): string | null {
    return null;
  }
  followedSessionIds(): string[] {
    return [];
  }
  subscribe(listener: (n: WatcherNotification) => void): void {
    this.listeners.add(listener);
  }
  start(): void {}
  stop(): void {}
}

class FakeHub implements AdapterHub, ReadinessHub {
  broadcasts: ServerMessage[] = [];
  sent: ServerMessage[] = [];
  private handlers: ((msg: ClientMessage, client: WebSocket) => void)[] = [];
  private greeters: ((client: WebSocket) => void)[] = [];

  broadcast(msg: ServerMessage): void {
    this.broadcasts.push(msg);
  }
  onMessage(handler: (msg: ClientMessage, client: WebSocket) => void): void {
    this.handlers.push(handler);
  }
  onConnection(greet: (client: WebSocket) => void): void {
    this.greeters.push(greet);
  }
  sendTo(_client: WebSocket, msg: ServerMessage): void {
    this.sent.push(msg);
  }

  dispatch(msg: ClientMessage): void {
    for (const h of this.handlers) h(msg, null as unknown as WebSocket);
  }
}

const readinessMsgs = (h: FakeHub) =>
  h.broadcasts.filter((m): m is Extract<ServerMessage, { type: "readiness" }> => m.type === "readiness");

async function waitUntil(fn: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const session = (id: string): SessionInfo => ({
  id,
  projectSlug: "C--GitHub-app",
  projectName: "app",
  file: `/logs/${id}.jsonl`,
  state: "live",
  lastActivity: "2026-08-05T10:00:00Z",
});

describe("readiness follows adapter toggles", () => {
  let hub: FakeHub;
  let registry: AdapterRegistry;
  let readiness: ReadinessService;

  beforeEach(() => {
    hub = new FakeHub();
    const watcher = new FakeWatcher();
    watcher.sessions = [session("s1")];
    registry = new AdapterRegistry(hub, settings, [{ id: "claude-code", label: "Claude Code", watcher }]);
    readiness = new ReadinessService(hub, provider(["m"]), settings, registry);
    // Mirrors the wiring in `server/src/app.ts`.
    registry.onChanged(() => {
      readiness.refresh().catch(() => {});
    });
  });

  it("broadcasts refreshed readiness on a toggle without a check-readiness message", async () => {
    expect((await readiness.refresh()).claudeLogs).toBe("ok");
    const before = readinessMsgs(hub).length;

    hub.dispatch({ type: "set-adapter-enabled", adapterId: "claude-code", enabled: false });
    await waitUntil(() => readinessMsgs(hub).length > before);

    expect(readinessMsgs(hub).at(-1)!.readiness.claudeLogs).toBe("disabled");
    expect(readinessMsgs(hub)).toHaveLength(before + 1);

    // Re-enabling restores the live value on the same path.
    hub.dispatch({ type: "set-adapter-enabled", adapterId: "claude-code", enabled: true });
    await waitUntil(() => readinessMsgs(hub).at(-1)!.readiness.claudeLogs === "ok");
  });

  it("still refreshes on an explicit check-readiness message", async () => {
    hub.dispatch({ type: "check-readiness" });
    await waitUntil(() => readinessMsgs(hub).length > 0);
    expect(readinessMsgs(hub).at(-1)!.readiness.claudeLogs).toBe("ok");
  });
});
