import type { Monitor, MonitorDraft, MonitorSource, MonitorSuggestion } from "../../shared/src/types";

// Monitor-editor decisions, kept pure so they are testable without a component
// harness — the same shape as lens.ts, colors.ts, and prompts.ts.

// Can this configuration actually run? A blank path or command would poll
// nothing forever, and a non-positive interval would spin.
export function isComplete(source: MonitorSource): boolean {
  if (source.kind === "file") return source.path.trim().length > 0;
  return source.command.trim().length > 0 && source.intervalMs > 0;
}

// What the drawer shows for a source. A command is rendered in full rather than
// elided: what HAL runs on a schedule must never be hidden (R6).
export function describeSource(source: MonitorSource): string {
  return source.kind === "file" ? source.path : source.command;
}

// Two sources are the same target when they point at the same file or run the
// same command. Compared on the source rather than the label or id: a monitor
// can be renamed, and its id is server-generated, so neither identifies what it
// is actually watching.
export function sourcesMatch(a: MonitorSource, b: MonitorSource): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "file" && b.kind === "file") return a.path === b.path;
  if (a.kind === "command" && b.kind === "command") return a.command === b.command;
  return false;
}

export function isAlreadyAdded(suggestion: MonitorSuggestion, monitors: Monitor[]): boolean {
  return monitors.some((m) => sourcesMatch(m.source, suggestion.source));
}

export interface SuggestionRow {
  suggestion: MonitorSuggestion;
  disabled: boolean;
  // Already a monitor. Distinct from `disabled`, because the two have different
  // causes and read differently: unavailable is a dead end, added is a success.
  added: boolean;
  // Why it cannot be added, or why it is worth adding when it can.
  note: string;
}

// An unavailable suggestion is shown and explained rather than hidden: knowing
// a log exists but is absent here is more useful than a shorter list, and the
// user told us they do not know which logs to watch (R15). One already added is
// shown too, marked, so the list stays a stable inventory rather than shrinking
// as you use it.
export function suggestionRow(suggestion: MonitorSuggestion, monitors: Monitor[] = []): SuggestionRow {
  const added = isAlreadyAdded(suggestion, monitors);
  const note = added
    ? "Already watching this."
    : suggestion.available
      ? suggestion.reason
      : `Not present on this machine. ${suggestion.reason}`;
  return { suggestion, disabled: added || !suggestion.available, added, note };
}

// A suggestion becomes a Monitor without the user composing anything. Quiet by
// default: a machine log is watched for the exception, not narrated line by line.
export function draftFromSuggestion(suggestion: MonitorSuggestion): MonitorDraft {
  return { label: suggestion.label, source: suggestion.source, verbosity: "quiet" };
}
