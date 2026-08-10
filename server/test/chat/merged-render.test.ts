import { describe, expect, it } from "vitest";
import { DEFAULT_CONTEXT_PREAMBLE, identityBand, type RecentSighting, type SendDescription } from "../../../shared/src/prompts.js";
import { renderConversationMessage } from "../../src/templates/merged.js";
import type { ChatContextInputs } from "../../src/templates/chatContext.js";

// The merged pass: a Conversation's prompt and its observations in one render.
//
// Two renders meant two ledgers, and that is what made a second route to a
// reading dangerous rather than merely repetitive. These are the cases that say
// the merge actually removed the hazard instead of moving it.

const NOW = new Date(2026, 7, 9, 18, 22, 4);
const SEND: SendDescription = { model: "qwen2.5:14b", backend: "http://127.0.0.1:11434", now: NOW };
const THRESHOLDS = { recognition: 0.35, statement: 0.6 };

const stamp = (minutesAgo: number): string => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();

const sighting = (name: string, confidence: number, minutesAgo: number): RecentSighting => ({
  name,
  confidence,
  band: identityBand(confidence, THRESHOLDS.recognition, THRESHOLDS.statement),
  at: stamp(minutesAgo),
});

const PROFILE = "Builds HAL. Prefers to be told the truth about failures.";

function inputs(over: Partial<ChatContextInputs> = {}): ChatContextInputs {
  return {
    presence: {
      watching: true,
      present: [{ match: { name: "Creator", confidence: 0.8 }, since: stamp(10), weight: 0.9 }],
    },
    lastLook: { caption: "A person sits at a desk, facing the screen.", at: stamp(0.2) },
    people: [{ name: "Creator", profile: PROFILE, isOperator: true }],
    thresholds: THRESHOLDS,
    entries: [
      { text: "A remark about the work.", at: stamp(5), sessionId: "s1", sessionLabel: "Claude Code" },
      { text: "A remark about the log.", at: stamp(3), monitorId: "m1" },
    ],
    watchedSessionId: "s1",
    preamble: DEFAULT_CONTEXT_PREAMBLE,
    visionBudget: 1200,
    sessionBudget: 1200,
    monitorBudget: 1200,
    monitorLabel: () => "syslog",
    recentlySeen: [sighting("Creator", 0.81, 2)],
    now: NOW,
    ...over,
  };
}

const render = (
  prompt: string,
  opts: { isTemplate?: boolean; contextTemplate?: string | null; inputs?: ChatContextInputs | null } = {},
) =>
  renderConversationMessage({
    prompt,
    promptIsTemplate: opts.isTemplate ?? true,
    contextTemplate: opts.contextTemplate ?? null,
    inputs: opts.inputs === undefined ? inputs() : opts.inputs,
    send: SEND,
  });

const occurrences = (text: string, needle: string): number => text.split(needle).length - 1;

describe("repetition, now that one ledger sees it", () => {
  it("renders a reading twice and charges it once (AE1)", () => {
    // The headline case, and the one a verdict reading `emitted` would get
    // wrong: `emitted` is charge-gated, so the copy inside the group is not in
    // it, and the group would drop while plainly rendering text.
    const out = render("{vision_caption}\n\n{context}");
    const caption = "A person sits at a desk, facing the screen.";
    expect(occurrences(out.text, caption)).toBe(2);
    expect(out.spoke).toBe(true);
  });

  it("keeps the group alive when the only reading inside it is one already placed above", () => {
    // Same shape, stated as the group's own question rather than as a count.
    const out = render("{vision_caption}\n\n{context}", {
      contextTemplate: "{#vision_caption}Look:\n{vision_caption}{/}",
    });
    expect(out.text).toContain("Look:");
  });

  it("charges a reading once, so repeating it does not shrink what follows", () => {
    const once = render("{context}", { contextTemplate: "{session_remarks}\n{vision_faces}" });
    const twice = render("{vision_faces}\n{context}", { contextTemplate: "{session_remarks}\n{vision_faces}" });
    // The session remarks are unaffected by the sight reading being named twice:
    // they are a different source, and the repeat cost the sight budget nothing.
    expect(twice.text).toContain("A remark about the work.");
    expect(once.text).toContain("A remark about the work.");
  });
});

