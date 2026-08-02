import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import WebSocket from "ws";
import { startApp, type App } from "../src/app.js";
import { ProviderError, type ChatStreamOptions, type Provider } from "../src/providers/provider.js";
import type { ClientMessage, ServerMessage } from "../../shared/src/types.js";

class TestClient {
  private readonly ws: WebSocket;
  readonly received: ServerMessage[] = [];
  private waiters: { predicate: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];

  constructor(port: number) {
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
}

function fakeProviderFactory(log: CallLog) {
  let flakyCalls = 0;
  return (endpoint: string): Provider => {
    log.endpoints.push(endpoint);
    return {
      async listModels() {
        return [{ name: "fake-ok" }, { name: "fake-flaky" }];
      },
      async *chatStream(opts: ChatStreamOptions): AsyncIterable<string> {
        log.models.push(opts.model);
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
  client = new TestClient(app.port);
  await client.ready();
  return { app, client };
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
    const log: CallLog = { models: [], endpoints: [] };
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
    const { client: c } = await boot(await tmpDataDir(), { models: [], endpoints: [] });
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
    const { client: c } = await boot(await tmpDataDir(), { models: [], endpoints: [] });
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
    const { client: c } = await boot(await tmpDataDir(), { models: [], endpoints: [] });
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
    const log: CallLog = { models: [], endpoints: [] };
    const { client: c } = await boot(await tmpDataDir(), log);
    c.send({ type: "new-conversation", model: "fake-ok" });
    const convo = (await c.waitFor(isConvo)).conversation;
    c.send({ type: "select-model", conversationId: convo.id, model: "fake-b" });
    await c.waitFor((m): m is Extract<ServerMessage, { type: "conversation" }> => isConvo(m) && m.conversation.model === "fake-b");
    c.send({ type: "send-message", conversationId: convo.id, content: "test" });
    await c.waitFor(isDone);
    expect(log.models).toEqual(["fake-b"]);
  });

  it("uses the updated provider endpoint on the next request (R18)", async () => {
    const log: CallLog = { models: [], endpoints: [] };
    const { client: c } = await boot(await tmpDataDir(), log);
    c.send({ type: "list-models" });
    await c.waitFor((m): m is Extract<ServerMessage, { type: "models" }> => m.type === "models");
    c.send({ type: "update-settings", patch: { providerEndpoint: "http://localhost:22222" } });
    await c.waitFor((m): m is Extract<ServerMessage, { type: "settings" }> => m.type === "settings" && m.settings.providerEndpoint.includes("22222"));
    c.send({ type: "list-models" });
    await new Promise((r) => setTimeout(r, 100));
    expect(log.endpoints.at(-1)).toBe("http://localhost:22222");
  });
});
