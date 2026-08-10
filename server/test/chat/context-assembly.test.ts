import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pinnedSettings } from "../settings.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChatService, type ContextSources } from "../../src/chat.js";
import { ConversationStore } from "../../src/storage/conversations.js";
import { SettingsStore } from "../../src/storage/settings.js";
import { ProviderQueue } from "../../src/providers/queue.js";
import type { ChatStreamOptions, Provider, ProviderFactory } from "../../src/providers/provider.js";
import type { ClientMessage, ServerMessage, NarrationEntry, VisionPresence } from "../../../shared/src/types.js";
import type { WsHub } from "../../src/ws.js";

// U5 — what the request actually carries.
//
// The load-bearing test is the first one: with both switches off the request
// must be exactly what it was before this feature existed. That is the one
// guarantee whose regression would be invisible from every other angle.

interface Sent {
  system: string | undefined;
  options: Record<string, unknown> | undefined;
  redact: string[] | undefined;
  messages: { role: string; content: string }[];
}

const WATCHED = "sess-a";

function fakeSources(over: Partial<ContextSources> = {}): ContextSources {
  return {
    presence: () => ({ watching: false, present: [] }) as VisionPresence,
    newestCaption: async () => null,
    recentCaptions: async () => [],
    people: async () => [],
    recentObservations: async () => [],
    recentlySeen: async () => [],
    monitorLabel: (id) => id,
    identityThresholds: () => ({ recognition: 0.5, statement: 0.6 }),
    ...over,
  };
}

