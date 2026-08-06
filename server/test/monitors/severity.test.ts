import { describe, it, expect } from "vitest";
import { classify, severityFromLevel, severityFromText } from "../../src/monitors/severity.js";

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
