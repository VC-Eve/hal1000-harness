import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { SettingsStore, DEFAULT_SETTINGS } from "../../src/storage/settings.js";

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
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hal1000-backends-"));
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
    expect(loaded.backends.shared).toEqual({
      endpoint: "http://localhost:11434",
      protocol: "auto",
      hasKey: false,
    });
    expect(loaded.backends.chat.enabled).toBe(false);
  });

  it("defaults the protocol to auto rather than to ollama", async () => {
    // The loopback default is Ollama's port, but someone replacing it with
    // llama.cpp should not also have to know there is a protocol to change.
    expect(DEFAULT_SETTINGS.backends.shared.protocol).toBe("auto");
  });
});

describe("migration from providerEndpoint", () => {
  it("carries a configured v1 endpoint onto the shared backend", async () => {
    await writeRaw("settings.json", { providerEndpoint: "http://192.168.1.50:11434", chatModel: "hal-ft" });

    const loaded = await new SettingsStore(dir).load();

    expect(loaded.backends.shared.endpoint).toBe("http://192.168.1.50:11434");
    expect(loaded.chatModel).toBe("hal-ft");
  });

  it("persists the migration, so the old key is not re-read every boot", async () => {
    await writeRaw("settings.json", { providerEndpoint: "http://192.168.1.50:11434" });
    await new SettingsStore(dir).load();

    const second = await new SettingsStore(dir).load();
    expect(second.backends.shared.endpoint).toBe("http://192.168.1.50:11434");
  });

  it("does not re-migrate over a backend the user has since changed", async () => {
    // Keyed on the absence of `backends`, not the presence of the old field, so
    // a stale `providerEndpoint` left in the file cannot overwrite a real
    // choice made after migrating.
    await writeRaw("settings.json", {
      providerEndpoint: "http://old:11434",
      backends: { shared: { endpoint: "http://new:8080", protocol: "openai", hasKey: false } },
    });

    const loaded = await new SettingsStore(dir).load();
    expect(loaded.backends.shared.endpoint).toBe("http://new:8080");
    expect(loaded.backends.shared.protocol).toBe("openai");
  });

  it("leaves a fresh install on the default rather than inventing an endpoint", async () => {
    const loaded = await new SettingsStore(dir).load();
    expect(loaded.backends.shared.endpoint).toBe("http://localhost:11434");
  });
});

describe("merging backend settings", () => {
  it("changes one slot without disturbing the other", async () => {
    const store = new SettingsStore(dir);
    await store.load();
    await store.update({ backends: { chat: { enabled: true, endpoint: "https://api.example.com" } } });

    const after = await store.update({ backends: { shared: { endpoint: "http://127.0.0.1:8080" } } });

    expect(after.backends.shared.endpoint).toBe("http://127.0.0.1:8080");
    expect(after.backends.chat.endpoint).toBe("https://api.example.com");
    expect(after.backends.chat.enabled).toBe(true);
  });

  it("keeps the chat backend's configuration when it is switched off", async () => {
    const store = new SettingsStore(dir);
    await store.load();
    await store.update({ backends: { chat: { enabled: true, endpoint: "https://api.example.com", apiKey: "sk-1" } } });

    const off = await store.update({ backends: { chat: { enabled: false } } });

    expect(off.backends.chat.enabled).toBe(false);
    expect(off.backends.chat.endpoint).toBe("https://api.example.com");
    expect(off.backends.chat.hasKey).toBe(true);
    expect(store.keyFor("chat")).toBe("sk-1");
  });

  it("leaves an unrelated setting alone when a backend changes", async () => {
    const store = new SettingsStore(dir);
    await store.load();
    await store.update({ narrationPrompt: "Narrate tersely.", chatContextCap: 4096 });

    const after = await store.update({ backends: { shared: { endpoint: "http://x:1" } } });

    expect(after.narrationPrompt).toBe("Narrate tersely.");
    expect(after.chatContextCap).toBe(4096);
  });

  it("trims an endpoint rather than storing the whitespace a paste leaves", async () => {
    const store = new SettingsStore(dir);
    await store.load();
    const after = await store.update({ backends: { shared: { endpoint: "  http://x:8080  " } } });
    expect(after.backends.shared.endpoint).toBe("http://x:8080");
  });

  it("drops an unrecognised protocol rather than handing it to the factory", async () => {
    const store = new SettingsStore(dir);
    await store.load();
    await store.update({ backends: { shared: { protocol: "openai" } } });

    const after = await store.update({
      backends: { shared: { protocol: "anthropic" as unknown as "openai" } },
    });

    expect(after.backends.shared.protocol).toBe("openai");
  });
});

