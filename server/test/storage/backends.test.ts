import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { tmpDir } from "../tmp.js";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { SettingsStore, DEFAULT_SETTINGS } from "../../src/storage/settings.js";
import { forgetAllProtocols, resolveProtocol } from "../../src/providers/detect.js";

// Backends in settings, and the credential that is deliberately not in them.
//
// Settings are broadcast wholesale on every connection and after every update.
// A key stored among them would have to be stripped at each of those points,
// which is the shape of failure
// docs/solutions/a-gate-that-checks-one-direction-is-half-a-gate.md records —
// so it is stored apart, and the tests below assert the separation rather than
// asserting that a redaction step was remembered.

let dir: string;

beforeEach(async () => {
  dir = await tmpDir("backends");
  forgetAllProtocols();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function writeRaw(name: string, value: unknown): Promise<void> {
  await fs.writeFile(path.join(dir, name), JSON.stringify(value), "utf8");
}

async function readRaw(name: string): Promise<string> {
  return fs.readFile(path.join(dir, name), "utf8");
}

describe("backend defaults", () => {
  it("a fresh install has one loopback backend and no chat override", async () => {
    const loaded = await new SettingsStore(dir).load();
    expect(loaded.backends.observation).toEqual({
      endpoint: "http://localhost:11434",
      protocol: "auto",
      hasKey: false,
    });
    // Both destinations configured and pointing at the same server, which is
    // the ordinary setup — arrived at without anybody turning anything on.
    expect(loaded.backends.chat).toEqual(loaded.backends.observation);
  });

  it("defaults the protocol to auto rather than to ollama", async () => {
    // The loopback default is Ollama's port, but someone replacing it with
    // llama.cpp should not also have to know there is a protocol to change.
    expect(DEFAULT_SETTINGS.backends.observation.protocol).toBe("auto");
  });
});

describe("migration from providerEndpoint", () => {
  it("carries a configured v1 endpoint onto the shared backend", async () => {
    await writeRaw("settings.json", { providerEndpoint: "http://192.168.1.50:11434", chatModel: "hal-ft" });

    const loaded = await new SettingsStore(dir).load();

    expect(loaded.backends.observation.endpoint).toBe("http://192.168.1.50:11434");
    expect(loaded.chatModel).toBe("hal-ft");
  });

  it("persists the migration, so the old key is not re-read every boot", async () => {
    await writeRaw("settings.json", { providerEndpoint: "http://192.168.1.50:11434" });
    await new SettingsStore(dir).load();

    const second = await new SettingsStore(dir).load();
    expect(second.backends.observation.endpoint).toBe("http://192.168.1.50:11434");
  });

  it("does not re-migrate over a backend the user has since changed", async () => {
    // Keyed on the absence of `backends`, not the presence of the old field, so
    // a stale `providerEndpoint` left in the file cannot overwrite a real
    // choice made after migrating.
    await writeRaw("settings.json", {
      providerEndpoint: "http://old:11434",
      backends: { observation: { endpoint: "http://new:8080", protocol: "openai", hasKey: false } },
    });

    const loaded = await new SettingsStore(dir).load();
    expect(loaded.backends.observation.endpoint).toBe("http://new:8080");
    expect(loaded.backends.observation.protocol).toBe("openai");
  });

  it("leaves a fresh install on the default rather than inventing an endpoint", async () => {
    const loaded = await new SettingsStore(dir).load();
    expect(loaded.backends.observation.endpoint).toBe("http://localhost:11434");
  });
});

describe("merging backend settings", () => {
  it("changes one slot without disturbing the other", async () => {
    const store = new SettingsStore(dir);
    await store.load();
    await store.update({ backends: { chat: { endpoint: "https://api.example.com" } } });

    const after = await store.update({ backends: { observation: { endpoint: "http://127.0.0.1:8080" } } });

    expect(after.backends.observation.endpoint).toBe("http://127.0.0.1:8080");
    expect(after.backends.chat.endpoint).toBe("https://api.example.com");
  });

  it("does not make one slot follow the other", async () => {
    // The point of two named destinations. `copyFrom` is how a setting moves
    // between them on purpose, rather than by an inheritance nobody can see.
    const store = new SettingsStore(dir);
    await store.load();
    await store.update({ backends: { chat: { endpoint: "https://api.example.com" } } });

    const after = await store.update({ backends: { observation: { endpoint: "http://127.0.0.1:8080" } } });

    expect(after.backends.chat.endpoint).toBe("https://api.example.com");
  });

  it("leaves an unrelated setting alone when a backend changes", async () => {
    const store = new SettingsStore(dir);
    await store.load();
    await store.update({ narrationPrompt: "Narrate tersely.", chatContextCap: 4096 });

    const after = await store.update({ backends: { observation: { endpoint: "http://x:1" } } });

    expect(after.narrationPrompt).toBe("Narrate tersely.");
    expect(after.chatContextCap).toBe(4096);
  });

  it("trims an endpoint rather than storing the whitespace a paste leaves", async () => {
    const store = new SettingsStore(dir);
    await store.load();
    const after = await store.update({ backends: { observation: { endpoint: "  http://x:8080  " } } });
    expect(after.backends.observation.endpoint).toBe("http://x:8080");
  });

  it("drops an unrecognised protocol rather than handing it to the factory", async () => {
    const store = new SettingsStore(dir);
    await store.load();
    await store.update({ backends: { observation: { protocol: "openai" } } });

    const after = await store.update({
      backends: { observation: { protocol: "anthropic" as unknown as "openai" } },
    });

    expect(after.backends.observation.protocol).toBe("openai");
  });
});

describe("copying one slot to the other", () => {
  it("takes the endpoint and the protocol", async () => {
    const store = new SettingsStore(dir);
    await store.load();
    await store.update({ backends: { observation: { endpoint: "http://127.0.0.1:8080", protocol: "openai" } } });

    const after = await store.update({ backends: { chat: { copyFrom: "observation" } } });

    expect(after.backends.chat.endpoint).toBe("http://127.0.0.1:8080");
    expect(after.backends.chat.protocol).toBe("openai");
  });

  it("takes the key, which is why the server performs the copy", async () => {
    // A client is never told a credential, so a copy it made itself would
    // silently drop the one part that is tedious to retype.
    const store = new SettingsStore(dir);
    await store.load();
    await store.update({ backends: { observation: { endpoint: "https://api.example.com", apiKey: "sk-obs" } } });

    const after = await store.update({ backends: { chat: { copyFrom: "observation" } } });

    expect(store.keyFor("chat")).toBe("sk-obs");
    expect(after.backends.chat.hasKey).toBe(true);
  });

  it("copies the absence of a key too, rather than leaving a stale one", async () => {
    const store = new SettingsStore(dir);
    await store.load();
    await store.update({ backends: { chat: { apiKey: "sk-old" } } });

    await store.update({ backends: { chat: { copyFrom: "observation" } } });

    expect(store.keyFor("chat")).toBeUndefined();
  });

  it("leaves the slot it copied from untouched", async () => {
    const store = new SettingsStore(dir);
    await store.load();
    await store.update({ backends: { observation: { endpoint: "http://127.0.0.1:8080", apiKey: "sk-obs" } } });

    await store.update({ backends: { chat: { copyFrom: "observation" } } });

    expect(store.keyFor("observation")).toBe("sk-obs");
  });

  it("lets an explicit field in the same patch win over what was copied", async () => {
    const store = new SettingsStore(dir);
    await store.load();
    await store.update({ backends: { observation: { endpoint: "http://127.0.0.1:8080", protocol: "openai" } } });

    const after = await store.update({
      backends: { chat: { copyFrom: "observation", endpoint: "https://elsewhere.example" } },
    });

    expect(after.backends.chat.endpoint).toBe("https://elsewhere.example");
    expect(after.backends.chat.protocol).toBe("openai");
  });

  it("ignores a slot copying from itself", async () => {
    const store = new SettingsStore(dir);
    await store.load();
    await store.update({ backends: { chat: { endpoint: "https://api.example.com", apiKey: "sk-1" } } });

    const after = await store.update({ backends: { chat: { copyFrom: "chat" } } });

    expect(after.backends.chat.endpoint).toBe("https://api.example.com");
    expect(store.keyFor("chat")).toBe("sk-1");
  });

  it("ignores a slot name that names no slot, rather than persisting an empty backend", async () => {
    // `copyFrom` arrives over the wire and is used as an index into both the
    // backends map and the key store. Unchecked, "observations" resolves to
    // undefined, spreads into a backend with no endpoint, and is written to
    // disk — after which every read throws on `.trim()`, including the render
    // of the panel that would let someone type the endpoint back in. The cast
    // is the test: a client can send anything, whatever the type says.
    const store = new SettingsStore(dir);
    await store.load();
    await store.update({ backends: { chat: { endpoint: "https://api.example.com", apiKey: "sk-1" } } });

    const after = await store.update({
      backends: { chat: { copyFrom: "observations" as "observation" } },
    });

    expect(after.backends.chat.endpoint).toBe("https://api.example.com");
    expect(store.keyFor("chat")).toBe("sk-1");
  });
});

describe("applying settings and what a probe remembers", () => {
  /** A server answering exactly one protocol's route. */
  function serving(route: string) {
    return vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith(route) ? Response.json({ models: [], data: [] }) : new Response("no", { status: 404 }),
    );
  }

  it("forgets what an endpoint answered, so a swapped server is found", async () => {
    // Stop Ollama, start llama-server on the same port, press apply. Nothing
    // about the settings changed, and the answer did: a cache with no way to be
    // wrong would keep POSTing `/api/chat` at a server that 404s it, and the
    // user would be told the model does not exist.
    const store = new SettingsStore(dir);
    await store.load();

    vi.stubGlobal("fetch", serving("/api/tags"));
    await expect(resolveProtocol("http://localhost:11434", "auto")).resolves.toBe("ollama");

    vi.stubGlobal("fetch", serving("/v1/models"));
    await store.update({ backends: { observation: { endpoint: "http://localhost:11434" } } });

    await expect(resolveProtocol("http://localhost:11434", "auto")).resolves.toBe("openai");
  });
});

describe("migration from the shared-plus-override shape", () => {
  it("renames shared to observation and gives chat the same endpoint", async () => {
    await writeRaw("settings.json", {
      backends: {
        shared: { endpoint: "http://192.168.1.50:11434", protocol: "openai", hasKey: false },
        chat: { enabled: false, endpoint: "", protocol: "auto", hasKey: false },
      },
    });

    const loaded = await new SettingsStore(dir).load();

    expect(loaded.backends.observation.endpoint).toBe("http://192.168.1.50:11434");
    expect(loaded.backends.observation.protocol).toBe("openai");
    expect(loaded.backends.chat.endpoint).toBe("http://192.168.1.50:11434");
  });

  it("keeps a configured chat override even though it was switched off", async () => {
    // A disabled override pointing somewhere was still a statement about where
    // chat should go. Dropping it on the way through would lose a choice the
    // user had already made.
    await writeRaw("settings.json", {
      backends: {
        shared: { endpoint: "http://localhost:11434", protocol: "auto", hasKey: false },
        chat: { enabled: false, endpoint: "https://api.example.com", protocol: "openai", hasKey: false },
      },
    });

    const loaded = await new SettingsStore(dir).load();

    expect(loaded.backends.chat.endpoint).toBe("https://api.example.com");
    expect(loaded.backends.observation.endpoint).toBe("http://localhost:11434");
  });

  it("carries a key written under the old slot name", async () => {
    await writeRaw("settings.json", {
      backends: {
        shared: { endpoint: "https://api.example.com", protocol: "openai", hasKey: true },
        chat: { enabled: false, endpoint: "", protocol: "auto", hasKey: false },
      },
    });
    await writeRaw("backend-keys.json", { shared: "sk-from-the-old-name" });

    const store = new SettingsStore(dir);
    const loaded = await store.load();

    expect(store.keyFor("observation")).toBe("sk-from-the-old-name");
    expect(loaded.backends.observation.hasKey).toBe(true);
  });

  it("migrates a v1 providerEndpoint onto both destinations", async () => {
    await writeRaw("settings.json", { providerEndpoint: "http://192.168.1.50:11434" });

    const loaded = await new SettingsStore(dir).load();

    expect(loaded.backends.chat.endpoint).toBe("http://192.168.1.50:11434");
    expect(loaded.backends.observation.endpoint).toBe("http://192.168.1.50:11434");
  });
});

describe("keys", () => {
  it("stores a key outside settings entirely", async () => {
    const store = new SettingsStore(dir);
    await store.load();
    await store.update({ backends: { observation: { apiKey: "sk-secret-value" } } });

    // The structural guarantee. Settings are what gets broadcast, so what
    // matters is that the secret is not in the file that gets broadcast.
    expect(await readRaw("settings.json")).not.toContain("sk-secret-value");
    expect(await readRaw("backend-keys.json")).toContain("sk-secret-value");
  });

  it("reports that a key exists without reporting the key", async () => {
    const store = new SettingsStore(dir);
    await store.load();
    const after = await store.update({ backends: { observation: { apiKey: "sk-secret-value" } } });

    expect(after.backends.observation.hasKey).toBe(true);
    expect(JSON.stringify(after)).not.toContain("sk-secret-value");
    expect(store.keyFor("observation")).toBe("sk-secret-value");
  });

  it("keeps the stored key when a patch omits it", async () => {
    const store = new SettingsStore(dir);
    await store.load();
    await store.update({ backends: { observation: { apiKey: "sk-1" } } });

    const after = await store.update({ backends: { observation: { endpoint: "http://elsewhere:8080" } } });

    expect(after.backends.observation.hasKey).toBe(true);
    expect(store.keyFor("observation")).toBe("sk-1");
  });

  it("clears the key on null, and on an empty string", async () => {
    const store = new SettingsStore(dir);
    await store.load();
    await store.update({ backends: { observation: { apiKey: "sk-1" } } });

    const cleared = await store.update({ backends: { observation: { apiKey: null } } });
    expect(cleared.backends.observation.hasKey).toBe(false);
    expect(store.keyFor("observation")).toBeUndefined();

    await store.update({ backends: { observation: { apiKey: "sk-2" } } });
    const blanked = await store.update({ backends: { observation: { apiKey: "" } } });
    expect(blanked.backends.observation.hasKey).toBe(false);
  });

  it("keeps the two slots' keys apart", async () => {
    const store = new SettingsStore(dir);
    await store.load();
    await store.update({ backends: { observation: { apiKey: "sk-observation" }, chat: { apiKey: "sk-chat" } } });

    expect(store.keyFor("observation")).toBe("sk-observation");
    expect(store.keyFor("chat")).toBe("sk-chat");

    await store.update({ backends: { observation: { apiKey: null } } });
    expect(store.keyFor("observation")).toBeUndefined();
    expect(store.keyFor("chat")).toBe("sk-chat");
  });

  it("survives a restart", async () => {
    const first = new SettingsStore(dir);
    await first.load();
    await first.update({ backends: { chat: { apiKey: "sk-persisted" } } });

    const second = new SettingsStore(dir);
    const loaded = await second.load();

    expect(second.keyFor("chat")).toBe("sk-persisted");
    expect(loaded.backends.chat.hasKey).toBe(true);
  });

  it("ignores a non-string in a hand-edited key file rather than sending it as a header", async () => {
    await writeRaw("backend-keys.json", { shared: 12345, chat: { nested: true } });
    const store = new SettingsStore(dir);
    const loaded = await store.load();

    expect(store.keyFor("observation")).toBeUndefined();
    expect(store.keyFor("chat")).toBeUndefined();
    expect(loaded.backends.observation.hasKey).toBe(false);
  });

  it("does not let a client claim a key exists by sending the flag", async () => {
    const store = new SettingsStore(dir);
    await store.load();

    const after = await store.update({
      backends: { observation: { hasKey: true } as unknown as { endpoint?: string } },
    });

    expect(after.backends.observation.hasKey).toBe(false);
  });
});
