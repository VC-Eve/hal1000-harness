import { describe, expect, it } from "vitest";
import { visionCaptionSlot, visionFacesSlot, type LastLook } from "../../../shared/src/prompts.js";
import { largestCount, parseTemplate, slotSpec } from "../../../shared/src/templates.js";
import { renderChatContext, type ChatContextInputs } from "../../src/templates/chatContext.js";

// Counts on the two sight readings, and the parse that has to happen before
// anything is fetched.

const NOW = new Date(2026, 7, 9, 18, 22, 4);
const THRESHOLDS = { recognition: 0.35, statement: 0.6 };
const stamp = (minutesAgo: number): string => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();

const look = (caption: string, minutesAgo: number): LastLook => ({ caption, at: stamp(minutesAgo) });

const CAPTIONS: LastLook[] = [
  look("A person sits at a desk, facing the screen.", 0.2),
  look("A person stands beside the desk.", 3),
  look("An empty desk in a dim room.", 9),
];

const face = (name: string, confidence: number, since: number) => ({
  match: { name, confidence },
  since: stamp(since),
  weight: 0.9,
});

function inputs(over: Partial<ChatContextInputs> = {}): ChatContextInputs {
  return {
    presence: {
      watching: true,
      present: [face("Creator", 0.8, 10), face("Ada", 0.74, 6), face("Bram", 0.72, 4)],
    },
    lastLook: CAPTIONS[0]!,
    captions: CAPTIONS,
    people: [],
    thresholds: THRESHOLDS,
    entries: [],
    watchedSessionId: null,
    preamble: "",
    visionBudget: 100_000,
    sessionBudget: 0,
    monitorBudget: 0,
    now: NOW,
    ...over,
  };
}

const render = (template: string, over: Partial<ChatContextInputs> = {}) =>
  renderChatContext(template, inputs(over)).text;

describe("{vision_caption[N]}", () => {
  it("renders both when three are asked for and two are on record (AE5)", () => {
    const out = render("{vision_caption[3]}", { captions: CAPTIONS.slice(0, 2) });
    expect(out).toContain("A person sits at a desk");
    expect(out).toContain("A person stands beside the desk");
    // Nothing invented for the third.
    expect(out.split("\n").filter((l) => l.trim().length > 0)).toHaveLength(2);
  });

  it("renders one when uncounted, exactly as it always did", () => {
    const out = render("{vision_caption}");
    expect(out).toContain("A person sits at a desk");
    expect(out).not.toContain("A person stands beside the desk");
  });

  it("renders nothing with nothing on record", () => {
    expect(render("{vision_caption[3]}", { captions: [], lastLook: null })).toBe("");
  });

  it("keeps each line quoted and dated", () => {
    // Quoted and dated rather than asserted, because the captioner invents
    // object counts. A count does not change what a caption is.
    const out = render("{vision_caption[2]}");
    expect(out.split("\n").filter((l) => l.trim())).toHaveLength(2);
    for (const line of out.split("\n").filter((l) => l.trim())) {
      expect(line).toMatch(/\d{2}:\d{2}:\d{2}/);
      expect(line).toContain('"');
    }
  });

  it("drops a whole line rather than cutting one in half", () => {
    // A caption cut mid-sentence reads as a confident half-observation, which
    // is the failure the guardrail cannot catch.
    const one = render("{vision_caption}").length;
    const out = render("{vision_caption[3]}", { visionBudget: one + 5 });
    expect(out.split("\n").filter((l) => l.trim())).toHaveLength(1);
    expect(out).toContain("facing the screen.");
  });

  it("renders the list newest first", () => {
    const out = render("{vision_caption[3]}");
    expect(out.indexOf("A person sits at a desk")).toBeLessThan(out.indexOf("An empty desk"));
  });
});

describe("{vision_faces[N]}", () => {
  it("lists only as many as asked for", () => {
    const out = render("{vision_faces[2]}");
    expect(out).toContain("Creator");
    expect(out).toContain("Ada");
    expect(out).not.toContain("Bram");
  });

  it("lists everybody when uncounted", () => {
    const out = render("{vision_faces}");
    expect(out).toContain("Bram");
  });
});

describe("the vocabulary agrees that both take a count", () => {
  // A slot that renders a count but is not declared to take one is refused by
  // the validator on apply — the editor and the renderer disagreeing is exactly
  // what keeping the language in shared/ exists to prevent.
  for (const name of ["vision_caption", "vision_faces"]) {
    it(`${name} declares it`, () => {
      expect(slotSpec("chat-context", name)?.count, name).toBe(true);
      expect(slotSpec("conversation-system", name)?.count, name).toBe(true);
    });
  }
});

describe("what has to be known before anything is fetched", () => {
  it("finds the largest count a template asks for", () => {
    const nodes = parseTemplate("{vision_caption} {vision_caption[5]} {vision_caption[2]}").nodes;
    expect(largestCount(nodes, "vision_caption")).toBe(5);
  });

  it("counts an uncounted mention as one", () => {
    expect(largestCount(parseTemplate("{vision_caption}").nodes, "vision_caption")).toBe(1);
  });

  it("finds one inside a block", () => {
    const nodes = parseTemplate("{#vision_caption}Lately:\n{vision_caption[4]}{/}").nodes;
    expect(largestCount(nodes, "vision_caption")).toBe(4);
  });

  it("is zero when the template never names it", () => {
    expect(largestCount(parseTemplate("Be terse.").nodes, "vision_caption")).toBe(0);
  });
});

describe("the slot renderers directly", () => {
  // Tested on the helper as well as through the render: a budget is exactly the
  // kind of value that acquires new callers, and a guard that only holds on the
  // path through the template is half a guard.
  it("takes one look or a list", () => {
    expect(visionCaptionSlot(CAPTIONS[0]!, 100_000, NOW)).toContain("A person sits");
    expect(visionCaptionSlot(CAPTIONS, 100_000, NOW, undefined, 2).split("\n")).toHaveLength(2);
  });

  it("renders nothing for a zero budget rather than a partial line", () => {
    expect(visionCaptionSlot(CAPTIONS, 0, NOW, undefined, 3)).toBe("");
  });

  it("bounds the face list without changing what is said about anyone", () => {
    const all = visionFacesSlot({ watching: true, present: [face("Creator", 0.8, 10), face("Ada", 0.74, 6)] }, THRESHOLDS, 100_000, NOW);
    const one = visionFacesSlot({ watching: true, present: [face("Creator", 0.8, 10), face("Ada", 0.74, 6)] }, THRESHOLDS, 100_000, NOW, undefined, 1);
    expect(all.text.split("\n")).toHaveLength(2);
    expect(one.text.split("\n")).toHaveLength(1);
    expect(all.text.startsWith(one.text)).toBe(true);
  });
});
