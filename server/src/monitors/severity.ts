import type { MonitorSeverity, MonitorSeverityRule } from "../../../shared/src/types.js";

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

// The rest of the vocabulary we recognise. This set is what makes "I have no
// opinion" distinguishable from "this is routine": without it, any word at all
// reads as a valid routine level, which silently turns every tab-containing log
// line into a structured record and suppresses keyword severity entirely.
const ROUTINE_LEVELS = new Set([
  "information",
  "informational",
  "info",
  "warning",
  "warn",
  "notice",
  "debug",
  "verbose",
  "trace",
]);

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
  if (SEVERE_LEVELS.has(trimmed)) return "severe";
  // Null, not "routine": an unrecognised word is not a level at all, and
  // claiming it is routine would mark a genuinely severe line unremarkable.
  return ROUTINE_LEVELS.has(trimmed) ? "routine" : null;
}

export function severityFromText(text: string): MonitorSeverity {
  return KEYWORD_PATTERN.test(text) ? "severe" : "routine";
}

// Longest pattern accepted. A user-authored regex runs against every line of
// every poll, so an unbounded one is a foot-gun; this at least keeps it a
// readable expression rather than a program.
export const MAX_SEVERITY_PATTERN = 200;

// Compiles a monitor's pattern once, not per line. Returns null when the rule
// is not a usable pattern — an invalid regex falls back to the shipped keyword
// rule rather than making the monitor silently deaf.
export function compileSeverityRule(rule: MonitorSeverityRule | undefined): RegExp | null {
  if (!rule || rule.kind !== "pattern") return null;
  if (rule.pattern.length === 0 || rule.pattern.length > MAX_SEVERITY_PATTERN) return null;
  try {
    return new RegExp(rule.pattern, "i");
  } catch {
    return null;
  }
}

// The whole decision: a stated level wins outright, including when it says the
// line is routine despite alarming words. Only an unstated level falls back to
// guessing from the text — by the monitor's own pattern when it has one, and by
// the shipped keyword list otherwise.
//
// `never` short-circuits everything: it is an explicit instruction that this
// source should not interrupt, not a hint to be weighed against a stated level.
export function classify(
  text: string,
  level?: string | number | null,
  rule?: MonitorSeverityRule,
  compiled?: RegExp | null,
): MonitorSeverity {
  if (rule?.kind === "never") return "routine";
  const stated = severityFromLevel(level);
  if (stated !== null) return stated;
  const pattern = compiled ?? compileSeverityRule(rule);
  if (pattern) return pattern.test(text) ? "severe" : "routine";
  // A pattern rule whose regex would not compile falls through to the default
  // keyword list — deaf is worse than noisy.
  return severityFromText(text);
}
