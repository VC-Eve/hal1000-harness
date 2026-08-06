import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import type { WebSocket } from "ws";
import { ADAPTER_IDS, type AdapterId, type ClientMessage, type ServerMessage, type SessionSummary } from "../../../shared/src/types.js";
import { DEFAULT_NARRATION_PROMPT } from "../../../shared/src/prompts.js";
import { NarrationService, type NarrationHub } from "../../src/narration/narrator.js";
import { ProviderError, type ChatStreamOptions, type Provider } from "../../src/providers/provider.js";
import { ProviderQueue } from "../../src/providers/queue.js";
import { SettingsStore } from "../../src/storage/settings.js";
import type { WatcherRegistry } from "../../src/watchers/registry.js";
import type { SessionEvent, SessionInfo, WatcherNotification } from "../../src/watchers/watcher.js";

// The narration service works against the registry now, not a bare watcher;
// this fake stands in for it, always attributing to the one adapter.
class FakeRegistry implements WatcherRegistry {
  private listeners = new Set<(n: WatcherNotification, adapterId: AdapterId) => void>();
  private disabledListeners = new Set<(adapterId: AdapterId) => Promise<void> | void>();
  private watched: string | null = null;
  sessions: SessionSummary[] = [];

  async discoverSessions(): Promise<SessionSummary[]> {
    return this.sessions;
  }
  async attach(sessionId: string): Promise<void> {
    this.watched = sessionId;
  }
  async detach(): Promise<void> {
    this.watched = null;
  }
  watchedSessionId(): string | null {
    return this.watched;
  }
  subscribe(listener: (n: WatcherNotification, adapterId: AdapterId) => void): void {
    this.listeners.add(listener);
  }
  onDisabled(listener: (adapterId: AdapterId) => Promise<void> | void): void {
    this.disabledListeners.add(listener);
  }

  emit(n: WatcherNotification, adapterId: AdapterId = "claude-code"): void {
    for (const l of this.listeners) l(n, adapterId);
  }
  async disable(): Promise<void> {
    for (const l of this.disabledListeners) await l("claude-code");
  }
}

class FakeHub implements NarrationHub {
  broadcasts: ServerMessage[] = [];
  private handlers: ((msg: ClientMessage, client: WebSocket) => void)[] = [];
  private greeters: ((client: WebSocket) => void)[] = [];
  sent: ServerMessage[] = [];

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

interface NarratorCall {
  model: string;
  prompt: string;
  system: string | undefined;
  options: Record<string, unknown> | undefined;
}

type Behavior = (call: NarratorCall, signal: AbortSignal | undefined) => Promise<string>;

function makeProvider(calls: NarratorCall[], behavior: Behavior) {
  return (_endpoint: string): Provider => ({
    async listModels() {
      return [];
    },
    async *chatStream(opts: ChatStreamOptions): AsyncIterable<string> {
      const call: NarratorCall = {
        model: opts.model,
        prompt: opts.messages.find((m) => m.role === "user")?.content ?? "",
        system: opts.messages.find((m) => m.role === "system")?.content,
        options: opts.options,
      };
      calls.push(call);
      yield await behavior(call, opts.signal);
    },
  });
}

function gate() {
  let open!: (v: string) => void;
  let fail!: (e: unknown) => void;
  const promise = new Promise<string>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  return { promise, open, fail };
}

const ev = (text: string, kind: SessionEvent["kind"] = "assistant"): SessionEvent => ({
  at: "2026-08-02T10:00:00Z",
  kind,
  text,
  toolUses: [],
});

async function waitUntil(fn: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

let dir: string;
let settings: SettingsStore;
let hub: FakeHub;
let registry: FakeRegistry;
let queue: ProviderQueue;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hal1000-narr-"));
  settings = new SettingsStore(dir);
  await settings.load();
  await settings.update({ chatModel: "chat-m1" });
  hub = new FakeHub();
  registry = new FakeRegistry();
  queue = new ProviderQueue();
});

const entries = (h: FakeHub) => h.broadcasts.filter((m): m is Extract<ServerMessage, { type: "narration-entry" }> => m.type === "narration-entry");
const statuses = (h: FakeHub) => h.broadcasts.filter((m): m is Extract<ServerMessage, { type: "narration-status" }> => m.type === "narration-status").map((m) => m.status);

