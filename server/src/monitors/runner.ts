import { promises as fs } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import type { MonitorEvent, MonitorFileSource } from "../../../shared/src/types.js";
import { classify } from "./severity.js";
import type { MonitorPollResult, MonitorRunner } from "./monitor.js";

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
