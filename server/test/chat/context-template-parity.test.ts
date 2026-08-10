import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTEXT_PREAMBLE,
  sessionContextSection,
  visionContextSection,
} from "../../../shared/src/prompts.js";
import { renderChatContext, type ChatContextInputs } from "../../src/templates/chatContext.js";

// R16 in one assertion, repeated across the matrix.
//
// The left-hand side is the hand-assembled implementation; the right-hand side
// is the shipped default template rendered through the slot resolvers. They
// must agree exactly, because anything else means an install that upgrades
// starts hearing something it did not hear before.
//
// `sessionContextSection` and `visionContextSection` survive for exactly this
// purpose. Nothing in the server calls them any more, and they go when phase
// two lands.

const NOW = new Date(2026, 7, 9, 18, 22, 4);
const THRESHOLDS = { recognition: 0.35, statement: 0.6 };
const BIG = 4000;

const stamp = (minutesAgo: number): string => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();

const remark = (n: number, minutesAgo: number, sessionId: string | null = "s1") => ({
  text: `Remark number ${n} about the work.`,
  at: stamp(minutesAgo),
  sessionId,
  sessionLabel: "Claude Code [a408c0a1]",
});

const face = (name: string | null, confidence: number, opts: { since?: number; weight?: number } = {}) => ({
  match: name === null ? null : { name, confidence },
  ...(opts.since !== undefined ? { since: stamp(opts.since) } : {}),
  ...(opts.weight !== undefined ? { weight: opts.weight } : {}),
});

const CAPTION = { caption: "A person sits at a desk, facing the screen.", at: stamp(0.2) };

/** What the hand-assembled path produced, including the join and the preamble. */
function legacy(inputs: ChatContextInputs): string {
  const parts: string[] = [];
  if (inputs.sessionBudget > 0) {
    const s = sessionContextSection(inputs.entries, inputs.watchedSessionId, inputs.sessionBudget, NOW);
    if (s) parts.push(s);
  }
  if (inputs.visionBudget > 0) {
    const v = visionContextSection(
      inputs.presence,
      inputs.lastLook,
      inputs.people,
      inputs.thresholds,
      inputs.visionBudget,
      NOW,
    );
    if (v) parts.push(v);
  }
  if (parts.length === 0) return "";
  const lead = inputs.preamble.trim().length > 0 ? [inputs.preamble] : [];
  return [...lead, ...parts].join("\n\n");
}

function inputs(over: Partial<ChatContextInputs> = {}): ChatContextInputs {
  return {
    presence: { watching: false, present: [] },
    lastLook: null,
    people: [],
    thresholds: THRESHOLDS,
    entries: [],
    watchedSessionId: null,
    preamble: DEFAULT_CONTEXT_PREAMBLE,
    visionBudget: BIG,
    sessionBudget: BIG,
    now: NOW,
    ...over,
  };
}

const CASES: [string, ChatContextInputs][] = [
  ["nothing at all", inputs()],
  ["camera off, no session", inputs({ presence: { watching: false, present: [] } })],
  [
    "session only",
    inputs({ entries: [remark(1, 30), remark(2, 5)], watchedSessionId: "s1" }),
  ],
  [
    "sight only, one stated face",
    inputs({
      presence: { watching: true, present: [face("Creator", 0.74, { since: 6, weight: 0.9 })] },
      lastLook: CAPTION,
    }),
  ],
  [
    "both sources",
    inputs({
      entries: [remark(1, 30), remark(2, 5)],
      watchedSessionId: "s1",
      presence: { watching: true, present: [face("Creator", 0.74, { since: 6, weight: 0.9 })] },
      lastLook: CAPTION,
    }),
  ],
  [
    "watching, nobody placed",
    inputs({ presence: { watching: true, present: [] }, lastLook: CAPTION }),
  ],
  [
    "watching, nobody placed, no caption",
    inputs({ presence: { watching: true, present: [] } }),
  ],
  [
    "camera off with a caption still on file",
    inputs({ presence: { watching: false, present: [] }, lastLook: CAPTION }),
  ],
  [
    "hedged face, no profile unlocked",
    inputs({
      presence: { watching: true, present: [face("Ada", 0.45, { since: 2 })] },
      people: [{ name: "Ada", profile: "Visits sometimes." }],
      lastLook: CAPTION,
    }),
  ],
  [
    "stated face unlocks a profile, operator standing",
    inputs({
      presence: { watching: true, present: [face("Creator", 0.8, { since: 10, weight: 0.8 })] },
      people: [
        { name: "Creator", profile: "Builds HAL. Prefers blunt answers.", isOperator: true },
        { name: "Ada", profile: "Visits sometimes." },
      ],
      lastLook: CAPTION,
    }),
  ],
  [
    "unrecognised face",
    inputs({ presence: { watching: true, present: [face(null, 0, { since: 1 })] }, lastLook: CAPTION }),
  ],
  [
    "two faces",
    inputs({
      presence: {
        watching: true,
        present: [face("Creator", 0.8, { since: 10, weight: 0.8 }), face(null, 0, { since: 1, weight: 0.1 })],
      },
      lastLook: CAPTION,
    }),
  ],
  [
    "session truncated with its notice",
    inputs({
      entries: Array.from({ length: 40 }, (_, i) => remark(i, 40 - i)),
      watchedSessionId: "s1",
      sessionBudget: 400,
    }),
  ],
  [
    "session budget too small for one remark",
    inputs({ entries: [remark(1, 5), remark(2, 4)], watchedSessionId: "s1", sessionBudget: 90 }),
  ],
  [
    "vision off, session on",
    inputs({ entries: [remark(1, 5)], watchedSessionId: "s1", visionBudget: 0 }),
  ],
  [
    "session off, vision on",
    inputs({
      presence: { watching: true, present: [face("Creator", 0.74, { since: 6 })] },
      lastLook: CAPTION,
      sessionBudget: 0,
      entries: [remark(1, 5)],
      watchedSessionId: "s1",
    }),
  ],
  [
    "blank preamble",
    inputs({ entries: [remark(1, 5)], watchedSessionId: "s1", preamble: "" }),
  ],
  [
    "a remark from another day",
    inputs({ entries: [remark(1, 60 * 30), remark(2, 5)], watchedSessionId: "s1" }),
  ],
  [
    "entries for another session only",
    inputs({ entries: [remark(1, 5, "other")], watchedSessionId: "s1" }),
  ],
];