describe("what the group holds on", () => {
  it("drops the whole block when nothing observational reached it (AE2)", () => {
    const out = render("Be terse.", {
      inputs: inputs({
        presence: { watching: false, present: [] },
        lastLook: null,
        people: [],
        entries: [],
        recentlySeen: [],
        visionBudget: 0,
        sessionBudget: 0,
        monitorBudget: 0,
      }),
    });
    expect(out.text).toBe("Be terse.");
    expect(out.spoke).toBe(false);
  });

  it("does not keep the group alive on a reading the prompt placed outside it", () => {
    // The discriminating case. The group's body would emit only its preamble
    // and headings; a verdict reading the flat emitted list would see the
    // caption the PROMPT placed and ship a block of empty headings.
    const out = render("{vision_caption}\n\n{context}", {
      contextTemplate: `${DEFAULT_CONTEXT_PREAMBLE}\n\n{#session_remarks}What I have been saying:\n{session_remarks}{/}`,
      inputs: inputs({ entries: [], sessionBudget: 0 }),
    });
    expect(out.text).not.toContain("What I have been saying");
    expect(out.text).not.toContain(DEFAULT_CONTEXT_PREAMBLE);
    expect(out.text).toContain("A person sits at a desk");
  });

  it("sends nothing at all for a blank prompt with nothing to observe", () => {
    // Blank means blank, and it is load-bearing: chat has never sent a system
    // message by default.
    const out = render("", { inputs: null });
    expect(out.text).toBe("");
  });
});

describe("where the block goes", () => {
  it("appends beneath a prompt that names neither the block nor a reading", () => {
    const out = render("Be terse.");
    expect(out.text.startsWith("Be terse.")).toBe(true);
    expect(out.text).toContain("A remark about the work.");
  });

  it("places the block where {context} is typed", () => {
    const out = render("Above.\n\n{context}\n\nBelow.");
    expect(out.text.startsWith("Above.")).toBe(true);
    expect(out.text.trimEnd().endsWith("Below.")).toBe(true);
  });

  it("gives a prompt that placed its own readings exactly what it placed", () => {
    // The narrowed fallback. Without it, a thread that arranged its own
    // observations and left `{context}` out would get everything twice.
    const out = render("Who I can see:\n{vision_faces}");
    expect(out.text).toContain("Who I can see:");
    expect(out.text).not.toContain("A remark about the work.");
    expect(out.text).not.toContain(DEFAULT_CONTEXT_PREAMBLE);
  });

  it("finds {context} inside a block", () => {
    const out = render("{#context}Here is what I have:\n{context}{/}");
    expect(out.text).toContain("Here is what I have:");
  });
});

describe("a prompt that never opted in", () => {
  it("keeps its braces unparsed under the merged pass", () => {
    const out = render('Reply as {"tone": "dry"}', { isTemplate: false });
    expect(out.text.startsWith('Reply as {"tone": "dry"}')).toBe(true);
  });

  it("still receives its context beneath", () => {
    const out = render("Be terse.", { isTemplate: false });
    expect(out.text).toContain("A remark about the work.");
  });
});

describe("redaction across the seam", () => {
  it("withholds a profile the prompt placed itself (AE4)", () => {
    // After this work the wording around a profile is entirely the user's, so
    // nothing about the finished string is predictable. The slot reports what
    // to withhold; nothing searches the output for it.
    const out = render("What I know:\n{vision_profiles}");
    expect(out.text).toContain(PROFILE);
    expect(out.redact).toContain(PROFILE);
  });

  it("withholds it once when it is placed twice", () => {
    const out = render("{vision_profiles}\n\n{context}");
    expect(out.redact.filter((r) => r === PROFILE)).toHaveLength(1);
  });
});

