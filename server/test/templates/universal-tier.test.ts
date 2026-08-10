import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTEXT_PREAMBLE,
  contextBudgetChars,
  withUniversalSlots,
  type SendDescription,
} from "../../../shared/src/prompts.js";
import {
  PHRASES,
  renderPhrase,
} from "../../../shared/src/phrases.js";
import {
  TEMPLATE_ROLES,
  UNIVERSAL_SLOTS,
  isUniversalSlot,
  slotNames,
  validateTemplate,
  vocabularyFor,
  type TemplateRole,
} from "../../../shared/src/templates.js";
import { renderRoleMessage, sendTo } from "../../src/templates/roleMessages.js";
import { renderChatContext } from "../../src/templates/chatContext.js";
import { composeSystemMessage } from "../support/legacyConversationSystem.js";

// The tier reaches every role, proved one role at a time.
//
// "Adding a universal reading is one registration and reaches every role" is
// exactly the shape this codebase has been burned by: a `phrases` argument was
// threaded through six resolvers and landed on five, and profile edits applied
// to Vision and silently not to chat. The rule that came out of it is in
// docs/solutions/assert-the-effect-not-the-existence.md — after threading
// anything through N call sites, write one test per site that OBSERVES the
// effect. Set the value to something distinctive and assert it appears.
//
// So this file renders every role for every universal slot rather than
// asserting that a resolver exists.

const NOW = new Date(2026, 7, 9, 18, 22, 4);
const SEND: SendDescription = { model: "qwen2.5:14b", backend: "http://192.168.1.50:8080", now: NOW };

// What each slot should render, given SEND. The clock and date come from the
// instant rather than being invented here, so a change to how either is
// formatted fails in one place instead of nine.
const EXPECTED: Record<string, string> = {
  clock: "18:22:04",
  date: "Sunday 9 August 2026",
  model: "qwen2.5:14b",
  backend: "http://192.168.1.50:8080",
};

/**
 * Render one role from a template, through the production entry point.
 *
 * Deliberately not a single generic call: the three entry points differ, and a
 * test that reached past them into the engine would prove the engine works
 * while the wiring stayed broken — which is the failure it exists to catch.
 */
function renderRole(role: TemplateRole, template: string): string {
  if (role === "chat-context") {
    // A content slot has to emit or the whole render is discarded, so the
    // template carries one alongside whatever is under test.
    return renderChatContext(`${template}\n{session_remarks}`, {
      presence: { watching: false, present: [] },
      lastLook: null,
      people: [],
      thresholds: { recognition: 0.35, statement: 0.6 },
      entries: [{ text: "A remark.", at: NOW.toISOString(), sessionId: "s1", sessionLabel: "Session" }],
      watchedSessionId: "s1",
      preamble: DEFAULT_CONTEXT_PREAMBLE,
      visionBudget: 0,
      sessionBudget: 4000,
      monitorBudget: 0,
      now: NOW,
      model: SEND.model,
      backend: SEND.backend,
    }).text;
  }
  if (role === "conversation-system") {
    return composeSystemMessage({ systemPrompt: template, promptIsTemplate: true }, template, "", SEND);
  }
  return renderRoleMessage(role, template, {}, SEND).text;
}

describe("every role gets every universal reading", () => {
  for (const role of TEMPLATE_ROLES) {
    for (const spec of UNIVERSAL_SLOTS) {
      it(`${role} renders {${spec.name}}`, () => {
        const out = renderRole(role, `[[${spec.name}=={${spec.name}}]]`);
        expect(out).toContain(`[[${spec.name}==${EXPECTED[spec.name]}]]`);
      });
    }
  }
});

describe("the vocabulary", () => {
  for (const role of TEMPLATE_ROLES) {
    it(`${role} accepts every universal name`, () => {
      const template = UNIVERSAL_SLOTS.map((s) => `{${s.name}}`).join(" ");
      expect(validateTemplate(template, role)).toEqual([]);
    });

    it(`${role} lists each universal name exactly once`, () => {
      // Moving the clock and the date into the tier without taking them out of
      // the two roles that carried them would show a name twice in the editor,
      // under two headings, which is the opposite of the point.
      const names = slotNames(role);
      for (const spec of UNIVERSAL_SLOTS) {
        expect(names.filter((n) => n === spec.name)).toHaveLength(1);
      }
    });
  }

  it("puts the role's own readings before the universal ones", () => {
    // The slot list reads as "what this message can see", then "what everything
    // can see". A role whose own reading shared a name would also win, which is
    // why nothing in the shipped vocabulary collides.
    const vocabulary = vocabularyFor("chat-context");
    const firstUniversal = vocabulary.findIndex((s) => isUniversalSlot(s.name));
    const lastOwn = vocabulary.map((s) => isUniversalSlot(s.name)).lastIndexOf(false);
    expect(lastOwn).toBeLessThan(firstUniversal);
  });

  it("gives every universal slot a meaning and a note", () => {
    // The same standard the role vocabularies are held to: a slot exposed for
    // editing with its reasoning stripped makes reintroducing a measured
    // failure the easy path.
    for (const spec of UNIVERSAL_SLOTS) {
      expect(spec.meaning.length, spec.name).toBeGreaterThan(10);
      expect(spec.note.length, spec.name).toBeGreaterThan(40);
    }
  });

  it("keeps off_machine out", () => {
    // Left out deliberately: it reports a policy decision rather than a
    // reading, and a prompt that branches on whether a send leaves the machine
    // is a prompt being invited to write a prohibition.
    expect(UNIVERSAL_SLOTS.map((s) => s.name)).not.toContain("off_machine");
  });
});

