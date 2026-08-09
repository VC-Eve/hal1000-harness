import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { SettingsStore } from "../../src/storage/settings.js";
import { backendForRole, endpointForRole, slotForRole } from "../../src/providers/resolve.js";
import { forgetAllProtocols } from "../../src/providers/detect.js";

// Which backend a role sends to.
//
// The rule worth testing is not that chat can point elsewhere — it is that the
// other three cannot. Narration, Monitors and Vision run continuously and
// unattended, and a metered endpoint they reached by inheriting a setting is a
// meter nobody is watching.

let dir: string;
let store: SettingsStore;

const ollamaServer = vi.fn(async (url: string | URL | Request) =>
  String(url).endsWith("/api/tags") ? Response.json({ models: [] }) : new Response("", { status: 404 }),
);

const openaiServer = vi.fn(async (url: string | URL | Request) =>
  String(url).endsWith("/v1/models") ? Response.json({ data: [] }) : new Response("", { status: 404 }),
);

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hal1000-resolve-"));
  store = new SettingsStore(dir);
  await store.load();
  forgetAllProtocols();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("slotForRole", () => {
  it("sends every role to the shared backend by default", () => {
    const s = store.get();
    for (const role of ["chat", "narration", "monitor", "vision"] as const) {
      expect(slotForRole(role, s)).toBe("shared");
    }
  });

  it("sends only chat to the chat backend when it is configured and on", async () => {
    const s = await store.update({ backends: { chat: { enabled: true, endpoint: "https://api.example.com" } } });

    expect(slotForRole("chat", s)).toBe("chat");
    expect(slotForRole("narration", s)).toBe("shared");
    expect(slotForRole("monitor", s)).toBe("shared");
    expect(slotForRole("vision", s)).toBe("shared");
  });

  it("keeps chat on the shared backend while the override is off", async () => {
    const s = await store.update({ backends: { chat: { enabled: false, endpoint: "https://api.example.com" } } });
    expect(slotForRole("chat", s)).toBe("shared");
  });

  it("treats an enabled override with no endpoint as not yet configured", async () => {
    // Failing every send because a switch was flipped before a URL was typed
    // would be worse than using the backend that works; the readiness row is
    // what makes the half-finished state visible.
    const s = await store.update({ backends: { chat: { enabled: true, endpoint: "   " } } });
    expect(slotForRole("chat", s)).toBe("shared");
  });
});

describe("endpointForRole", () => {
  it("answers where a job is going without probing anything", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const s = await store.update({ backends: { chat: { enabled: true, endpoint: "https://api.example.com" } } });

    expect(endpointForRole("chat", s)).toBe("https://api.example.com");
    expect(endpointForRole("narration", s)).toBe("http://localhost:11434");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers even when nothing is listening", async () => {
    const s = await store.update({ backends: { shared: { endpoint: "http://127.0.0.1:9" } } });
    expect(endpointForRole("narration", s)).toBe("http://127.0.0.1:9");
  });
});

describe("backendForRole", () => {
  it("resolves the protocol by probe", async () => {
    vi.stubGlobal("fetch", ollamaServer);
    await expect(backendForRole("narration", store)).resolves.toMatchObject({
      endpoint: "http://localhost:11434",
      protocol: "ollama",
    });
  });

  it("honours an explicit protocol without probing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await store.update({ backends: { shared: { protocol: "openai" } } });

    await expect(backendForRole("narration", store)).resolves.toMatchObject({ protocol: "openai" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null when the protocol cannot be determined", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    await expect(backendForRole("narration", store)).resolves.toBeNull();
  });

  it("attaches the key for the slot it resolved to", async () => {
    vi.stubGlobal("fetch", openaiServer);
    await store.update({
      backends: {
        shared: { apiKey: "sk-shared" },
        chat: { enabled: true, endpoint: "https://api.example.com", apiKey: "sk-chat" },
      },
    });

    await expect(backendForRole("chat", store)).resolves.toMatchObject({ apiKey: "sk-chat" });
    await expect(backendForRole("narration", store)).resolves.toMatchObject({ apiKey: "sk-shared" });
  });

  it("carries no key field at all when none is set", async () => {
    vi.stubGlobal("fetch", ollamaServer);
    const backend = await backendForRole("narration", store);
    expect(backend).not.toHaveProperty("apiKey");
  });

  it("routes chat and narration to different backends when the override is on", async () => {
    vi.stubGlobal("fetch", async (url: string | URL | Request) => {
      const href = String(url);
      if (href.startsWith("https://api.example.com")) return openaiServer(url);
      return ollamaServer(url);
    });
    await store.update({ backends: { chat: { enabled: true, endpoint: "https://api.example.com" } } });

    const chat = await backendForRole("chat", store);
    const narration = await backendForRole("narration", store);

    expect(chat).toMatchObject({ endpoint: "https://api.example.com", protocol: "openai" });
    expect(narration).toMatchObject({ endpoint: "http://localhost:11434", protocol: "ollama" });
  });
});
