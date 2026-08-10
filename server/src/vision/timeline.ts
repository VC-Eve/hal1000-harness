// What HAL saw, on disk.
//
// A sibling of `storage/observations.ts` rather than a part of it. That log is
// the narration feed shared by all three observation roles, and its records are
// what HAL *said*; these are what it *saw*. Mixing them would change what every
// existing reader of that feed receives, for no gain — they are read for
// different reasons and at different rates.
//
// Append-only, one file per day, read as a bounded tail. The same shape and the
// same reasons: a record written once per event and read either offline or as a
// recent window is exactly what an append-only file is good at, and rewriting a
// day of records to add one line costs more every hour.
//
// No expiry, no cap, no purge. Everyone in the gallery has consented to being
// held; the constraint on this record is that it does not leave the machine,
// which is the recogniser endpoint's and the provider's acknowledgement to
// carry, not this store's.

import { promises as fs } from "node:fs";
import path from "node:path";
import type { VisionEvent } from "../../../shared/src/types.js";
import { appendJsonl, dayStamp, readJsonlTail } from "../storage/jsonl.js";

export class VisionTimeline {
  private readonly dir: string;

  constructor(dataRoot: string) {
    this.dir = path.join(dataRoot, "vision-timeline");
  }

  get directory(): string {
    return this.dir;
  }

  /**
   * Record one event.
   *
   * Reported and swallowed, like both other logs: detection must not stop
   * because a disk is full, and a caller that had to handle this would end up
   * choosing between dropping the frame and crashing the loop.
   */
  async append(event: VisionEvent): Promise<void> {
    try {
      await appendJsonl(path.join(this.dir, `${dayStamp(new Date(event.at))}.jsonl`), event);
    } catch (err) {
      console.error(`vision timeline write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * The most recent `limit` events, oldest first.
   *
   * Walks day files newest-first and stops as soon as it has enough, so a year
   * of watching costs the same read as a day of it.
   */
  async recent(limit: number): Promise<VisionEvent[]> {
    if (limit <= 0) return [];
    let days: string[];
    try {
      days = (await fs.readdir(this.dir)).filter((e) => e.endsWith(".jsonl")).sort();
    } catch {
      // No directory yet is the ordinary state before the first check, not a
      // fault worth reporting.
      return [];
    }

    const collected: VisionEvent[][] = [];
    let total = 0;
    for (let i = days.length - 1; i >= 0 && total < limit; i -= 1) {
      const events = await readJsonlTail<VisionEvent>(path.join(this.dir, days[i]!), limit - total);
      if (events.length === 0) continue;
      collected.unshift(events);
      total += events.length;
    }
    return collected.flat();
  }

  /**
   * The newest caption, if one was written recently enough to find.
   *
   * Bounded the way `lastSeen` is, and for the same reason: a caption older
   * than the tail is one HAL will report as hours stale anyway, so walking a
   * year of history to find it buys nothing a caller acts on differently.
   * Checks vastly outnumber captions — one every few seconds against one a
   * minute — so the window is wide enough to cross a quiet stretch.
   */
  async recentCaptions(limit: number, within = 6_000): Promise<{ caption: string; at: string }[]> {
    // A wider window than `newestCaption` by default, and deliberately: that
    // one stops at the first hit, so 2,000 events is plenty to find one. Asking
    // for several means walking past the checks between them, and checks
    // outnumber captions roughly twenty to one.
    if (!(limit >= 1)) return [];
    const events = await this.recent(within);
    const out: { caption: string; at: string }[] = [];
    for (let i = events.length - 1; i >= 0 && out.length < limit; i -= 1) {
      const event = events[i]!;
      if (event.kind === "caption") out.push({ caption: event.caption, at: event.at });
    }
    // Newest first, which is the order the slot renders and the order a reader
    // wants: the most recent look is the one a question is usually about.
    return out;
  }

  async newestCaption(within = 2_000): Promise<{ caption: string; at: string } | null> {
    const events = await this.recent(within);
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]!;
      if (event.kind === "caption") return { caption: event.caption, at: event.at };
    }
    return null;
  }

  /**
   * The most recent check that saw a given person, if any.
   *
   * This is how weight survives a restart: the last event carrying someone
   * holds their weight and the time it was computed, and decaying that by
   * elapsed wall-clock is already the ordinary read. A restart is therefore
   * just another gap and needs no special case.
   *
   * Bounded rather than exhaustive — it walks back only as far as `within`
   * events. Someone not seen in that many checks has a weight that has decayed
   * to nothing anyway, so reading further would cost a full history scan to
   * recover a number indistinguishable from zero.
   */
  async lastSeen(personId: string, within = 2_000): Promise<{ at: string; weight: number } | null> {
    const events = await this.recent(within);
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]!;
      if (event.kind !== "check") continue;
      const face = event.faces.find((f) => f.personId === personId && typeof f.weight === "number");
      if (face) return { at: event.at, weight: face.weight! };
    }
    return null;
  }
}
