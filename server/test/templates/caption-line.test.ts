import { describe, expect, it } from "vitest";
import { formatIdentity, visionCaptionLine } from "../../../shared/src/prompts.js";

// The line that carries identity into the Vision summariser.
//
// It had no editor and no test until a user asked why `{vision_faces}` could
// not be used in the Vision prompt. The honest answer — that identity was
// already reaching that role, per frame, through a bracket assembled in code —
// is what this file pins.

describe("the Vision caption line", () => {
  it("prefixes one recognised person", () => {
    expect(visionCaptionLine(["Dave 71%"], "A person at a desk.")).toBe("[Dave 71%] A person at a desk.");
  });

  it("joins two people with a word rather than a comma", () => {
    // A comma-separated list read as one compound name to a small vision model.
    expect(visionCaptionLine(["Dave 71%", "Ada 84%"], "Two people talking.")).toBe(
      "[Dave 71% and Ada 84%] Two people talking.",
    );
  });

  it("renders the caption alone when nobody was placed", () => {
    // Not an empty bracket. This is also what withheld consent looks like: the
    // scene is still described, only who was in it is withheld.
    expect(visionCaptionLine([], "An empty desk.")).toBe("An empty desk.");
  });

  it("carries the band through untouched, hedge and all", () => {
    const hedged = formatIdentity("Dave", 0.55, "hedged");
    const stated = formatIdentity("Ada", 0.84, "stated");
    expect(visionCaptionLine([hedged], "Someone at the door.")).toBe(
      "[someone who looks like Dave 55%] Someone at the door.",
    );
    expect(visionCaptionLine([hedged, stated], "Two at the door.")).toBe(
      "[someone who looks like Dave 55% and Ada 84%] Two at the door.",
    );
  });

  it("reproduces the format the vision service used to build inline", () => {
    // Byte identity with the template literal this replaced. A diff here means
    // every install would start hearing something different.
    const literal = (names: string[], caption: string) =>
      `${names.length ? `[${names.join(" and ")}] ` : ""}${caption}`;
    const cases: [string[], string][] = [
      [[], "nobody"],
      [["Dave 71%"], "one"],
      [["Dave 71%", "Ada 84%"], "two"],
      [["someone who looks like Dave 55%"], "hedged"],
      [["A", "B", "C"], "three"],
    ];
    for (const [names, caption] of cases) {
      expect(visionCaptionLine(names, caption), caption).toBe(literal(names, caption));
    }
  });
});

describe("editing the caption line", () => {
  it("an edited prefix reaches the summariser", () => {
    expect(
      visionCaptionLine(["Dave 71%"], "A person at a desk.", { "sight.caption_line": "{caption} (in frame: {names})" }),
    ).toBe("A person at a desk. (in frame: Dave 71%)");
  });

  it("an edited joiner reaches every name", () => {
    expect(visionCaptionLine(["Dave", "Ada", "Bram"], "Three.", { "sight.identity_join": ", " })).toBe(
      "[Dave, Ada, Bram] Three.",
    );
  });

  it("an edited line still renders nothing extra when nobody was placed", () => {
    // The no-names case never reaches the phrase, so an edit cannot
    // accidentally reintroduce a prefix for an empty room.
    expect(visionCaptionLine([], "An empty desk.", { "sight.caption_line": "ALWAYS [{names}] {caption}" })).toBe(
      "An empty desk.",
    );
  });

  it("the joiner is one phrase, shared with the observation's own record", () => {
    // Two copies of a separator is how they drift, and the record and the line
    // disagreeing about who was in the room is exactly the drift that matters.
    expect(visionCaptionLine(["A", "B"], "x", { "sight.identity_join": " / " })).toBe("[A / B] x");
  });
});
