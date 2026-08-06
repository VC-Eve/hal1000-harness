import type { MonitorEvent, MonitorSource } from "../../../shared/src/types.js";

// Defaults chosen so a Monitor added from a suggestion needs no form filling.
// The cycle is deliberately long: a quiet Monitor summarising every minute
// would cost sixty model calls an hour against a single local model that chat
// already preempts. Five minutes is ambient; a minute is chatter.
export const DEFAULT_CYCLE_MS = 300_000;
export const DEFAULT_POLL_MS = 30_000;

// Floor on how often a command may run. A stored zero would otherwise schedule
// a shell process as fast as the poll guard releases.
export const MIN_POLL_MS = 5_000;

// A single file read is bounded too: a log that gains hundreds of megabytes
// between polls must not be allocated whole. The excess is skipped with a
// notice rather than buffered.
export const FILE_READ_CAP = 4 * 1024 * 1024;

// Bounds on command acquisition. The cap is applied to captured output before
// it becomes events, so a runaway command cannot grow the process unbounded.
export const COMMAND_TIMEOUT_MS = 20_000;
export const COMMAND_OUTPUT_CAP = 256 * 1024;

// How many recently emitted lines a command monitor remembers. A command that
// re-emits a window (Get-WinEvent -MaxEvents N) is deduped against this; a line
// that scrolls out of it and reappears would be emitted twice, so the window is
// larger than any suggested command's output.
export const LINE_WINDOW = 500;

// The runner seam. `MonitorService` owns the schedule; a runner only knows how
// to answer "what is new since last time" for one source.
export interface MonitorRunner {
  poll(): Promise<MonitorPollResult>;
}

export interface MonitorPollResult {
  events: MonitorEvent[];
  // Set when the source could not be read this time — a missing file, a failing
  // command. Reported in persona and retried; never terminal (R5).
  problem?: string;
}

export function pollIntervalMs(source: MonitorSource): number {
  return source.kind === "command" ? source.intervalMs : DEFAULT_POLL_MS;
}