describe("context at send time", () => {
  let dir: string;
  let settings: SettingsStore;
  let store: ConversationStore;
  let hub: WsHub;
  let broadcasts: ServerMessage[];
  let sends: Sent[];
  let handlers: ((m: ClientMessage) => void)[];

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "hal-chat-ctx-"));
    settings = await pinnedSettings(dir);
    store = new ConversationStore(dir);
    broadcasts = [];
    sends = [];
    handlers = [];
    hub = {
      broadcast: (m: ServerMessage) => broadcasts.push(m),
      onMessage: (fn: (m: ClientMessage) => void) => handlers.push(fn),
      onConnection: () => {},
      sendTo: () => {},
    } as unknown as WsHub;
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  function provider(): ProviderFactory {
    return () => ({
      async listModels() {
        return [{ name: "m", contextTokens: 8192 }];
      },
      async modelWindow() {
        return 8192;
      },
      async *chatStream(opts: ChatStreamOptions) {
        sends.push({
          system: opts.messages.find((m) => m.role === "system")?.content,
          options: opts.options,
          redact: opts.redact,
          messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
        });
        yield "ok";
      },
    });
  }

  function build(sources?: ContextSources): ChatService {
    return new ChatService(hub, store, settings, new ProviderQueue(), provider(), sources);
  }

  async function sendIn(svc: ChatService, id: string): Promise<void> {
    await (svc as unknown as { handle(m: ClientMessage): Promise<void> }).handle({
      type: "send-message",
      conversationId: id,
      content: "what am I doing?",
    });
  }

  async function convo(context?: { vision?: string; session?: string }): Promise<string> {
    const c = await store.create("m", "");
    if (context) await store.setContext(c.id, context as never);
    return c.id;
  }

  it("sends exactly the pre-feature request when both switches are off", async () => {
    // Characterization: a blank prompt sends no system message at all, and no
    // context branch may change that.
    const id = await convo();
    await sendIn(build(fakeSources()), id);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.system).toBeUndefined();
    expect(sends[0]!.messages.map((m) => m.role)).toEqual(["user"]);
    expect(sends[0]!.redact).toBeUndefined();
  });

  it("leaves a stored prompt untouched when both switches are off", async () => {
    const c = await store.create("m", "You are HAL.");
    await sendIn(build(fakeSources()), c.id);
    expect(sends[0]!.system).toBe("You are HAL.");
  });

  it("never consults the sources when both switches are off", async () => {
    // A thread that asked for nothing must not open the camera's state.
    let touched = false;
    const spy = fakeSources({
      presence: () => {
        touched = true;
        return { watching: false, present: [] };
      },
    });
    await sendIn(build(spy), await convo());
    expect(touched).toBe(false);
  });

  it("sends exactly one system message when a blank prompt meets an active switch", async () => {
    const id = await convo({ vision: "large" });
    await sendIn(build(fakeSources({ presence: () => ({ watching: true, present: [] }) })), id);
    expect(sends[0]!.messages.filter((m) => m.role === "system")).toHaveLength(1);
    expect(sends[0]!.system).toContain("no face I can place");
  });

  it("appends context beneath a stored prompt rather than replacing it", async () => {
    const c = await store.create("m", "You are HAL.");
    await store.setContext(c.id, { vision: "large" });
    await sendIn(build(fakeSources({ presence: () => ({ watching: true, present: [] }) })), c.id);
    expect(sends[0]!.system!.startsWith("You are HAL.")).toBe(true);
    expect(sends[0]!.system).toContain("no face I can place");
  });

  it("carries both segments, each within its own budget", async () => {
    await settings.update({ watchedSessionId: WATCHED });
    const entries: NarrationEntry[] = [
      { id: "1", at: new Date().toISOString(), kind: "narration", text: "It is editing the parser.", sessionId: WATCHED, sessionLabel: "Claude [a3f9]" },
    ];
    const id = await convo({ vision: "large", session: "large" });
    await sendIn(
      build(fakeSources({
        presence: () => ({ watching: true, present: [] }),
        recentObservations: async () => entries,
      })),
      id,
    );
    expect(sends[0]!.system).toContain("no face I can place");
    expect(sends[0]!.system).toContain("It is editing the parser.");
  });

  it("names the context as its own faculty before any of it arrives", async () => {
    // Without this the blocks read as a report delivered for comment, and HAL
    // answered them instead of simply knowing where it was.
    const id = await convo({ vision: "large" });
    await sendIn(build(fakeSources({ presence: () => ({ watching: true, present: [] }) })), id);
    const system = sends[0]!.system!;
    expect(system).toContain("mine rather than anything said to me");
    expect(system.indexOf("mine rather than anything said to me")).toBeLessThan(system.indexOf("no face I can place"));
  });

  it("uses an edited preamble instead of the shipped one", async () => {
    await settings.update({ chatContextPreamble: "These are my own senses." });
    const id = await convo({ vision: "large" });
    await sendIn(build(fakeSources({ presence: () => ({ watching: true, present: [] }) })), id);
    expect(sends[0]!.system).toContain("These are my own senses.");
    expect(sends[0]!.system).not.toContain("mine rather than anything said to me");
  });

  it("sends the context unintroduced when the preamble is blank", async () => {
    // Blank is a real choice, the way a blank conversation prompt sends no
    // system message — not a signal to fall back to the shipped text.
    await settings.update({ chatContextPreamble: "" });
    const id = await convo({ vision: "large" });
    await sendIn(build(fakeSources({ presence: () => ({ watching: true, present: [] }) })), id);
    expect(sends[0]!.system).not.toContain("mine rather than anything said to me");
    expect(sends[0]!.system).toContain("no face I can place");
  });

  it("picks up an edited preamble on a thread already under way", async () => {
    // Resolved at send time, not stamped at creation — unlike the conversation
    // prompt, which is deliberately a copy.
    const id = await convo({ vision: "large" });
    const svc = build(fakeSources({ presence: () => ({ watching: true, present: [] }) }));
    await sendIn(svc, id);
    await settings.update({ chatContextPreamble: "Changed mid-thread." });
    await sendIn(svc, id);
    expect(sends[0]!.system).toContain("mine rather than anything said to me");
    expect(sends[1]!.system).toContain("Changed mid-thread.");
  });

  it("carries no preamble when there is no context to introduce", async () => {
    await sendIn(build(fakeSources()), await convo());
    expect(sends[0]!.system).toBeUndefined();
  });

  it("puts sight last, after the session commentary", async () => {
    // Order is load-bearing. The session block is HAL's own narration, is often
    // far larger, and — when the watched session is the one building HAL —
    // discusses vision itself. With sight first, a model asked what it could
    // see answered from the narration instead, while a caption describing the
    // room sat above it. The last thing in the prompt is what carries.
    await settings.update({ watchedSessionId: WATCHED });
    const entries: NarrationEntry[] = [
      { id: "1", at: new Date().toISOString(), kind: "narration", text: "Vision came back on after the restart.", sessionId: WATCHED, sessionLabel: "Claude [a3f9]" },
    ];
    const id = await convo({ vision: "large", session: "large" });
    await sendIn(
      build(fakeSources({
        presence: () => ({ watching: true, present: [] }),
        recentObservations: async () => entries,
      })),
      id,
    );
    const system = sends[0]!.system!;
    expect(system.indexOf("Vision came back on")).toBeLessThan(system.indexOf("no face I can place"));
  });

  it("writes nothing to the conversation record", async () => {
    // Persisting assembled context would put profile text beyond the reach of
    // per-person deletion and the purge, and freeze the roster at creation.
    const id = await convo({ vision: "large" });
    await sendIn(
      build(fakeSources({
        presence: () => ({ watching: true, present: [{ match: { personId: "p1", name: "Alice", confidence: 0.9 }, since: new Date().toISOString() }] }),
        people: async () => [{ name: "Alice", profile: "Writes the compiler." }],
      })),
      id,
    );
    const raw = await fs.readFile(path.join(dir, "conversations", `${id}.json`), "utf8");
    expect(raw).not.toContain("Writes the compiler.");
    expect(raw).not.toContain("Alice");
  });

  it("reflects a roster rename on the next send", async () => {
    // Proof the context is assembled per request rather than at thread
    // creation: the same conversation, two sends, two names.
    let name = "Alice";
    const id = await convo({ vision: "large" });
    const sources = fakeSources({
      presence: () => ({ watching: true, present: [{ match: { personId: "p1", name, confidence: 0.9 }, since: new Date().toISOString() }] }),
    });
    const svc = build(sources);
    await sendIn(svc, id);
    name = "Alicia";
    await sendIn(svc, id);
    expect(sends[0]!.system).toContain("Alice");
    expect(sends[1]!.system).toContain("Alicia");
  });

  it("names delivered profile text for redaction from the inference log", async () => {
    const id = await convo({ vision: "large" });
    await sendIn(
      build(fakeSources({
        presence: () => ({ watching: true, present: [{ match: { personId: "p1", name: "Alice", confidence: 0.9 }, since: new Date().toISOString() }] }),
        people: async () => [{ name: "Alice", profile: "Writes the compiler." }],
      })),
      id,
    );
    expect(sends[0]!.redact).toContain("Writes the compiler.");
  });

  it("does not name a profile that the band withheld", async () => {
    // Nothing was sent, so there is nothing to redact — and listing it would
    // suggest it had been.
    const id = await convo({ vision: "large" });
    await sendIn(
      build(fakeSources({
        presence: () => ({ watching: true, present: [{ match: { personId: "p1", name: "Alice", confidence: 0.55 }, since: new Date().toISOString() }] }),
        people: async () => [{ name: "Alice", profile: "Writes the compiler." }],
      })),
      id,
    );
    expect(sends[0]!.system).not.toContain("Writes the compiler.");
    expect(sends[0]!.redact ?? []).not.toContain("Writes the compiler.");
  });

  it("still streams a reply when a source throws", async () => {
    const id = await convo({ vision: "large" });
    await sendIn(
      build(fakeSources({
        presence: () => {
          throw new Error("camera exploded");
        },
      })),
      id,
    );
    expect(sends).toHaveLength(1);
    expect(broadcasts.some((m) => m.type === "chat-done")).toBe(true);
  });

  it("sets num_ctx on every request, switches or not", async () => {
    await sendIn(build(fakeSources()), await convo());
    expect(sends[0]!.options).toEqual({ num_ctx: 8192 });
  });

  it("caps num_ctx below what a large model advertises", async () => {
    await settings.update({ chatContextCap: 4096 });
    await sendIn(build(fakeSources()), await convo());
    expect(sends[0]!.options).toEqual({ num_ctx: 4096 });
  });

  describe("the off-machine gate", () => {
    const seen = () => ({
      watching: true,
      present: [{ match: { personId: "p1", name: "Alice", confidence: 0.9 }, since: new Date().toISOString() }],
    });

    it("sends context to a loopback provider without an acknowledgement", async () => {
      const id = await convo({ vision: "large" });
      await sendIn(build(fakeSources({ presence: seen })), id);
      expect(sends[0]!.system).toContain("Alice");
    });

    // The protocol is pinned in these tests rather than probed. They are about
    // the acknowledgement gate, and a probe against an endpoint nobody is
    // listening at would decide the outcome before the gate was reached.

    it("omits context for a remote provider that was never acknowledged", async () => {
      await settings.update({ backends: { chat: { endpoint: "http://192.168.1.50:11434", protocol: "ollama" } } });
      const id = await convo({ vision: "large" });
      await sendIn(build(fakeSources({ presence: seen })), id);
      expect(sends[0]!.system).toBeUndefined();
    });

    it("still streams the reply when the gate withholds context", async () => {
      await settings.update({ backends: { chat: { endpoint: "http://192.168.1.50:11434", protocol: "ollama" } } });
      await sendIn(build(fakeSources({ presence: seen })), await convo({ vision: "large" }));
      expect(broadcasts.some((m) => m.type === "chat-done")).toBe(true);
    });

    it("sends once acknowledged", async () => {
      await settings.update({ backends: { chat: { endpoint: "http://192.168.1.50:11434", protocol: "ollama" } }, offMachineAcknowledged: true });
      const id = await convo({ vision: "large" });
      await sendIn(build(fakeSources({ presence: seen })), id);
      expect(sends[0]!.system).toContain("Alice");
    });

    it("re-checks on every send, so a later endpoint change cannot slip past", async () => {
      // The failure this prevents: acknowledging nothing while local, then
      // pointing the provider elsewhere and having the old decision carry.
      const id = await convo({ vision: "large" });
      const svc = build(fakeSources({ presence: seen }));
      await sendIn(svc, id);
      await settings.update({ backends: { chat: { endpoint: "https://api.example.com", protocol: "ollama" } } });
      await sendIn(svc, id);
      expect(sends[0]!.system).toContain("Alice");
      expect(sends[1]!.system).toBeUndefined();
    });

    it("treats an unparseable endpoint as remote", async () => {
      await settings.update({ backends: { chat: { endpoint: "not a url", protocol: "ollama" } } });
      await sendIn(build(fakeSources({ presence: seen })), await convo({ vision: "large" }));
      expect(sends[0]!.system).toBeUndefined();
    });

    it("gates on chat's own backend, not on a remote shared one", async () => {
      // Per role. Narration going off-machine says nothing about where this
      // conversation's request is headed.
      await settings.update({
        backends: {
          observation: { endpoint: "https://api.example.com", protocol: "openai" },
          chat: { endpoint: "http://127.0.0.1:8080", protocol: "ollama" },
        },
      });
      const id = await convo({ vision: "large" });
      await sendIn(build(fakeSources({ presence: seen })), id);
      expect(sends[0]!.system).toContain("Alice");
    });

    it("gates a remote chat backend even while the shared one is local", async () => {
      await settings.update({
        backends: {
          observation: { endpoint: "http://localhost:11434", protocol: "ollama" },
          chat: { endpoint: "https://api.example.com", protocol: "ollama" },
        },
      });
      const id = await convo({ vision: "large" });
      await sendIn(build(fakeSources({ presence: seen })), id);
      expect(sends[0]!.system).toBeUndefined();
    });

    it("treats loopback on a non-default port as local", async () => {
      await settings.update({ backends: { chat: { endpoint: "http://127.0.0.1:9999", protocol: "ollama" } } });
      const id = await convo({ vision: "large" });
      await sendIn(build(fakeSources({ presence: seen })), id);
      expect(sends[0]!.system).toContain("Alice");
    });
  });
});
