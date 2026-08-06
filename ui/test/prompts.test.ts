import { describe, it, expect } from "vitest";
import { isHandEdited } from "../src/prompts";
import { DEFAULT_NARRATION_PROMPT, NARRATION_PRESETS, resolvePrompt } from "../../shared/src/prompts";

const KNOWN = [DEFAULT_NARRATION_PROMPT, ...NARRATION_PRESETS.map((p) => p.text)];

describe("isHandEdited", () => {
  it("reports an unedited prompt as untouched, so seeding does not warn", () => {
    expect(isHandEdited(null, KNOWN)).toBe(false);
    // A record written before prompts existed carries no value at all.
    expect(isHandEdited(undefined, KNOWN)).toBe(false);
  });

  it("reports hand-written text as edited, so seeding warns", () => {
    expect(isHandEdited("Narrate tersely. No character.", KNOWN)).toBe(true);
  });

  it("does not treat the shipped default as edited", () => {
    // Reset then preset should not nag.
    expect(isHandEdited(DEFAULT_NARRATION_PROMPT, KNOWN)).toBe(false);
  });

  it("does not treat a preset the user already seeded as edited", () => {
    // Cycling between presets is not destroying work.
    for (const preset of NARRATION_PRESETS) {
      expect(isHandEdited(preset.text, KNOWN)).toBe(false);
    }
  });

  it("treats a deliberately blanked prompt as edited", () => {
    expect(isHandEdited("", KNOWN)).toBe(true);
  });
});

describe("resolvePrompt in the editor", () => {
  it("shows the shipped default for an unedited prompt and the stored text otherwise", () => {
    expect(resolvePrompt(null, DEFAULT_NARRATION_PROMPT)).toBe(DEFAULT_NARRATION_PROMPT);
    expect(resolvePrompt("Mine.", DEFAULT_NARRATION_PROMPT)).toBe("Mine.");
    // A blanked prompt stays blank in the editor rather than refilling.
    expect(resolvePrompt("", DEFAULT_NARRATION_PROMPT)).toBe("");
  });
});
