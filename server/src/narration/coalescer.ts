import type { AdapterId } from "../../../shared/src/types.js";
import type { SessionEvent } from "../watchers/watcher.js";

// Rough chars-per-token heuristic; the narrator runs with an explicit num_ctx
// (see narrator.ts) and this budget keeps the event block well inside it.
export const NARRATION_NUM_CTX = 4096;
export const EVENT_BUDGET_CHARS = 6000;

export interface DrainResult {
  lines: string[];
  count: number;
}

export function eventLine(event: SessionEvent): string {
  const tools = event.toolUses.length > 0 ? ` (tools: ${event.toolUses.join(", ")})` : "";
  const text = event.text.replace(/\s+/g, " ").trim();
  return `[${event.kind}] ${text}${tools}`;
}

// Accumulates watcher events between narrator calls. Each drain hands the
// narrator everything pending (R15), capped to a char budget: newest events
// stay verbatim, older overflow folds into one aggregate line.
export class Coalescer {
  private pending: SessionEvent[] = [];
  // The adapter whose events are pending. At most one adapter is attached at a
  // time, so a batch has a single owner; it rides out with the drain so the
  // narrator can stamp the entry with it long after the attachment changed.
  private adapterId: AdapterId | null = null;

  push(events: SessionEvent[], adapterId: AdapterId): void {
    this.pending.push(...events);
    this.adapterId = adapterId;
  }

  // Returns drained events to the front of the queue — used when a chat job
  // aborts an in-flight narration (the batch re-narrates after chat). The
  // batch's adapter comes back with it, so the re-narration is attributed to
  // the adapter that supplied the events, not to whatever is attached now.
  requeue(events: SessionEvent[], adapterId: AdapterId | null): void {
    this.pending.unshift(...events);
    this.adapterId ??= adapterId;
  }

  get size(): number {
    return this.pending.length;
  }

  drain(budgetChars = EVENT_BUDGET_CHARS): { events: SessionEvent[]; result: DrainResult; adapterId: AdapterId | null } {
    const events = this.pending;
    const adapterId = this.adapterId;
    this.pending = [];
    this.adapterId = null;
    // Walk newest-first so the freshest activity survives the budget verbatim.
    const kept: string[] = [];
    let used = 0;
    let keptCount = 0;
    for (let i = events.length - 1; i >= 0; i--) {
      const line = eventLine(events[i]!);
      if (used + line.length > budgetChars && keptCount > 0) break;
      kept.unshift(line);
      used += line.length;
      keptCount += 1;
    }
    const omitted = events.slice(0, events.length - keptCount);
    const lines = [...kept];
    if (omitted.length > 0) {
      const byKind = new Map<SessionEvent["kind"], number>();
      for (const e of omitted) byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1);
      const parts = [...byKind].map(([kind, n]) => `${n} ${kind}`);
      lines.unshift(`…plus ${omitted.length} earlier events not shown (${parts.join(", ")}).`);
    }
    return { events, result: { lines, count: events.length }, adapterId };
  }
}
