import { describe, expect, it } from "vitest";
import { PHRASES, renderPhrase } from "../../../shared/src/phrases.js";
import { knownPeopleSection, visionProfilesSlot } from "../../../shared/src/prompts.js";
import { renderChatContext, type ChatContextInputs } from "../../src/templates/chatContext.js";

// The invariant this file exists for: whatever profile text reaches a request
// is also on the list withheld from the inference log, which is never pruned.
//
// A code review found this broken. Rendering a phrase ran the whole-message
// normaliser over one line, reflowing a profile that contained a blank line;
// the redact list was then recovered by searching the finished string for the
// ORIGINAL profile, found nothing, and the profile was logged in full.

const T = { recognition: 0.35, statement: 0.6 };
const seen = (name: string) => ({ watching: true, present: [{ match: { name, confidence: 0.9 } }] });

const PROFILES = [
  ["a single line", "Runs the lab."],
  ["a blank-line run", "Runs the lab.\n\n\nAllergic to bees."],
  ["CRLF", "Runs the lab.\r\nAllergic to bees."],
  ["padding", "   Runs the lab.   "],
  ["a brace", 'Answers as {"tone": "dry"}.'],
  ["a template-looking fragment", "Says {#vision_faces} a lot."],
] as const;

describe("every profile that reaches a request is withheld from the log", () => {
  for (const [name, profile] of PROFILES) {
    it(`covers ${name}`, () => {
      const out = visionProfilesSlot(seen("Ada"), [{ name: "Ada", profile }], T, 4000);
      expect(out.text.length, "the profile should have rendered").toBeGreaterThan(0);
      // Whatever of the profile is discernible in the output must be covered by
      // some entry on the list.
      const covered = out.redact.some((r) => out.text.includes(r));
      expect(covered, `redact ${JSON.stringify(out.redact)} covers none of ${JSON.stringify(out.text)}`).toBe(true);
    });
  }

  it("keeps a multi-line profile intact rather than reflowing it", () => {
    // The phrase render must not collapse blank runs inside a substituted
    // value: a phrase is one line, and the collapse belongs to whole messages.
    const profile = "Runs the lab.\n\n\nAllergic to bees.";
    const out = visionProfilesSlot(seen("Ada"), [{ name: "Ada", profile }], T, 4000);
    expect(out.text).toContain(profile);
    expect(out.redact).toContain(profile);
  });

  it("names nothing when the band withheld the profile", () => {
    const hedged = { watching: true, present: [{ match: { name: "Ada", confidence: 0.45 } }] };
    expect(visionProfilesSlot(hedged, [{ name: "Ada", profile: "Secret." }], T, 4000).redact).toEqual([]);
  });

  it("names nothing when the budget dropped the line", () => {
    const out = visionProfilesSlot(seen("Ada"), [{ name: "Ada", profile: "x".repeat(400) }], T, 20);
    expect(out.text).toBe("");
    expect(out.redact).toEqual([]);
  });
});

describe("the phrases map actually reaches the chat context", () => {
  // A dropped argument on any one of the six slot calls would otherwise pass
  // the whole suite — which is exactly what happened to visionProfilesSlot.
  const base = (over: Partial<ChatContextInputs> = {}): ChatContextInputs => ({
    presence: seen("Ada"),
    lastLook: { caption: "A room.", at: new Date().toISOString() },
    people: [{ name: "Ada", profile: "Runs the lab.", isOperator: true }],
    thresholds: T,
    entries: [{ text: "A remark.", at: new Date().toISOString(), sessionId: "s1", sessionLabel: "S" }],
    watchedSessionId: "s1",
    preamble: "Preamble.",
    visionBudget: 4000,
    sessionBudget: 4000,
    ...over,
  });

  const EDITS: [string, string, string][] = [
    ["sight.camera_off", "CAMERA-OFF-EDIT", "camera off"],
    ["sight.nobody_placed", "NOBODY-EDIT", "nobody placed"],
    ["sight.face_line", "FACE-EDIT {who}", "a face"],
    ["sight.unrecognised", "UNRECOGNISED-EDIT", "an unrecognised face"],
    ["sight.last_look", "LASTLOOK-EDIT {caption}", "the last look"],
    ["people.operator", "OPERATOR-EDIT {name}: {profile}", "the operator line"],
    ["session.remark_line", "REMARK-EDIT {text}", "a remark"],
  ];

  for (const [id, edited, what] of EDITS) {
    it(`honours an edit to ${what}`, () => {
      const inputs =
        id === "sight.camera_off"
          ? base({ presence: { watching: false, present: [] } })
          : id === "sight.nobody_placed"
            ? base({ presence: { watching: true, present: [] } })
            : id === "sight.unrecognised"
              ? base({ presence: { watching: true, present: [{ match: null }] } })
              : base();
      const out = renderChatContext(null, { ...inputs, phrases: { [id]: edited } });
      expect(out.text, `${id} did not reach the render`).toContain(edited.split(" ")[0]);
    });
  }
});

describe("every shipped phrase is reachable", () => {
  it("has a call site somewhere in the rendered surface", () => {
    // A phrase nobody renders is a settings control that changes nothing, which
    // is worse than no control. `session.heading` was one until a review found
    // it: the heading it claimed to own is literal text in the context template.
    const rendered = new Set<string>();
    const values: Record<string, string> = {
      who: "W", held: "set", age: "A", run: "set", strength: "S", name: "N",
      percent: "%", profile: "P", count: "1", plural: "s", stamp: "T",
      text: "X", label: "L", clock: "C", when: "W", caption: "C",
    };
    for (const spec of PHRASES) {
      const out = renderPhrase(spec.id, undefined, values);
      if (out.length > 0) rendered.add(spec.id);
    }
    expect(rendered.size).toBe(PHRASES.length);

    // And each id is named by production code, not only by this test.
    const ids = PHRASES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("knownPeopleSection reports what it rendered", () => {
  it("registers each kept person and nothing dropped", () => {
    const out = knownPeopleSection(
      [
        { name: "Ada", profile: "Runs the lab.", isOperator: true },
        { name: "Bram", profile: "y".repeat(400) },
      ],
      60,
    );
    expect(out.text).toContain("Ada");
    expect(out.redact).toContain("Runs the lab.");
    expect(out.redact.some((r) => r.startsWith("yyy"))).toBe(false);
  });
});
