import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import type { WebSocket } from "ws";
import type { ClientMessage, ServerMessage } from "../../../shared/src/types.js";
import { NarrationService, type NarrationHub } from "../../src/narration/narrator.js";
import { ProviderError, type ChatStreamOptions, type Provider } from "../../src/providers/provider.js";
import { ProviderQueue } from "../../src/providers/queue.js";
import { SettingsStore } from "../../src/storage/settings.js";
import { AdapterRegistry, type AdapterHub } from "../../src/watchers/registry.js";
import type { LogWatcher, SessionEvent, SessionInfo, WatcherNotification } from "../../src/watchers/watcher.js";

// Same shape as the narration suite's fakes, plus the lifecycle counters this
// unit is about: whether polling was (re)started and whether it was stopped.
class FakeWatcher implements LogWatcher {
  private listeners = new Set<(n: WatcherNotification) => void>();
  private watched: string | null = null;
  sessions: SessionInfo[] = [];
  starts = 0;
  stops = 0;
  attaches: string[] = [];
  detaches = 0;
  discoverError: Error | null = null;

  async discoverSessions(): Promise<SessionInfo[]> {
    if (this.discoverError) throw this.discoverError;
    return this.sessions;
  }
  async attach(sessionId: string): Promise<void> {
    this.attaches.push(sessionId);
    this.watched = sessionId;
  }
  async detach(): Promise<void> {
    this.detaches += 1;
    this.watched = null;
  }
  watchedSessionId(): string | null {
    return this.watched;
  }
  subscribe(listener: (n: WatcherNotification) => void): void {
    this.listeners.add(listener);
  }
  start(): void {
    this.starts += 1;
  }
  stop(): void {
    this.stops += 1;
  }

  emit(n: WatcherNotification): void {
    for (const l of this.listeners) l(n);
  }
}

class FakeHub implements AdapterHub, NarrationHub {
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
  connect(): void {
    for (const g of this.greeters) g(null as unknown as WebSocket);
  }
}

type Behavior = (signal: AbortSignal | undefined) => Promise<string>;

function makeProvider(calls: string[], behavior: Behavior) {
  return (_endpoint: string): Provider => ({
    async listModels() {
      return [];
    },
    async *chatStream(opts: ChatStreamOptions): AsyncIterable<string> {
      calls.push(opts.messages.find((m) => m.role === "user")?.content ?? "");
      yield await behavior(opts.signal);
    },
  });
}

