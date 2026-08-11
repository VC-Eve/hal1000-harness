import { renderPhrase, type PhraseSettings } from "../../../shared/src/phrases.js";
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

/**
 * One watched-session event, as the narrator reads it.
 *
 * Every part of this line is a Phrase, because the narration system prompt
 * contains a glossary describing exactly this format. Leaving the format in a
 * template literal made half a documented contract editable: the glossary could
 * be rewritten without the tags moving, and the tags could be moved without the
 * glossary noticing.
 *
 * Rendering three phrases per line costs about 11µs against 0.7µs for the
 * literal this replaced — 4.5ms across a 400-line batch, measured, against the
 * multi-second inference that batch is assembled for. The engine parses on every
 * render and is deliberately not cached here; if this ever moves somewhere that
 * is not immediately followed by a model call, measure again.
 */
export function eventLine(event: SessionEvent, phrases?: PhraseSettings): string {
  const joined = event.toolUses.join(renderPhrase("narration.list_join", phrases, {}));
  const toolList = event.toolUses.length > 0 ? renderPhrase("narration.tool_list", phrases, { tools: joined }) : "";
  const text = event.text.replace(/\s+/g, " ").trim();
  return renderPhrase("narration.event_line", phrases, { kind: event.kind, text, tool_list: toolList });
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

  drain(
    budgetChars = EVENT_BUDGET_CHARS,
    phrases?: PhraseSettings,
  ): { events: SessionEvent[]; result: DrainResult; adapterId: AdapterId | null } {
    const events = this.pending;
    const adapterId = this.adapterId;
    this.pending = [];
    this.adapterId = null;
    // Walk newest-first so the freshest activity survives the budget verbatim.
    const kept: string[] = [];
    let used = 0;
    let keptCount = 0;
    for (let i = events.length - 1; i >= 0; i--) {
      const line = eventLine(events[i]!, phrases);
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
      const parts = [...byKind].map(([kind, n]) => renderPhrase("narration.omitted_kind", phrases, { count: String(n), kind }));
      lines.unshift(
        renderPhrase("narration.events_omitted", phrases, {
          count: String(omitted.length),
          kinds: parts.join(renderPhrase("narration.list_join", phrases, {})),
        }),
      );
    }
    return { events, result: { lines, count: events.length }, adapterId };
  }
}
