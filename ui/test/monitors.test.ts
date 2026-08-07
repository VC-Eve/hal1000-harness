import { describe, it, expect } from "vitest";
import { describeSource, draftFromSuggestion, isAlreadyAdded, isComplete, suggestionRow } from "../src/monitors";
import type { Monitor, MonitorSuggestion } from "../../shared/src/types";

const monitor = (over: Partial<Monitor> = {}): Monitor => ({
  id: "m1",
  label: "systemd journal",
  source: { kind: "command", command: "journalctl -n 50", intervalMs: 30_000 },
  verbosity: "quiet",
  cycleMs: 300_000,
  color: "#9ec5d8",
  enabled: true,
  ...over,
});

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
    expect(row.added).toBe(false);
    expect(row.note).toBe("The whole machine's log.");
  });

  it("disables an unavailable suggestion and explains why (R15, AE6)", () => {
    const row = suggestionRow(suggestion({ available: false }));
    expect(row.disabled).toBe(true);
    expect(row.added).toBe(false);
    expect(row.note).toMatch(/not present on this machine/i);
    // The reason is kept too: knowing what it would have watched is the point.
    expect(row.note).toContain("The whole machine's log.");
  });

  it("marks a suggestion already added, and says so rather than repeating the pitch", () => {
    const s = suggestion();
    const row = suggestionRow(s, [monitor({ source: s.source })]);
    expect(row.added).toBe(true);
    expect(row.disabled).toBe(true);
    expect(row.note).toMatch(/already watching/i);
  });

  it("keeps added distinct from unavailable, since they mean opposite things", () => {
    const s = suggestion({ available: false });
    const row = suggestionRow(s, [monitor({ source: s.source })]);
    // Added wins: it is watching, whatever the probe currently says.
    expect(row.added).toBe(true);
    expect(row.note).toMatch(/already watching/i);
  });
});

describe("isAlreadyAdded", () => {
  it("matches on the source, not the label", () => {
    const s = suggestion();
    // A renamed monitor still watches the same thing.
    expect(isAlreadyAdded(s, [monitor({ label: "renamed by hand", source: s.source })])).toBe(true);
  });

  it("does not match a different target of the same kind", () => {
    const s = suggestion();
    const other = monitor({ source: { kind: "command", command: "journalctl -p err", intervalMs: 30_000 } });
    expect(isAlreadyAdded(s, [other])).toBe(false);
  });

  it("does not match across source kinds", () => {
    const fileSuggestion = suggestion({ source: { kind: "file", path: "/var/log/syslog" } });
    const commandMonitor = monitor({ source: { kind: "command", command: "/var/log/syslog", intervalMs: 30_000 } });
    expect(isAlreadyAdded(fileSuggestion, [commandMonitor])).toBe(false);
  });

  it("ignores an interval difference, since the target is the same", () => {
    const s = suggestion();
    const slower = monitor({ source: { kind: "command", command: "journalctl -n 50", intervalMs: 999_000 } });
    expect(isAlreadyAdded(s, [slower])).toBe(true);
  });

  it("reports false against an empty list", () => {
    expect(isAlreadyAdded(suggestion(), [])).toBe(false);
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
