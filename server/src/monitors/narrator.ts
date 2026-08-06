import crypto from "node:crypto";
import type { Monitor, MonitorEvent, NarrationEntry } from "../../../shared/src/types.js";
import { DEFAULT_MONITOR_PROMPT, isBlankPrompt, resolvePrompt } from "../../../shared/src/prompts.js";
import type { ProviderFactory } from "../providers/provider.js";
import type { ProviderQueue } from "../providers/queue.js";
import type { SettingsStore } from "../storage/settings.js";
import { NARRATION_NUM_CTX } from "../narration/coalescer.js";
import type { MonitorPollResult } from "./monitor.js";

// Where a Monitor's entries land. NarrationService satisfies this — Monitors
// share the feed and its ring rather than owning a second one.
export interface EntrySink {
  record(entry: NarrationEntry): void;
}

// Bounds one batch handed to the model, matching the session narrator's budget.
const EVENT_BUDGET_CHARS = 6000;

// How often pending buffers are checked against their cycle deadline. A cycle
// is minutes; sweeping every few seconds is cheap and avoids a timer per
// monitor to leak on teardown.
const SWEEP_MS = 5_000;

interface Pending {
  events: MonitorEvent[];
  // When this monitor's current cycle is due. Set when the first event of a
  // cycle arrives, so a silent monitor never has a deadline at all.
  dueAt: number | null;
  narrating: boolean;
}

// Turns monitor events into feed entries.
//
// Quiet is the default and the point: events accumulate and one summary is
// emitted per cycle. A severe line short-circuits that and speaks immediately,
// then the monitor returns to its cadence unchanged — interrupting never
// promotes it and never changes what the session narrator is narrating (R10).
//
// A cycle that saw nothing produces nothing. An all-clear on a timer is noise,
// and R8 scopes the summary to "that period's activity" — with no activity
// there is nothing to cover.
export class MonitorNarrator {
  private readonly pending = new Map<string, Pending>();
  private sweep: NodeJS.Timeout | null = null;

  constructor(
    private readonly sink: EntrySink,
    private readonly settings: SettingsStore,
    private readonly queue: ProviderQueue,
    private readonly providerFactory: ProviderFactory,
    private readonly now: () => number = () => Date.now(),
  ) {}

  start(): void {
    if (this.sweep) return;
    this.sweep = setInterval(() => {
      void this.sweepDue().catch((err: unknown) => {
        console.error(`monitor narrator sweep error: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, SWEEP_MS);
    this.sweep.unref?.();
  }

  stop(): void {
    if (this.sweep) clearInterval(this.sweep);
    this.sweep = null;
  }

  // Drops a removed or disabled monitor's buffered work so it cannot surface
  // after the user turned it off.
  forget(monitorId: string): void {
    this.pending.delete(monitorId);
  }

  async ingest(monitor: Monitor, result: MonitorPollResult): Promise<void> {
    // A problem is HAL's own condition report about this monitor. It is stated
    // directly rather than sent to the model: it needs no interpretation, and
    // routing it through the queue would delay the one message that says HAL
    // has stopped seeing anything.
    if (result.problem) {
      this.emit(monitor, "status", result.problem);
    }
    if (result.events.length === 0) return;

    const state = this.pending.get(monitor.id) ?? { events: [], dueAt: null, narrating: false };
    state.events.push(...result.events);
    this.pending.set(monitor.id, state);

    if (monitor.verbosity === "full") {
      await this.flush(monitor, "full");
      return;
    }

    if (state.events.some((e) => e.severity === "severe")) {
      // Out of cycle, then straight back to the cadence (R9, R10).
      await this.flush(monitor, "interrupt");
      return;
    }

    state.dueAt ??= this.now() + monitor.cycleMs;
  }

  // Called by the sweep and, in tests, directly.
  async sweepDue(monitors: Monitor[] = []): Promise<void> {
    const byId = new Map(monitors.map((m) => [m.id, m]));
    for (const [id, state] of this.pending) {
      const monitor = byId.get(id);
      if (!monitor || state.dueAt === null || this.now() < state.dueAt) continue;
      await this.flush(monitor, "cycle");
    }
  }

  private async flush(monitor: Monitor, reason: "cycle" | "interrupt" | "full"): Promise<void> {
    const state = this.pending.get(monitor.id);
    if (!state || state.events.length === 0 || state.narrating) return;

    const batch = state.events;
    state.events = [];
    state.dueAt = null;
    state.narrating = true;
    try {
      const text = await this.narrate(monitor, batch, reason);
      if (text.trim()) this.emit(monitor, "narration", text.trim());
    } catch (err) {
      // Returning the batch would replay stale lines once the provider
      // recovers; a monitor is about now. Report and move on.
      this.emit(monitor, "status", `I could not narrate ${monitor.label} just now: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      const current = this.pending.get(monitor.id);
      if (current) current.narrating = false;
    }
  }

  private async narrate(monitor: Monitor, events: MonitorEvent[], reason: "cycle" | "interrupt" | "full"): Promise<string> {
    const s = this.settings.get();
    const model = s.narrationModel ?? s.chatModel;
    if (!model) throw new Error("no narration model is selected");

    const prompt = resolvePrompt(s.monitorPrompt, DEFAULT_MONITOR_PROMPT);
    const lines = this.render(events);
    const framing =
      reason === "interrupt"
        ? `Something in ${monitor.label} looks wrong. Report it now.`
        : reason === "full"
          ? `Recent activity in ${monitor.label}. Narrate it.`
          : `Activity in ${monitor.label} over the last period. Summarise it.`;

    // Enqueued as narration, not a new job class: chat still preempts, and the
    // existing scheduling contract is unchanged. Ordering between a severe line
    // and a routine summary is decided here, before enqueueing.
    return this.queue.enqueue("narration", async (signal) => {
      const provider = this.providerFactory(s.providerEndpoint);
      let out = "";
      const stream = provider.chatStream({
        model,
        messages: [
          ...(isBlankPrompt(prompt) ? [] : [{ role: "system" as const, content: prompt }]),
          { role: "user" as const, content: `${framing}\n\n${lines}` },
        ],
        signal,
        options: { num_ctx: NARRATION_NUM_CTX },
      });
      for await (const token of stream) out += token;
      return out;
    });
  }

  // Newest-first under a budget, so the freshest lines survive verbatim when a
  // burst exceeds what one call should carry — the coalescer's rule.
  private render(events: MonitorEvent[]): string {
    const rendered: string[] = [];
    let used = 0;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const e = events[i]!;
      const line = `${e.severity === "severe" ? "[severe] " : ""}${e.source ? `${e.source}: ` : ""}${e.text}`;
      if (used + line.length > EVENT_BUDGET_CHARS && rendered.length > 0) break;
      used += line.length;
      rendered.unshift(line);
    }
    const dropped = events.length - rendered.length;
    return dropped > 0 ? `(${dropped} earlier lines omitted)\n${rendered.join("\n")}` : rendered.join("\n");
  }

  private emit(monitor: Monitor, kind: NarrationEntry["kind"], text: string): void {
    this.sink.record({
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      kind,
      text,
      // Attributed to the monitor rather than left on HAL's colour even for a
      // status: with several monitors running, which one lost its source is the
      // useful part of the message.
      monitorId: monitor.id,
      adapterId: null,
    });
  }
}
