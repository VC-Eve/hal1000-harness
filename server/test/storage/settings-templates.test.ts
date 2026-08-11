import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsStore } from "../../src/storage/settings.js";
import { eventLine } from "../../src/narration/coalescer.js";
import { tmpDir } from "../tmp.js";

// The merge that had no coverage at all. Three reviewers reached it from
// different directions — the per-role semantics, the upgrade path from a
// settings.json written before templates existed, and what a hand-edited file
// can put in the slot.

let dir: string;
let store: SettingsStore;

beforeEach(async () => {
  dir = await tmpDir("hal-settings-templates-");
  store = new SettingsStore(dir);
  await store.load();
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe("templates merge per role", () => {
  it("starts with none stored, so every role resolves to what shipped", async () => {
    expect(store.get().templates).toEqual({});
    expect(store.get().templateBaselines).toEqual({});
  });

  it("sets one role without disturbing another", async () => {
    await store.update({ templates: { "monitor-user": "mine" } });
    await store.update({ templates: { "narration-user": "theirs" } });
    expect(store.get().templates).toEqual({ "monitor-user": "mine", "narration-user": "theirs" });
  });

  it("clears one role with null and leaves the rest", async () => {
    await store.update({ templates: { "monitor-user": "mine", "narration-user": "theirs" } });
    await store.update({ templates: { "monitor-user": null } });
    expect(store.get().templates).toEqual({ "narration-user": "theirs" });
  });

  it("keeps a role the patch does not mention", async () => {
    await store.update({ templates: { "monitor-user": "mine" } });
    await store.update({ chatModel: "something-else" });
    expect(store.get().templates["monitor-user"]).toBe("mine");
  });

  it("stores an empty string as a deliberate blanking", async () => {
    await store.update({ templates: { "monitor-user": "" } });
    expect(store.get().templates["monitor-user"]).toBe("");
  });

  it("drops a non-string rather than storing it", async () => {
    await store.update({ templates: { "monitor-user": 42 as unknown as string } });
    expect(store.get().templates["monitor-user"]).toBeUndefined();
  });

  it("ignores a role name the vocabulary does not have", async () => {
    await store.update({ templates: { "not-a-role": "x" } as never });
    expect(Object.keys(store.get().templates)).toEqual([]);
  });
});

describe("baselines merge per role", () => {
  it("stores a baseline with the shipped default it was taken against", async () => {
    await store.update({
      templateBaselines: { "monitor-user": { text: "mine", shippedDefault: "shipped" } },
    });
    expect(store.get().templateBaselines["monitor-user"]).toEqual({ text: "mine", shippedDefault: "shipped" });
  });

  it("forgets one with null", async () => {
    await store.update({ templateBaselines: { "monitor-user": { text: "a", shippedDefault: "b" } } });
    await store.update({ templateBaselines: { "monitor-user": null } });
    expect(store.get().templateBaselines["monitor-user"]).toBeUndefined();
  });

  it("drops a malformed baseline rather than storing half of one", async () => {
    await store.update({
      templateBaselines: { "monitor-user": { text: "only text" } as never },
    });
    expect(store.get().templateBaselines["monitor-user"]).toBeUndefined();
  });
});

describe("a settings.json written before templates existed", () => {
  it("loads, and every role resolves to what shipped", async () => {
    // Exactly what an install upgrading into this change has on disk: no
    // `templates` key at all.
    const file = path.join(dir, "settings.json");
    await fs.writeFile(
      file,
      JSON.stringify({ chatModel: "llama3", narrationPrompt: "kept", personaIntensity: "high" }),
      "utf8",
    );
    const upgraded = new SettingsStore(dir);
    const loaded = await upgraded.load();
    expect(loaded.templates).toEqual({});
    expect(loaded.templateBaselines).toEqual({});
    // And nothing else was lost on the way through.
    expect(loaded.chatModel).toBe("llama3");
    expect(loaded.narrationPrompt).toBe("kept");
  });

  it("survives a hand-edited file whose templates key is not an object", async () => {
    const file = path.join(dir, "settings.json");
    await fs.writeFile(file, JSON.stringify({ templates: "abc", templateBaselines: 7 }), "utf8");
    const upgraded = new SettingsStore(dir);
    const loaded = await upgraded.load();
    // Not spread into {0:"a",1:"b",2:"c"}.
    expect(loaded.templates).toEqual({});
    expect(loaded.templateBaselines).toEqual({});
  });
});

describe("phrases merge per id", () => {
  it("starts with none stored", () => {
    expect(store.get().phrases).toEqual({});
  });

  it("sets one id without disturbing another", async () => {
    await store.update({ phrases: { "sight.unrecognised": "a stranger" } });
    await store.update({ phrases: { "people.other": "You know {name}." } });
    expect(store.get().phrases).toEqual({
      "sight.unrecognised": "a stranger",
      "people.other": "You know {name}.",
    });
  });

  it("clears one with null and leaves the rest", async () => {
    await store.update({ phrases: { "sight.unrecognised": "a stranger", "people.other": "x" } });
    await store.update({ phrases: { "sight.unrecognised": null } });
    expect(store.get().phrases).toEqual({ "people.other": "x" });
  });

  it("drops a non-string", async () => {
    await store.update({ phrases: { "sight.unrecognised": 42 as unknown as string } });
    expect(store.get().phrases["sight.unrecognised"]).toBeUndefined();
  });

  it("ignores an id the catalogue does not have", async () => {
    await store.update({ phrases: { "sight.invented": "x" } });
    expect(Object.keys(store.get().phrases)).toEqual([]);
  });

  // The id was checked and the TEXT was not, which is the half that matters: a
  // phrase's fields hold the line's own content, and an unknown field renders
  // as empty rather than failing. The editor refuses these; this route did not.
  describe("a phrase naming a field it does not have", () => {
    it("is refused rather than stored", async () => {
      await store.update({ phrases: { "narration.event_line": "[{kind}] {message}" } });
      expect(store.get().phrases["narration.event_line"]).toBeUndefined();
    });

    it("leaves the line rendering its text, instead of deleting it silently", async () => {
      // The actual harm: stored, this renders "[assistant] " for every log
      // line and HAL comments confidently on nothing.
      await store.update({ phrases: { "narration.event_line": "[{kind}] {message}" } });
      const line = eventLine(
        { at: "t", kind: "assistant", text: "edited the router", toolUses: [] },
        store.get().phrases,
      );
      expect(line).toBe("[assistant] edited the router");
    });

    it("does not destroy a good edit made earlier", async () => {
      await store.update({ phrases: { "narration.event_line": "{kind} — {text}{tool_list}" } });
      await store.update({ phrases: { "narration.event_line": "[{kind}] {message}" } });
      expect(store.get().phrases["narration.event_line"]).toBe("{kind} — {text}{tool_list}");
    });

    it("accepts a rewording that only rearranges the fields it does have", async () => {
      await store.update({ phrases: { "sight.caption_line": "{caption} (in frame: {names})" } });
      expect(store.get().phrases["sight.caption_line"]).toBe("{caption} (in frame: {names})");
    });

    it("refuses a universal reading, which a phrase deliberately cannot take", async () => {
      await store.update({ phrases: { "sight.unrecognised": "someone, at {clock}" } });
      expect(store.get().phrases["sight.unrecognised"]).toBeUndefined();
    });

    it("survives a hand-edited file carrying one, without dropping the rest", async () => {
      const file = path.join(dir, "settings.json");
      await fs.writeFile(
        file,
        JSON.stringify({ phrases: { "narration.event_line": "[{kind}] {message}", "sight.unrecognised": "a stranger" } }),
        "utf8",
      );
      const upgraded = new SettingsStore(dir);
      const loaded = await upgraded.load();
      expect(loaded.phrases["narration.event_line"]).toBeUndefined();
      expect(loaded.phrases["sight.unrecognised"]).toBe("a stranger");
    });
  });

  it("survives a hand-edited file whose phrases key is not an object", async () => {
    const file = path.join(dir, "settings.json");
    await fs.writeFile(file, JSON.stringify({ phrases: "abc" }), "utf8");
    const upgraded = new SettingsStore(dir);
    const loaded = await upgraded.load();
    expect(loaded.phrases).toEqual({});
  });

  it("loads a settings.json with no phrases key at all", async () => {
    const file = path.join(dir, "settings.json");
    await fs.writeFile(file, JSON.stringify({ chatModel: "m" }), "utf8");
    const upgraded = new SettingsStore(dir);
    expect((await upgraded.load()).phrases).toEqual({});
  });
});
