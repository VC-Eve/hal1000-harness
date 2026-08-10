import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTEXT_PREAMBLE,
  DEFAULT_MONITOR_PROMPT,
  DEFAULT_NARRATION_PROMPT,
  DEFAULT_VISION_CAPTION_PROMPT,
  DEFAULT_VISION_PROMPT,
  VISION_SILENCE_TOKEN,
  identityBand,
  resolveTemplate,
  visionSensitivityInstruction,
  type RecentSighting,
} from "../../../shared/src/prompts.js";
import { renderTemplateText, type TemplateRole } from "../../../shared/src/templates.js";
import { renderChatContext, type ChatContextInputs } from "../../src/templates/chatContext.js";
import { composeSystemMessage } from "../../src/templates/conversationSystem.js";

// What every message renders TODAY, recorded from the running code.
//
// This is the oracle the prompt-template standardisation work is checked
// against — see docs/plans/2026-08-10-001-feat-prompt-template-standardization-plan.md,
// unit U1. It is recorded before any of that work begins, deliberately: a
// parallel reimplementation is not an oracle, because if both paths end up
// sharing the code being changed the test agrees with itself. Recorded strings
// cannot drift in sympathy with a mistake, because they are not code.
//
// DO NOT RE-RECORD THESE SNAPSHOTS TO MAKE A CHANGE PASS. A diff here means
// every existing install would start hearing something different. If a
// divergence is genuine, name it in its own test and write it down in
// docs/residual-review-findings/ — do not widen this file until it is quiet.
//
// Distinct from server/test/chat/context-golden.test.ts, which snapshots the
// PRE-TEMPLATE hand assembly. That file is an oracle for the era before the
// template engine; this one is an oracle for the era after it. Keeping them
// separate is what makes a diff say which era changed.
//
// One gap is recorded rather than papered over: `renderChatContext` returns
// text, redaction and degraded, but not `emitted` or `dropped` — those live on
// the engine's result and the entry point does not forward them. Recording them
// would mean changing production code, and this unit records before it changes
// anything. The role renders below capture all five because they go through the
// engine directly with the same arguments the entry point passes.

const NOW = new Date(2026, 7, 9, 18, 22, 4);
const THRESHOLDS = { recognition: 0.35, statement: 0.6 };

const stamp = (minutesAgo: number): string => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();

const remark = (n: number, minutesAgo: number) => ({
  text: `Remark number ${n} about the work.`,
  at: stamp(minutesAgo),
  sessionId: "s1",
  sessionLabel: "Claude Code [a408c0a1]",
});

const monitorRemark = (n: number, minutesAgo: number) => ({
  text: `Monitor remark ${n} about the log.`,
  at: stamp(minutesAgo),
  monitorId: "m1",
});

const face = (name: string, confidence: number, since: number, weight: number) => ({
  match: { name, confidence },
  since: stamp(since),
  weight,
});

const CAPTION = { caption: "A person sits at a desk, facing the screen.", at: stamp(0.2) };

// Banded by what the check actually found, exactly as the live list is — so the
// recording reflects the band each reading earned rather than a band chosen here.
const sighting = (name: string, confidence: number, minutesAgo: number): RecentSighting => ({
  name,
  confidence,
  band: identityBand(confidence, THRESHOLDS.recognition, THRESHOLDS.statement),
  at: stamp(minutesAgo),
});

// The profile shapes that broke redaction before. A value containing a blank
// line came out of the render reflowed, no longer matched the string the
// redaction list was built from, and reached the never-pruned inference log in
// full. A single clean-line profile is structurally blind to that.
const PLAIN_PROFILE = "Builds HAL. Prefers to be told the truth about failures.";
const BLANK_LINE_PROFILE = "Builds HAL.\n\nPrefers to be told the truth about failures.";
const MULTI_LINE_PROFILE = "Builds HAL.\nWorks late.\nPrefers to be told the truth.";
const CRLF_PROFILE = "Builds HAL.\r\nPrefers to be told the truth about failures.";

