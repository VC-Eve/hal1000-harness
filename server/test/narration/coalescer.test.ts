import { describe, it, expect } from "vitest";
import { Coalescer, eventLine } from "../../src/narration/coalescer.js";
import type { SessionEvent } from "../../src/watchers/watcher.js";

const ev = (text: string, kind: SessionEvent["kind"] = "assistant", tools: string[] = []): SessionEvent => ({
  at: "t",
  kind,
  text,
  toolUses: tools,
});

describe("Coalescer", () => {
  it("drains everything pending into lines with tool annotations", () => {
    const c = new Coalescer();
    c.push([ev("edited file", "assistant", ["Edit"]), ev("run tests", "user")], "claude-code");
    const { result } = c.drain();
    expect(result.lines).toEqual(["[assistant] edited file (tools: Edit)", "[user] run tests"]);
    expect(c.size).toBe(0);
  });

  it("keeps newest events verbatim and folds overflow into one aggregate line", () => {
    const c = new Coalescer();
    const events = Array.from({ length: 10 }, (_, i) => ev(`event number ${i} ${"x".repeat(40)}`, i % 2 ? "user" : "assistant"));
    c.push(events, "claude-code");
    const { result } = c.drain(150);
    expect(result.lines[0]).toMatch(/^…plus \d+ earlier events not shown/);
    expect(result.lines.at(-1)).toContain("event number 9");
    // Oldest events are not present verbatim.
    expect(result.lines.join("\n")).not.toContain("event number 0 ");
  });

  it("requeue puts events back at the front for re-narration", () => {
    const c = new Coalescer();
    c.push([ev("first")], "claude-code");
    const { events } = c.drain();
    c.push([ev("second")], "claude-code");
    c.requeue(events, "claude-code");
    const { result } = c.drain();
    expect(result.lines).toEqual([eventLine(ev("first")), eventLine(ev("second"))]);
  });
});

// The narration system prompt contains a glossary of this exact format. Both
// halves are editable now; these pin that the shipped half still says what the
// glossary claims, and that an edit reaches the line.
describe("the log-line format is a Phrase", () => {
  const KINDS: SessionEvent["kind"][] = ["user", "assistant", "thinking", "tool-result", "system"];

  it("renders each tag the narration prompt's glossary names", () => {
    for (const kind of KINDS) {
      expect(eventLine(ev("did a thing", kind))).toBe(`[${kind}] did a thing`);
    }
  });

  it("annotates tools exactly as the glossary quotes it", () => {
    expect(eventLine(ev("edited", "assistant", ["Edit(a.ts)"]))).toBe("[assistant] edited (tools: Edit(a.ts))");
  });

  it("joins several tools with one separator", () => {
    expect(eventLine(ev("worked", "assistant", ["Read(a.ts)", "Bash(npm test)"]))).toBe(
      "[assistant] worked (tools: Read(a.ts), Bash(npm test))",
    );
  });

  it("omits the annotation entirely when nothing was invoked", () => {
    expect(eventLine(ev("just talking", "user"))).toBe("[user] just talking");
  });

  it("an edited phrase changes the line", () => {
    const line = eventLine(ev("edited", "assistant", ["Edit"]), {
      "narration.event_line": "{kind} said: {text}{tools}",
      "narration.tool_list": " [used {tools}]",
    });
    expect(line).toBe("assistant said: edited [used Edit]");
  });

  it("an edited separator reaches every item in the list", () => {
    const line = eventLine(ev("worked", "assistant", ["Read", "Edit"]), { "narration.list_join": " then " });
    expect(line).toBe("[assistant] worked (tools: Read then Edit)");
  });

  it("the overflow notice is a phrase, and an edit reaches it", () => {
    const c = new Coalescer();
    const events = Array.from({ length: 10 }, (_, i) => ev(`event number ${i} ${"x".repeat(40)}`, i % 2 ? "user" : "assistant"));
    c.push(events, "claude-code");
    const shipped = c.drain(150).result.lines[0]!;
    expect(shipped).toMatch(/^…plus \d+ earlier events not shown \(\d+ \w+(, \d+ [\w-]+)*\)\.$/);

    c.push(events, "claude-code");
    const edited = c.drain(150, {
      "narration.events_omitted": "({count} dropped: {kinds})",
      "narration.omitted_kind": "{kind}×{count}",
    }).result.lines[0]!;
    expect(edited).toMatch(/^\(\d+ dropped: \w+×\d+/);
  });

  it("phrases left unedited render byte-identically to the format they replaced", () => {
    const literal = (e: SessionEvent) =>
      `[${e.kind}] ${e.text.replace(/\s+/g, " ").trim()}${e.toolUses.length > 0 ? ` (tools: ${e.toolUses.join(", ")})` : ""}`;
    const cases = [
      ev("plain", "user"),
      ev("  collapses   whitespace\n\n", "assistant"),
      ev("one tool", "assistant", ["Read(x)"]),
      ev("two tools", "tool-result", ["Read(x)", "Write(y)"]),
      ev("braces {kind} survive", "system"),
    ];
    for (const c of cases) expect(eventLine(c), c.kind).toBe(literal(c));
  });
});