describe("NarrationService", () => {
  it("narrates a single event and returns to idle", async () => {
    const calls: NarratorCall[] = [];
    const svc = new NarrationService(hub, registry, settings, queue, makeProvider(calls, async () => "The agent proceeds."), {});
    await svc.watch("s1");
    registry.emit({ kind: "session-events", sessionId: "s1", events: [ev("edited app.ts")] });
    await waitUntil(() => entries(hub).length === 1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt).toContain("edited app.ts");
    expect(calls[0]!.options?.num_ctx).toBeDefined();
    expect(entries(hub)[0]!.entry.text).toBe("The agent proceeds.");
    await waitUntil(() => statuses(hub).at(-1) === "idle");
  });

  it("sends the shipped narration default when no prompt is stored", async () => {
    const calls: NarratorCall[] = [];
    const svc = new NarrationService(hub, registry, settings, queue, makeProvider(calls, async () => "ok"), {});
    await svc.watch("s1");
    registry.emit({ kind: "session-events", sessionId: "s1", events: [ev("edited app.ts")] });
    await waitUntil(() => calls.length === 1);
    expect(calls[0]!.system).toBe(DEFAULT_NARRATION_PROMPT);
  });

  it("sends a stored narration prompt verbatim", async () => {
    const calls: NarratorCall[] = [];
    await settings.update({ narrationPrompt: "Report tersely. No character." });
    const svc = new NarrationService(hub, registry, settings, queue, makeProvider(calls, async () => "ok"), {});
    await svc.watch("s1");
    registry.emit({ kind: "session-events", sessionId: "s1", events: [ev("edited app.ts")] });
    await waitUntil(() => calls.length === 1);
    expect(calls[0]!.system).toBe("Report tersely. No character.");
  });

  it("applies an edited prompt to the next narration and leaves the earlier entry alone (R6, AE7)", async () => {
    const calls: NarratorCall[] = [];
    const svc = new NarrationService(hub, registry, settings, queue, makeProvider(calls, async () => "ok"), {});
    await svc.watch("s1");
    registry.emit({ kind: "session-events", sessionId: "s1", events: [ev("first")] });
    await waitUntil(() => entries(hub).length === 1);
    const firstEntryText = entries(hub)[0]!.entry.text;

    await settings.update({ narrationPrompt: "A different voice entirely." });
    registry.emit({ kind: "session-events", sessionId: "s1", events: [ev("second")] });
    await waitUntil(() => calls.length === 2);
    expect(calls[0]!.system).toBe(DEFAULT_NARRATION_PROMPT);
    expect(calls[1]!.system).toBe("A different voice entirely.");
    expect(entries(hub)[0]!.entry.text).toBe(firstEntryText);
  });

  it("sends the same prompt whichever adapter produced the events (R2)", async () => {
    const calls: NarratorCall[] = [];
    const svc = new NarrationService(hub, registry, settings, queue, makeProvider(calls, async () => "ok"), {});
    await svc.watch("s1");
    for (const id of ADAPTER_IDS) {
      registry.emit({ kind: "session-events", sessionId: "s1", events: [ev(`from ${id}`)] }, id);
      await waitUntil(() => calls.some((c) => c.prompt.includes(`from ${id}`)));
    }
    expect(new Set(calls.map((c) => c.system)).size).toBe(1);
    expect(calls[0]!.system).toBe(DEFAULT_NARRATION_PROMPT);
  });

  it("coalesces a burst during a slow call into one follow-up prompt (AE6)", async () => {
    const calls: NarratorCall[] = [];
    const first = gate();
    let callIndex = 0;
    const svc = new NarrationService(
      hub,
      registry,
      settings,
      queue,
      makeProvider(calls, (call) => {
        callIndex += 1;
        return callIndex === 1 ? first.promise : Promise.resolve("Coalesced summary.");
      }),
      { catchingUpThreshold: 3 },
    );
    await svc.watch("s1");
    registry.emit({ kind: "session-events", sessionId: "s1", events: [ev("first")] });
    await waitUntil(() => calls.length === 1);
    for (const t of ["second", "third", "fourth", "fifth"]) {
      registry.emit({ kind: "session-events", sessionId: "s1", events: [ev(t)] });
    }
    first.open("First summary.");
    await waitUntil(() => entries(hub).length === 2);
    expect(calls).toHaveLength(2);
    for (const t of ["second", "third", "fourth", "fifth"]) {
      expect(calls[1]!.prompt).toContain(t);
    }
    expect(statuses(hub)).toContain("catching-up");
  });

  it("waits behind a streaming chat job (R16)", async () => {
    const calls: NarratorCall[] = [];
    const chatGate = gate();
    const svc = new NarrationService(hub, registry, settings, queue, makeProvider(calls, async () => "After chat."), {});
    await svc.watch("s1");
    const chatJob = queue.enqueue("chat", async () => chatGate.promise);
    registry.emit({ kind: "session-events", sessionId: "s1", events: [ev("while chat streams")] });
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toHaveLength(0);
    chatGate.open("done");
    await chatJob;
    await waitUntil(() => entries(hub).length === 1);
    expect(calls).toHaveLength(1);
  });

  it("re-queues an aborted batch and narrates it after chat (R16 abort path)", async () => {
    const calls: NarratorCall[] = [];
    let callIndex = 0;
    const svc = new NarrationService(
      hub,
      registry,
      settings,
      queue,
      makeProvider(calls, (call, signal) => {
        callIndex += 1;
        if (callIndex === 1) {
          return new Promise<string>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new ProviderError("aborted", "interrupted")));
          });
        }
        return Promise.resolve("Recovered narration.");
      }),
      {},
    );
    await svc.watch("s1");
    registry.emit({ kind: "session-events", sessionId: "s1", events: [ev("important activity")] });
    await waitUntil(() => calls.length === 1);
    const chatGate = gate();
    const chatJob = queue.enqueue("chat", async () => chatGate.promise);
    chatGate.open("chat done");
    await chatJob;
    await waitUntil(() => entries(hub).length === 1);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.prompt).toContain("important activity");
    expect(entries(hub)[0]!.entry.text).toBe("Recovered narration.");
  });

  it("pauses without a narration model and resumes when one is chosen (R19)", async () => {
    await settings.update({ chatModel: null });
    const calls: NarratorCall[] = [];
    const svc = new NarrationService(hub, registry, settings, queue, makeProvider(calls, async () => "Now narrating."), {});
    await svc.watch("s1");
    registry.emit({ kind: "session-events", sessionId: "s1", events: [ev("unheard activity")] });
    await waitUntil(() => statuses(hub).includes("paused-missing-model"));
    expect(calls).toHaveLength(0);
    hub.dispatch({ type: "update-settings", patch: { narrationModel: "n-ok" } });
    await waitUntil(() => entries(hub).length === 1);
    expect(calls[0]!.model).toBe("n-ok");
  });

  it("in follow mode, picking a chat model also resumes a paused narrator", async () => {
    await settings.update({ chatModel: null });
    const calls: NarratorCall[] = [];
    const svc = new NarrationService(hub, registry, settings, queue, makeProvider(calls, async () => "Following now."), {});
    await svc.watch("s1");
    registry.emit({ kind: "session-events", sessionId: "s1", events: [ev("waiting activity")] });
    await waitUntil(() => statuses(hub).includes("paused-missing-model"));
    hub.dispatch({ type: "update-settings", patch: { chatModel: "chat-picked" } });
    await waitUntil(() => entries(hub).length === 1);
    expect(calls[0]!.model).toBe("chat-picked");
  });

  it("unwatch clears pending work and pending retries", async () => {
    const calls: NarratorCall[] = [];
    let failing = true;
    const svc = new NarrationService(
      hub,
      registry,
      settings,
      queue,
      makeProvider(calls, async () => {
        if (failing) throw new ProviderError("provider_unavailable", "down");
        return "should never appear";
      }),
      { retryMs: 40 },
    );
    await svc.watch("s1");
    registry.emit({ kind: "session-events", sessionId: "s1", events: [ev("doomed")] });
    await waitUntil(() => statuses(hub).includes("provider-unavailable"));
    failing = false;
    hub.dispatch({ type: "unwatch" });
    await waitUntil(() => hub.broadcasts.some((m) => m.type === "watch-stopped"));
    const before = entries(hub).length;
    await new Promise((r) => setTimeout(r, 150));
    expect(entries(hub).length).toBe(before);
    expect(entries(hub).every((e) => e.entry.text !== "should never appear")).toBe(true);
  });

  it("reports provider outage in-feed once, keeps entries, and retries (AE4)", async () => {
    const calls: NarratorCall[] = [];
    let failing = true;
    const svc = new NarrationService(
      hub,
      registry,
      settings,
      queue,
      makeProvider(calls, async () => {
        if (failing) throw new ProviderError("provider_unavailable", "Ollama is not reachable.");
        return "Back online.";
      }),
      { retryMs: 40 },
    );
    await svc.watch("s1");
    registry.emit({ kind: "session-events", sessionId: "s1", events: [ev("during outage")] });
    await waitUntil(() => statuses(hub).includes("provider-unavailable"));
    const statusEntries = entries(hub).filter((e) => e.entry.kind === "status");
    expect(statusEntries).toHaveLength(1);
    failing = false;
    await waitUntil(() => entries(hub).some((e) => e.entry.text === "Back online."));
    // Prior status entry is still in the feed (nothing dropped).
    expect(entries(hub).filter((e) => e.entry.kind === "status")).toHaveLength(1);
  });

  it("keeps the narration model sticky across chat-model changes", async () => {
    const calls: NarratorCall[] = [];
    const svc = new NarrationService(hub, registry, settings, queue, makeProvider(calls, async () => "ok"), {});
    await svc.watch("s1");
    await settings.update({ chatModel: "chat-m2" });
    registry.emit({ kind: "session-events", sessionId: "s1", events: [ev("activity")] });
    await waitUntil(() => calls.length === 1);
    expect(calls[0]!.model).toBe("chat-m1");
  });

  it("broadcasts gap entries and replays the backlog on connect", async () => {
    const calls: NarratorCall[] = [];
    const svc = new NarrationService(hub, registry, settings, queue, makeProvider(calls, async () => "narrated"), {});
    await svc.watch("s1");
    registry.emit({ kind: "gap", sessionId: "s1" });
    expect(entries(hub)).toHaveLength(1);
    expect(entries(hub)[0]!.entry.kind).toBe("gap");

    hub.connect();
    const backlog = hub.sent.find((m): m is Extract<ServerMessage, { type: "narration-backlog" }> => m.type === "narration-backlog");
    expect(backlog).toBeDefined();
    expect(backlog!.entries).toHaveLength(1);
    expect(backlog!.watchedSessionId).toBe("s1");
  });

  it("relays session state, sessions list, and new-session notifications", async () => {
    const calls: NarratorCall[] = [];
    new NarrationService(hub, registry, settings, queue, makeProvider(calls, async () => "x"), {});
    const info: SessionInfo = { id: "s2", projectSlug: "p", projectName: "proj", file: "f", state: "live", lastActivity: "t" };
    registry.emit({ kind: "session-state", sessionId: "s1", state: "idle" });
    registry.emit({ kind: "sessions", sessions: [info] });
    registry.emit({ kind: "new-session", session: info });
    expect(hub.broadcasts.some((m) => m.type === "session-status" && m.state === "idle")).toBe(true);
    const sessions = hub.broadcasts.find((m): m is Extract<ServerMessage, { type: "sessions" }> => m.type === "sessions");
    expect(sessions!.sessions[0]).not.toHaveProperty("file");
    expect(hub.broadcasts.some((m) => m.type === "new-session-available")).toBe(true);
  });
});

