import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpDir } from "../tmp.js";
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
  dir = await tmpDir("resolve");
  store = new SettingsStore(dir);
  await store.load();
  forgetAllProtocols();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("slotForRole", () => {
  it("sends each role to its own slot", () => {
    const s = store.get();
    expect(slotForRole("chat", s)).toBe("chat");
    for (const role of ["narration", "monitor", "vision"] as const) {
      expect(slotForRole(role, s)).toBe("observation");
    }
  });

  it("keeps the three unattended roles on observation however chat is pointed", async () => {
    const s = await store.update({ backends: { chat: { endpoint: "https://api.example.com" } } });

    expect(slotForRole("chat", s)).toBe("chat");
    expect(slotForRole("narration", s)).toBe("observation");
    expect(slotForRole("monitor", s)).toBe("observation");
    expect(slotForRole("vision", s)).toBe("observation");
  });

  it("falls back to observation when the chat endpoint is blank", async () => {
    // A repair rather than a feature: settings are hand-editable and an install
    // predating two first-class destinations may hold a blank one. Failing
    // every send over an empty field would be worse than using the endpoint
    // that works.
    const s = await store.update({ backends: { chat: { endpoint: "   " } } });
    expect(slotForRole("chat", s)).toBe("observation");
  });
});

describe("endpointForRole", () => {
  it("answers where a job is going without probing anything", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const s = await store.update({ backends: { chat: { endpoint: "https://api.example.com" } } });

    expect(endpointForRole("chat", s)).toBe("https://api.example.com");
    expect(endpointForRole("narration", s)).toBe("http://localhost:11434");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers even when nothing is listening", async () => {
    const s = await store.update({ backends: { observation: { endpoint: "http://127.0.0.1:9" } } });
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
    await store.update({ backends: { observation: { protocol: "openai" } } });

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
        observation: { apiKey: "sk-observation" },
        chat: { endpoint: "https://api.example.com", apiKey: "sk-chat" },
      },
    });

    await expect(backendForRole("chat", store)).resolves.toMatchObject({ apiKey: "sk-chat" });
    await expect(backendForRole("narration", store)).resolves.toMatchObject({ apiKey: "sk-observation" });
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
    await store.update({ backends: { chat: { endpoint: "https://api.example.com" } } });

    const chat = await backendForRole("chat", store);
    const narration = await backendForRole("narration", store);

    expect(chat).toMatchObject({ endpoint: "https://api.example.com", protocol: "openai" });
    expect(narration).toMatchObject({ endpoint: "http://localhost:11434", protocol: "ollama" });
  });
});