// ---------------------------------------------------------------------------
// The engine's whole result, for the roles whose entry point exposes it
// ---------------------------------------------------------------------------

interface Recorded {
  text: string;
  redact: readonly string[];
  emitted: readonly string[];
  degraded: readonly string[];
  dropped: readonly string[];
}

/**
 * Render a role exactly as `renderRoleMessage` does, but keep the whole result.
 *
 * The entry point narrows the engine's result to text, redaction and degraded.
 * Calling the engine here with the same template and the same resolver produces
 * the same three plus the two the narrowing drops, without touching production
 * code — which this unit must not do, because it is the thing everything else
 * is measured against.
 */
function recordRole(role: TemplateRole, values: Readonly<Record<string, string>>): Recorded {
  const rendered = renderTemplateText(resolveTemplate(null, role), {
    role,
    resolve: (req) => ({ text: values[req.name] ?? "" }),
  });
  return {
    text: rendered.text,
    redact: rendered.redact,
    emitted: rendered.emitted,
    degraded: rendered.degraded,
    dropped: rendered.dropped,
  };
}

const LINES = "[user] fix the parser\n[assistant] looking at it now\n[tool-result] failed: no such file";
const CAPTION_LINES = "[Creator 74%] A person at a desk.\nA person at a desk, typing.";
const KNOWN = "You know Creator, whose machine this is: Builds HAL.";

