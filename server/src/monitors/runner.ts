import { promises as fs } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { exec } from "node:child_process";
import crypto from "node:crypto";
import type {
  MonitorCommandSource,
  MonitorEvent,
  MonitorFileSource,
  MonitorSeverityRule,
} from "../../../shared/src/types.js";
import { readByteRange } from "../storage/byte-range.js";
import { renderPhrase, type PhraseSettings } from "../../../shared/src/phrases.js";
import { classify, compileSeverityRule, severityFromLevel } from "./severity.js";
import {
  COMMAND_OUTPUT_CAP,
  COMMAND_TIMEOUT_MS,
  FILE_READ_CAP,
  LINE_WINDOW,
  type MonitorPollResult,
  type MonitorRunner,
} from "./monitor.js";

// Splits a decoded block into lines, tolerating CRLF. Windows is the primary
// dev OS and a trailing carriage return would ride into every event's text.
function toLines(block: string): string[] {
  return block
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
    .filter((line) => line.trim().length > 0);
}

export function toEvents(lines: string[], at: string, rule?: MonitorSeverityRule, compiled?: RegExp | null): MonitorEvent[] {
  // A plain text tail states no level, so severity comes from the text alone —
  // by the monitor's own pattern when it has one.
  return lines.map((text) => ({ at, text, severity: classify(text, undefined, rule, compiled) }));
}

// Tails a file, answering "what is new since last time".
//
// Mirrors ClaudeCodeWatcher's offset handling — start at end of file, detect
// replacement by identity rather than by size, hold a partial trailing line
// until its newline arrives — because those behaviours are what make the tail
// predictable on Windows, not incidental details.
export class FileMonitorRunner implements MonitorRunner {
  private fileId: string | null = null;
  private offset = 0;
  private pending = "";
  private decoder = new StringDecoder("utf8");
  private initialized = false;
  // Compiled once per monitor, not once per line.
  private readonly compiled: RegExp | null;

  constructor(
    private readonly source: MonitorFileSource,
    private readonly rule?: MonitorSeverityRule,
    // A getter rather than a value: a runner outlives an edit to the wording,
    // and every other setting in this project is resolved per use.
    private readonly phrases: () => PhraseSettings | undefined = () => undefined,
  ) {
    this.compiled = compileSeverityRule(rule);
  }

  async poll(): Promise<MonitorPollResult> {
    let stat;
    try {
      stat = await fs.stat(this.source.path, { bigint: true });
    } catch {
      // Missing is recoverable, never terminal (R5): keep the schedule and
      // resync when it returns. Reset identity so the return is treated as a
      // replacement rather than resumed at a stale offset.
      this.fileId = null;
      this.initialized = false;
      return { events: [], problem: renderPhrase("monitor.source_unreadable", this.phrases(), { path: this.source.path }) };
    }

    const fileId = `${stat.dev}:${stat.ino}`;
    const size = Number(stat.size);

    if (!this.initialized) {
      // A Monitor observes from the present, never replaying history (R3).
      this.fileId = fileId;
      this.offset = size;
      this.pending = "";
      this.decoder = new StringDecoder("utf8");
      this.initialized = true;
      return { events: [] };
    }

    if (fileId !== this.fileId) {
      // Replaced under us: resync at the new end rather than reading another
      // file's bytes at this file's offset.
      this.fileId = fileId;
      this.offset = size;
      this.pending = "";
      this.decoder = new StringDecoder("utf8");
      return { events: [], problem: renderPhrase("monitor.source_replaced", this.phrases(), { path: this.source.path }) };
    }

    if (size < this.offset) {
      // Truncated — rotated in place, or emptied. Resync rather than emitting
      // the whole file as though it were new.
      this.offset = size;
      this.pending = "";
      this.decoder = new StringDecoder("utf8");
      return { events: [], problem: renderPhrase("monitor.source_truncated", this.phrases(), { path: this.source.path }) };
    }

    if (size === this.offset) return { events: [] };

    // Bounded: a log that gained hundreds of megabytes since the last poll must
    // not be allocated whole. Skipping to the tail keeps the monitor about now,
    // which is what a Monitor is for.
    let skipped = 0;
    if (size - this.offset > FILE_READ_CAP) {
      skipped = size - this.offset - FILE_READ_CAP;
      this.offset = size - FILE_READ_CAP;
      this.pending = "";
      this.decoder = new StringDecoder("utf8");
    }

    const chunk = this.decoder.write(await this.readRange(this.offset, size));
    this.offset = size;
    const combined = this.pending + chunk;
    const lastNewline = combined.lastIndexOf("\n");
    if (lastNewline < 0) {
      // Still mid-line: hold it rather than emitting a fragment. Capped, so a
      // source that never emits a newline cannot grow this without bound.
      this.pending = combined.length > FILE_READ_CAP ? combined.slice(-FILE_READ_CAP) : combined;
      return { events: [] };
    }
    this.pending = combined.slice(lastNewline + 1);
    const events = toEvents(toLines(combined.slice(0, lastNewline)), new Date().toISOString(), this.rule, this.compiled);
    return skipped > 0
      ? { events, problem: renderPhrase("monitor.source_outpaced", this.phrases(), { path: this.source.path }) }
      : { events };
  }

