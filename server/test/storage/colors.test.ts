import { describe, it, expect } from "vitest";
import {
  normalizeColor,
  parseHex,
  contrastRatio,
  deltaE,
  PANE_BACKGROUND,
  RESERVED_COLORS,
  MIN_CONTRAST,
  MIN_RESERVED_DISTANCE,
  FALLBACK_COLOR,
} from "../../src/storage/colors.js";

const background = parseHex(PANE_BACKGROUND)!;
const [HAL_RED, STATUS_AMBER] = RESERVED_COLORS;

const contrast = (hex: string) => contrastRatio(parseHex(hex)!, background);
const distanceTo = (hex: string, reserved: string) => deltaE(parseHex(hex)!, parseHex(reserved)!);

describe("normalizeColor", () => {
  it("returns a colour that already clears both rules unchanged", () => {
    // The default adapter colour: the stylesheet's narration text colour.
    expect(normalizeColor("#e8c8c2")).toBe("#e8c8c2");
    expect(normalizeColor("#d6d6d2")).toBe("#d6d6d2");
  });

  it("accepts shorthand and hash-less hex, normalizing the written form", () => {
    expect(normalizeColor("#fff")).toBe("#ffffff");
    expect(normalizeColor("e8c8c2")).toBe("#e8c8c2");
    expect(normalizeColor("  #E8C8C2  ")).toBe("#e8c8c2");
  });

  it("signals unparseable input so the caller can drop the field", () => {
    for (const bad of ["", "not-a-colour", "#12", "#12345", "#gggggg", "rgb(1,2,3)", "#1234567"]) {
      expect(normalizeColor(bad)).toBeNull();
    }
  });

  it("lifts a colour below the contrast floor until it clears the floor", () => {
    const lifted = normalizeColor("#332018")!;
    expect(contrast("#332018")).toBeLessThan(MIN_CONTRAST);
    expect(lifted).not.toBe("#332018");
    expect(contrast(lifted)).toBeGreaterThanOrEqual(MIN_CONTRAST);
  });

  it("lifts even pure black, which has no lightness to work with", () => {
    const lifted = normalizeColor("#000000")!;
    expect(contrast(lifted)).toBeGreaterThanOrEqual(MIN_CONTRAST);
  });

  it("leaves a colour just above the contrast floor alone and lifts one just below", () => {
    // #7a7a7a sits at 4.55:1; #797979 at 4.49:1 — either side of the floor.
    expect(contrast("#7a7a7a")).toBeGreaterThanOrEqual(MIN_CONTRAST);
    expect(contrast("#797979")).toBeLessThan(MIN_CONTRAST);
    expect(normalizeColor("#7a7a7a")).toBe("#7a7a7a");
    const lifted = normalizeColor("#797979")!;
    expect(lifted).not.toBe("#797979");
    expect(contrast(lifted)).toBeGreaterThanOrEqual(MIN_CONTRAST);
  });

  it("moves a colour within the minimum distance of HAL red away from it", () => {
    expect(distanceTo("#e33a26", HAL_RED)).toBeLessThan(MIN_RESERVED_DISTANCE);
    const moved = normalizeColor("#e33a26")!;
    expect(distanceTo(moved, HAL_RED)).toBeGreaterThanOrEqual(MIN_RESERVED_DISTANCE);
    expect(contrast(moved)).toBeGreaterThanOrEqual(MIN_CONTRAST);
  });

  it("moves a colour within the minimum distance of the status amber away from it", () => {
    expect(distanceTo("#d9a521", STATUS_AMBER)).toBeLessThan(MIN_RESERVED_DISTANCE);
    const moved = normalizeColor("#d9a521")!;
    expect(distanceTo(moved, STATUS_AMBER)).toBeGreaterThanOrEqual(MIN_RESERVED_DISTANCE);
  });

  it("keeps a colour that sits just outside the reserved distance", () => {
    // #e76455 is deltaE ~26 from HAL red — clear, but only just.
    expect(distanceTo("#e76455", HAL_RED)).toBeGreaterThanOrEqual(MIN_RESERVED_DISTANCE);
    expect(normalizeColor("#e76455")).toBe("#e76455");
  });

  it("applies both rules together: a dark red comes back readable and clear of red", () => {
    const fixed = normalizeColor("#8f2114")!;
    expect(contrast(fixed)).toBeGreaterThanOrEqual(MIN_CONTRAST);
    for (const reserved of RESERVED_COLORS) {
      expect(distanceTo(fixed, reserved)).toBeGreaterThanOrEqual(MIN_RESERVED_DISTANCE);
    }
  });

  it("is deterministic and idempotent", () => {
    for (const input of ["#e0301e", "#332018", "#000000", "#d9a521", "#e8c8c2"]) {
      const once = normalizeColor(input)!;
      expect(normalizeColor(input)).toBe(once);
      expect(normalizeColor(once)).toBe(once);
    }
  });

  it("never returns a colour that violates either rule", () => {
    // Sweep the hue circle at several lightnesses, including values that sit
    // on top of both reserved colours.
    for (let r = 0; r < 256; r += 37) {
      for (let g = 0; g < 256; g += 41) {
        for (let b = 0; b < 256; b += 43) {
          const hex = `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
          const out = normalizeColor(hex)!;
          expect(contrast(out)).toBeGreaterThanOrEqual(MIN_CONTRAST);
          for (const reserved of RESERVED_COLORS) {
            expect(distanceTo(out, reserved)).toBeGreaterThanOrEqual(MIN_RESERVED_DISTANCE);
          }
        }
      }
    }
  });

  it("ships a fallback that itself satisfies both rules", () => {
    expect(normalizeColor(FALLBACK_COLOR)).toBe(FALLBACK_COLOR);
  });
});
