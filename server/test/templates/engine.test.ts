import { describe, expect, it } from "vitest";
import {
  SLOT_VOCABULARY,
  TEMPLATE_ROLES,
  type SlotRequest,
  type SlotResult,
  parseTemplate,
  renderTemplateText,
  slotNames,
  validateTemplate,
} from "../../../shared/src/templates.js";

// A resolver built from a plain map, so a test says what each slot answers and
// nothing else. Anything unnamed answers empty, which is the ordinary case.
function resolverFrom(map: Record<string, string | SlotResult>) {
  const calls: SlotRequest[] = [];
  const resolve = (req: SlotRequest): SlotResult => {
    calls.push(req);
    const hit = map[req.name];
    if (hit === undefined) return { text: "" };
    return typeof hit === "string" ? { text: hit } : hit;
  };
  return { resolve, calls };
}

describe("parseTemplate", () => {
  it("returns literal text unchanged", () => {
    const { nodes, errors } = parseTemplate("just words");
    expect(errors).toEqual([]);
    expect(nodes).toEqual([{ kind: "text", value: "just words" }]);
  });

  it("reads a bare slot and a counted slot", () => {
    const { nodes, errors } = parseTemplate("{clock} and {session_remarks[5]}");
    expect(errors).toEqual([]);
    expect(nodes[0]).toEqual({ kind: "slot", name: "clock", at: 0 });
    expect(nodes[2]).toMatchObject({ kind: "slot", name: "session_remarks", count: 5 });
  });

  it("rejects a count below one", () => {
    for (const text of ["{session_remarks[0]}", "{session_remarks[-1]}"]) {
      const { errors } = parseTemplate(text);
      expect(errors.map((e) => e.kind)).toContain("bad-count");
    }
  });

  it("unescapes doubled braces and never reads them as a slot", () => {
    const { nodes, errors } = parseTemplate('Reply as {{"tone": "dry"}}');
    expect(errors).toEqual([]);
    expect(nodes).toEqual([{ kind: "text", value: 'Reply as {"tone": "dry"}' }]);
  });

  it("reads a block, including a nested one", () => {
    const { nodes, errors } = parseTemplate("{#a}x{#b}y{/}{/}");
    expect(errors).toEqual([]);
    expect(nodes[0]).toMatchObject({ kind: "block", name: "a" });
    const outer = nodes[0] as Extract<(typeof nodes)[number], { kind: "block" }>;
    expect(outer.children[1]).toMatchObject({ kind: "block", name: "b" });
  });

  it("reports an unclosed block at the position it opened", () => {
    const { errors } = parseTemplate("lead {#a}x");
    const err = errors.find((e) => e.kind === "unclosed-block");
    expect(err).toBeDefined();
    expect(err?.at).toBe(5);
    expect(err?.name).toBe("a");
  });

  it("reports a close with nothing open", () => {
    const { errors } = parseTemplate("x{/}");
    expect(errors[0]).toMatchObject({ kind: "stray-close", at: 1 });
  });

  it("keeps the text of an unclosed block so a stored template still renders", () => {
    const { nodes } = parseTemplate("{#a}kept");
    const text = nodes.map((n) => (n.kind === "text" ? n.value : "")).join("");
    expect(text).toContain("kept");
  });

  it("never throws on unbalanced input", () => {
    const nasty = ["{", "}", "{{{", "}}}", "{#}", "{/", "{a", "{a[}", "{[5]}", "{#a}{#b}", "{}"];
    for (const text of nasty) {
      expect(() => parseTemplate(text)).not.toThrow();
    }
  });

  it("treats a non-string as empty rather than failing", () => {
    expect(parseTemplate(undefined).nodes).toEqual([]);
    expect(parseTemplate(42).nodes).toEqual([]);
  });
});

describe("validateTemplate", () => {
  it("accepts a slot in the role's vocabulary", () => {
    expect(validateTemplate("{clock}", "chat-context")).toEqual([]);
  });

  it("rejects an unknown slot and lists what is valid", () => {
    const errors = validateTemplate("{data_vison}", "chat-context");
    expect(errors[0]?.kind).toBe("unknown-slot");
    expect(errors[0]?.name).toBe("data_vison");
    expect(errors[0]?.valid).toEqual(slotNames("chat-context"));
  });

  it("scopes the vocabulary per role", () => {
    expect(validateTemplate("{session_remarks}", "chat-context")).toEqual([]);
    expect(validateTemplate("{session_remarks}", "monitor-user").map((e) => e.kind)).toContain("unknown-slot");
  });

  it("rejects a count on a slot that takes none", () => {
    expect(validateTemplate("{clock[3]}", "chat-context").map((e) => e.kind)).toContain("count-unsupported");
  });

  it("rejects a condition slot used inline but accepts it as a block", () => {
    expect(validateTemplate("{reason_cycle}", "monitor-user").map((e) => e.kind)).toContain("condition-inline");
    expect(validateTemplate("{#reason_cycle}x{/}", "monitor-user")).toEqual([]);
  });

  it("still reports structural errors alongside vocabulary ones", () => {
    const kinds = validateTemplate("{#a}{nope}", "chat-context").map((e) => e.kind);
    expect(kinds).toContain("unknown-slot");
    expect(kinds).toContain("unclosed-block");
  });
});

