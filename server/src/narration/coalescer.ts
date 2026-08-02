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

  push(events: SessionEvent[]): void {
    this.pending.push(...events);
  }

  // Returns drained events to the front of the queue — used when a chat job
  // aborts an in-flight narration (the batch re-narrates after chat).
  requeue(events: SessionEvent[]): void {
    this.pending.unshift(...events);
  }

  get size(): number {
    return this.pending.length;
  }

  drain(budgetChars = EVENT_BUDGET_CHARS): { events: SessionEvent[]; result: DrainResult } {
    const events = this.pending;
    this.pending = [];
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
      const byKind = { user: 0, assistant: 0, system: 0 };
      for (const e of omitted) byKind[e.kind] += 1;
      const parts = Object.entries(byKind)
        .filter(([, n]) => n > 0)
        .map(([kind, n]) => `${n} ${kind}`);
      lines.unshift(`…plus ${omitted.length} earlier events not shown (${parts.join(", ")}).`);
    }
    return { events, result: { lines, count: events.length } };
  }
}
