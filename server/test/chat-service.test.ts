import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import WebSocket from "ws";
import { startApp, type App } from "../src/app.js";
import { ProviderError, type ChatStreamOptions, type Provider, type ResolvedBackend } from "../src/providers/provider.js";
import type { ClientMessage, ServerMessage } from "../../shared/src/types.js";
import { DEFAULT_CHAT_PROMPT, DEFAULT_NARRATION_PROMPT, NARRATION_PRESETS } from "../../shared/src/prompts.js";

class TestClient {
  private readonly ws: WebSocket;
  readonly received: ServerMessage[] = [];
  private waiters: { predicate: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];

  constructor(
    port: number,
    private readonly token: string,
  ) {
    this.ws = new WebSocket(`ws://localhost:${port}/ws`);
    this.ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as ServerMessage;
      this.received.push(msg);
      this.waiters = this.waiters.filter((w) => {
        if (w.predicate(msg)) {
          w.resolve(msg);
          return false;
        }
        return true;
      });
    });
  }

  async ready(): Promise<void> {
    if (this.ws.readyState !== WebSocket.OPEN) {
      await new Promise<void>((resolve, reject) => {
        this.ws.once("open", resolve);
        this.ws.once("error", reject);
      });
    }
    // The handshake is a precondition on every socket (U1). Nothing is sent to
    // us and nothing of ours is dispatched until it lands, so "ready" now means
    // admitted rather than merely connected.
    this.ws.send(JSON.stringify({ type: "authenticate", token: this.token }));
    await this.waitFor((m): m is ServerMessage & { type: "hello" } => m.type === "hello");
  }

  send(msg: ClientMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  waitFor<T extends ServerMessage>(predicate: (m: ServerMessage) => m is T, timeoutMs = 5000): Promise<T> {
    const already = this.received.find(predicate);
    if (already) return Promise.resolve(already);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("waitFor timed out")), timeoutMs);
      this.waiters.push({
        predicate,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m as T);
        },
      });
    });
  }

  close(): void {
    this.ws.close();
  }
}

interface CallLog {
  models: string[];
  endpoints: string[];
  // The system message per call, or undefined when the request carried none.
  // Distinguishing those two is the whole point of R11.
  systems: (string | undefined)[];
}

function fakeProviderFactory(log: CallLog) {
  let flakyCalls = 0;
  return (backend: ResolvedBackend): Provider => {
    log.endpoints.push(backend.endpoint);
    return {
      async listModels() {
        return [{ name: "fake-ok" }, { name: "fake-flaky" }];
      },
      async *chatStream(opts: ChatStreamOptions): AsyncIterable<string> {
        log.models.push(opts.model);
        log.systems.push(opts.messages.find((m) => m.role === "system")?.content);
        switch (opts.model) {
          case "fake-ok":
          case "fake-b":
            yield "I am ";
            yield "HAL.";
            return;
          case "fake-flaky":
            flakyCalls += 1;
            if (flakyCalls === 1) {
              yield "partial ";
              throw new ProviderError("provider_unavailable", "Connection to Ollama lost.");
            }
            yield "recovered reply";
            return;
          case "fake-missing":
            throw new ProviderError("model_not_found", 'Model "fake-missing" is not available in Ollama.');
          default:
            throw new ProviderError("provider_unavailable", "Ollama is not reachable.");
        }
      },
    };
  };
}

let app: App | null = null;
let client: TestClient | null = null;

async function boot(dataDir: string, log: CallLog): Promise<{ app: App; client: TestClient }> {
  process.env.HAL_DATA_DIR = dataDir;
  app = await startApp(0, { providerFactory: fakeProviderFactory(log) });
  client = new TestClient(app.port, app.wsToken);
  await client.ready();
  return { app, client };
}

/** Boot with a caller-supplied factory, for the tests that are about the backend. */
async function bootWith(dataDir: string, providerFactory: (b: ResolvedBackend) => Provider): Promise<TestClient> {
  process.env.HAL_DATA_DIR = dataDir;
  app = await startApp(0, { providerFactory });
  client = new TestClient(app.port, app.wsToken);
  await client.ready();
  return client;
}

afterEach(async () => {
  client?.close();
  await app?.close();
  client = null;
  app = null;
});

async function tmpDataDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "hal1000-chat-"));
}