describe("renderTemplate", () => {
  it("emits literal text unchanged", () => {
    const { resolve } = resolverFrom({});
    expect(renderTemplateText("plain words", { resolve }).text).toBe("plain words");
  });

  it("keeps a block whose slot has text and drops one whose slot is empty", () => {
    const { resolve } = resolverFrom({ full: "content" });
    const out = renderTemplateText("{#full}Heading:\n{full}{/}{#bare}Gone:\n{bare}{/}", { resolve });
    expect(out.text).toBe("Heading:\ncontent");
  });

  it("collapses the gap left by a dropped block to one blank line", () => {
    const { resolve } = resolverFrom({ a: "A", c: "C" });
    const out = renderTemplateText("{#a}{a}{/}\n\n{#b}{b}{/}\n\n{#c}{c}{/}", { resolve });
    expect(out.text).toBe("A\n\nC");
  });

  it("trims the ends rather than leaving the separators a dropped block left", () => {
    const { resolve } = resolverFrom({ b: "B" });
    const out = renderTemplateText("{#a}{a}{/}\n\n{#b}{b}{/}\n\n{#c}{c}{/}", { resolve });
    expect(out.text).toBe("B");
  });

  it("takes one line break with a dropped block, keeping single-newline joins intact", () => {
    const { resolve } = resolverFrom({ a: "A", c: "C" });
    // Three single-newline-joined sections with the middle one absent must read
    // as two lines, not as two lines with a gap between them.
    expect(renderTemplateText("{#a}{a}{/}\n{#b}{b}{/}\n{#c}{c}{/}", { resolve }).text).toBe("A\nC");
  });

  it("keeps a deliberate blank line between two surviving sections", () => {
    const { resolve } = resolverFrom({ a: "A", c: "C" });
    expect(renderTemplateText("{#a}{a}{/}\n\n{#c}{c}{/}", { resolve }).text).toBe("A\n\nC");
  });

  it("swallows only one break, so a dropped section between paragraphs still leaves one", () => {
    const { resolve } = resolverFrom({ a: "A", c: "C" });
    expect(renderTemplateText("{#a}{a}{/}\n\n{#b}{b}{/}\n\n{#c}{c}{/}", { resolve }).text).toBe("A\n\nC");
  });

  it("charges a sourceless slot to the section it sits in", () => {
    const seen = new Map<string, number>();
    const resolve = (req: SlotRequest): SlotResult => {
      seen.set(req.name, req.budgetLeft);
      return { text: req.name === "clock" ? "18:22:04" : req.name === "vision_faces" ? "- Ada" : "" };
    };
    renderTemplateText("{#vision_faces}at {clock}:\n{vision_faces}{/}", {
      resolve,
      role: "chat-context",
      budgets: { vision: 100 },
    });
    // "at " charged 3, then the clock's own 8 characters come out of vision too,
    // so the face list is asked with 100 - 3 - 8 - 2 left.
    expect(seen.get("vision_faces")).toBe(87);
  });

  it("never removes a line that still has literal text on it", () => {
    // The heading survives, visibly, because it was not wrapped in a block.
    // That is the whole difference between this and an auto-prune heuristic.
    const { resolve } = resolverFrom({});
    const out = renderTemplateText("Who I can see:\n{vision_faces}", { resolve });
    expect(out.text).toBe("Who I can see:");
  });

  it("charges literal text against the budget before the slot beneath it", () => {
    const seen: SlotRequest[] = [];
    const resolve = (req: SlotRequest): SlotResult => {
      seen.push(req);
      return { text: "x".repeat(Math.min(req.budgetLeft, 100)) };
    };
    const out = renderTemplateText("{#session_remarks}12345\n{session_remarks}{/}", {
      resolve,
      role: "chat-context",
      budgets: { session: 20 },
    });
    // Six characters of heading and newline are spent before the slot is asked.
    expect(seen.at(-1)?.budgetLeft).toBe(14);
    expect(out.text).toBe(`12345\n${"x".repeat(14)}`);
  });

  it("gives a dropped block's spend back to a later slot", () => {
    const budgets: number[] = [];
    const resolve = (req: SlotRequest): SlotResult => {
      budgets.push(req.budgetLeft);
      return req.name === "vision_caption" ? { text: "kept" } : { text: "" };
    };
    renderTemplateText("{#vision_faces}wasted padding here{vision_faces}{/}{#vision_caption}{vision_caption}{/}", {
      resolve,
      role: "chat-context",
      budgets: { vision: 100 },
    });
    // The caption is asked with the full budget: the dropped block refunded the
    // literal text it charged for.
    expect(budgets.at(-1)).toBe(100);
  });

  it("keeps the two chat budgets independent", () => {
    const seen = new Map<string, number>();
    const resolve = (req: SlotRequest): SlotResult => {
      seen.set(req.name, req.budgetLeft);
      return { text: req.name === "vision_faces" ? "y".repeat(req.budgetLeft) : "" };
    };
    renderTemplateText("{vision_faces}{session_remarks}", {
      resolve,
      role: "chat-context",
      budgets: { vision: 30, session: 40 },
    });
    expect(seen.get("vision_faces")).toBe(30);
    // Exhausting vision left session untouched.
    expect(seen.get("session_remarks")).toBe(40);
  });

  it("resolves a slot once even when it appears twice", () => {
    let calls = 0;
    const resolve = (): SlotResult => {
      calls += 1;
      return { text: "once" };
    };
    const out = renderTemplateText("{clock} and {clock}", { resolve, role: "chat-context" });
    expect(out.text).toBe("once and once");
    expect(calls).toBe(1);
  });

  it("surfaces redactions from a slot that rendered, and not from one that dropped", () => {
    const resolve = (req: SlotRequest): SlotResult =>
      req.name === "vision_profiles"
        ? { text: "You know Ada: a person", redact: ["a person"] }
        : { text: "", redact: ["never sent"] };
    const out = renderTemplateText("{#vision_profiles}{vision_profiles}{/}{#vision_faces}{vision_faces}{/}", {
      resolve,
      role: "chat-context",
    });
    expect(out.redact).toEqual(["a person"]);
  });

  it("renders an unknown slot empty and reports it as degraded", () => {
    const { resolve } = resolverFrom({});
    const out = renderTemplateText("kept {gone_away}", { resolve, role: "chat-context" });
    expect(out.text).toBe("kept");
    expect(out.degraded).toEqual(["gone_away"]);
  });

  it("uses a condition slot to pick one branch and emits no marker for it", () => {
    const resolve = (req: SlotRequest): SlotResult => ({
      text: req.name === "reason_interrupt" ? "yes" : req.name === "monitor_label" ? "syslog" : "",
    });
    const out = renderTemplateText(
      "{#reason_interrupt}Something in {monitor_label} looks wrong. Report it now.{/}" +
        "{#reason_cycle}Activity in {monitor_label}. Summarise it.{/}",
      { resolve, role: "monitor-user" },
    );
    expect(out.text).toBe("Something in syslog looks wrong. Report it now.");
    expect(out.text).not.toContain("yes");
  });

  it("drops a block whose condition held but whose body came out blank", () => {
    const resolve = (req: SlotRequest): SlotResult => ({ text: req.name === "reason_cycle" ? "yes" : "" });
    const out = renderTemplateText("A\n\n{#reason_cycle}{monitor_lines}{/}\n\nB", { resolve, role: "monitor-user" });
    expect(out.text).toBe("A\n\nB");
  });

  it("renders a template with structural errors rather than refusing", () => {
    const { resolve } = resolverFrom({ clock: "12:00:00" });
    const out = renderTemplateText("{#unclosed}at {clock}", { resolve });
    expect(out.text).toContain("12:00:00");
  });
});

