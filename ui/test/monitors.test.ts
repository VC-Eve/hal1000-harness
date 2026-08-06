import { describe, it, expect } from "vitest";
import { describeSource, draftFromSuggestion, isComplete, suggestionRow } from "../src/monitors";
import type { MonitorSuggestion } from "../../shared/src/types";

const suggestion = (over: Partial<MonitorSuggestion> = {}): MonitorSuggestion => ({
  id: "s1",
  label: "systemd journal",
  reason: "The whole machine's log.",
  source: { kind: "command", command: "journalctl -n 50", intervalMs: 30_000 },
  available: true,
  ...over,
});

describe("isComplete", () => {
  it("accepts a file source with a path", () => {
    expect(isComplete({ kind: "file", path: "/var/log/syslog" })).toBe(true);
  });

  it("rejects a file source with a blank path", () => {
    expect(isComplete({ kind: "file", path: "" })).toBe(false);
    expect(isComplete({ kind: "file", path: "   " })).toBe(false);
  });

  it("accepts a command source with a command and a positive interval", () => {
    expect(isComplete({ kind: "command", command: "journalctl", intervalMs: 30_000 })).toBe(true);
  });

  it("rejects a command source with a blank command", () => {
    expect(isComplete({ kind: "command", command: "  ", intervalMs: 30_000 })).toBe(false);
  });

  it("rejects a non-positive interval, which would spin", () => {
    expect(isComplete({ kind: "command", command: "journalctl", intervalMs: 0 })).toBe(false);
    expect(isComplete({ kind: "command", command: "journalctl", intervalMs: -1 })).toBe(false);
  });
});

describe("describeSource", () => {
  it("shows a file's path", () => {
    expect(describeSource({ kind: "file", path: "/var/log/auth.log" })).toBe("/var/log/auth.log");
  });

  it("shows a command in full rather than eliding it (R6)", () => {
    // What HAL runs on a schedule must be visible, however long.
    const command = "powershell -NoProfile -NonInteractive -Command \"Get-WinEvent -LogName System -MaxEvents 40\"";
    expect(describeSource({ kind: "command", command, intervalMs: 30_000 })).toBe(command);
  });
});

describe("suggestionRow", () => {
  it("enables an available suggestion and shows its reason", () => {
    const row = suggestionRow(suggestion());
    expect(row.disabled).toBe(false);
    expect(row.note).toBe("The whole machine's log.");
  });

  it("disables an unavailable suggestion and explains why (R15, AE6)", () => {
    const row = suggestionRow(suggestion({ available: false }));
    expect(row.disabled).toBe(true);
    expect(row.note).toMatch(/not present on this machine/i);
    // The reason is kept too: knowing what it would have watched is the point.
    expect(row.note).toContain("The whole machine's log.");
  });
});

describe("draftFromSuggestion", () => {
  it("carries the label and source through unchanged", () => {
    const s = suggestion();
    const draft = draftFromSuggestion(s);
    expect(draft.label).toBe(s.label);
    expect(draft.source).toEqual(s.source);
  });

  it("defaults to quiet, because a machine log is watched for the exception", () => {
    expect(draftFromSuggestion(suggestion()).verbosity).toBe("quiet");
  });
});
