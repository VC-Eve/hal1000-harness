import type { MonitorDraft, MonitorSource, MonitorSuggestion } from "../../shared/src/types";

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

export interface SuggestionRow {
  suggestion: MonitorSuggestion;
  disabled: boolean;
  // Why it cannot be added, or why it is worth adding when it can.
  note: string;
}

// An unavailable suggestion is shown and explained rather than hidden: knowing
// a log exists but is absent here is more useful than a shorter list, and the
// user told us they do not know which logs to watch (R15).
export function suggestionRow(suggestion: MonitorSuggestion): SuggestionRow {
  return {
    suggestion,
    disabled: !suggestion.available,
    note: suggestion.available ? suggestion.reason : `Not present on this machine. ${suggestion.reason}`,
  };
}

// A suggestion becomes a Monitor without the user composing anything. Quiet by
// default: a machine log is watched for the exception, not narrated line by line.
export function draftFromSuggestion(suggestion: MonitorSuggestion): MonitorDraft {
  return { label: suggestion.label, source: suggestion.source, verbosity: "quiet" };
}
