import { describe, expect, it } from "vitest";
import { BACKINGS, cleanSlot, resolveSlot, type OverlaySlot } from "../../../shared/src/overlays.js";
import type { Utterance, World } from "../../../shared/src/types.js";

const slot = (over: Partial<OverlaySlot> = {}): OverlaySlot =>
  ({
    position: "bottom-center",
    source: "speech",
    font: "Georgia",
    size: 4,
    color: "#ffffff",
    ...over,
  }) as OverlaySlot;

const world = (): World => ({ id: "w", title: "Night Drive" }) as World;

const speaking = (current: number): Utterance => ({
  generation: 3,
  text: "I am afraid, Dave. This mission is too important.",
  voiceId: "hal",
  sentences: [
    { text: "I am afraid, Dave.", durationMs: 1500 },
    { text: "This mission is too important.", durationMs: 2000 },
  ],
  current,
});

describe("the speech source", () => {
  it("draws the sentence being spoken, not the whole line", () => {
    // Each sentence is rendered separately and shown for its own measured
    // duration (R16), which is what makes the timing a by-product rather than
    // an estimate.
    expect(resolveSlot(slot(), world(), null, speaking(0))).toBe("I am afraid, Dave.");
    expect(resolveSlot(slot(), world(), null, speaking(1))).toBe("This mission is too important.");
  });

  it("draws nothing before the first sentence begins", () => {
    expect(resolveSlot(slot(), world(), null, speaking(-1))).toBeNull();
  });

  it("draws nothing when nothing is being said", () => {
    // A slot with nothing to say renders no element at all, which is the rule
    // that keeps the broadcast surface's allowlist exact (R17).
    expect(resolveSlot(slot(), world(), null, null)).toBeNull();
    expect(resolveSlot(slot(), world(), null, undefined)).toBeNull();
  });

  it("draws nothing for a sentence index past the end", () => {
    expect(resolveSlot(slot(), world(), null, speaking(9))).toBeNull();
  });

  it("leaves every other source unaffected by speech state", () => {
    // The live-state sources it joins: `playlist-header` and `track-description`
    // already resolve from the transport, so nothing about drawing transient
    // text is new — only this source is.
    expect(resolveSlot(slot({ source: "title" }), world(), null, speaking(0))).toBe("Night Drive");
    expect(resolveSlot(slot({ source: "text", text: "fixed" }), world(), null, speaking(0))).toBe("fixed");
  });
});

describe("the subtitle and the manifest", () => {
  it("carries no spoken word, only where one would be drawn", () => {
    // R15. The slot is the World's; the words are decided when they are drawn.
    // Anything else would rewrite the World on every line spoken.
    const cleaned = cleanSlot(slot());
    expect(cleaned).toEqual({
      position: "bottom-center",
      source: "speech",
      font: "Georgia",
      size: 4,
      color: "#ffffff",
    });
    expect(JSON.stringify(cleaned)).not.toContain("afraid");
  });
});

describe("the optional backing", () => {
  it("is absent in the canonical form, so no existing manifest is rewritten", () => {
    expect(cleanSlot(slot())).not.toHaveProperty("backing");
  });

  it("is kept when one is asked for", () => {
    for (const backing of BACKINGS) {
      expect(cleanSlot(slot({ backing }))).toMatchObject({ backing });
    }
  });

  it("refuses an unknown value rather than falling back to none", () => {
    // The rule an unknown `kind` follows: drawing something nobody asked for
    // because a word was misspelled is the worse half of the two failures.
    expect(cleanSlot(slot({ backing: "glow" } as never))).toBeNull();
  });

  it("is available to every text slot, not only to speech", () => {
    // The problem is the medium, not the source: any caption can land over a
    // bright frame.
    expect(cleanSlot(slot({ source: "title", backing: "band" }))).toMatchObject({ backing: "band" });
  });
});
