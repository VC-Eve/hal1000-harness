import { describe, it, expect, beforeEach } from "vitest";
import { pinnedSettings } from "./settings.js";
import { tmpDir } from "./tmp.js";
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
  dir = await tmpDir("ready");
  settings = await pinnedSettings(dir);
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
    expect(r).toEqual({
      observationBackend: "ok",
      chatBackend: "ok",
      models: "ok",
      claudeLogs: "ok",
      captioner: "disabled",
      recogniser: "disabled",
    });
  });

  it("reports both legs from one probe when they name the same server", async () => {
    // The ordinary setup. Probing one machine twice would only invite the two
    // rows to disagree about it.
    let calls = 0;
    const counting = (): Provider => ({
      async listModels() {
        calls += 1;
        return [{ name: "m" }];
      },
      async *chatStream() {
        yield "";
      },
    });

    const r = await probeReadiness(counting, settings, adapters({ sessions: 1 }));

    expect(calls).toBe(1);
    expect(r.chatBackend).toBe("ok");
    expect(r.observationBackend).toBe("ok");
  });

  it("probes the chat backend separately once it points somewhere else", async () => {
    await settings.update({
      backends: { chat: { endpoint: "http://127.0.0.1:8080", protocol: "openai" } },
    });
    const seen: string[] = [];
    const byEndpoint = (backend: { endpoint: string }): Provider => ({
      async listModels() {
        seen.push(backend.endpoint);
        if (backend.endpoint === "http://127.0.0.1:8080") {
          throw new ProviderError("provider_unavailable", "unreachable");
        }
        return [{ name: "m" }];
      },
      async *chatStream() {
        yield "";
      },
    });

    const r = await probeReadiness(byEndpoint, settings, adapters({ sessions: 1 }));

    // Two destinations, two answers. One row cannot describe both.
    expect(seen).toContain("http://localhost:11434");
    expect(seen).toContain("http://127.0.0.1:8080");
    expect(r.observationBackend).toBe("ok");
    expect(r.chatBackend).toBe("unreachable");
  });

  it("reports a blank chat endpoint against the backend it falls back to", async () => {
    // The row must not disagree with where a request would actually go, and a
    // blank chat endpoint resolves to the observation one.
    await settings.update({ backends: { chat: { endpoint: "  " } } });
    const r = await probeReadiness(provider(["m"]), settings, adapters({ sessions: 1 }));
    expect(r.chatBackend).toBe("ok");
  });

  it("reports a chat backend reachable even when it lists no models", async () => {
    await settings.update({
      backends: { chat: { endpoint: "http://127.0.0.1:8080", protocol: "openai" } },
    });
    const r = await probeReadiness(provider([]), settings, adapters({ sessions: 1 }));
    expect(r.chatBackend).toBe("ok");
    // Reachability and model count are different questions; the models leg is
    // what distinguishes "nothing pulled" from "nothing listening".
    expect(r.models).toBe("none");
  });

  it("does not lend one slot's credential to the other on a shared host", async () => {
    // The reviewed defect. Same endpoint, same protocol, key on observation
    // only — compared by endpoint these are one destination, so readiness ran
    // one probe with observation's key and reported chat `ok` on the strength
    // of it. Every chat send then came back 401 against a row saying fine.
    await settings.update({
      backends: {
        chat: { endpoint: "https://api.example.com", protocol: "openai" },
        observation: { endpoint: "https://api.example.com", protocol: "openai", apiKey: "sk-obs" },
      },
    });
    const keyed = (backend: { endpoint: string; apiKey?: string }): Provider => ({
      async listModels() {
        if (!backend.apiKey) throw new ProviderError("provider_unavailable", "401");
        return [{ name: "m" }];
      },
      async *chatStream() {
        yield "";
      },
    });

    const r = await probeReadiness(keyed, settings, adapters({ sessions: 1 }));

    expect(r.observationBackend).toBe("ok");
    expect(r.chatBackend).toBe("unreachable");
  });

  it("does not lend one slot's failure to the other on a shared host", async () => {
    // The mirror image, which is where this bit `list-models` too: chat keyless
    // and failing, observation keyed and working, one endpoint.
    await settings.update({
      backends: {
        chat: { endpoint: "https://api.example.com", protocol: "openai", apiKey: "sk-chat" },
        observation: { endpoint: "https://api.example.com", protocol: "openai" },
      },
    });
    const keyed = (backend: { apiKey?: string }): Provider => ({
      async listModels() {
        if (backend.apiKey) throw new ProviderError("provider_unavailable", "revoked");
        return [{ name: "m" }];
      },
      async *chatStream() {
        yield "";
      },
    });

    const r = await probeReadiness(keyed, settings, adapters({ sessions: 1 }));

    expect(r.observationBackend).toBe("ok");
    expect(r.chatBackend).toBe("unreachable");
  });

  it("reports no models when the chat backend has none, even with observation stocked", async () => {
    // Before the split there was one endpoint, so "nothing pulled" had one
    // answer. A chat backend with no model loaded rendered every row green and
    // an empty model picker, with nothing saying why a conversation could not
    // start.
    await settings.update({
      backends: { chat: { endpoint: "http://127.0.0.1:8080", protocol: "openai" } },
    });
    const byEndpoint = (backend: { endpoint: string }): Provider => ({
      async listModels() {
        return backend.endpoint === "http://127.0.0.1:8080" ? [] : [{ name: "stocked" }];
      },
      async *chatStream() {
        yield "";
      },
    });

    const r = await probeReadiness(byEndpoint, settings, adapters({ sessions: 1 }));

    expect(r.chatBackend).toBe("ok");
    expect(r.observationBackend).toBe("ok");
    expect(r.models).toBe("none");
  });

  it("distinguishes a down backend from zero-models", async () => {
    const down = await probeReadiness(provider("down"), settings, adapters({ sessions: 1 }));
    expect(down.observationBackend).toBe("unreachable");
    expect(down.models).toBe("unknown");

    const empty = await probeReadiness(provider([]), settings, adapters({ sessions: 1 }));
    expect(empty.observationBackend).toBe("ok");
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
    expect(r).toEqual({
      observationBackend: "ok",
      chatBackend: "ok",
      models: "ok",
      claudeLogs: "disabled",
      captioner: "disabled",
      recogniser: "disabled",
    });
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

  it("reports disabled even when the model backend is down", async () => {
    const r = await probeReadiness(provider("down"), settings, adapters({ enabled: false }));
    expect(r.observationBackend).toBe("unreachable");
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