describe("chat context — template renders what the assembly did", () => {
  for (const [name, given] of CASES) {
    it(name, () => {
      expect(renderChatContext(null, given).text).toBe(legacy(given));
    });
  }

  it("agrees across a sweep of session budgets", () => {
    const entries = Array.from({ length: 25 }, (_, i) => remark(i, 25 - i));
    for (let budget = 0; budget <= 900; budget += 7) {
      const given = inputs({ entries, watchedSessionId: "s1", sessionBudget: budget, visionBudget: 0 });
      expect(renderChatContext(null, given).text, `session budget ${budget}`).toBe(legacy(given));
    }
  });

  it("agrees across a sweep of sight budgets", () => {
    const presence = {
      watching: true,
      present: Array.from({ length: 8 }, (_, i) => face(`Person${i}`, 0.8, { since: i + 1, weight: 0.9 })),
    };
    // From a floor of 120 characters. Below that the two differ in one named
    // way, covered by the test beneath this one; and no Context Level can
    // produce a budget that small — the smallest share of the smallest window
    // this project supports is around 400 characters.
    for (let budget = 120; budget <= 900; budget += 7) {
      const given = inputs({ presence, lastLook: CAPTION, visionBudget: budget, sessionBudget: 0 });
      expect(renderChatContext(null, given).text, `sight budget ${budget}`).toBe(legacy(given));
    }
  });
});

describe("chat context — the one deliberate difference", () => {
  // The heading is 45 characters. Given less than that, the old assembly failed
  // to add the heading, dropped every face for the same reason, and then found
  // room for the "8 others in view" notice — emitting a parenthetical about a
  // list it had never introduced. The heading is literal text inside a block
  // now, so it lives and dies with the block, and the section is simply absent.
  //
  // This is the only case where the template does not reproduce the assembly,
  // it is unreachable through any Context Level, and the new behaviour is the
  // better of the two.
  const presence = {
    watching: true,
    present: Array.from({ length: 8 }, (_, i) => face(`Person${i}`, 0.8, { since: i + 1, weight: 0.9 })),
  };
  const given = inputs({ presence, lastLook: CAPTION, visionBudget: 42, sessionBudget: 0 });

  it("the assembly emitted a notice with no heading", () => {
    expect(legacy(given)).toContain("others in view, not listed here.");
    expect(legacy(given)).not.toContain("Who I can see");
  });

  it("the template emits nothing at all", () => {
    expect(renderChatContext(null, given).text).toBe("");
  });
});

describe("chat context — redaction", () => {
  it("names the profile text that was rendered", () => {
    const given = inputs({
      presence: { watching: true, present: [face("Creator", 0.8, { since: 10 })] },
      people: [{ name: "Creator", profile: "Builds HAL. Prefers blunt answers.", isOperator: true }],
      lastLook: CAPTION,
    });
    expect(renderChatContext(null, given).redact).toEqual(["Builds HAL. Prefers blunt answers."]);
  });

  it("names nothing when the band withheld the profile", () => {
    const given = inputs({
      presence: { watching: true, present: [face("Ada", 0.45, { since: 2 })] },
      people: [{ name: "Ada", profile: "Visits sometimes." }],
      lastLook: CAPTION,
    });
    expect(renderChatContext(null, given).redact).toEqual([]);
  });

  it("still names it when the user moved the profile slot to the top", () => {
    const template =
      "{#vision_profiles}{vision_profiles}{/}\n\n{#vision_faces}Who I see: {vision_faces}{/}";
    const given = inputs({
      presence: { watching: true, present: [face("Creator", 0.8, { since: 10 })] },
      people: [{ name: "Creator", profile: "Builds HAL. Prefers blunt answers.", isOperator: true }],
    });
    const out = renderChatContext(template, given);
    expect(out.redact).toEqual(["Builds HAL. Prefers blunt answers."]);
    expect(out.text.startsWith("You know Creator")).toBe(true);
  });
});

describe("chat context — placement is the template's", () => {
  it("renders sight before session when the template says so", () => {
    const template =
      "{#vision_faces}Who I can see: {vision_faces}{/}\n\n{#session_remarks}Lately: {session_remarks}{/}";
    const given = inputs({
      entries: [remark(1, 5)],
      watchedSessionId: "s1",
      presence: { watching: true, present: [face("Creator", 0.74, { since: 6 })] },
    });
    const out = renderChatContext(template, given).text;
    expect(out.indexOf("Who I can see")).toBeLessThan(out.indexOf("Lately:"));
  });

  it("drops a heading whose slot came back empty", () => {
    const template = "{#vision_faces}Who I can see: {vision_faces}{/}";
    const given = inputs({ presence: { watching: false, present: [] } });
    expect(renderChatContext(template, given).text).toBe("");
  });

  it("reports a slot the vocabulary no longer has", () => {
    const given = inputs({ entries: [remark(1, 5)], watchedSessionId: "s1" });
    const out = renderChatContext("{session_remarks} {gone_away}", given);
    expect(out.degraded).toEqual(["gone_away"]);
    expect(out.text).toContain("Remark number 1");
  });
});
