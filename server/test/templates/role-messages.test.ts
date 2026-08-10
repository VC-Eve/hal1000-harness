import { describe, expect, it } from "vitest";
import {
  DEFAULT_MONITOR_PROMPT,
  DEFAULT_NARRATION_PROMPT,
  DEFAULT_VISION_CAPTION_PROMPT,
  DEFAULT_VISION_PROMPT,
  VISION_SILENCE_TOKEN,
  visionSensitivityInstruction,
} from "../../../shared/src/prompts.js";
import { renderRoleMessage, systemMessages } from "../../src/templates/roleMessages.js";

// The send description every render now carries. None of the templates below
// name a universal slot, so these assertions are unchanged by it — which is
// the point: adding the tier must not move what an unedited install hears.
const SEND = { model: "qwen2.5:14b", backend: "http://127.0.0.1:11434", now: new Date(2026, 7, 9, 18, 22, 4) };
const render = (
  role: Parameters<typeof renderRoleMessage>[0],
  stored: Parameters<typeof renderRoleMessage>[1],
  values: Parameters<typeof renderRoleMessage>[2],
) => renderRoleMessage(role, stored, values, SEND);

// R16 for the four observation roles.
//
// The right-hand side of each assertion is the string the call site built by
// hand before templates existed, written out literally. If a shipped default
// template drifts, these fail — which is the point: an install that edits
// nothing must hear exactly what it heard before.

const LINES = "[user] fix the parser\n[assistant] looking at it now\n[tool-result] failed: no such file";

describe("narration", () => {
  it("sends the prompt as the system message", () => {
    const system = render("narration-system", null, { narration_prompt: DEFAULT_NARRATION_PROMPT }).text;
    expect(system).toBe(DEFAULT_NARRATION_PROMPT);
  });

  it("omits the system message when the prompt is blank", () => {
    const system = render("narration-system", null, { narration_prompt: "" }).text;
    expect(system).toBe("");
    expect(systemMessages(system)).toEqual([]);
  });

  it("frames the log lines exactly as the call site did", () => {
    const user = render("narration-user", null, { session_lines: LINES }).text;
    expect(user).toBe(`Session activity:\n${LINES}\n\nNarrate this activity now.`);
  });
});

describe("monitors", () => {
  it("sends the Monitor prompt as the system message", () => {
    const system = render("monitor-system", null, { monitor_prompt: DEFAULT_MONITOR_PROMPT }).text;
    expect(system).toBe(DEFAULT_MONITOR_PROMPT);
  });

  const cases: [string, "interrupt" | "full" | "cycle", string][] = [
    ["interrupt", "interrupt", "Something in syslog looks wrong. Report it now."],
    ["full", "full", "Recent activity in syslog. Narrate it."],
    ["cycle", "cycle", "Activity in syslog over the last period. Summarise it."],
  ];

  for (const [name, reason, framing] of cases) {
    it(`frames a ${name} batch exactly as the call site did`, () => {
      const user = render("monitor-user", null, {
        monitor_label: "syslog",
        monitor_lines: "kernel: oops",
        reason_interrupt: reason === "interrupt" ? "set" : "",
        reason_full: reason === "full" ? "set" : "",
        reason_cycle: reason === "cycle" ? "set" : "",
      }).text;
      expect(user).toBe(`${framing}\n\nkernel: oops`);
    });
  }

  it("emits no marker word for the branch that fired", () => {
    const user = render("monitor-user", null, {
      monitor_label: "syslog",
      monitor_lines: "kernel: oops",
      reason_cycle: "set",
    }).text;
    expect(user).not.toContain("set");
  });
});

describe("vision", () => {
  const CAPTIONS = "[Creator 74%] A person at a desk.\nA person at a desk, typing.";
  const KNOWN = "You know Creator, whose machine this is: Builds HAL.";

  for (const sensitivity of ["always", "high", "medium", "low"] as const) {
    it(`frames a ${sensitivity} cycle exactly as the call site did`, () => {
      const user = render("vision-user", null, {
        vision_caption_lines: CAPTIONS,
        silence_token: VISION_SILENCE_TOKEN,
        silence_expected: sensitivity === "always" ? "" : "set",
        sensitivity_always: sensitivity === "always" ? "set" : "",
        sensitivity_high: sensitivity === "high" ? "set" : "",
        sensitivity_medium: sensitivity === "medium" ? "set" : "",
        sensitivity_low: sensitivity === "low" ? "set" : "",
      }).text;
      expect(user).toBe(`${visionSensitivityInstruction(sensitivity)}\n\nFrames from the last period:\n${CAPTIONS}`);
    });
  }

  it("joins the prompt and the people section the way the call site did", () => {
    const system = render("vision-system", null, {
      vision_prompt: DEFAULT_VISION_PROMPT,
      known_people: KNOWN,
    }).text;
    expect(system).toBe(`${DEFAULT_VISION_PROMPT}\n\n${KNOWN}`);
  });

  it("keeps the people section when the prompt is blank", () => {
    // Blanking the prompt says "nothing of your own about how to narrate". It
    // does not say "forget who these people are", and the message must survive.
    const system = render("vision-system", null, { vision_prompt: "", known_people: KNOWN }).text;
    expect(system).toBe(KNOWN);
    expect(systemMessages(system)).toHaveLength(1);
  });

  it("sends the prompt alone when nobody has a profile", () => {
    const system = render("vision-system", null, {
      vision_prompt: DEFAULT_VISION_PROMPT,
      known_people: "",
    }).text;
    expect(system).toBe(DEFAULT_VISION_PROMPT);
  });

  it("sends no system message when both are absent", () => {
    const system = render("vision-system", null, { vision_prompt: "", known_people: "" }).text;
    expect(systemMessages(system)).toEqual([]);
  });
});

describe("captioner", () => {
  it("asks the shipped question verbatim", () => {
    const question = render("captioner-user", null, {
      caption_prompt: DEFAULT_VISION_CAPTION_PROMPT,
    }).text;
    expect(question).toBe(DEFAULT_VISION_CAPTION_PROMPT);
  });
});

describe("editing a template", () => {
  it("lets the wording around the log lines change without touching the prompt", () => {
    const user = render("narration-user", "Here is what just happened:\n{session_lines}", {
      session_lines: LINES,
    }).text;
    expect(user).toBe(`Here is what just happened:\n${LINES}`);
  });

  it("lets a Monitor drop two branches and keep one", () => {
    const user = render("monitor-user", "{#reason_cycle}Summarise {monitor_label}.{/}\n\n{monitor_lines}", {
      monitor_label: "syslog",
      monitor_lines: "kernel: oops",
      reason_cycle: "set",
    }).text;
    expect(user).toBe("Summarise syslog.\n\nkernel: oops");
  });

  it("reports a slot the vocabulary no longer has instead of failing the send", () => {
    const out = render("narration-user", "Lines:\n{session_lines}\n{gone_away}", {
      session_lines: LINES,
    });
    expect(out.degraded).toEqual(["gone_away"]);
    expect(out.text).toContain(LINES);
  });
});
