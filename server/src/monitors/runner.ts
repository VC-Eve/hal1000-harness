import { promises as fs } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { exec } from "node:child_process";
import crypto from "node:crypto";
import type { MonitorCommandSource, MonitorEvent, MonitorFileSource } from "../../../shared/src/types.js";
import { classify, severityFromLevel } from "./severity.js";
import { COMMAND_OUTPUT_CAP, COMMAND_TIMEOUT_MS, LINE_WINDOW, type MonitorPollResult, type MonitorRunner } from "./monitor.js";

// Splits a decoded block into lines, tolerating CRLF. Windows is the primary
// dev OS and a trailing carriage return would ride into every event's text.
function toLines(block: string): string[] {
  return block
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
    .filter((line) => line.trim().length > 0);
}

export function toEvents(lines: string[], at: string): MonitorEvent[] {
  // A plain text tail states no level, so severity comes from the text alone.
  return lines.map((text) => ({ at, text, severity: classify(text) }));
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

  constructor(private readonly source: MonitorFileSource) {}

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
      return { events: [], problem: `I cannot read ${this.source.path} at the moment.` };
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
      return { events: [], problem: `${this.source.path} was replaced; I have resumed at the present.` };
    }

    if (size < this.offset) {
      // Truncated — rotated in place, or emptied. Resync rather than emitting
      // the whole file as though it were new.
      this.offset = size;
      this.pending = "";
      this.decoder = new StringDecoder("utf8");
      return { events: [], problem: `${this.source.path} was truncated; I have resumed at the present.` };
    }

    if (size === this.offset) return { events: [] };

    const chunk = this.decoder.write(await this.readRange(this.offset, size));
    this.offset = size;
    const combined = this.pending + chunk;
    const lastNewline = combined.lastIndexOf("\n");
    if (lastNewline < 0) {
      // Still mid-line: hold it rather than emitting a fragment.
      this.pending = combined;
      return { events: [] };
    }
    this.pending = combined.slice(lastNewline + 1);
    return { events: toEvents(toLines(combined.slice(0, lastNewline)), new Date().toISOString()) };
  }

  private async readRange(from: number, to: number): Promise<Buffer> {
    const handle = await fs.open(this.source.path, "r");
    try {
      const length = to - from;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, from);
      return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
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

  constructor(
    private readonly source: MonitorCommandSource,
    opts: CommandRunnerOptions = {},
  ) {
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

    const fresh: MonitorEvent[] = [];
    for (const line of toLines(stdout)) {
      const key = crypto.createHash("sha1").update(line).digest("hex");
      if (this.seen.has(key)) continue;
      this.remember(key);
      const { level, source, text } = parseStructured(line);
      fresh.push({ at: startedAt, text, severity: classify(text, level), ...(source ? { source } : {}) });
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
    if (e?.killed) return `The command for this monitor did not finish within ${Math.round(this.timeoutMs / 1000)} seconds.`;
    const code = typeof e?.code === "number" ? ` (exit ${e.code})` : "";
    return `The command for this monitor failed${code}.`;
  }
}