function gate() {
  let open!: (v: string) => void;
  const promise = new Promise<string>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

const session = (id: string): SessionInfo => ({
  id,
  projectSlug: "C--GitHub-app",
  projectName: "app",
  file: `/logs/${id}.jsonl`,
  state: "live",
  lastActivity: "2026-08-05T10:00:00Z",
});

const ev = (text: string): SessionEvent => ({ at: "2026-08-05T10:00:00Z", kind: "assistant", text, toolUses: [] });

async function waitUntil(fn: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const entries = (h: FakeHub) => h.broadcasts.filter((m): m is Extract<ServerMessage, { type: "narration-entry" }> => m.type === "narration-entry");
const rosters = (h: FakeHub) => h.broadcasts.filter((m): m is Extract<ServerMessage, { type: "adapters" }> => m.type === "adapters");
const errors = (h: FakeHub) => h.broadcasts.filter((m): m is Extract<ServerMessage, { type: "error" }> => m.type === "error");

let dir: string;
let settings: SettingsStore;
let hub: FakeHub;
let watcher: FakeWatcher;
let queue: ProviderQueue;
let registry: AdapterRegistry;

async function build(opts: { behavior?: Behavior; retryMs?: number } = {}) {
  const calls: string[] = [];
  registry = new AdapterRegistry(hub, settings, [{ id: "claude-code", label: "Claude Code", watcher }]);
  const narration = new NarrationService(
    hub,
    registry,
    settings,
    queue,
    makeProvider(calls, opts.behavior ?? (async () => "The agent proceeds.")),
    { retryMs: opts.retryMs ?? 10_000 },
  );
  registry.start();
  return { calls, narration };
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hal1000-registry-"));
  settings = new SettingsStore(dir);
  await settings.load();
  await settings.update({ chatModel: "chat-m1" });
  hub = new FakeHub();
  watcher = new FakeWatcher();
  watcher.sessions = [session("s1"), session("s2")];
  queue = new ProviderQueue();
});

describe("adapter lifecycle", () => {
  it("disabling the adapter holding the watched session detaches it, stops polling, and broadcasts watch-stopped", async () => {
    const { narration } = await build();
    await narration.watch("s1");
    expect(watcher.starts).toBe(1);

    hub.dispatch({ type: "set-adapter-enabled", adapterId: "claude-code", enabled: false });
    await waitUntil(() => hub.broadcasts.some((m) => m.type === "watch-stopped"));

    expect(watcher.detaches).toBe(1);
    expect(watcher.stops).toBe(1);
    expect(registry.watchedSessionId()).toBeNull();
    expect(rosters(hub).at(-1)!.adapters).toEqual([{ id: "claude-code", label: "Claude Code", enabled: false }]);
  });

  it("produces no entry for a narration batch already in flight when the adapter is disabled", async () => {
    const inFlight = gate();
    const { calls, narration } = await build({ behavior: () => inFlight.promise });
    await narration.watch("s1");
    watcher.emit({ kind: "session-events", sessionId: "s1", events: [ev("mid-inference activity")] });
    await waitUntil(() => calls.length === 1);

    await registry.setEnabled("claude-code", false);
    // The queue cannot cancel a running job, so the batch still resolves.
    inFlight.open("This observation arrived too late.");
    await new Promise((r) => setTimeout(r, 100));

    expect(entries(hub)).toHaveLength(0);
  });

  it("does not fire a pending narration retry timer after its adapter is disabled", async () => {
    let failing = true;
    const { narration } = await build({
      retryMs: 30,
      behavior: async () => {
        if (failing) throw new ProviderError("provider_unavailable", "down");
        return "should never appear";
      },
    });
    await narration.watch("s1");
    watcher.emit({ kind: "session-events", sessionId: "s1", events: [ev("doomed")] });
    await waitUntil(() => hub.broadcasts.some((m) => m.type === "narration-status" && m.status === "provider-unavailable"));

    failing = false;
    await registry.setEnabled("claude-code", false);
    const before = entries(hub).length;
    await new Promise((r) => setTimeout(r, 150));

    expect(entries(hub)).toHaveLength(before);
    expect(entries(hub).every((e) => e.entry.text !== "should never appear")).toBe(true);
  });

  it("clears the persisted watched session so a restart does not re-attach it", async () => {
    const { narration } = await build();
    await narration.watch("s1");
    expect(settings.get().watchedSessionId).toBe("s1");

    await registry.setEnabled("claude-code", false);
    expect(settings.get().watchedSessionId).toBeNull();

    // Boot again against the same data dir: nothing to restore.
    const rebooted = new SettingsStore(dir);
    expect((await rebooted.load()).watchedSessionId).toBeNull();

    const hub2 = new FakeHub();
    const watcher2 = new FakeWatcher();
    watcher2.sessions = [session("s1")];
    const registry2 = new AdapterRegistry(hub2, rebooted, [{ id: "claude-code", label: "Claude Code", watcher: watcher2 }]);
    const narration2 = new NarrationService(hub2, registry2, rebooted, queue, makeProvider([], async () => "x"), {});
    await narration2.restoreWatch();
    expect(watcher2.attaches).toEqual([]);
  });

  it("keeps entries already in the ring buffer in the backlog after a disable", async () => {
    const { narration } = await build();
    await narration.watch("s1");
    watcher.emit({ kind: "session-events", sessionId: "s1", events: [ev("recorded before the toggle")] });
    await waitUntil(() => entries(hub).length === 1);
    const recorded = entries(hub)[0]!.entry;

    await registry.setEnabled("claude-code", false);
    hub.connect();

    const backlog = hub.sent.find((m): m is Extract<ServerMessage, { type: "narration-backlog" }> => m.type === "narration-backlog");
    expect(backlog!.entries).toHaveLength(1);
    expect(backlog!.entries[0]).toEqual(recorded);
    expect(backlog!.watchedSessionId).toBeNull();
  });

  it("re-enabling resumes polling but does not re-attach (R10)", async () => {
    const { narration } = await build();
    await narration.watch("s1");
    await registry.setEnabled("claude-code", false);

    await registry.setEnabled("claude-code", true);

    expect(watcher.starts).toBe(2);
    expect(watcher.attaches).toEqual(["s1"]);
    expect(registry.watchedSessionId()).toBeNull();
    expect(settings.get().watchedSessionId).toBeNull();
  });

  it("toggling an already-enabled adapter is a no-op and does not restart polling", async () => {
    await build();
    expect(watcher.starts).toBe(1);
    let changes = 0;
    registry.onChanged(() => {
      changes += 1;
    });

    hub.dispatch({ type: "set-adapter-enabled", adapterId: "claude-code", enabled: true });
    await waitUntil(() => rosters(hub).length > 0);

    expect(watcher.starts).toBe(1);
    expect(watcher.stops).toBe(0);
    expect(changes).toBe(0);
    expect(rosters(hub).at(-1)!.adapters[0]!.enabled).toBe(true);
  });

  it("disabling an adapter that holds no watched session stops polling without a watch-stopped", async () => {
    await build();
    await registry.setEnabled("claude-code", false);

    expect(watcher.stops).toBe(1);
    expect(watcher.detaches).toBe(0);
    expect(hub.broadcasts.some((m) => m.type === "watch-stopped")).toBe(false);
  });

  it("signals a readiness refresh on a real toggle", async () => {
    await build();
    let changes = 0;
    registry.onChanged(() => {
      changes += 1;
    });

    await registry.setEnabled("claude-code", false);
    await registry.setEnabled("claude-code", true);

    expect(changes).toBe(2);
  });

  it("persists the enabled state so the next boot starts nothing", async () => {
    await build();
    await registry.setEnabled("claude-code", false);
    expect(settings.get().adapters["claude-code"].enabled).toBe(false);

    const rebooted = new SettingsStore(dir);
    await rebooted.load();
    const watcher2 = new FakeWatcher();
    const registry2 = new AdapterRegistry(new FakeHub(), rebooted, [
      { id: "claude-code", label: "Claude Code", watcher: watcher2 },
    ]);
    registry2.start();
    expect(watcher2.starts).toBe(0);
    expect(registry2.isEnabled("claude-code")).toBe(false);
  });
});

describe("discovery and attach", () => {
  it("tags every discovered summary with the adapter that produced it", async () => {
    await build();
    const sessions = await registry.discoverSessions();
    expect(sessions.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(sessions.every((s) => s.adapterId === "claude-code")).toBe(true);
    // Wire summaries only — the local log path never leaves the server.
    expect(sessions[0]).not.toHaveProperty("file");
  });

  it("omits sessions belonging to a disabled adapter", async () => {
    await build();
    await registry.setEnabled("claude-code", false);
    expect(await registry.discoverSessions()).toEqual([]);
  });

  it("yields a watch-failure error rather than throwing for a session no enabled adapter owns", async () => {
    await build();
    hub.dispatch({ type: "watch-session", sessionId: "not-a-session" });
    await waitUntil(() => errors(hub).length > 0);

    expect(errors(hub)[0]!.code).toBe("watch_failed");
    expect(watcher.attaches).toEqual([]);
    // A disabled adapter owns nothing, so its own sessions fail the same way.
    await registry.setEnabled("claude-code", false);
    await expect(registry.attach("s1")).rejects.toThrow(/No enabled adapter/);
  });

  it("survives an adapter whose discovery fails", async () => {
    await build();
    watcher.discoverError = new Error("log directory vanished");
    expect(await registry.discoverSessions()).toEqual([]);
    await expect(registry.attach("s1")).rejects.toThrow(/No enabled adapter/);
  });

  it("routes an attach to the owning adapter and reports its watched session", async () => {
    const { narration } = await build();
    await narration.watch("s2");
    expect(watcher.attaches).toEqual(["s2"]);
    expect(registry.watchedSessionId()).toBe("s2");
    expect(registry.watchedAdapterId()).toBe("claude-code");
  });
});

describe("adapter protocol", () => {
  it("lists every registered adapter, including ones absent from stored settings", async () => {
    // A settings file written before adapters existed.
    await fs.writeFile(path.join(dir, "settings.json"), JSON.stringify({ providerEndpoint: "http://localhost:11434" }), "utf8");
    const fresh = new SettingsStore(dir);
    await fresh.load();

    const reg = new AdapterRegistry(hub, fresh, [{ id: "claude-code", label: "Claude Code", watcher }]);
    hub.dispatch({ type: "list-adapters" });
    await waitUntil(() => rosters(hub).length > 0);

    expect(reg.list()).toEqual([{ id: "claude-code", label: "Claude Code", enabled: true }]);
    expect(rosters(hub).at(-1)!.adapters).toEqual(reg.list());
  });

  it("sends the roster to each new connection", async () => {
    await build();
    hub.connect();
    const roster = hub.sent.find((m): m is Extract<ServerMessage, { type: "adapters" }> => m.type === "adapters");
    expect(roster!.adapters).toEqual([{ id: "claude-code", label: "Claude Code", enabled: true }]);
  });

  it("does not crash the process when a handler rejects", async () => {
    await build();
    // settings.update writes to disk; point it at a path that cannot be written
    // so the toggle's persistence rejects inside the fire-and-forget handler.
    const broken = new SettingsStore(path.join(dir, "settings.json", "nested"));
    await broken.load();
    const reg = new AdapterRegistry(hub, broken, [{ id: "claude-code", label: "Claude Code", watcher }]);
    reg.start();
    hub.dispatch({ type: "set-adapter-enabled", adapterId: "claude-code", enabled: false });
    await new Promise((r) => setTimeout(r, 100));
    expect(reg.list()[0]!.enabled).toBe(false);
  });
});