describe("vocabulary", () => {
  it("gives every slot a meaning and a rationale note", () => {
    for (const role of TEMPLATE_ROLES) {
      for (const spec of SLOT_VOCABULARY[role]) {
        expect(spec.meaning.trim(), `${role}/${spec.name} meaning`).not.toBe("");
        expect(spec.note.trim(), `${role}/${spec.name} note`).not.toBe("");
      }
    }
  });

  it("declares a budget source on chat slots and on nothing else", () => {
    const chatSourced = SLOT_VOCABULARY["chat-context"].filter((s) => s.source);
    expect(chatSourced.length).toBeGreaterThan(0);
    for (const role of TEMPLATE_ROLES) {
      if (role === "chat-context") continue;
      for (const spec of SLOT_VOCABULARY[role]) {
        expect(spec.source, `${role}/${spec.name}`).toBeUndefined();
      }
    }
  });

  it("marks only the identity-bearing slots", () => {
    const identity = TEMPLATE_ROLES.flatMap((role) =>
      SLOT_VOCABULARY[role].filter((s) => s.identity).map((s) => s.name),
    );
    expect(new Set(identity)).toEqual(
      new Set(["context", "vision_faces", "vision_recent_people", "vision_profiles", "known_people"]),
    );
  });

  it("uses unique slot names within a role", () => {
    for (const role of TEMPLATE_ROLES) {
      const names = slotNames(role);
      expect(new Set(names).size, role).toBe(names.length);
    }
  });
});
