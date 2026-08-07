import { describe, it, expect } from "vitest";
import { MAX_SEVERITY_PATTERN, classify, compileSeverityRule, severityFromLevel, severityFromText } from "../../src/monitors/severity.js";

describe("severity from a stated level", () => {
  it("treats Windows error-class levels as severe", () => {
    for (const level of ["Error", "Critical", "error", "CRITICAL"]) {
      expect(severityFromLevel(level)).toBe("severe");
    }
  });

  it("treats Windows informational levels as routine", () => {
    for (const level of ["Information", "Verbose", "Warning"]) {
      expect(severityFromLevel(level)).toBe("routine");
    }
  });

  it("reads journald numeric priorities, severe at 3 and below", () => {
    expect(severityFromLevel(0)).toBe("severe");
    expect(severityFromLevel(3)).toBe("severe");
    expect(severityFromLevel(4)).toBe("routine");
    expect(severityFromLevel(6)).toBe("routine");
    // journald priorities arrive as strings over JSON output.
    expect(severityFromLevel("3")).toBe("severe");
    expect(severityFromLevel("6")).toBe("routine");
  });

  it("reports no opinion when the source stated nothing", () => {
    expect(severityFromLevel(undefined)).toBeNull();
    expect(severityFromLevel(null)).toBeNull();
    expect(severityFromLevel("   ")).toBeNull();
  });

  it("reports no opinion for an unrecognised level vocabulary", () => {
    // Not "routine": an unknown word is not a level, and treating it as one
    // would suppress keyword severity for every tab-containing line.
    expect(severityFromLevel("catastrophe")).toBeNull();
    expect(severityFromLevel("Service Control Manager")).toBeNull();
  });
});

describe("severity from text", () => {
  it("matches error keywords", () => {
    expect(severityFromText("connection failed after 3 retries")).toBe("severe");
    expect(severityFromText("FATAL: cannot allocate")).toBe("severe");
    expect(severityFromText("llama_model_load: out of memory")).toBe("severe");
  });

  it("is case-insensitive", () => {
    expect(severityFromText("ERROR loading model")).toBe("severe");
    expect(severityFromText("error loading model")).toBe("severe");
  });

  it("does not match a keyword embedded in an unrelated word", () => {
    // The classic false positive: "terror" contains "error".
    expect(severityFromText("the terrorist plot subplot")).toBe("routine");
    expect(severityFromText("failover completed cleanly")).toBe("routine");
  });

  it("leaves ordinary lines routine", () => {
    // A real line from the Ollama server log — busy, structured, unremarkable.
    expect(severityFromText("slot launch_slot_: id  0 | task 4394 | processing task, is_child = 0")).toBe("routine");
    expect(severityFromText("")).toBe("routine");
    expect(severityFromText("   \t ")).toBe("routine");
  });
});

describe("classify", () => {
  it("lets a stated level override alarming text", () => {
    // Get-WinEvent routinely reports informational events whose message text
    // mentions failures; trusting the text would flood the feed.
    expect(classify("The service failed to start on a previous attempt", "Information")).toBe("routine");
  });

  it("lets a stated level mark a bland line severe", () => {
    expect(classify("Service control operation completed", "Error")).toBe("severe");
  });

  it("falls back to text when no level is stated", () => {
    expect(classify("disk write failed")).toBe("severe");
    expect(classify("disk write completed")).toBe("routine");
  });

  it("falls back to text when the stated level is not a level at all", () => {
    // A plain line that merely contains tabs must not have its first field
    // treated as a level and its severity suppressed.
    expect(classify("FATAL: allocation refused", "some-component")).toBe("severe");
  });

  it("is synchronous and does no I/O", () => {
    // Guards R11: severity must be decidable while chat holds the model.
    const result = classify("error");
    expect(result).toBe("severe");
    expect(result).not.toBeInstanceOf(Promise);
  });
});

describe("per-monitor severity rules", () => {
  const ollamaRoutine = "slot update_slots: id  0 | task 4394 | checkpoint check failed, restoring";

  it("never interrupts when the rule says never, whatever the text", () => {
    expect(classify("FATAL: out of memory", undefined, { kind: "never" })).toBe("routine");
  });

  it("never overrides even a stated error level", () => {
    // An explicit instruction, not a hint to be weighed.
    expect(classify("The device is not ready", "Error", { kind: "never" })).toBe("routine");
  });

  it("uses the monitor's own pattern instead of the shipped keywords", () => {
    const rule = { kind: "pattern", pattern: "out of memory|cuda error" } as const;
    // The line the shipped keywords got wrong on the real Ollama log.
    expect(classify(ollamaRoutine, undefined, rule)).toBe("routine");
    expect(classify("ggml_backend_cuda: out of memory", undefined, rule)).toBe("severe");
  });

  it("matches a pattern case-insensitively", () => {
    const rule = { kind: "pattern", pattern: "out of memory" } as const;
    expect(classify("OUT OF MEMORY", undefined, rule)).toBe("severe");
  });

  it("lets a stated level win over a pattern, since the source knows better", () => {
    const rule = { kind: "pattern", pattern: "never matches anything here" } as const;
    expect(classify("Some message", "Error", rule)).toBe("severe");
    expect(classify("out of memory mentioned", "Information", rule)).toBe("routine");
  });

  it("falls back to the shipped keywords when the pattern will not compile", () => {
    // Deaf is worse than noisy: a broken rule must not silence a monitor.
    const broken = { kind: "pattern", pattern: "unclosed (group" } as const;
    expect(classify("disk write failed", undefined, broken)).toBe("severe");
    expect(classify("all is well", undefined, broken)).toBe("routine");
  });

  it("falls back when the pattern is empty or absurdly long", () => {
    expect(classify("disk write failed", undefined, { kind: "pattern", pattern: "" })).toBe("severe");
    const huge = "a|".repeat(MAX_SEVERITY_PATTERN);
    expect(classify("disk write failed", undefined, { kind: "pattern", pattern: huge })).toBe("severe");
  });

  it("treats an explicit default rule exactly as no rule at all", () => {
    expect(classify(ollamaRoutine, undefined, { kind: "default" })).toBe(classify(ollamaRoutine));
    expect(classify("panic: nil", undefined, { kind: "default" })).toBe("severe");
  });

  it("compiles a rule once for reuse across lines", () => {
    const compiled = compileSeverityRule({ kind: "pattern", pattern: "boom" });
    expect(compiled).toBeInstanceOf(RegExp);
    expect(classify("boom", undefined, { kind: "pattern", pattern: "boom" }, compiled)).toBe("severe");
    expect(compileSeverityRule({ kind: "never" })).toBeNull();
    expect(compileSeverityRule(undefined)).toBeNull();
    expect(compileSeverityRule({ kind: "pattern", pattern: "unclosed (" })).toBeNull();
  });
});
