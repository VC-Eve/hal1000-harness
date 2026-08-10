import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTEXT_PREAMBLE,
} from "../../../shared/src/prompts.js";
import { sessionContextSection, visionContextSection } from "../support/legacyContextSections.js";
import { renderChatContext, type ChatContextInputs } from "../../src/templates/chatContext.js";

// The sweep the parity suite does not do: BOTH sources funded at once.
//
// `context-template-parity.test.ts` varies one budget while pinning the other
// at zero, so every cross-source interaction in the ledger is structurally
// invisible to it. This file exists to look exactly there.

const NOW = new Date(2026, 7, 9, 18, 22, 4);
const THRESHOLDS = { recognition: 0.35, statement: 0.6 };

const stamp = (minutesAgo: number): string => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();

const remark = (n: number, minutesAgo: number) => ({
  text: `Remark number ${n} about the work.`,
  at: stamp(minutesAgo),
  sessionId: "s1",
  sessionLabel: "Claude Code [a408c0a1]",
});

const face = (name: string, confidence: number, since: number, weight: number) => ({
  match: { name, confidence },
  since: stamp(since),
  weight,
});

const CAPTION = { caption: "A person sits at a desk, facing the screen.", at: stamp(0.2) };

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
    presence: {
      watching: true,
      present: [
        face("Creator", 0.8, 10, 0.9),
        face("Ada", 0.74, 6, 0.8),
        face("Bram", 0.72, 4, 0.5),
      ],
    },
    lastLook: CAPTION,
    people: [],
    thresholds: THRESHOLDS,
    entries: [remark(1, 30), remark(2, 20), remark(3, 5)],
    watchedSessionId: "s1",
    preamble: DEFAULT_CONTEXT_PREAMBLE,
    visionBudget: 1200,
    sessionBudget: 1200,
    now: NOW,
    ...over,
  };
}

describe("both sources funded at once", () => {
  it("agrees with the assembly across a joint sweep", () => {
    const mismatches: number[] = [];
    for (let budget = 120; budget <= 1400; budget += 1) {
      const given = inputs({ visionBudget: budget, sessionBudget: budget });
      if (renderChatContext(null, given).text !== legacy(given)) mismatches.push(budget);
    }
    expect(mismatches, `disagrees at ${mismatches.length} budgets, e.g. ${mismatches.slice(0, 8).join(", ")}`).toEqual(
      [],
    );
  });

  it("charges the sight heading's clock to the sight budget even when the session heading already used one", () => {
    // The clock appears in both headings. Each section paid for its own copy in
    // the assembly; if the ledger bills it once globally, the second section is
    // silently richer by the width of a clock.
    const withSession = inputs({ visionBudget: 400, sessionBudget: 1200 });
    const withoutSession = inputs({ visionBudget: 400, sessionBudget: 0 });
    const sightOf = (text: string): string => text.slice(text.indexOf("Who I can see"));
    expect(sightOf(renderChatContext(null, withSession).text)).toBe(
      sightOf(renderChatContext(null, withoutSession).text),
    );
  });
});
