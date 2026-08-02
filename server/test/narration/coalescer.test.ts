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
    c.push([ev("edited file", "assistant", ["Edit"]), ev("run tests", "user")]);
    const { result } = c.drain();
    expect(result.lines).toEqual(["[assistant] edited file (tools: Edit)", "[user] run tests"]);
    expect(c.size).toBe(0);
  });

  it("keeps newest events verbatim and folds overflow into one aggregate line", () => {
    const c = new Coalescer();
    const events = Array.from({ length: 10 }, (_, i) => ev(`event number ${i} ${"x".repeat(40)}`, i % 2 ? "user" : "assistant"));
    c.push(events);
    const { result } = c.drain(150);
    expect(result.lines[0]).toMatch(/^…plus \d+ earlier events not shown/);
    expect(result.lines.at(-1)).toContain("event number 9");
    // Oldest events are not present verbatim.
    expect(result.lines.join("\n")).not.toContain("event number 0 ");
  });

  it("requeue puts events back at the front for re-narration", () => {
    const c = new Coalescer();
    c.push([ev("first")]);
    const { events } = c.drain();
    c.push([ev("second")]);
    c.requeue(events);
    const { result } = c.drain();
    expect(result.lines).toEqual([eventLine(ev("first")), eventLine(ev("second"))]);
  });
});