describe("consent", () => {
  it("sends nothing observational when there is no context to draw on (AE8)", () => {
    // `null` inputs is what a withheld Off-Machine Acknowledgement produces,
    // and the point is that it is decided before anything is read rather than
    // by dropping text afterwards — so a prompt naming a reading directly gets
    // nothing rather than getting it and having it stripped.
    const out = render("Lately:\n{session_remarks}", { inputs: null });
    expect(out.text).toBe("Lately:");
    expect(out.spoke).toBe(false);
  });

  it("leaves the prompt's own words untouched", () => {
    const out = render("Be terse and precise.", { inputs: null });
    expect(out.text).toBe("Be terse and precise.");
  });
});

describe("the emission bound", () => {
  it("lets a repeat through while the source has room", () => {
    const out = render("{vision_caption}\n\n{vision_caption}");
    expect(occurrences(out.text, "A person sits at a desk")).toBe(2);
  });

  it("renders a later repeat empty rather than truncating it", () => {
    // Charging once is right for apportioning between sources and wrong for
    // protecting the window: the repeat costs no budget but its characters are
    // still in the message. Half a sentence about who is in the room reads as a
    // claim, so the later copy goes rather than being cut.
    // Room for one copy and not three. Sized from the rendered line rather than
    // guessed: at a budget too small for even one, the bound is not what is
    // being measured — the ordinary truncation is.
    const one = render("{vision_caption}", { inputs: inputs({ visionBudget: 100_000 }) }).text.length;
    const out = render("{vision_caption}\n\n{vision_caption}\n\n{vision_caption}", {
      inputs: inputs({ visionBudget: one + 10 }),
    });
    expect(occurrences(out.text, "A person sits at a desk")).toBe(1);
    // What survived is whole rather than cut mid-sentence.
    expect(out.text).toContain("A person sits at a desk, facing the screen.");
  });

  it("does not let one source spend another's allowance", () => {
    // Per source rather than one total: a saturated sight source must not
    // absorb an unused Monitor allowance, because that is not what a per-source
    // level means.
    const one = render("{vision_caption}", { inputs: inputs({ visionBudget: 100_000 }) }).text.length;
    const out = render("{vision_caption}\n\n{vision_caption}", {
      inputs: inputs({ visionBudget: one + 10, monitorBudget: 100_000 }),
    });
    expect(occurrences(out.text, "A person sits at a desk")).toBe(1);
  });
});

