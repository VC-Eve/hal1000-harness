import { describe, expect, it } from "vitest";
import { outlineCss, shadowCss, treatmentStyle } from "../src/textTreatment";
import type { TextSlot } from "../../shared/src/overlays";

const slot = (over: Partial<TextSlot> = {}): TextSlot => ({
  position: "bottom-left",
  source: "text",
  text: "hello",
  font: "Segoe UI",
  size: 4,
  color: "#ffffff",
  ...over,
});

const shadow = (over: Partial<TextSlot["shadow"]> = {}) => ({
  color: "#000000",
  angle: 135,
  distance: 4,
  blur: 6,
  ...over,
});

describe("which way a shadow is cast", () => {
  it("casts straight up at 0°, and down at 180°", () => {
    // The angle is the direction the shadow goes, clockwise from up. A page's
    // y axis points down, which is why up is the negative one.
    expect(shadowCss(shadow({ angle: 0, distance: 10, blur: 0 }))).toContain("0em -0.1em");
    expect(shadowCss(shadow({ angle: 180, distance: 10, blur: 0 }))).toContain("0em 0.1em");
  });

  it("casts right at 90°, and left at 270°", () => {
    expect(shadowCss(shadow({ angle: 90, distance: 10, blur: 0 }))).toContain("0.1em 0em");
    expect(shadowCss(shadow({ angle: 270, distance: 10, blur: 0 }))).toContain("-0.1em 0em");
  });

  it("casts down and to the right at 135°, which is what the editor starts with", () => {
    const value = shadowCss(shadow({ angle: 135, distance: 10, blur: 0 }));
    const [x, y] = value.split(" ");
    expect(Number(x!.replace("em", ""))).toBeGreaterThan(0);
    expect(Number(y!.replace("em", ""))).toBeGreaterThan(0);
  });

  it("has no direction at all at distance 0, which is what a glow is", () => {
    // Every angle answers the same, so there is one dial and no glow mode.
    for (const angle of [0, 45, 135, 200, 359]) {
      expect(shadowCss(shadow({ angle, distance: 0, blur: 20 }))).toBe(
        "0em 0em 0.2em rgba(0, 0, 0, 1)",
      );
    }
  });
});

describe("what a stored number becomes", () => {
  it("reads a percentage as a hundredth of the type size", () => {
    expect(shadowCss(shadow({ angle: 180, distance: 50, blur: 25 }))).toContain("0.5em 0.25em");
    expect(outlineCss({ color: "#000000", width: 4 })).toMatchObject({
      WebkitTextStrokeWidth: "0.04em",
    });
  });

  it("rounds to a stable string, so two runs cannot disagree about the last digit", () => {
    const once = shadowCss(shadow({ angle: 137, distance: 7, blur: 3 }));
    expect(shadowCss(shadow({ angle: 137, distance: 7, blur: 3 }))).toBe(once);
    expect(once).not.toMatch(/\d{6}em/);
  });

  it("means opaque when no opacity was asked for", () => {
    expect(shadowCss(shadow())).toContain("rgba(0, 0, 0, 1)");
  });

  it("reads an opacity percentage as an alpha, including a stored 0", () => {
    expect(shadowCss(shadow({ opacity: 50 }))).toContain("rgba(0, 0, 0, 0.5)");
    expect(shadowCss(shadow({ opacity: 0 }))).toContain("rgba(0, 0, 0, 0)");
  });

  it("reads a stored hex as its own three channels", () => {
    expect(shadowCss(shadow({ color: "#3366ff", opacity: 100 }))).toContain("rgba(51, 102, 255, 1)");
  });
});

describe("what an untreated slot adds", () => {
  it("adds no property at all", () => {
    // Asserted by key count, not by truthiness: a style object carrying
    // `textShadow: undefined` would pass a truthiness check and would still be
    // a property the layer set.
    expect(Object.keys(treatmentStyle(slot()))).toEqual([]);
  });

  it("adds only the stroke when only an outline was asked for", () => {
    const style = treatmentStyle(slot({ outline: { color: "#000000", width: 4 } }));
    expect(style).toMatchObject({ WebkitTextStrokeWidth: "0.04em", WebkitTextStrokeColor: "#000000" });
    expect(style).not.toHaveProperty("textShadow");
  });

  it("adds only the shadow when only a shadow was asked for", () => {
    const style = treatmentStyle(slot({ shadow: shadow() }));
    expect(style).toHaveProperty("textShadow");
    expect(style).not.toHaveProperty("WebkitTextStrokeWidth");
  });

  it("adds both when both were asked for, and keeps their colours apart", () => {
    const style = treatmentStyle(
      slot({ outline: { color: "#ff0000", width: 4 }, shadow: shadow({ color: "#0000ff" }) }),
    );
    expect(style.WebkitTextStrokeColor).toBe("#ff0000");
    expect(style.textShadow).toContain("rgba(0, 0, 255, 1)");
    expect(style.textShadow).not.toContain("255, 0, 0");
  });

  it("paints the stroke behind the fill, so a border does not thin the letter", () => {
    // The half that makes it a border rather than a heavier glyph. What a
    // browser actually does with it is scripts/treatment-check.mjs' question.
    expect(treatmentStyle(slot({ outline: { color: "#000000", width: 10 } }))).toMatchObject({
      paintOrder: "stroke fill",
    });
  });
});