const isConvo = (m: ServerMessage): m is Extract<ServerMessage, { type: "conversation" }> => m.type === "conversation";
const isDone = (m: ServerMessage): m is Extract<ServerMessage, { type: "chat-done" }> => m.type === "chat-done";
const isChatError = (m: ServerMessage): m is Extract<ServerMessage, { type: "chat-error" }> => m.type === "chat-error";

describe("ChatService", () => {
  it("streams a reply, persists it, and survives restart (AE3)", async () => {
    const dir = await tmpDataDir();
    const log: CallLog = { models: [], endpoints: [], systems: [] };
    const { app: a, client: c } = await boot(dir, log);

    c.send({ type: "new-conversation", model: "fake-ok" });
    const convo = (await c.waitFor(isConvo)).conversation;
    c.send({ type: "send-message", conversationId: convo.id, content: "Who are you?" });
    const done = await c.waitFor(isDone);
    expect(done.message.content).toBe("I am HAL.");
    const tokens = c.received.filter((m) => m.type === "chat-token").map((m) => m.token);
    expect(tokens).toEqual(["I am ", "HAL."]);

    // Restart against the same data dir; history must survive (AE3).
    c.close();
    await a.close();
    const { client: c2 } = await boot(dir, log);
    c2.send({ type: "open-conversation", conversationId: convo.id });
    const reopened = (await c2.waitFor(isConvo)).conversation;
    expect(reopened.messages.map((m) => m.content)).toEqual(["Who are you?", "I am HAL."]);
    expect(reopened.model).toBe("fake-ok");
  });

  it("reports provider errors without losing the conversation (AE4)", async () => {
    const { client: c } = await boot(await tmpDataDir(), { models: [], endpoints: [], systems: [] });
    c.send({ type: "new-conversation", model: "fake-down" });
    const convo = (await c.waitFor(isConvo)).conversation;
    c.send({ type: "send-message", conversationId: convo.id, content: "Hello?" });
    const err = await c.waitFor(isChatError);
    expect(err.code).toBe("provider_unavailable");
    c.send({ type: "open-conversation", conversationId: convo.id });
    const after = await c.waitFor((m): m is Extract<ServerMessage, { type: "conversation" }> => isConvo(m) && m.conversation.messages.length > 0);
    expect(after.conversation.messages[0]!.content).toBe("Hello?");
  });

  it("persists an interrupted partial reply and regenerates cleanly", async () => {
    const { client: c } = await boot(await tmpDataDir(), { models: [], endpoints: [], systems: [] });
    c.send({ type: "new-conversation", model: "fake-flaky" });
    const convo = (await c.waitFor(isConvo)).conversation;
    c.send({ type: "send-message", conversationId: convo.id, content: "Status report" });
    const done = await c.waitFor(isDone);
    expect(done.message.interrupted).toBe(true);
    expect(done.message.content).toBe("partial ");
    await c.waitFor(isChatError);

    c.send({ type: "regenerate", conversationId: convo.id });
    const done2 = await c.waitFor((m): m is Extract<ServerMessage, { type: "chat-done" }> => isDone(m) && !m.message.interrupted);
    expect(done2.message.content).toBe("recovered reply");
    c.send({ type: "open-conversation", conversationId: convo.id });
    const final = await c.waitFor((m): m is Extract<ServerMessage, { type: "conversation" }> => isConvo(m) && m.conversation.messages.length === 2);
    expect(final.conversation.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "Status report"],
      ["assistant", "recovered reply"],
    ]);
  });

  it("reports missing models in persona code and keeps the original model name (R19)", async () => {
    const { client: c } = await boot(await tmpDataDir(), { models: [], endpoints: [], systems: [] });
    c.send({ type: "new-conversation", model: "fake-missing" });
    const convo = (await c.waitFor(isConvo)).conversation;
    c.send({ type: "send-message", conversationId: convo.id, content: "Are you there?" });
    const err = await c.waitFor(isChatError);
    expect(err.code).toBe("model_not_found");
    c.send({ type: "open-conversation", conversationId: convo.id });
    const after = await c.waitFor((m): m is Extract<ServerMessage, { type: "conversation" }> => isConvo(m) && m.conversation.messages.length > 0);
    expect(after.conversation.model).toBe("fake-missing");
  });

  it("applies a model change to the next message only", async () => {
    const log: CallLog = { models: [], endpoints: [], systems: [] };
    const { client: c } = await boot(await tmpDataDir(), log);
    c.send({ type: "new-conversation", model: "fake-ok" });
    const convo = (await c.waitFor(isConvo)).conversation;
    c.send({ type: "select-model", conversationId: convo.id, model: "fake-b" });
    await c.waitFor((m): m is Extract<ServerMessage, { type: "conversation" }> => isConvo(m) && m.conversation.model === "fake-b");
    c.send({ type: "send-message", conversationId: convo.id, content: "test" });
    await c.waitFor(isDone);
    expect(log.models).toEqual(["fake-b"]);
  });

  it("pins the default chat model server-side on the first conversation", async () => {
    const { client: c } = await boot(await tmpDataDir(), { models: [], endpoints: [], systems: [] });
    c.send({ type: "new-conversation", model: "fake-ok" });
    const settings = await c.waitFor(
      (m): m is Extract<ServerMessage, { type: "settings" }> => m.type === "settings" && m.settings.chatModel === "fake-ok",
    );
    expect(settings.settings.chatModel).toBe("fake-ok");
  });

  it("ignores conversation ids that are not UUIDs (path traversal guard)", async () => {
    const { client: c } = await boot(await tmpDataDir(), { models: [], endpoints: [], systems: [] });
    c.send({ type: "open-conversation", conversationId: "..\\..\\evil" });
    c.send({ type: "delete-conversation", conversationId: "../../../etc/passwd" });
    // Server must neither crash nor answer; a normal request still works after.
    c.send({ type: "list-conversations" });
    const list = await c.waitFor((m): m is Extract<ServerMessage, { type: "conversations" }> => m.type === "conversations");
    expect(list.conversations).toEqual([]);
  });

  it("sends no system message at all when the prompt is blank (R11, AE1, AE6)", async () => {
    const log: CallLog = { models: [], endpoints: [], systems: [] };
    const { client: c } = await boot(await tmpDataDir(), log);
    c.send({ type: "new-conversation", model: "fake-ok" });
    const convo = (await c.waitFor(isConvo)).conversation;
    // Fresh install: the shipped chat default is empty, so chat behaves
    // exactly as it did before prompts existed.
    expect(convo.systemPrompt).toBe("");
    c.send({ type: "send-message", conversationId: convo.id, content: "Who are you?" });
    await c.waitFor(isDone);
    expect(log.systems).toEqual([undefined]);
  });

  it("seeds a new conversation from the global chat default and sends it (R8)", async () => {
    const log: CallLog = { models: [], endpoints: [], systems: [] };
    const { client: c } = await boot(await tmpDataDir(), log);
    c.send({ type: "update-settings", patch: { chatDefaultPrompt: "You are HAL 1000." } });
    await c.waitFor((m): m is Extract<ServerMessage, { type: "settings" }> => m.type === "settings" && m.settings.chatDefaultPrompt === "You are HAL 1000.");

    c.send({ type: "new-conversation", model: "fake-ok" });
    const convo = (await c.waitFor(isConvo)).conversation;
    expect(convo.systemPrompt).toBe("You are HAL 1000.");
    c.send({ type: "send-message", conversationId: convo.id, content: "Hello" });
    await c.waitFor(isDone);
    expect(log.systems).toEqual(["You are HAL 1000."]);
  });

  it("editing the global default leaves an existing conversation untouched (R9, AE5)", async () => {
    const log: CallLog = { models: [], endpoints: [], systems: [] };
    const { client: c } = await boot(await tmpDataDir(), log);
    c.send({ type: "update-settings", patch: { chatDefaultPrompt: "First voice." } });
    await c.waitFor((m): m is Extract<ServerMessage, { type: "settings" }> => m.type === "settings" && m.settings.chatDefaultPrompt === "First voice.");
    c.send({ type: "new-conversation", model: "fake-ok" });
    const convo = (await c.waitFor(isConvo)).conversation;

    c.send({ type: "update-settings", patch: { chatDefaultPrompt: "Second voice." } });
    await c.waitFor((m): m is Extract<ServerMessage, { type: "settings" }> => m.type === "settings" && m.settings.chatDefaultPrompt === "Second voice.");
    c.send({ type: "send-message", conversationId: convo.id, content: "Hello" });
    await c.waitFor(isDone);
    expect(log.systems).toEqual(["First voice."]);
  });

  it("treats a whitespace-only prompt as blank", async () => {
    const log: CallLog = { models: [], endpoints: [], systems: [] };
    const { client: c } = await boot(await tmpDataDir(), log);
    c.send({ type: "new-conversation", model: "fake-ok" });
    const convo = (await c.waitFor(isConvo)).conversation;
    c.send({ type: "set-conversation-prompt", conversationId: convo.id, prompt: "   \n\t " });
    await c.waitFor((m): m is Extract<ServerMessage, { type: "conversation" }> => isConvo(m) && m.conversation.systemPrompt === "   \n\t ");
    c.send({ type: "send-message", conversationId: convo.id, content: "Hello" });
    await c.waitFor(isDone);
    expect(log.systems).toEqual([undefined]);
  });

  it("set-conversation-prompt updates only its target and applies to the next message (R7)", async () => {
    const log: CallLog = { models: [], endpoints: [], systems: [] };
    const { client: c } = await boot(await tmpDataDir(), log);
    c.send({ type: "new-conversation", model: "fake-ok" });
    const first = (await c.waitFor(isConvo)).conversation;
    c.send({ type: "new-conversation", model: "fake-ok" });
    const second = (await c.waitFor((m): m is Extract<ServerMessage, { type: "conversation" }> => isConvo(m) && m.conversation.id !== first.id)).conversation;

    c.send({ type: "set-conversation-prompt", conversationId: first.id, prompt: "Only the first." });
    await c.waitFor((m): m is Extract<ServerMessage, { type: "conversation" }> => isConvo(m) && m.conversation.id === first.id && m.conversation.systemPrompt === "Only the first.");

    c.send({ type: "send-message", conversationId: first.id, content: "Hello" });
    await c.waitFor(isDone);
    c.send({ type: "send-message", conversationId: second.id, content: "Hello" });
    await c.waitFor((m): m is Extract<ServerMessage, { type: "chat-done" }> => isDone(m) && m.conversationId === second.id);
    expect(log.systems).toEqual(["Only the first.", undefined]);
  });

  it("rejects a set-conversation-prompt carrying a non-UUID id", async () => {
    const { client: c } = await boot(await tmpDataDir(), { models: [], endpoints: [], systems: [] });
    c.send({ type: "set-conversation-prompt", conversationId: "../../evil", prompt: "gotcha" });
    c.send({ type: "list-conversations" });
    const list = await c.waitFor((m): m is Extract<ServerMessage, { type: "conversations" }> => m.type === "conversations");
    expect(list.conversations).toEqual([]);
  });

  it("a conversation stored before prompts existed loads and sends as blank", async () => {
    const dir = await tmpDataDir();
    const log: CallLog = { models: [], endpoints: [], systems: [] };
    // Exactly the pre-prompt record shape: no systemPrompt key at all.
    const id = "11111111-2222-4333-8444-555555555555";
    await fs.mkdir(path.join(dir, "conversations"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "conversations", `${id}.json`),
      JSON.stringify({
        id,
        title: "Old thread",
        model: "fake-ok",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
        messages: [],
      }),
      "utf8",
    );
    const { client: c } = await boot(dir, log);
    c.send({ type: "send-message", conversationId: id, content: "Still there?" });
    await c.waitFor(isDone);
    expect(log.systems).toEqual([undefined]);
  });

  it("reports a chat-error rather than dying silently when a stored prompt is not a string", async () => {
    const dir = await tmpDataDir();
    const log: CallLog = { models: [], endpoints: [], systems: [] };
    const id = "22222222-3333-4444-8555-666666666666";
    // Hand-edited conversation file: the prompt slot holds a number.
    await fs.mkdir(path.join(dir, "conversations"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "conversations", `${id}.json`),
      JSON.stringify({
        id,
        title: "Tampered",
        model: "fake-ok",
        systemPrompt: 42,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
        messages: [],
      }),
      "utf8",
    );
    const { client: c } = await boot(dir, log);
    c.send({ type: "send-message", conversationId: id, content: "Hello" });
    // A non-string is treated as no prompt at all, so the send still completes
    // instead of throwing past the handler and leaving the client with nothing.
    await c.waitFor(isDone);
    expect(log.systems).toEqual([undefined]);
  });

  it("broadcasts the shipped prompt catalog alongside settings so a protocol-only client can reset", async () => {
    const { client: c } = await boot(await tmpDataDir(), { models: [], endpoints: [], systems: [] });
    c.send({ type: "get-settings" });
    const msg = await c.waitFor((m): m is Extract<ServerMessage, { type: "settings" }> => m.type === "settings");
    expect(msg.prompts.narrationDefault).toBe(DEFAULT_NARRATION_PROMPT);
    expect(msg.prompts.chatDefault).toBe(DEFAULT_CHAT_PROMPT);
    expect(msg.prompts.narrationPresets.map((p) => p.id)).toEqual(NARRATION_PRESETS.map((p) => p.id));
    // The effective prompt is discoverable even though the stored value is null.
    expect(msg.settings.narrationPrompt).toBeNull();
  });

  it("uses the updated provider endpoint on the next request (R18)", async () => {
    const log: CallLog = { models: [], endpoints: [], systems: [] };
    const { client: c } = await boot(await tmpDataDir(), log);
    c.send({ type: "list-models" });
    await c.waitFor((m): m is Extract<ServerMessage, { type: "models" }> => m.type === "models");
    // Protocol pinned: this is about the endpoint reaching the next request,
    // and nothing is listening on 22222 for a probe to find.
    c.send({ type: "update-settings", patch: { backends: { chat: { endpoint: "http://localhost:22222", protocol: "ollama" } } } });
    await c.waitFor((m): m is Extract<ServerMessage, { type: "settings" }> => m.type === "settings" && m.settings.backends.chat.endpoint.includes("22222"));
    c.send({ type: "list-models" });
    await new Promise((r) => setTimeout(r, 100));
    expect(log.endpoints.at(-1)).toBe("http://localhost:22222");
  });

  it("lists each slot on its own credential when they share a host", async () => {
    // The reviewed defect, inverted. Chat and observation on one endpoint with
    // a key on observation only: comparing endpoints made them one destination,
    // so chat's keyless failure was copied onto the observation slot and the
    // narration picker went empty for a backend that was answering.
    const listed: string[] = [];
    const c = await bootWith(await tmpDataDir(), (backend): Provider => ({
      async listModels() {
        listed.push(backend.apiKey ?? "anonymous");
        if (!backend.apiKey) throw new ProviderError("provider_unavailable", "401");
        return [{ name: "keyed-model" }];
      },
      async *chatStream() {
        yield "";
      },
    }));

    c.send({
      type: "update-settings",
      patch: {
        backends: {
          chat: { endpoint: "https://api.example.com", protocol: "openai" },
          observation: { endpoint: "https://api.example.com", protocol: "openai", apiKey: "sk-obs" },
        },
      },
    });
    await c.waitFor((m): m is Extract<ServerMessage, { type: "settings" }> => m.type === "settings" && m.settings.backends.observation.hasKey);

    c.send({ type: "list-models" });
    await new Promise((r) => setTimeout(r, 150));

    const models = c.received.filter((m): m is Extract<ServerMessage, { type: "models" }> => m.type === "models");
    const chat = models.filter((m) => m.slot === "chat").at(-1)!;
    const observation = models.filter((m) => m.slot === "observation").at(-1)!;

    expect(observation.models).toEqual(["keyed-model"]);
    expect(observation.error).toBeUndefined();
    expect(chat.error).toBe("provider_unavailable");
    // Two destinations, so two asks — not one answer wearing both slots' names.
    expect(listed).toContain("sk-obs");
    expect(listed).toContain("anonymous");
  });

  it("still broadcasts both slots when they name one destination", async () => {
    // That one destination costs one round trip is asserted in
    // server/test/providers/probe.test.ts, where the count is not shared with
    // readiness's own probe against the same factory. What belongs here is that
    // deleting the short-circuit did not cost a slot its broadcast.
    const c = await bootWith(await tmpDataDir(), (): Provider => ({
      async listModels() {
        return [{ name: "shared" }];
      },
      async *chatStream() {
        yield "";
      },
    }));

    c.send({ type: "update-settings", patch: { backends: { chat: { endpoint: "http://localhost:11434", protocol: "ollama" }, observation: { endpoint: "http://localhost:11434", protocol: "ollama" } } } });
    await c.waitFor((m): m is Extract<ServerMessage, { type: "settings" }> => m.type === "settings");

    c.send({ type: "list-models" });
    await new Promise((r) => setTimeout(r, 150));

    const models = c.received.filter((m): m is Extract<ServerMessage, { type: "models" }> => m.type === "models");
    expect(models.filter((m) => m.slot === "chat").at(-1)!.models).toEqual(["shared"]);
    expect(models.filter((m) => m.slot === "observation").at(-1)!.models).toEqual(["shared"]);
  });
});
