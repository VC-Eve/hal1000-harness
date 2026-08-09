import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { ChatService } from "../../src/chat.js";
import { ConversationStore } from "../../src/storage/conversations.js";
import { SettingsStore } from "../../src/storage/settings.js";
import { ProviderQueue } from "../../src/providers/queue.js";
import { forgetAllProtocols } from "../../src/providers/detect.js";
import type { ChatStreamOptions, ModelInfo, Provider, ProviderFactory } from "../../src/providers/provider.js";
import type { ClientMessage, ServerMessage } from "../../../shared/src/types.js";

// The window cache, and where its figure came from.
//
// Configured on the chat slot throughout: these are questions about a chat
// request, and chat has its own destination that does not follow observation.
//
// A window is not a property of a model name. Two backends can serve `qwen3`
// with different windows — one llama-server built at 8k, one at 128k — and a
// cache keyed on the name alone serves the first backend's answer for the
// second. That is
// docs/solutions/a-value-frozen-for-one-caller-is-stale-for-the-next.md, and it
// was harmless only while there was one endpoint to be wrong about.

let dir: string;
let settings: SettingsStore;
let broadcasts: ServerMessage[];
let handlers: ((msg: ClientMessage) => void)[];

const OLLAMA = "http://localhost:11434";
const LLAMA = "http://127.0.0.1:8080";

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hal-window-cache-"));
  settings = new SettingsStore(dir);
  await settings.load();
  await settings.update({ backends: { chat: { endpoint: OLLAMA, protocol: "ollama" } } });
  broadcasts = [];
  handlers = [];
  forgetAllProtocols();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

const hub = {
  broadcast: (msg: ServerMessage) => broadcasts.push(msg),
  onMessage: (h: (msg: ClientMessage) => void) => handlers.push(h),
  onConnection: () => {},
  sendTo: () => {},
};

/** A provider whose reported window depends on which endpoint it was built for. */
function windowByEndpoint(windows: Record<string, number | null>): ProviderFactory {
  return (backend): Provider => ({
    async listModels(): Promise<ModelInfo[]> {
      return [{ name: "qwen3" }];
    },
    async modelWindow(): Promise<number | null> {
      return windows[backend.endpoint] ?? null;
    },
    async *chatStream(_opts: ChatStreamOptions): AsyncIterable<string> {
      yield "ok";
    },
  });
}

function build(factory: ProviderFactory): ChatService {
  return new ChatService(
    hub as unknown as ConstructorParameters<typeof ChatService>[0],
    new ConversationStore(dir),
    settings,
    new ProviderQueue(),
    factory,
  );
}

const listModels = async (svc: ChatService): Promise<void> => {
  await (svc as unknown as { listModels(): Promise<void> }).listModels();
};

// One broadcast per backend now, so the chat one has to be picked out by slot
// rather than by being last.
const lastModels = (): Extract<ServerMessage, { type: "models" }> =>
  [...broadcasts]
    .reverse()
    .find((m) => m.type === "models" && m.slot === "chat") as Extract<ServerMessage, { type: "models" }>;

describe("the window cache", () => {
  it("keeps two backends' answers for the same model name apart", async () => {
    const svc = build(windowByEndpoint({ [OLLAMA]: 8192, [LLAMA]: 131072 }));

    await listModels(svc);
    expect(lastModels().windows).toEqual({ qwen3: 8192 });

    await settings.update({ backends: { chat: { endpoint: LLAMA, protocol: "openai" } } });
    await listModels(svc);

    // The bug this file exists for: keyed on the name alone, this returned
    // 8192 — the first backend's answer, served for the second.
    expect(lastModels().windows).toEqual({ qwen3: 131072 });
  });

  it("returns to the first backend's answer on switching back", async () => {
    const svc = build(windowByEndpoint({ [OLLAMA]: 8192, [LLAMA]: 131072 }));

    await listModels(svc);
    await settings.update({ backends: { chat: { endpoint: LLAMA, protocol: "openai" } } });
    await listModels(svc);
    await settings.update({ backends: { chat: { endpoint: OLLAMA, protocol: "ollama" } } });
    await listModels(svc);

    expect(lastModels().windows).toEqual({ qwen3: 8192 });
  });

  it("counts a trailing slash as the same backend rather than re-asking", async () => {
    let asked = 0;
    const svc = build((): Provider => ({
      async listModels() {
        return [{ name: "qwen3" }];
      },
      async modelWindow() {
        asked += 1;
        return 8192;
      },
      async *chatStream() {
        yield "ok";
      },
    }));

    await listModels(svc);
    const afterFirst = asked;
    await settings.update({ backends: { chat: { endpoint: `${OLLAMA}/`, protocol: "ollama" } } });
    await listModels(svc);

    expect(asked).toBe(afterFirst);
  });
});

