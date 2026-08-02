import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { ConversationStore } from "../../src/storage/conversations.js";
import { SettingsStore, DEFAULT_SETTINGS } from "../../src/storage/settings.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hal1000-storage-"));
});

describe("ConversationStore", () => {
  it("round-trips create, append, list, reopen", async () => {
    const store = new ConversationStore(dir);
    const convo = await store.create("hal-ft");
    await store.appendMessage(convo.id, { role: "user", content: "Open the pod bay doors", at: new Date().toISOString() });
    await store.appendMessage(convo.id, { role: "assistant", content: "I'm afraid I can't do that.", at: new Date().toISOString() });

    // Fresh store instance simulates an app restart (AE3).
    const reopened = new ConversationStore(dir);
    const listed = await reopened.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.title).toBe("Open the pod bay doors");
    expect(listed[0]!.model).toBe("hal-ft");
    const full = await reopened.get(convo.id);
    expect(full!.messages).toHaveLength(2);
    expect(full!.messages[1]!.content).toBe("I'm afraid I can't do that.");
  });

  it("delete removes the file and the listing entry", async () => {
    const store = new ConversationStore(dir);
    const convo = await store.create("llama3");
    await store.delete(convo.id);
    expect(await store.list()).toEqual([]);
    expect(await store.get(convo.id)).toBeNull();
  });

  it("keeps the original model name on the record when the model changes", async () => {
    const store = new ConversationStore(dir);
    const convo = await store.create("hal-ft-v1");
    await store.setModel(convo.id, "hal-ft-v2");
    const updated = await store.get(convo.id);
    expect(updated!.model).toBe("hal-ft-v2");
  });
});

describe("SettingsStore", () => {
  it("returns defaults when nothing is stored", async () => {
    const store = new SettingsStore(dir);
    expect(await store.load()).toEqual(DEFAULT_SETTINGS);
  });

  it("persists updates and survives reload", async () => {
    const store = new SettingsStore(dir);
    await store.load();
    await store.update({ chatModel: "hal-ft", personaIntensity: "high" });
    const fresh = new SettingsStore(dir);
    const loaded = await fresh.load();
    expect(loaded.chatModel).toBe("hal-ft");
    expect(loaded.personaIntensity).toBe("high");
  });

  it("a stray temp file from a crashed write leaves previous settings readable", async () => {
    const store = new SettingsStore(dir);
    await store.load();
    await store.update({ chatModel: "hal-ft" });
    // Simulate a crash between temp-write and rename.
    await fs.writeFile(path.join(dir, ".settings.json.9999.tmp"), "{ garbage", "utf8");
    const fresh = new SettingsStore(dir);
    const loaded = await fresh.load();
    expect(loaded.chatModel).toBe("hal-ft");
  });
});