describe("oracle: the observation roles", () => {
  it("narration-system, with the shipped prompt", () => {
    expect(recordRole("narration-system", { narration_prompt: DEFAULT_NARRATION_PROMPT })).toMatchSnapshot();
  });

  it("narration-system, prompt blanked", () => {
    expect(recordRole("narration-system", { narration_prompt: "" })).toMatchSnapshot();
  });

  it("narration-user", () => {
    expect(recordRole("narration-user", { session_lines: LINES })).toMatchSnapshot();
  });

  it("monitor-system, with the shipped prompt", () => {
    expect(recordRole("monitor-system", { monitor_prompt: DEFAULT_MONITOR_PROMPT })).toMatchSnapshot();
  });

  it("monitor-system, prompt blanked", () => {
    expect(recordRole("monitor-system", { monitor_prompt: "" })).toMatchSnapshot();
  });

  for (const reason of ["interrupt", "full", "cycle"] as const) {
    it(`monitor-user, ${reason}`, () => {
      expect(
        recordRole("monitor-user", {
          monitor_label: "syslog",
          monitor_lines: "kernel: oops",
          reason_interrupt: reason === "interrupt" ? "set" : "",
          reason_full: reason === "full" ? "set" : "",
          reason_cycle: reason === "cycle" ? "set" : "",
        }),
      ).toMatchSnapshot();
    });
  }

  it("vision-system, prompt and people", () => {
    expect(recordRole("vision-system", { vision_prompt: DEFAULT_VISION_PROMPT, known_people: KNOWN })).toMatchSnapshot();
  });

  it("vision-system, prompt blanked but people kept", () => {
    expect(recordRole("vision-system", { vision_prompt: "", known_people: KNOWN })).toMatchSnapshot();
  });

  it("vision-system, both absent", () => {
    expect(recordRole("vision-system", { vision_prompt: "", known_people: "" })).toMatchSnapshot();
  });

  for (const sensitivity of ["always", "high", "medium", "low"] as const) {
    it(`vision-user, ${sensitivity}`, () => {
      expect(
        recordRole("vision-user", {
          vision_caption_lines: CAPTION_LINES,
          silence_token: VISION_SILENCE_TOKEN,
          silence_expected: sensitivity === "always" ? "" : "set",
          sensitivity_always: sensitivity === "always" ? "set" : "",
          sensitivity_high: sensitivity === "high" ? "set" : "",
          sensitivity_medium: sensitivity === "medium" ? "set" : "",
          sensitivity_low: sensitivity === "low" ? "set" : "",
        }),
      ).toMatchSnapshot();
    });
  }

  it("captioner-user", () => {
    expect(recordRole("captioner-user", { caption_prompt: DEFAULT_VISION_CAPTION_PROMPT })).toMatchSnapshot();
  });

  it("the sensitivity instructions the vision-user template selects between", () => {
    // Recorded separately because the template chooses one of four by block, and
    // a change to the wording would otherwise only show through whichever
    // sensitivity the snapshots above happen to cover.
    expect(
      (["always", "high", "medium", "low"] as const).map((s) => [s, visionSensitivityInstruction(s)]),
    ).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// chat-context
// ---------------------------------------------------------------------------

function inputs(over: Partial<ChatContextInputs> = {}): ChatContextInputs {
  return {
    presence: {
      watching: true,
      present: [face("Creator", 0.8, 10, 0.9), face("Ada", 0.74, 6, 0.8), face("Bram", 0.72, 4, 0.5)],
    },
    lastLook: CAPTION,
    people: [{ name: "Creator", profile: PLAIN_PROFILE, isOperator: true }],
    thresholds: THRESHOLDS,
    entries: [remark(1, 30), remark(2, 20), remark(3, 5), monitorRemark(1, 15), monitorRemark(2, 3)],
    watchedSessionId: "s1",
    preamble: DEFAULT_CONTEXT_PREAMBLE,
    visionBudget: 1200,
    sessionBudget: 1200,
    monitorBudget: 1200,
    monitorLabel: () => "syslog",
    // One in each band, so a change to how a band is spoken shows here rather
    // than only in whichever band the live list happens to hold.
    recentlySeen: [sighting("Creator", 0.81, 2), sighting("Ada", 0.55, 9), sighting("Bram", 0.62, 21)],
    now: NOW,
    ...over,
  };
}

const recordContext = (over: Partial<ChatContextInputs> = {}) => {
  const out = renderChatContext(null, inputs(over));
  return { text: out.text, redact: out.redact, degraded: out.degraded };
};

describe("oracle: chat-context", () => {
  it("all three sources funded", () => {
    expect(recordContext()).toMatchSnapshot();
  });

  it("vision only", () => {
    expect(recordContext({ sessionBudget: 0, monitorBudget: 0 })).toMatchSnapshot();
  });

  it("session only", () => {
    expect(recordContext({ visionBudget: 0, monitorBudget: 0 })).toMatchSnapshot();
  });

  it("monitor only", () => {
    // The source with no byte-identity guard before this file existed: the
    // parity suite's legacy assembly has no Monitor equivalent, and the joint
    // sweep never funds the Monitor budget. Recorded first, so the merged
    // render has something to be wrong against.
    expect(recordContext({ visionBudget: 0, sessionBudget: 0 })).toMatchSnapshot();
  });

  it("every source off", () => {
    expect(recordContext({ visionBudget: 0, sessionBudget: 0, monitorBudget: 0 })).toMatchSnapshot();
  });

  it("camera off", () => {
    expect(recordContext({ presence: { watching: false, present: [] }, lastLook: null })).toMatchSnapshot();
  });

  it("watching, nobody placed", () => {
    expect(recordContext({ presence: { watching: true, present: [] } })).toMatchSnapshot();
  });

  it("no watched session", () => {
    expect(recordContext({ watchedSessionId: null })).toMatchSnapshot();
  });

  it("preamble blanked", () => {
    expect(recordContext({ preamble: "" })).toMatchSnapshot();
  });

  it("budgets tight enough to truncate every list", () => {
    expect(recordContext({ visionBudget: 200, sessionBudget: 200, monitorBudget: 200 })).toMatchSnapshot();
  });

  for (const [name, profile] of [
    ["plain", PLAIN_PROFILE],
    ["blank line", BLANK_LINE_PROFILE],
    ["multi line", MULTI_LINE_PROFILE],
    ["CRLF", CRLF_PROFILE],
  ] as const) {
    it(`profile shape: ${name}`, () => {
      // The redaction list is the load-bearing part of these four. A profile
      // that renders but does not appear in `redact` verbatim reaches the
      // inference log, which is never pruned.
      expect(recordContext({ people: [{ name: "Creator", profile, isOperator: true }] })).toMatchSnapshot();
    });
  }
});

describe("oracle: slots the shipped default does not name", () => {
  // `DEFAULT_CHAT_CONTEXT_TEMPLATE` names neither `{vision_recent_people}` nor
  // `{date}`, so recording only the shipped defaults would leave both with
  // nothing to be wrong against — and they are exactly the readings the
  // decomposition makes reachable from a Conversation prompt. Recorded here
  // against an edited template, which is a supported thing for a user to write.
  const recordEdited = (template: string, over: Partial<ChatContextInputs> = {}) => {
    const out = renderChatContext(template, inputs(over));
    return { text: out.text, redact: out.redact, degraded: out.degraded };
  };

  it("vision_recent_people, uncounted", () => {
    expect(recordEdited("Lately:\n{vision_recent_people}")).toMatchSnapshot();
  });

  for (const count of [1, 2, 3, 40] as const) {
    it(`vision_recent_people[${count}]`, () => {
      expect(recordEdited(`Lately:\n{vision_recent_people[${count}]}`)).toMatchSnapshot();
    });
  }

  it("vision_recent_people, budget too tight for the whole list", () => {
    expect(recordEdited("Lately:\n{vision_recent_people}", { visionBudget: 90 })).toMatchSnapshot();
  });

  it("vision_recent_people, nothing on record", () => {
    expect(recordEdited("Lately:\n{vision_recent_people}", { recentlySeen: [] })).toMatchSnapshot();
  });

  it("date", () => {
    expect(recordEdited("Today is {date}.\n{session_remarks}")).toMatchSnapshot();
  });

  it("session_remarks at a count", () => {
    expect(recordEdited("{session_remarks[2]}")).toMatchSnapshot();
  });

  it("monitor_remarks at a count", () => {
    expect(recordEdited("{monitor_remarks[1]}")).toMatchSnapshot();
  });

  it("a reading named twice in one template", () => {
    // The shape the decomposition makes ordinary. Recorded now so what changes
    // about it later is visible, including how the second mention is charged.
    expect(recordEdited("{vision_faces}\n\n--\n\n{vision_faces}")).toMatchSnapshot();
  });

  it("the same reading at two different counts", () => {
    expect(recordEdited("{session_remarks[1]}\n\n--\n\n{session_remarks[3]}")).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// conversation-system
// ---------------------------------------------------------------------------

// `composeSystemMessage` reads `Date.now()` for `{clock}`, so a fixture naming
// that slot cannot be snapshotted. Everything else about the function is
// deterministic, and the two branches that matter — literal and template — are
// recorded here.
const SEND = { model: "qwen2.5:14b", backend: "http://127.0.0.1:11434", now: NOW };
const compose = (
  conversation: Parameters<typeof composeSystemMessage>[0],
  prompt: Parameters<typeof composeSystemMessage>[1],
  context: Parameters<typeof composeSystemMessage>[2],
) => composeSystemMessage(conversation, prompt, context, SEND);

const CONTEXT_BLOCK = "What I can see right now:\n  - Creator 80%, for 10 minutes.";

describe("oracle: conversation-system", () => {
  it("the shipped default, which is blank", () => {
    // Blank is load-bearing: chat has never sent a system message by default,
    // and the empty string is what preserves that.
    expect(resolveTemplate(null, "conversation-system")).toMatchSnapshot();
  });

  it("a literal prompt, context appended beneath", () => {
    expect(compose({ systemPrompt: "Be terse." }, "Be terse.", CONTEXT_BLOCK)).toMatchSnapshot();
  });

  it("a literal prompt containing braces, unparsed", () => {
    const prompt = 'Reply as {"tone": "dry"}';
    expect(compose({ systemPrompt: prompt }, prompt, CONTEXT_BLOCK)).toMatchSnapshot();
  });

  it("a blank prompt with context", () => {
    expect(compose({ systemPrompt: "" }, "", CONTEXT_BLOCK)).toMatchSnapshot();
  });

  it("a blank prompt with no context sends nothing", () => {
    expect(compose({ systemPrompt: "" }, "", "")).toMatchSnapshot();
  });

  it("a template prompt placing the context", () => {
    const prompt = "Here is what you can see.\n\n{context}\n\nBe terse about it.";
    expect(
      compose({ systemPrompt: prompt, promptIsTemplate: true }, prompt, CONTEXT_BLOCK),
    ).toMatchSnapshot();
  });

  it("a template prompt omitting the context, which is appended", () => {
    const prompt = "Be terse.";
    expect(
      compose({ systemPrompt: prompt, promptIsTemplate: true }, prompt, CONTEXT_BLOCK),
    ).toMatchSnapshot();
  });

  it("a template prompt with a context block that drops", () => {
    const prompt = "Be terse.{#context}\n\n{context}{/}";
    expect(compose({ systemPrompt: prompt, promptIsTemplate: true }, prompt, "")).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

describe("oracle: the budget sweep", () => {
  // Every budget is visited, stepping by 1 and running past the interesting
  // range — a previous sweep here stepped by 7, stopped at 900, and a real
  // defect sat at 1075. What is RECORDED is each budget at which the rendered
  // length changes, rather than all sixteen hundred readings.
  //
  // That is a run-length encoding of the same sweep, not a coarser one. What
  // the sweep protects is where the truncation boundary sits, and a boundary is
  // exactly a transition — so a charging change of eight characters, the width
  // of a clock and the size of the defect this codebase already paid for, moves
  // a transition and fails here. Recording all sixteen hundred points instead
  // cost eight seconds of suite time and timed out an unrelated test's waitFor;
  // a snapshot nobody can run is not an oracle.
  const transitions = (render: (budget: number) => string, from: number, to: number): string[] => {
    const out: string[] = [];
    let previous: number | null = null;
    for (let budget = from; budget <= to; budget += 1) {
      const length = render(budget).length;
      if (length !== previous) out.push(`${budget}:${length}`);
      previous = length;
    }
    return out;
  };

  it("records every length transition, all three sources funded together", () => {
    expect(
      transitions(
        (budget) =>
          renderChatContext(null, inputs({ visionBudget: budget, sessionBudget: budget, monitorBudget: budget })).text,
        0,
        1600,
      ).join("\n"),
    ).toMatchSnapshot();
  });

  it("records the sight block's transitions while the session budget varies", () => {
    // The interaction a single-source sweep cannot see: sight is pinned, so if
    // the ledger leaks between sources this moves. The clock in both headings
    // is the reading that made it move last time.
    const sightLength = (text: string): number => {
      const at = text.indexOf("Who I can see");
      return at === -1 ? 0 : text.length - at;
    };
    expect(
      transitions(
        (session) => {
          const out = renderChatContext(null, inputs({ visionBudget: 400, sessionBudget: session, monitorBudget: 300 }));
          return "x".repeat(sightLength(out.text));
        },
        0,
        1200,
      ).join("\n"),
    ).toMatchSnapshot();
  });

  it("records the sight block's transitions while the Monitor budget varies", () => {
    // The Monitor source is funded in a sweep for the first time here. Nothing
    // covered it before: the parity suite's legacy assembly has no Monitor
    // equivalent, and the joint sweep pinned it at zero.
    const sightLength = (text: string): number => {
      const at = text.indexOf("Who I can see");
      return at === -1 ? 0 : text.length - at;
    };
    expect(
      transitions(
        (monitor) => {
          const out = renderChatContext(null, inputs({ visionBudget: 400, sessionBudget: 300, monitorBudget: monitor }));
          return "x".repeat(sightLength(out.text));
        },
        0,
        1200,
      ).join("\n"),
    ).toMatchSnapshot();
  });
});