  private readRange(from: number, to: number): Promise<Buffer> {
    return readByteRange(this.source.path, from, to);
  }
}

export interface CommandRunnerOptions {
  timeoutMs?: number;
  outputCap?: number;
  windowSize?: number;
}

// Output convention a shipped suggestion can opt into: level, source, message,
// tab-separated. Anything else is treated as a plain line. This is what lets
// Get-WinEvent's LevelDisplayName and journald's PRIORITY reach severity as a
// stated level instead of being guessed from the message text.
function parseStructured(line: string): { level?: string; source?: string; text: string } {
  const parts = line.split("\t");
  if (parts.length < 3) return { text: line };
  const [level, source, ...rest] = parts;
  // Only treat it as structured when the first field is a level vocabulary we
  // recognise — a message that merely contains tabs must not be misread.
  if (severityFromLevel(level) === null) return { text: line };
  return { level, source: source!.trim() || undefined, text: rest.join("\t") };
}

// Runs a command on a schedule and answers what is new since last time.
//
// New-ness is line identity, not a byte offset: a command that re-emits its
// window returns the same bytes every run, so an offset would either replay
// everything or nothing. A rolling window of recently emitted line hashes is
// what makes `Get-WinEvent -MaxEvents N` usable as a source at all.
export class CommandMonitorRunner implements MonitorRunner {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];
  private readonly timeoutMs: number;
  private readonly outputCap: number;
  private readonly windowSize: number;
  private lastPollAt: string | null = null;
  private primed = false;

  private readonly compiled: RegExp | null;

  constructor(
    private readonly source: MonitorCommandSource,
    opts: CommandRunnerOptions = {},
    private readonly rule?: MonitorSeverityRule,
    private readonly phrases: () => PhraseSettings | undefined = () => undefined,
  ) {
    this.compiled = compileSeverityRule(rule);
    this.timeoutMs = opts.timeoutMs ?? COMMAND_TIMEOUT_MS;
    this.outputCap = opts.outputCap ?? COMMAND_OUTPUT_CAP;
    this.windowSize = opts.windowSize ?? LINE_WINDOW;
  }

  async poll(): Promise<MonitorPollResult> {
    const command = this.resolveCommand();
    const startedAt = new Date().toISOString();

    let stdout: string;
    try {
      stdout = await this.run(command);
    } catch (err) {
      this.lastPollAt = startedAt;
      return { events: [], problem: this.describe(err) };
    }
    this.lastPollAt = startedAt;

    // The first poll primes the window and emits nothing: a Monitor observes
    // from the present (R3), and a command's first output is history. Without
    // this, adding a Windows event-log monitor would narrate the last forty
    // events as though they had just happened.
    const priming = !this.primed;
    this.primed = true;

    const fresh: MonitorEvent[] = [];
    for (const line of toLines(stdout)) {
      const key = crypto.createHash("sha1").update(line).digest("hex");
      if (this.seen.has(key)) continue;
      this.remember(key);
      if (priming) continue;
      const { level, source, text } = parseStructured(line);
      fresh.push({
        at: startedAt,
        text,
        severity: classify(text, level, this.rule, this.compiled),
        ...(source ? { source } : {}),
      });
    }
    return { events: fresh };
  }

  // The since placeholder is substituted with the previous poll's start time,
  // so an incremental-capable command narrows at the source. Absent on the
  // first run: there is no previous time, and a Monitor starts at the present.
  private resolveCommand(): string {
    const { command, sinceTemplate } = this.source;
    if (!sinceTemplate) return command;
    return command.split(sinceTemplate).join(this.lastPollAt ?? "");
  }

  private remember(key: string): void {
    this.seen.add(key);
    this.order.push(key);
    if (this.order.length > this.windowSize) {
      const evicted = this.order.shift();
      if (evicted !== undefined) this.seen.delete(evicted);
    }
  }

  private run(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      // Through the platform shell deliberately: Get-WinEvent and journalctl
      // are shell constructs, and an argv-only runner would not reach the logs
      // this feature exists for. Bounded by timeout and output cap; the command
      // only runs because the user configured it, and is never elevated.
      exec(
        command,
        { timeout: this.timeoutMs, maxBuffer: this.outputCap, windowsHide: true },
        (err, stdout) => {
          if (err) {
            // A capped overrun still carries usable output — some is better
            // than none, and the cap is what bounds the process.
            if ((err as NodeJS.ErrnoException).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" && stdout) {
              resolve(stdout.slice(0, this.outputCap));
              return;
            }
            reject(err);
            return;
          }
          resolve(stdout.slice(0, this.outputCap));
        },
      );
    });
  }

  private describe(err: unknown): string {
    const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
    if (e?.killed)
      return renderPhrase("monitor.command_timeout", this.phrases(), {
        seconds: String(Math.round(this.timeoutMs / 1000)),
      });
    const code =
      typeof e?.code === "number"
        ? renderPhrase("monitor.command_exit_code", this.phrases(), { code: String(e.code) })
        : "";
    return renderPhrase("monitor.command_failed", this.phrases(), { exit_clause: code });
  }
}
