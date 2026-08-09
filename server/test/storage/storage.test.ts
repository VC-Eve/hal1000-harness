import { describe, it, expect, beforeEach } from "vitest";
import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { ConversationStore } from "../../src/storage/conversations.js";
import { SettingsStore, DEFAULT_SETTINGS } from "../../src/storage/settings.js";
import {
  contrastRatio,
  deltaE,
  parseHex,
  MIN_CONTRAST,
  MIN_RESERVED_DISTANCE,
  PANE_BACKGROUND,
  RESERVED_COLORS,
} from "../../src/storage/colors.js";
import { ADAPTER_IDS, type SettingsPatch } from "../../../shared/src/types.js";
import {
  DEFAULT_CHAT_PROMPT,
  DEFAULT_NARRATION_PROMPT,
  NARRATION_PRESETS,
  isBlankPrompt,
  narrationPreset,
  resolvePrompt,
} from "../../../shared/src/prompts.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hal1000-storage-"));
});

// Writes a settings file directly, standing in for a hand-edited file or one
// left by a prior version.
// Deliberately loose: several tests write settings files in shapes older than
// the current type, which is the point of a migration test.
async function writeSettings(value: SettingsPatch | Record<string, unknown>): Promise<void> {
  await fs.writeFile(path.join(dir, "settings.json"), JSON.stringify(value), "utf8");
}

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

  // U2 — the two context switches.
  describe("context switches", () => {
    it("a conversation created before the feature reads as both off", async () => {
      // The record carries no context key at all, and nothing invents one.
      const store = new ConversationStore(dir);
      const convo = await store.create("m");
      expect(convo.context).toBeUndefined();
      expect((await store.get(convo.id))!.context).toBeUndefined();
    });

    it("sets one switch without clearing the other", async () => {
      const store = new ConversationStore(dir);
      const convo = await store.create("m");
      await store.setContext(convo.id, { vision: "large" });
      await store.setContext(convo.id, { session: "small" });
      expect((await store.get(convo.id))!.context).toEqual({ vision: "large", session: "small" });
    });

    it("survives a restart", async () => {
      const store = new ConversationStore(dir);
      const convo = await store.create("m");
      await store.setContext(convo.id, { vision: "medium", session: "large" });
      const reopened = new ConversationStore(dir);
      expect((await reopened.get(convo.id))!.context).toEqual({ vision: "medium", session: "large" });
    });

    it("falls back to off for a level it does not recognise", async () => {
      // The value decides how much text reaches a model, so an older client or
      // a hand-edited file must not be able to put something else in the slot.
      const store = new ConversationStore(dir);
      const convo = await store.create("m");
      await store.setContext(convo.id, { vision: "enormous" as never });
      expect((await store.get(convo.id))!.context!.vision).toBe("off");
    });

    it("falls back to off for a non-string level", async () => {
      const store = new ConversationStore(dir);
      const convo = await store.create("m");
      await store.setContext(convo.id, { session: 6000 as never });
      expect((await store.get(convo.id))!.context!.session).toBe("off");
    });

    it("answers null for a conversation that does not exist", async () => {
      const store = new ConversationStore(dir);
      expect(await store.setContext(crypto.randomUUID(), { vision: "small" })).toBeNull();
    });

    it("lands both of two concurrent switch changes", async () => {
      // Read-modify-write on one record from two handlers: without the lock the
      // second write is built on a snapshot taken before the first.
      const store = new ConversationStore(dir);
      const convo = await store.create("m");
      await Promise.all([
        store.setContext(convo.id, { vision: "large" }),
        store.setContext(convo.id, { session: "medium" }),
      ]);
      expect((await store.get(convo.id))!.context).toEqual({ vision: "large", session: "medium" });
    });

    it("carries the switches into the listing, not only the full record", async () => {
      const store = new ConversationStore(dir);
      const convo = await store.create("m");
      await store.setContext(convo.id, { vision: "small" });
      const listed = (await store.list()).find((c) => c.id === convo.id);
      expect(listed!.context).toEqual({ vision: "small", session: "off" });
    });
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

  it("patching one adapter's enabled state preserves its colour and every registered adapter", async () => {
    const store = new SettingsStore(dir);
    await store.load();
    await store.update({ adapters: { "claude-code": { color: "#7fdc9a" } } });

    const after = await store.update({ adapters: { "claude-code": { enabled: false } } });
    expect(after.adapters["claude-code"]).toEqual({ enabled: false, color: "#7fdc9a" });
    // Every registered adapter still has an entry — the map is merged per id,
    // not replaced by the patch.
    for (const id of ADAPTER_IDS) expect(after.adapters[id]).toBeDefined();
    // Unrelated settings survive the nested merge.
    expect(after.chatColors).toEqual(DEFAULT_SETTINGS.chatColors);
  });

  it("a stored file mentioning some adapters still yields defaults for the ones it omits", async () => {
    await writeSettings({ chatModel: "hal-ft", adapters: {} });
    const loaded = await new SettingsStore(dir).load();
    for (const id of ADAPTER_IDS) {
      expect(loaded.adapters[id]).toEqual(DEFAULT_SETTINGS.adapters[id]);
    }
    expect(loaded.chatModel).toBe("hal-ft");
  });

  it("settings written by a prior version load with adapter and colour defaults applied", async () => {
    // Exactly the v1 shape: no adapters key, no chatColors key.
    await writeSettings({
      providerEndpoint: "http://localhost:11434",
      chatModel: "hal-ft",
      narrationModel: "hal-narrate",
      personaIntensity: "high",
      watchedSessionId: "s1",
    });
    const loaded = await new SettingsStore(dir).load();
    expect(loaded.adapters).toEqual(DEFAULT_SETTINGS.adapters);
    expect(loaded.chatColors).toEqual(DEFAULT_SETTINGS.chatColors);
    expect(loaded.personaIntensity).toBe("high");
    expect(loaded.watchedSessionId).toBe("s1");
    // The v1 endpoint becomes the shared backend rather than being dropped.
    // Losing it would silently repoint a configured install at the default.
    expect(loaded.backends.shared.endpoint).toBe("http://localhost:11434");
  });

  it("stores a below-floor colour lifted, and returns the lifted value rather than the submitted one", async () => {
    const store = new SettingsStore(dir);
    await store.load();
    const submitted = "#332018";
    const updated = await store.update({ adapters: { "claude-code": { color: submitted } } });
    const stored = updated.adapters["claude-code"].color;
    expect(stored).not.toBe(submitted);
    expect(contrastRatio(parseHex(stored)!, parseHex(PANE_BACKGROUND)!)).toBeGreaterThanOrEqual(MIN_CONTRAST);
    // The broadcast value is what a reload sees.
    expect((await new SettingsStore(dir).load()).adapters["claude-code"].color).toBe(stored);
  });

  it("moves a colour within the minimum distance of HAL red away from it", async () => {
    const store = new SettingsStore(dir);
    await store.load();
    const updated = await store.update({ adapters: { "claude-code": { color: "#e33a26" } } });
    const stored = updated.adapters["claude-code"].color;
    expect(deltaE(parseHex(stored)!, parseHex(RESERVED_COLORS[0])!)).toBeGreaterThanOrEqual(MIN_RESERVED_DISTANCE);
  });

  it("round-trips a colour that already clears both rules", async () => {
    const store = new SettingsStore(dir);
    await store.load();
    const updated = await store.update({
      adapters: { "claude-code": { color: "#7fdc9a" } },
      chatColors: { user: "#8ab4f8" },
    });
    expect(updated.adapters["claude-code"].color).toBe("#7fdc9a");
    expect(updated.chatColors.user).toBe("#8ab4f8");
    expect(updated.chatColors.assistant).toBe(DEFAULT_SETTINGS.chatColors.assistant);
  });

  it("loads a stored below-floor colour with the lifted value", async () => {
    // Hand-edited file, or one written before the floor was tuned: it never
    // passed through update(), so load() has to correct it.
    await writeSettings({
      adapters: { "claude-code": { enabled: true, color: "#332018" } },
      chatColors: { user: "#101010", assistant: "#d6d6d2" },
    });
    const loaded = await new SettingsStore(dir).load();
    const bg = parseHex(PANE_BACKGROUND)!;
    expect(loaded.adapters["claude-code"].color).not.toBe("#332018");
    expect(contrastRatio(parseHex(loaded.adapters["claude-code"].color)!, bg)).toBeGreaterThanOrEqual(MIN_CONTRAST);
    expect(loaded.chatColors.user).not.toBe("#101010");
    expect(contrastRatio(parseHex(loaded.chatColors.user)!, bg)).toBeGreaterThanOrEqual(MIN_CONTRAST);
    // A stored value that was already fine is untouched.
    expect(loaded.chatColors.assistant).toBe("#d6d6d2");
  });

  it("drops a malformed colour from the patch and keeps the prior stored value", async () => {
    const store = new SettingsStore(dir);
    await store.load();
    await store.update({ adapters: { "claude-code": { color: "#7fdc9a" } }, chatColors: { user: "#8ab4f8" } });

    const after = await store.update({
      adapters: { "claude-code": { enabled: false, color: "octarine" } },
      chatColors: { user: "#zzz" },
    });
    expect(after.adapters["claude-code"].color).toBe("#7fdc9a");
    expect(after.chatColors.user).toBe("#8ab4f8");
    // The rest of the same patch still applies — only the colour is dropped.
    expect(after.adapters["claude-code"].enabled).toBe(false);
  });

  it("falls back to defaults when a stored colour is malformed", async () => {
    await writeSettings({ adapters: { "claude-code": { enabled: false, color: "octarine" } } });
    const loaded = await new SettingsStore(dir).load();
    expect(loaded.adapters["claude-code"].color).toBe(DEFAULT_SETTINGS.adapters["claude-code"].color);
    expect(loaded.adapters["claude-code"].enabled).toBe(false);
  });
});