// Only one adapter id exists today; a second is cast in so the switch cases
// exercise real attribution rather than a single-owner degenerate case.
const OTHER = "codex" as AdapterId;

describe("NarrationService attribution (R14, R15)", () => {
  it("stamps a narration entry with the adapter that supplied the events", async () => {
    const calls: NarratorCall[] = [];
    const svc = new NarrationService(hub, registry, settings, queue, makeProvider(calls, async () => "The agent proceeds."), {});
    await svc.watch("s1");
    registry.emit({ kind: "session-events", sessionId: "s1", events: [ev("edited app.ts")] });
    await waitUntil(() => entries(hub).length === 1);
    expect(entries(hub)[0]!.entry.adapterId).toBe("claude-code");
  });

  it("attributes an in-flight batch to its own adapter when the attachment changes underneath", async () => {
    const calls: NarratorCall[] = [];
    const inflight = gate();
    const svc = new NarrationService(hub, registry, settings, queue, makeProvider(calls, () => inflight.promise), {});
    await svc.watch("s1");
    registry.emit({ kind: "session-events", sessionId: "s1", events: [ev("claude activity")] });
    await waitUntil(() => calls.length === 1);
    // Attaching another session detaches the first without a teardown, so U2's
    // epoch guard does not drop this batch — it lands after the attachment it
    // came from is gone, which is exactly the case the drain-time capture is
    // for. (A teardown-shaped detach drops the batch entirely; that invariant
    // belongs to U2 and is covered there.)
    await svc.watch("s2");
    inflight.open("Narrated after the switch.");
    await waitUntil(() => entries(hub).length === 1);
    expect(entries(hub)[0]!.entry.adapterId).toBe("claude-code");
  });

  it("keeps the adapter id on a batch requeued after chat preemption", async () => {
    const calls: NarratorCall[] = [];
    let callIndex = 0;
    const svc = new NarrationService(
      hub,
      registry,
      settings,
      queue,
      makeProvider(calls, (_call, signal) => {
        callIndex += 1;
        if (callIndex === 1) {
          return new Promise<string>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new ProviderError("aborted", "interrupted")));
          });
        }
        return Promise.resolve("Recovered narration.");
      }),
      {},
    );
    await svc.watch("s1");
    registry.emit({ kind: "session-events", sessionId: "s1", events: [ev("important activity")] });
    await waitUntil(() => calls.length === 1);
    const chatGate = gate();
    const chatJob = queue.enqueue("chat", async () => chatGate.promise);
    chatGate.open("chat done");
    await chatJob;
    await waitUntil(() => entries(hub).length === 1);
    expect(entries(hub)[0]!.entry.text).toBe("Recovered narration.");
    expect(entries(hub)[0]!.entry.adapterId).toBe("claude-code");
  });

  it("leaves gap and status entries unattributed (HAL's own voice)", async () => {
    const calls: NarratorCall[] = [];
    let failing = true;
    const svc = new NarrationService(
      hub,
      registry,
      settings,
      queue,
      makeProvider(calls, async () => {
        if (failing) throw new ProviderError("provider_unavailable", "down");
        return "Back online.";
      }),
      { retryMs: 40 },
    );
    await svc.watch("s1");
    registry.emit({ kind: "gap", sessionId: "s1" });
    registry.emit({ kind: "session-events", sessionId: "s1", events: [ev("during outage")] });
    await waitUntil(() => entries(hub).some((e) => e.entry.kind === "status"));
    const gapEntry = entries(hub).find((e) => e.entry.kind === "gap")!;
    const statusEntry = entries(hub).find((e) => e.entry.kind === "status")!;
    expect(gapEntry.entry.adapterId ?? null).toBeNull();
    expect(statusEntry.entry.adapterId ?? null).toBeNull();
    // The narration entry from the same run is still attributed.
    failing = false;
    await waitUntil(() => entries(hub).some((e) => e.entry.text === "Back online."));
    expect(entries(hub).find((e) => e.entry.text === "Back online.")!.entry.adapterId).toBe("claude-code");
  });

  it("leaves already-recorded ids alone after switching adapters (AE3)", async () => {
    const calls: NarratorCall[] = [];
    let callIndex = 0;
    const svc = new NarrationService(hub, registry, settings, queue, makeProvider(calls, async () => `narrated ${++callIndex}`), {});
    await svc.watch("s1");
    registry.emit({ kind: "session-events", sessionId: "s1", events: [ev("claude activity")] });
    await waitUntil(() => entries(hub).length === 1);
    await svc.watch("s2");
    registry.emit({ kind: "session-events", sessionId: "s2", events: [ev("other activity")] }, OTHER);
    await waitUntil(() => entries(hub).length === 2);
    expect(entries(hub)[0]!.entry.adapterId).toBe("claude-code");
    expect(entries(hub)[1]!.entry.adapterId).toBe(OTHER);
  });

  it("replays the backlog with every recorded id intact", async () => {
    const calls: NarratorCall[] = [];
    let callIndex = 0;
    const svc = new NarrationService(hub, registry, settings, queue, makeProvider(calls, async () => `narrated ${++callIndex}`), {});
    await svc.watch("s1");
    registry.emit({ kind: "gap", sessionId: "s1" });
    registry.emit({ kind: "session-events", sessionId: "s1", events: [ev("claude activity")] });
    await waitUntil(() => entries(hub).length === 2);
    await svc.watch("s2");
    registry.emit({ kind: "session-events", sessionId: "s2", events: [ev("other activity")] }, OTHER);
    await waitUntil(() => entries(hub).length === 3);

    hub.connect();
    const backlog = hub.sent.find((m): m is Extract<ServerMessage, { type: "narration-backlog" }> => m.type === "narration-backlog")!;
    expect(backlog.entries.map((e) => e.adapterId ?? null)).toEqual([null, "claude-code", OTHER]);
  });
});