describe("invariants the emission cap must not break", () => {
  // A review reported three defects in the first version of the cap, two of
  // them with measured output. I could not reproduce those two across two
  // fixtures and roughly four thousand budget values, so these are written as
  // the invariants rather than as reproductions — swept, because the window
  // where a cap interacts with a budget is narrow and sampling misses it.
  //
  // The code was changed anyway, because all three changes are right by
  // inspection: charging for text that is not emitted is wrong however the
  // arithmetic lands, a per-source cap keyed by name alone is a category error,
  // and a universal reading is not what a Context Level apportions.

  it("never leaves a heading standing with nothing under it", () => {
    // The failure this guards is on record twice: a heading whose list the
    // budget emptied reads as a live claim about an empty room.
    const dangling: number[] = [];
    for (let budget = 40; budget <= 1200; budget += 1) {
      const out = render("{vision_faces}\n\n{context}", {
        contextTemplate: "{#vision_faces}Who I can see, read live just now at {clock}:\n{vision_faces}{/}",
        inputs: inputs({ visionBudget: budget }),
      }).text;
      const at = out.indexOf("Who I can see");
      if (at === -1) continue;
      const under = out.slice(at).split("\n").slice(1).join("\n").trim();
      if (under.length === 0) dangling.push(budget);
    }
    expect(dangling, `heading with nothing under it at ${dangling.length} budgets`).toEqual([]);
  });

  it("charges nothing for a repeat it suppressed", () => {
    // Charging first and returning empty spends the source's allowance on
    // characters that never reached the message, so the slots after it see a
    // reduced budget and render empty — which can take the whole block down.
    // Swept because the window is exactly where the cap and the budget cross.
    const short: number[] = [];
    for (let budget = 100; budget <= 1400; budget += 1) {
      const once = render("{vision_caption}\n\n{vision_profiles}", { inputs: inputs({ visionBudget: budget }) }).text;
      const twice = render("{vision_caption}\n\n{vision_caption}\n\n{vision_profiles}", {
        inputs: inputs({ visionBudget: budget }),
      }).text;
      // Naming the caption a second time must never cost the profile its place.
      if (once.includes(PROFILE) && !twice.includes(PROFILE)) short.push(budget);
    }
    expect(short, `a suppressed repeat cost a later reading its place at ${short.length} budgets`).toEqual([]);
  });

  it("never blanks a universal reading inside a heading", () => {
    // `{clock}` appears in two headings of the shipped template, billed to two
    // different sources. Keyed by name alone the second counts as a repeat and
    // is checked against the other source's cap — which would leave "read live
    // just now at :" in the message, a malformed line rather than a shorter one.
    const malformed: number[] = [];
    for (let budget = 40; budget <= 1200; budget += 1) {
      const out = render("{vision_caption}\n\n{vision_caption}\n\n{context}", {
        contextTemplate: "{#vision_faces}Who I can see, read live just now at {clock}:\n{vision_faces}{/}",
        inputs: inputs({ visionBudget: budget }),
      }).text;
      if (!out.includes("read live just now at")) continue;
      if (!/read live just now at \d{2}:\d{2}:\d{2}:/.test(out)) malformed.push(budget);
    }
    expect(malformed, `clock blanked inside a heading at ${malformed.length} budgets`).toEqual([]);
  });
});

describe("{#context} wrapping wording but naming nothing", () => {
  it("keeps both the wording and the context", () => {
    // The conversion to a group used to be discarded unless an inner
    // `{context}` was also present, so the block stayed a block, dropped every
    // time, and took the user's heading with it — while the context was
    // appended somewhere else entirely.
    const out = render("{#context}Here is what I can see:\n{/}\n\nBe terse.");
    expect(out.text).toContain("Here is what I can see:");
    expect(out.text).toContain("A remark about the work.");
    expect(out.text).toContain("Be terse.");
  });

  it("takes the wording with it when there is nothing to say", () => {
    const out = render("{#context}Here is what I can see:\n{/}\n\nBe terse.", {
      inputs: inputs({
        presence: { watching: false, present: [] },
        lastLook: null,
        people: [],
        entries: [],
        recentlySeen: [],
        visionBudget: 0,
        sessionBudget: 0,
        monitorBudget: 0,
      }),
    });
    expect(out.text).not.toContain("Here is what I can see:");
    expect(out.text).toBe("Be terse.");
  });

  it("does not also append a second copy beneath", () => {
    const out = render("{#context}Seen:\n{/}");
    expect(occurrences(out.text, "A remark about the work.")).toBe(1);
  });
});

describe("one instant", () => {
  it("agrees with itself about the time across the whole message", () => {
    // Marked rather than pattern-matched: the remark lines carry their own
    // stamps in the same shape, so a bare regex reads those as clocks too.
    const out = render("A[{clock}]\n\n{context}", { contextTemplate: "B[{clock}]\n{session_remarks}" });
    const a = /A\[(\d{2}:\d{2}:\d{2})\]/.exec(out.text);
    const b = /B\[(\d{2}:\d{2}:\d{2})\]/.exec(out.text);
    expect(a?.[1]).toBeDefined();
    expect(b?.[1]).toBe(a?.[1]);
  });
});