describe("system prompts in settings", () => {
  it("a stored file with no prompt keys loads both prompts unedited", async () => {
    await writeSettings({ chatModel: "hal-ft" });
    const loaded = await new SettingsStore(dir).load();
    expect(loaded.narrationPrompt).toBeNull();
    expect(loaded.chatDefaultPrompt).toBeNull();
  });

  it("stores a prompt verbatim and leaves the other prompt untouched", async () => {
    const store = new SettingsStore(dir);
    await store.load();
    const after = await store.update({ narrationPrompt: "Narrate tersely." });
    expect(after.narrationPrompt).toBe("Narrate tersely.");
    expect(after.chatDefaultPrompt).toBeNull();
  });

  it("a patch carrying null clears a stored prompt back to unedited (R12)", async () => {
    const store = new SettingsStore(dir);
    await store.load();
    await store.update({ narrationPrompt: "Narrate tersely." });
    const after = await store.update({ narrationPrompt: null });
    expect(after.narrationPrompt).toBeNull();
    // Reset survives a reload — it is stored, not just forgotten in memory.
    expect((await new SettingsStore(dir).load()).narrationPrompt).toBeNull();
  });

  it("an empty string is stored as a deliberate blanking, distinct from null", async () => {
    const store = new SettingsStore(dir);
    await store.load();
    const after = await store.update({ chatDefaultPrompt: "" });
    expect(after.chatDefaultPrompt).toBe("");
    expect(after.chatDefaultPrompt).not.toBeNull();
    expect(resolvePrompt(after.chatDefaultPrompt, "SHIPPED")).toBe("");
  });

  it("a patch touching an unrelated setting leaves both prompts unchanged", async () => {
    const store = new SettingsStore(dir);
    await store.load();
    await store.update({ narrationPrompt: "Narrate tersely.", chatDefaultPrompt: "Be HAL." });
    const after = await store.update({ backends: { shared: { endpoint: "http://localhost:9999" } } });
    expect(after.narrationPrompt).toBe("Narrate tersely.");
    expect(after.chatDefaultPrompt).toBe("Be HAL.");
  });

  it("against a changed shipped default, unedited follows and edited does not (R13, R14, AE4)", async () => {
    const store = new SettingsStore(dir);
    await store.load();
    // Stands in for a release that ships different default text.
    const nextRelease = "A revised shipped default.";
    expect(resolvePrompt((await store.update({ narrationPrompt: null })).narrationPrompt, nextRelease)).toBe(nextRelease);

    const edited = await store.update({ narrationPrompt: "Mine." });
    expect(resolvePrompt(edited.narrationPrompt, nextRelease)).toBe("Mine.");
  });

  it("drops a non-string prompt from a patch and keeps the prior stored value", async () => {
    const store = new SettingsStore(dir);
    await store.load();
    await store.update({ narrationPrompt: "Mine." });
    // Hand-edited file or a malformed client: a number here would otherwise be
    // stamped onto every new conversation and throw on send.
    const after = await store.update({ narrationPrompt: 42 as unknown as string });
    expect(after.narrationPrompt).toBe("Mine.");
  });

  it("converts a stored low/high intensity into the matching prompt once, on upgrade", async () => {
    // Exactly the pre-prompt shape: intensity set, no narrationPrompt key.
    await writeSettings({ personaIntensity: "high", chatModel: "hal-ft" });
    const loaded = await new SettingsStore(dir).load();
    expect(loaded.narrationPrompt).toBe(narrationPreset("full")!.text);

    // Migrated once: a later deliberate reset must survive a restart rather
    // than being re-seeded from the still-set intensity.
    const store = new SettingsStore(dir);
    await store.load();
    await store.update({ narrationPrompt: null });
    expect((await new SettingsStore(dir).load()).narrationPrompt).toBeNull();
  });

  it("leaves a medium-intensity install unedited so it keeps tracking the shipped default", async () => {
    await writeSettings({ personaIntensity: "medium", chatModel: "hal-ft" });
    expect((await new SettingsStore(dir).load()).narrationPrompt).toBeNull();
  });

  it("the shipped narration default is the retired medium-intensity wording", () => {
    // Guards the claim that nothing changes on screen for a user who never
    // opens the editor. If this fails because the shipped wording was edited
    // deliberately, update the expectations — a failure here means the default
    // moved, which is a decision to make consciously, not a flake.
    expect(DEFAULT_NARRATION_PROMPT).toContain("calm, understated HAL 9000 tone");
    expect(DEFAULT_NARRATION_PROMPT).toContain("Never invent activity that is not in the log lines.");
    expect(DEFAULT_NARRATION_PROMPT).toBe(NARRATION_PRESETS.find((p) => p.id === "measured")!.text);
  });

  it("the shipped chat default is empty, and blankness ignores whitespace", () => {
    expect(DEFAULT_CHAT_PROMPT).toBe("");
    expect(isBlankPrompt(DEFAULT_CHAT_PROMPT)).toBe(true);
    expect(isBlankPrompt("   \n\t ")).toBe(true);
    expect(isBlankPrompt("Be HAL.")).toBe(false);
  });
});
