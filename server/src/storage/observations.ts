import { promises as fs } from "node:fs";
import path from "node:path";
import type { NarrationEntry } from "../../../shared/src/types.js";
import { appendJsonl, dayStamp, readJsonlTail } from "./jsonl.js";

// The observation feed, on disk.
//
// The feed was a 200-entry array in memory: a browser reload survived it
// because the server still held the ring, but a restart erased every
// observation HAL had ever made. That made the session observation tab a
// live view with no history — which is the one thing a record of what HAL
// saw is for.
//
// Everything the feed shows passes through `NarrationService.record()`, so
// this store hangs off that single chokepoint and covers all three roles:
// session narration, monitors, and vision.
export class ObservationLog {
  private readonly dir: string;

  constructor(dataRoot: string) {
    this.dir = path.join(dataRoot, "observations");
  }

  get directory(): string {
    return this.dir;
  }

  // Reported and swallowed, like the inference log: a feed entry that cannot
  // be written must still reach the connected clients.
  async append(entry: NarrationEntry): Promise<void> {
    try {
      await appendJsonl(path.join(this.dir, `${dayStamp(new Date(entry.at))}.jsonl`), entry);
    } catch (err) {
      console.error(`observation log write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * The most recent `limit` entries, oldest first — the shape the feed ring
   * wants back at boot.
   *
   * Walks day files newest-first and stops as soon as it has enough, so a
   * year of observations costs the same read as a day of them.
   */
  async recent(limit: number): Promise<NarrationEntry[]> {
    if (limit <= 0) return [];
    let days: string[];
    try {
      days = (await fs.readdir(this.dir)).filter((e) => e.endsWith(".jsonl")).sort();
    } catch {
      return [];
    }
    const collected: NarrationEntry[][] = [];
    let total = 0;
    for (let i = days.length - 1; i >= 0 && total < limit; i -= 1) {
      const entries = await readJsonlTail<NarrationEntry>(path.join(this.dir, days[i]!), limit - total);
      if (entries.length === 0) continue;
      collected.unshift(entries);
      total += entries.length;
    }
    return collected.flat();
  }
}