describe("where the window figure came from", () => {
  it("reports requested on a native Ollama backend", async () => {
    const svc = build(windowByEndpoint({ [OLLAMA]: 8192 }));
    await listModels(svc);
    expect(lastModels().windowSource).toBe("requested");
  });

  it("reports reported on an OpenAI-compatible backend", async () => {
    // HAL cannot ask for a window here. `llama-server` fixes n_ctx at launch
    // and a hosted API does not expose one, so the cap is a budget spent inside
    // a window HAL did not choose.
    await settings.update({ backends: { chat: { endpoint: LLAMA, protocol: "openai" } } });
    const svc = build(windowByEndpoint({ [LLAMA]: 131072 }));
    await listModels(svc);
    expect(lastModels().windowSource).toBe("reported");
  });

  it("reports unknown when the protocol could not be determined", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    await settings.update({ backends: { chat: { endpoint: "http://127.0.0.1:9", protocol: "auto" } } });
    const svc = build(windowByEndpoint({}));
    await listModels(svc);

    expect(lastModels().error).toBe("provider_unavailable");
  });

  it("still reports a window of null as absent rather than as zero", async () => {
    const svc = build(windowByEndpoint({ [OLLAMA]: null }));
    await listModels(svc);
    expect(lastModels().windows).toEqual({});
  });
});

describe("what the list response already answered", () => {
  /** A backend that reports each model's window in its list response, as Ollama does. */
  function listReporting(models: ModelInfo[], onAsk: () => void): ProviderFactory {
    return (): Provider => ({
      async listModels() {
        return models;
      },
      async modelWindow() {
        onAsk();
        return null;
      },
      async *chatStream() {
        yield "ok";
      },
    });
  }

  it("takes the window from the list rather than buying it back per model", async () => {
    // `/api/tags` already carries `context_length`. Narrowing the list to names
    // threw it away, so a machine with twenty pulled models paid twenty
    // sequential `/api/show` requests before the picker could be populated.
    let asked = 0;
    const svc = build(
      listReporting(
        [
          { name: "qwen3", contextTokens: 8192 },
          { name: "llama3", contextTokens: 131072 },
        ],
        () => {
          asked += 1;
        },
      ),
    );

    await listModels(svc);

    expect(lastModels().windows).toEqual({ qwen3: 8192, llama3: 131072 });
    expect(asked).toBe(0);
  });

  it("asks only about the models the list left out", async () => {
    let asked = 0;
    const svc = build(
      listReporting([{ name: "qwen3", contextTokens: 8192 }, { name: "mystery" }], () => {
        asked += 1;
      }),
    );

    await listModels(svc);

    expect(asked).toBe(1);
  });

  it("remembers that a backend had no window to give, rather than re-asking every time", async () => {
    // A hosted API 404s the window route, so every model caches null. Read with
    // `??` that was a miss, and each connect re-probed every model in turn,
    // each one a timeout — the picker stayed empty for as long as that took.
    let asked = 0;
    const svc = build(listReporting([{ name: "a" }, { name: "b" }], () => {
      asked += 1;
    }));

    await listModels(svc);
    const afterFirst = asked;
    await listModels(svc);

    expect(afterFirst).toBe(2);
    expect(asked).toBe(afterFirst);
  });
});
