import { describe, expect, it } from "vitest";
import {
  EDITABLE_PROMPTS,
  PROMPT_CATALOG,
  PROMPT_FIELDS,
  type SendDescription,
} from "../../../shared/src/prompts.js";
import { UNIVERSAL_SLOTS, validateTemplate } from "../../../shared/src/templates.js";
import { renderPrompt, renderRoleMessage } from "../../src/templates/roleMessages.js";

// The six prompts that used to be plain text.
//
// Each keeps its own settings field, its presets and its reset. What it gains
// is the language — and a marker saying whether it is using it, because a
// prompt written when braces meant braces has to keep them.

const NOW = new Date(2026, 7, 9, 18, 22, 4);
const SEND: SendDescription = { model: "qwen2.5:14b", backend: "http://127.0.0.1:11434", now: NOW };

const render = (text: unknown, isTemplate: boolean | undefined, id: keyof typeof PROMPT_FIELDS = "narrationPrompt") =>
  renderPrompt(text, isTemplate, PROMPT_FIELDS[id], SEND, id);

describe("a prompt that has not opted in", () => {
  it("keeps its braces", () => {
    // The failure this prevents is not "the braces render as a slot". The
    // parser does not read an unrecognised brace literally — it reports a bad
    // name and DROPS the text. A caption prompt carrying a JSON example would
    // lose the example on the first send after an upgrade, silently.
    const prompt = 'Reply as {"tone": "dry"}';
    expect(render(prompt, undefined).text).toBe(prompt);
    expect(render(prompt, false).text).toBe(prompt);
  });

  it("renders a slot name as the literal text it is", () => {
    expect(render("It is {clock} now.", undefined).text).toBe("It is {clock} now.");
  });

  it("is blank when blank", () => {
    expect(render("", undefined).text).toBe("");
    expect(render("   ", undefined).text).toBe("");
  });

  it("drops a value that is not a string, rather than stringifying it", () => {
    // A hand-edited settings file can put anything here, and `String(42)` is
    // not a prompt.
    expect(render(42, undefined).text).toBe("");
    expect(render(null, undefined).text).toBe("");
  });
});

describe("a prompt that has opted in", () => {
  it("renders the universal tier", () => {
    expect(render("It is {clock} on {date}.", true).text).toBe("It is 18:22:04 on Sunday 9 August 2026.");
  });

  it("renders an escaped brace as a brace", () => {
    expect(render('Reply as {{"tone": "dry"}}', true).text).toBe('Reply as {"tone": "dry"}');
  });

  it("drops a block whose slot has nothing to say", () => {
    expect(render("Voice.{#model} Model: {model}.{/}", true).text).toBe("Voice. Model: qwen2.5:14b.");
    const empty = renderPrompt("Voice.{#model} Model: {model}.{/}", true, PROMPT_FIELDS.narrationPrompt, {
      ...SEND,
      model: "",
    }, "narrationPrompt");
    expect(empty.text).toBe("Voice.");
  });

  it("is still blank when blank", () => {
    expect(render("", true).text).toBe("");
  });
});

describe("whitespace survives the conversion", () => {
  // The shipped defaults carry none of these shapes, so the oracle cannot see
  // this. The inner render uses `normalize: false` deliberately: the outer
  // render normalizes the finished message, and trimming here as well would
  // change how the separator the template placed around this value collapses.
  const shapes: [string, string][] = [
    ["a leading newline", "\nVoice."],
    ["a trailing newline", "Voice.\n"],
    ["a three-newline run", "One.\n\n\nTwo."],
    ["trailing spaces on a line", "One.   \nTwo."],
    ["a CRLF pair", "One.\r\nTwo."],
  ];

  for (const [name, text] of shapes) {
    it(`${name} renders the same whether or not the prompt opted in`, () => {
      // Both go through the host role, which is where the outer render's
      // normalization is applied — the only place it should be applied.
      const literal = renderRoleMessage(
        "narration-system",
        null,
        { narration_prompt: renderPrompt(text, false, PROMPT_FIELDS.narrationPrompt, SEND, "n").text },
        SEND,
      ).text;
      const templated = renderRoleMessage(
        "narration-system",
        null,
        { narration_prompt: renderPrompt(text, true, PROMPT_FIELDS.narrationPrompt, SEND, "n").text },
        SEND,
      ).text;
      expect(templated).toBe(literal);
    });
  }
});

describe("what each of the six may name", () => {
  it("gives five of them the universal tier and nothing else", () => {
    for (const id of ["narrationPrompt", "monitorPrompt", "visionPrompt", "captionPrompt", "chatContextPreamble"] as const) {
      expect(PROMPT_FIELDS[id], id).toEqual(UNIVERSAL_SLOTS);
    }
  });

  it("gives the default conversation prompt what a Conversation prompt accepts", () => {
    // It is copied onto a Conversation at creation. A prompt that validated
    // here and not there would be one the editor accepts and the thread cannot
    // render.
    expect(PROMPT_FIELDS.chatDefaultPrompt.map((s) => s.name)).toContain("context");
  });

  it("refuses an observation reading in the context preamble", () => {
    // The preamble sits inside the budgeted context render. A vision reading
    // here would be a second route to it with its own ledger — the hazard the
    // merge exists to remove, arriving through the back door.
    const errors = validateTemplate("{vision_faces}", PROMPT_FIELDS.chatContextPreamble);
    expect(errors.map((e) => e.kind)).toContain("unknown-slot");
  });

  it("refuses the slot that carries it, in each of the four observation prompts", () => {
    // A prompt naming the slot whose value it IS would be naming itself.
    const circular: [keyof typeof PROMPT_FIELDS, string][] = [
      ["narrationPrompt", "narration_prompt"],
      ["monitorPrompt", "monitor_prompt"],
      ["visionPrompt", "vision_prompt"],
      ["captionPrompt", "caption_prompt"],
    ];
    for (const [id, slot] of circular) {
      const errors = validateTemplate(`{${slot}}`, PROMPT_FIELDS[id]);
      expect(errors.map((e) => e.kind), id).toContain("unknown-slot");
    }
  });
});

describe("the wire catalog", () => {
  it("carries a vocabulary for every editable prompt", () => {
    // A protocol-only client cannot author what it cannot read, and a slot
    // missing here is one the editor refuses on apply with no way for the user
    // to discover it existed.
    for (const id of EDITABLE_PROMPTS) {
      expect(PROMPT_CATALOG.promptSlots[id], id).toBeDefined();
      expect(PROMPT_CATALOG.promptSlots[id]!.length, id).toBeGreaterThan(0);
    }
  });

  it("carries the universal tier separately from the role vocabularies", () => {
    // Sent apart so a client can render them under their own headings. Flattened
    // into one list, the editor could not say which are which.
    expect(PROMPT_CATALOG.universalSlots).toEqual(UNIVERSAL_SLOTS);
    for (const slots of Object.values(PROMPT_CATALOG.templateSlots)) {
      expect(slots.map((s) => s.name)).not.toContain("clock");
    }
  });
});
