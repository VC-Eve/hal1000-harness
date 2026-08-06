import type { MonitorSeverity } from "../../../shared/src/types.js";

// Severity, decided without the model (R11) so a severe line is recognised even
// while chat is streaming. Pure by construction: no I/O, no async, nothing
// imported from the provider or storage layers.
//
// Two tiers, because the sources genuinely differ. Structured commands state a
// level — Get-WinEvent has LevelDisplayName, journalctl -o json has PRIORITY —
// and that is authoritative. A plain text tail states nothing (the Ollama
// server log is raw llama.cpp slot output with no levels or timestamps), so
// keywords are the only signal available there.

// Level vocabulary from the sources we ship suggestions for. Windows uses
// words; journald uses numeric syslog priorities where 0-3 is error or worse.
const SEVERE_LEVELS = new Set(["error", "critical", "fatal", "alert", "emerg", "emergency", "err"]);

// Deliberately conservative. A monitor that cries wolf gets switched off, so a
// false negative is cheaper than a false positive. Matched on word boundaries
// so "errors" counts but "terror" does not.
const SEVERE_KEYWORDS = [
  "error",
  "errors",
  "fail",
  "failed",
  "failure",
  "fatal",
  "panic",
  "exception",
  "critical",
  "denied",
  "refused",
  "timeout",
  "timed out",
  "out of memory",
  "segfault",
  "segmentation fault",
];

const KEYWORD_PATTERN = new RegExp(`(?:^|[^a-z0-9])(?:${SEVERE_KEYWORDS.join("|")})(?:[^a-z0-9]|$)`, "i");

// A level the source stated. Accepts the word forms Windows emits and the
// numeric priorities journald emits; anything unrecognised is not severe,
// because guessing from an unknown vocabulary is how false positives start.
export function severityFromLevel(level: string | number | undefined | null): MonitorSeverity | null {
  if (level === undefined || level === null) return null;
  if (typeof level === "number") return Number.isFinite(level) && level <= 3 ? "severe" : "routine";
  const trimmed = level.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  // journald priorities arrive as strings over JSON.
  if (/^\d+$/.test(trimmed)) return Number(trimmed) <= 3 ? "severe" : "routine";
  return SEVERE_LEVELS.has(trimmed) ? "severe" : "routine";
}

export function severityFromText(text: string): MonitorSeverity {
  return KEYWORD_PATTERN.test(text) ? "severe" : "routine";
}

// The whole decision: a stated level wins outright, including when it says the
// line is routine despite alarming words. Only an unstated level falls back to
// guessing from the text.
export function classify(text: string, level?: string | number | null): MonitorSeverity {
  return severityFromLevel(level) ?? severityFromText(text);
}
