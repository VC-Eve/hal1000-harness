import { describe, expect, it } from "vitest";
import { fittedRect } from "../src/overlay";

describe("where the picture is inside its box", () => {
  it("letterboxes a wide picture in a squarer box, centred", () => {
    // 16:9 in 4:3 — the width fills, the height does not.
    const rect = fittedRect({ width: 800, height: 600 }, { width: 1920, height: 1080 });
    expect(rect).toEqual({ left: 0, top: 75, width: 800, height: 450 });
  });

  it("pillarboxes a squarer picture in a wide box, centred", () => {
    // 4:3 in 16:9 — the height fills, the width does not.
    const rect = fittedRect({ width: 1920, height: 1080 }, { width: 640, height: 480 });
    expect(rect).toEqual({ left: 240, top: 0, width: 1440, height: 1080 });
  });

  it("fills the box when the aspects match", () => {
    expect(fittedRect({ width: 1920, height: 1080 }, { width: 1280, height: 720 })).toEqual({
      left: 0,
      top: 0,
      width: 1920,
      height: 1080,
    });
  });

  it("is the whole box with no picture, or a picture with no size yet", () => {
    // What keeps the title up over black: nothing assigned, or metadata not
    // yet read, both mean the words are placed on the box itself.
    const whole = { left: 0, top: 0, width: 800, height: 600 };
    expect(fittedRect({ width: 800, height: 600 }, null)).toEqual(whole);
    expect(fittedRect({ width: 800, height: 600 }, undefined)).toEqual(whole);
    expect(fittedRect({ width: 800, height: 600 }, { width: 0, height: 0 })).toEqual(whole);
    expect(fittedRect({ width: 800, height: 600 }, { width: 1920, height: 0 })).toEqual(whole);
    expect(fittedRect({ width: 800, height: 600 }, { width: NaN, height: 1080 })).toEqual(whole);
  });

  it("is the whole box when the box itself has no size yet", () => {
    expect(fittedRect({ width: 0, height: 0 }, { width: 1920, height: 1080 })).toEqual({
      left: 0,
      top: 0,
      width: 0,
      height: 0,
    });
  });
});