describe("keys", () => {
  it("stores a key outside settings entirely", async () => {
    const store = new SettingsStore(dir);
    await store.load();
    await store.update({ backends: { shared: { apiKey: "sk-secret-value" } } });

    // The structural guarantee. Settings are what gets broadcast, so what
    // matters is that the secret is not in the file that gets broadcast.
    expect(await readRaw("settings.json")).not.toContain("sk-secret-value");
    expect(await readRaw("backend-keys.json")).toContain("sk-secret-value");
  });

  it("reports that a key exists without reporting the key", async () => {
    const store = new SettingsStore(dir);
    await store.load();
    const after = await store.update({ backends: { shared: { apiKey: "sk-secret-value" } } });

    expect(after.backends.shared.hasKey).toBe(true);
    expect(JSON.stringify(after)).not.toContain("sk-secret-value");
    expect(store.keyFor("shared")).toBe("sk-secret-value");
  });

  it("keeps the stored key when a patch omits it", async () => {
    const store = new SettingsStore(dir);
    await store.load();
    await store.update({ backends: { shared: { apiKey: "sk-1" } } });

    const after = await store.update({ backends: { shared: { endpoint: "http://elsewhere:8080" } } });

    expect(after.backends.shared.hasKey).toBe(true);
    expect(store.keyFor("shared")).toBe("sk-1");
  });

  it("clears the key on null, and on an empty string", async () => {
    const store = new SettingsStore(dir);
    await store.load();
    await store.update({ backends: { shared: { apiKey: "sk-1" } } });

    const cleared = await store.update({ backends: { shared: { apiKey: null } } });
    expect(cleared.backends.shared.hasKey).toBe(false);
    expect(store.keyFor("shared")).toBeUndefined();

    await store.update({ backends: { shared: { apiKey: "sk-2" } } });
    const blanked = await store.update({ backends: { shared: { apiKey: "" } } });
    expect(blanked.backends.shared.hasKey).toBe(false);
  });

  it("keeps the two slots' keys apart", async () => {
    const store = new SettingsStore(dir);
    await store.load();
    await store.update({ backends: { shared: { apiKey: "sk-shared" }, chat: { apiKey: "sk-chat" } } });

    expect(store.keyFor("shared")).toBe("sk-shared");
    expect(store.keyFor("chat")).toBe("sk-chat");

    await store.update({ backends: { shared: { apiKey: null } } });
    expect(store.keyFor("shared")).toBeUndefined();
    expect(store.keyFor("chat")).toBe("sk-chat");
  });

  it("survives a restart", async () => {
    const first = new SettingsStore(dir);
    await first.load();
    await first.update({ backends: { chat: { enabled: true, apiKey: "sk-persisted" } } });

    const second = new SettingsStore(dir);
    const loaded = await second.load();

    expect(second.keyFor("chat")).toBe("sk-persisted");
    expect(loaded.backends.chat.hasKey).toBe(true);
  });

  it("ignores a non-string in a hand-edited key file rather than sending it as a header", async () => {
    await writeRaw("backend-keys.json", { shared: 12345, chat: { nested: true } });
    const store = new SettingsStore(dir);
    const loaded = await store.load();

    expect(store.keyFor("shared")).toBeUndefined();
    expect(store.keyFor("chat")).toBeUndefined();
    expect(loaded.backends.shared.hasKey).toBe(false);
  });

  it("does not let a client claim a key exists by sending the flag", async () => {
    const store = new SettingsStore(dir);
    await store.load();

    const after = await store.update({
      backends: { shared: { hasKey: true } as unknown as { endpoint?: string } },
    });

    expect(after.backends.shared.hasKey).toBe(false);
  });
});
