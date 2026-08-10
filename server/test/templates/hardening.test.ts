import { describe, expect, it } from "vitest";
import {
  sessionRemarksSlot,
  visionCaptionSlot,
  visionFacesSlot,
  visionNobodySlot,
  visionOffSlot,
  visionProfilesSlot,
} from "../../../shared/src/prompts.js";
import { parseTemplate, renderTemplateText, validateTemplate, type SlotRequest, type SlotResult } from "../../../shared/src/templates.js";

// The cases a code review found unguarded. Each one is here because it was
// reachable and nothing covered it, not because it is hypothetical.

const NOW = new Date(2026, 7, 9, 18, 22, 4);
const THRESHOLDS = { recognition: 0.35, statement: 0.6 };
const stamp = (m: number): string => new Date(NOW.getTime() - m * 60_000).toISOString();

describe("a budget that is not a number", () => {
  // The boundary guard in `contextBudgetChars` keeps NaN out today, so these
  // are defence in depth rather than a live bug. They exist because a guard at
  // one boundary is a single point of failure, and the next caller may not
  // route through it — which is exactly how
  // docs/solutions/a-threshold-guard-written-as-a-negation-fails-open-on-nan.md
  // says this class of defect arrives.
  const entries = [{ text: "A remark.", at: stamp(5), sessionId: "s1", sessionLabel: "Session" }];
  const presence = {
    watching: true,
    present: [{ match: { name: "Ada", confidence: 0.8 }, since: stamp(2), weight: 0.9 }],
  };
  const lastLook = { caption: "A room.", at: stamp(1) };
  const people = [{ name: "Ada", profile: "Visits.", isOperator: true }];

  for (const budget of [Number.NaN, -1, Number.NEGATIVE_INFINITY]) {
    it(`renders nothing at a budget of ${String(budget)}`, () => {
      expect(sessionRemarksSlot(entries, "s1", budget, NOW)).toBe("");
      expect(visionOffSlot({ watching: false }, budget)).toBe("");
      expect(visionNobodySlot({ watching: true, present: [] }, budget)).toBe("");
      expect(visionFacesSlot(presence, THRESHOLDS, budget, NOW).text).toBe("");
      expect(visionCaptionSlot(lastLook, budget, NOW)).toBe("");
      expect(visionProfilesSlot(presence, people, THRESHOLDS, budget).text).toBe("");
    });
  }
});

describe("a template that tries to exhaust the renderer", () => {
  it("stops nesting at the depth limit instead of overflowing the stack", () => {
    const deep = "{#reason_cycle}".repeat(5000) + "x" + "{/}".repeat(5000);
    expect(() => parseTemplate(deep)).not.toThrow();
    const errors = validateTemplate(deep, "monitor-user");
    expect(errors.some((e) => e.kind === "too-deep")).toBe(true);
  });

  it("renders a pathologically nested template rather than throwing", () => {
    const deep = "{#reason_cycle}".repeat(5000) + "x" + "{/}".repeat(5000);
    const resolve = (req: SlotRequest): SlotResult => ({ text: req.name === "reason_cycle" ? "set" : "" });
    expect(() => renderTemplateText(deep, { resolve, role: "monitor-user" })).not.toThrow();
  });

  it("survives a very wide unclosed block", () => {
    const wide = "{#reason_cycle}" + "line\n".repeat(50_000);
    expect(() => parseTemplate(wide)).not.toThrow();
  });

  it("does not scan quadratically over a long template", () => {
    const long = "{clock} ".repeat(40_000);
    const started = Date.now();
    parseTemplate(long);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("line endings", () => {
  it("treats a CRLF template the same as an LF one", () => {
    const resolve = (req: SlotRequest): SlotResult => ({ text: req.name === "monitor_lines" ? "a line" : "" });
    const lf = renderTemplateText("{#reason_cycle}gone{/}\n{monitor_lines}", { resolve, role: "monitor-user" });
    const crlf = renderTemplateText("{#reason_cycle}gone{/}\r\n{monitor_lines}", { resolve, role: "monitor-user" });
    expect(crlf.text).toBe(lf.text);
  });

  it("reports an error at an offset that matches the normalised text", () => {
    const errors = validateTemplate("a\r\nb\r\n{nope}", "monitor-user");
    // Two lines of two characters each once CRLF is collapsed.
    expect(errors[0]?.at).toBe(4);
  });
});

describe("the same slot at two counts", () => {
  it("keeps each block's verdict its own", () => {
    // Keyed by name alone, the second resolution overwrote the first's verdict
    // and a block could drop while its own slot still had something to say.
    const resolve = (req: SlotRequest): SlotResult => ({
      text: req.name !== "session_remarks" ? "" : req.count === 1 ? "one remark" : "",
    });
    const out = renderTemplateText(
      "{#session_remarks}A: {session_remarks[9]}{/}\n{#session_remarks}B: {session_remarks[1]}{/}",
      { resolve, role: "chat-context" },
    );
    expect(out.text).toBe("B: one remark");
  });
});

describe("nested blocks", () => {
  it("drops only the inner block when only its slot is empty", () => {
    const resolve = (req: SlotRequest): SlotResult => ({
      text: req.name === "session_remarks" ? "remarks" : "",
    });
    const out = renderTemplateText("{#session_remarks}outer {session_remarks}{#vision_faces}inner{/}{/}", {
      resolve,
      role: "chat-context",
    });
    expect(out.text).toBe("outer remarks");
  });

  it("leaves the outer block's accounting untouched when the inner one rolls back", () => {
    const seen: number[] = [];
    const resolve = (req: SlotRequest): SlotResult => {
      if (req.name === "vision_faces") return { text: "" };
      if (req.name === "vision_caption") {
        seen.push(req.budgetLeft);
        return { text: "caption" };
      }
      return { text: "" };
    };
    renderTemplateText("{#vision_caption}{#vision_faces}wasted padding{vision_faces}{/}{vision_caption}{/}", {
      resolve,
      role: "chat-context",
      budgets: { vision: 100 },
    });
    // The inner block charged 14 characters of literal padding and then
    // dropped; the caption must be asked with the full budget back.
    expect(seen).toEqual([100]);
  });
});

describe("slot values are never re-parsed as template syntax", () => {
  it("emits a value containing braces verbatim", () => {
    const hostile = "{#reason_full}evil{/} {clock} }} {{";
    const resolve = (req: SlotRequest): SlotResult => ({
      text: req.name === "monitor_lines" ? hostile : req.name === "reason_cycle" ? "set" : "",
    });
    const out = renderTemplateText("{#reason_cycle}Report:{/}\n{monitor_lines}", { resolve, role: "monitor-user" });
    expect(out.text).toBe(`Report:\n${hostile}`);
  });
});
