import { promises as fs } from "node:fs";
import path from "node:path";

// Append-only JSONL, the storage shape for the two logs that only ever grow:
// the inference log and the observation feed. Both are written once per event
// and read either offline or as a bounded tail, which is exactly what an
// append-only file is good at — and what the atomic whole-file rewrite in
// `atomic.ts` is bad at, since rewriting a day of records to add one line
// costs more every hour.

// One promise chain per file, process-wide. `fs.appendFile` is not atomic for
// a record larger than a pipe buffer, so two overlapping appends could
// interleave mid-line and corrupt both. Serializing here is enough: a single
// HAL process owns its data directory.
const chains = new Map<string, Promise<void>>();

export async function appendJsonl(file: string, value: unknown): Promise<void> {
  const line = `${JSON.stringify(value)}\n`;
  const previous = chains.get(file) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.appendFile(file, line, "utf8");
    });
  chains.set(file, next);
  try {
    await next;
  } finally {
    // Drop the chain once it is the last one queued, so a long-lived process
    // does not retain a promise per file it ever touched.
    if (chains.get(file) === next) chains.delete(file);
  }
}

/**
 * Waits for every append currently in flight.
 *
 * Both logs are written fire-and-forget — an entry must reach the connected
 * clients whether or not the disk is keeping up — which leaves a window where
 * a record is queued but not yet on disk. Shutdown closes that window, and a
 * test that asserts on what was written needs the same guarantee.
 *
 * Loops because a queued append can enqueue behind one that is still running.
 */
export async function flushJsonl(): Promise<void> {
  for (let i = 0; i < 5 && chains.size > 0; i += 1) {
    await Promise.allSettled([...chains.values()]);
  }
}

// The last `limit` well-formed records. A truncated or hand-edited line is
// skipped rather than failing the read: a log that cannot be replayed at all
// because one line is bad is worse than a log missing that line.
export async function readJsonlTail<T>(file: string, limit: number): Promise<T[]> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return [];
  }
  const out: T[] = [];
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const line = lines[i]!.trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // Skip; a partial final line is the common case.
    }
  }
  return out.reverse();
}

// Day-stamped file names are what keep a JSONL log navigable by hand and
// prunable by date without parsing anything.
export function dayStamp(at = new Date()): string {
  return at.toISOString().slice(0, 10);
}

// Ids reach the filesystem as a path segment (a conversation uuid, a session
// id, a monitor id), so anything that is not plainly safe becomes an
// underscore rather than a directory traversal or an illegal Windows name.
export function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
  return cleaned.slice(0, 80) || "unknown";
}