describe("phrases do not get the tier", () => {
  // A phrase is one line inside a slot, and it reuses this engine by handing in
  // its own small field set. `{clock}` there would be a second, unbudgeted
  // route to a reading the surrounding template already places — so the
  // explicit-vocabulary path must stay untouched.
  for (const phrase of PHRASES) {
    it(`${phrase.id} refuses {clock}`, () => {
      const errors = validateTemplate("{clock}", phrase.fields);
      expect(errors.map((e) => e.kind)).toContain("unknown-slot");
    });
  }

  it("renders nothing for a universal name a phrase was edited to name", () => {
    const phrase = PHRASES[0]!;
    const out = renderPhrase(phrase.id, { [phrase.id]: "at {clock}" }, {});
    expect(out).not.toContain("18:22:04");
    expect(out).toBe("at ");
  });
});

describe("what {model} means depends on where it is asked", () => {
  it("names the Captioner in the caption prompt", () => {
    // The model this message is going to, not the one chat happens to be using.
    const out = renderRoleMessage(
      "captioner-user",
      "{model}",
      {},
      sendTo("moondream:1.8b", "http://127.0.0.1:8081"),
    ).text;
    expect(out).toBe("moondream:1.8b");
  });

  it("names the chat model in a Conversation prompt", () => {
    const out = composeSystemMessage(
      { systemPrompt: "{model}", promptIsTemplate: true },
      "{model}",
      "",
      sendTo("qwen2.5:14b", "http://127.0.0.1:11434"),
    );
    expect(out).toBe("qwen2.5:14b");
  });

  it("renders empty when nothing can say what model is answering", () => {
    // A captioner whose server does not answer /v1/models leaves the slot
    // empty rather than failing a capture.
    expect(renderRoleMessage("captioner-user", "{model}", {}, sendTo(null, null)).text).toBe("");
  });
});

describe("the {date} slot a Conversation prompt could not reach", () => {
  it("renders the date", () => {
    // It was in this role's vocabulary, accepted by the validator and offered
    // in the editor — and answered by nothing, so it rendered empty and was not
    // reported as degraded either, because the NAME was valid. Nothing failed;
    // the prompt was just quietly shorter than it read.
    const out = composeSystemMessage(
      { systemPrompt: "Today is {date}.", promptIsTemplate: true },
      "Today is {date}.",
      "",
      SEND,
    );
    expect(out).toBe("Today is Sunday 9 August 2026.");
  });

  it("agrees with {clock} about which day it is", () => {
    const out = composeSystemMessage(
      { systemPrompt: "{date} {clock}", promptIsTemplate: true },
      "{date} {clock}",
      "",
      SEND,
    );
    expect(out).toBe("Sunday 9 August 2026 18:22:04");
  });
});

describe("a universal reading is charged to the section it sits in", () => {
  it("costs the session budget when placed inside the session block", () => {
    // "No budget source of its own" is not "free". `{clock}` inside the sight
    // heading charges the sight budget today, and billing it once globally made
    // the second section eight characters richer and moved where a crowded
    // frame starts truncating.
    //
    // Swept rather than asserted at one size, because the difference is eight
    // characters and only shows at the budgets where it decides whether one
    // more remark fits. Picking a single budget is how the original defect
    // stayed invisible.
    const entries = Array.from({ length: 40 }, (_, i) => ({
      text: `Remark number ${i} about the work, at some length so the budget bites.`,
      at: new Date(NOW.getTime() - i * 60_000).toISOString(),
      sessionId: "s1",
      sessionLabel: "Session",
    }));
    const remarksAt = (template: string, sessionBudget: number): number =>
      renderChatContext(template, {
        presence: { watching: false, present: [] },
        lastLook: null,
        people: [],
        thresholds: { recognition: 0.35, statement: 0.6 },
        entries,
        watchedSessionId: "s1",
        preamble: "",
        visionBudget: 0,
        sessionBudget,
        now: NOW,
      })
        .text.split("\n")
        .filter((l) => l.startsWith("- ")).length;

    const withClock = "{#session_remarks}At {clock}:\n{session_remarks}{/}";
    const withoutClock = "{#session_remarks}At:\n{session_remarks}{/}";

    let everFewer = false;
    for (let budget = 100; budget <= 1600; budget += 1) {
      const a = remarksAt(withClock, budget);
      const b = remarksAt(withoutClock, budget);
      // Never MORE: the clock cannot buy room.
      expect(a, `at budget ${budget}`).toBeLessThanOrEqual(b);
      if (a < b) everFewer = true;
    }
    expect(everFewer, "the clock never cost the session budget anything").toBe(true);
  });
});

describe("the wrapper", () => {
  it("hands anything it does not own to the role's resolver", () => {
    const resolve = withUniversalSlots(SEND, (req) => ({ text: `role:${req.name}` }));
    expect(resolve({ name: "session_lines", budgetLeft: Infinity }).text).toBe("role:session_lines");
    expect(resolve({ name: "clock", budgetLeft: Infinity }).text).toBe("18:22:04");
  });

  it("reads the instant it was given rather than the wall clock", () => {
    // Two resolutions of {clock} in one message must not disagree, and once a
    // slot can be repeated — which the decomposition makes ordinary — reading
    // Date.now() inside the resolver is how a message states two times.
    const resolve = withUniversalSlots(SEND, () => ({ text: "" }));
    const first = resolve({ name: "clock", budgetLeft: Infinity }).text;
    const second = resolve({ name: "clock", budgetLeft: Infinity }).text;
    expect(first).toBe(second);
    expect(first).toBe("18:22:04");
  });
});
