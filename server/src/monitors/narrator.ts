import crypto from "node:crypto";
import type { Monitor, MonitorEvent, NarrationEntry } from "../../../shared/src/types.js";
import { DEFAULT_MONITOR_PROMPT, PROMPT_FIELDS, resolvePrompt } from "../../../shared/src/prompts.js";
import { renderPrompt, renderRoleMessage, sendTo, systemMessages } from "../templates/roleMessages.js";
import { ProviderError, type ProviderFactory } from "../providers/provider.js";
import { backendForRole, endpointForRole, numCtxFor } from "../providers/resolve.js";
import type { ProviderQueue } from "../providers/queue.js";
import type { SettingsStore } from "../storage/settings.js";
import { EVENT_BUDGET_CHARS, NARRATION_NUM_CTX } from "../narration/coalescer.js";
import type { MonitorPollResult } from "./monitor.js";

// Chat preempting narration surfaces as this, per `providers/ollama.ts`. It is
// scheduling rather than failure, so the batch is kept.
function isAborted(err: unknown): boolean {
  return err instanceof ProviderError && err.code === "aborted";
}

// Where a Monitor's entries land. NarrationService satisfies this — Monitors
// share the feed and its ring rather than owning a second one.
export interface EntrySink {
  record(entry: NarrationEntry): void;
}

// Caps what one monitor holds between flushes. The render budget only trims the
// prompt; without this the buffer itself grows for a whole cycle, and a
// high-volume log can evict real narration from the shared feed ring.
const PENDING_CAP = 500;

// A monitor that interrupts on every poll would saturate the single provider
// lane and defeat its own quiet cadence — a servicing log full of the word
// "error" is a realistic source. Severity still buys immediacy, just not
// unboundedly.
const MIN_INTERRUPT_GAP_MS = 60_000;

interface Pending {
  events: MonitorEvent[];
  // When this monitor's current cycle is due. Set when the first event of a
  // cycle arrives, so a silent monitor never has a deadline at all.
  dueAt: number | null;
  narrating: boolean;
  // How many routine events the cap discarded, so the summary can say so
  // rather than quietly under-reporting.
  dropped: number;
  lastInterruptAt: number | null;
  // The last problem reported for this monitor, so an hour of a missing file
  // is one entry and a recovery is another — not one entry per poll.
  problem: string | null;
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

  constructor(
    private readonly sink: EntrySink,
    private readonly settings: SettingsStore,
    private readonly queue: ProviderQueue,
    private readonly providerFactory: ProviderFactory,
    private readonly now: () => number = () => Date.now(),
  ) {}

  // Drops a removed or disabled monitor's buffered work so it cannot surface
  // after the user turned it off.
  forget(monitorId: string): void {
    this.pending.delete(monitorId);
  }

  async ingest(monitor: Monitor, result: MonitorPollResult): Promise<void> {
    const state = this.stateFor(monitor.id);

    // A problem is HAL's own condition report about this monitor. It is stated
    // directly rather than sent to the model: it needs no interpretation, and
    // routing it through the queue would delay the one message that says HAL
    // has stopped seeing anything.
    //
    // Reported on transition only. A file missing for an hour polls 120 times;
    // 120 identical entries would bury real narration in a bounded feed ring.
    if (result.problem && result.problem !== state.problem) {
      this.emit(monitor, "status", result.problem);
    } else if (!result.problem && state.problem) {
      this.emit(monitor, "status", `${monitor.label} is readable again.`);
    }
    state.problem = result.problem ?? null;

    if (result.events.length === 0) return;

    state.events.push(...result.events);
    this.capPending(state);

    if (monitor.verbosity === "full") {
      await this.flush(monitor, "full");
      return;
    }

    const gap = state.lastInterruptAt === null || this.now() - state.lastInterruptAt >= MIN_INTERRUPT_GAP_MS;
    if (state.events.some((e) => e.severity === "severe") && gap) {
      state.lastInterruptAt = this.now();
      // Out of cycle, then straight back to the cadence (R9, R10).
      await this.flush(monitor, "interrupt");
      return;
    }

    state.dueAt ??= this.now() + monitor.cycleMs;
  }

  private stateFor(id: string): Pending {
    const existing = this.pending.get(id);
    if (existing) return existing;
    const created: Pending = { events: [], dueAt: null, narrating: false, dropped: 0, lastInterruptAt: null, problem: null };
    this.pending.set(id, created);
    return created;
  }

  // Drops oldest routine events first and never a severe one: the whole reason
  // a monitor speaks is the exception, so the exception is the last thing to go.
  private capPending(state: Pending): void {
    if (state.events.length <= PENDING_CAP) return;
    const severe = state.events.filter((e) => e.severity === "severe");
    const routine = state.events.filter((e) => e.severity !== "severe");
    const keepRoutine = Math.max(0, PENDING_CAP - severe.length);
    state.dropped += routine.length - Math.min(routine.length, keepRoutine);
    state.events = [...routine.slice(-keepRoutine), ...severe];
  }

  // Driven by MonitorService, which is the only thing that knows which monitors
  // exist right now — a monitor removed mid-cycle must not flush afterwards.
  async sweepDue(monitors: Monitor[]): Promise<void> {
    const byId = new Map(monitors.map((m) => [m.id, m]));
    for (const [id, state] of this.pending) {
      const monitor = byId.get(id);
      if (!monitor || state.dueAt === null || this.now() < state.dueAt) continue;
      await this.flush(monitor, "cycle");
    }
  }

  private async flush(monitor: Monitor, reason: "cycle" | "interrupt" | "full"): Promise<void> {
    const state = this.pending.get(monitor.id);
    if (!state || state.events.length === 0) return;
    if (state.narrating) {
      // Arm a deadline so the sweep retries. Without this the batch — possibly
      // the severe one that triggered an interrupt — sits with no deadline and
      // is only rescued by the next event, which may never come.
      state.dueAt ??= this.now();
      return;
    }

    const batch = state.events;
    const dropped = state.dropped;
    state.events = [];
    state.dropped = 0;
    state.dueAt = null;
    state.narrating = true;
    try {
      const text = await this.narrate(monitor, batch, reason, dropped);
      if (text.trim()) this.emit(monitor, "narration", text.trim());
    } catch (err) {
      const current = this.pending.get(monitor.id);
      if (current && isAborted(err)) {
        // Chat preempted this job. An abort is scheduling, not failure — the
        // session narrator re-queues its batch for exactly this reason, and
        // dropping ours would silently lose the severe line we were reporting.
        current.events = [...batch, ...current.events];
        current.dropped += dropped;
        this.capPending(current);
        current.dueAt = this.now();
      } else {
        // A real provider failure: replaying stale lines once it recovers would
        // narrate the past as the present. Report and move on.
        this.emit(monitor, "status", `I could not narrate ${monitor.label} just now: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      const current = this.pending.get(monitor.id);
      if (current) {
        current.narrating = false;
        // Events that arrived during the call need a deadline of their own.
        if (current.events.length > 0) current.dueAt ??= this.now();
      }
    }
  }

  private async narrate(monitor: Monitor, events: MonitorEvent[], reason: "cycle" | "interrupt" | "full", dropped = 0): Promise<string> {
    const s = this.settings.get();
    const model = s.narrationModel ?? s.chatModel;
    if (!model) throw new Error("no narration model is selected");

    const prompt = resolvePrompt(s.monitorPrompt, DEFAULT_MONITOR_PROMPT);
    const lines = this.render(events, dropped);
    // The three framings are branches in the template now rather than a
    // conditional here. Exactly one reason slot resolves, so the other two
    // blocks drop with their wording — which is what makes them editable
    // without the language needing to compare anything.
    // Built from the endpoint the queue will send to, because the Backend
    // itself is resolved inside the job — after the message it carries has
    // already been rendered.
    const send = sendTo(model, endpointForRole("monitor", s));
    const system = renderRoleMessage(
      "monitor-system",
      s.templates?.["monitor-system"],
      { monitor_prompt: renderPrompt(prompt, s.monitorPromptIsTemplate, PROMPT_FIELDS.monitorPrompt, send, "monitorPrompt").text },
      send,
    ).text;
    const user = renderRoleMessage(
      "monitor-user",
      s.templates?.["monitor-user"],
      {
        monitor_label: monitor.label,
        monitor_lines: lines,
        reason_interrupt: reason === "interrupt" ? "set" : "",
        reason_full: reason === "full" ? "set" : "",
        reason_cycle: reason === "cycle" ? "set" : "",
      },
      send,
    ).text;
    // Nothing to ask means no request. See the same guard in the session
    // narrator: the system half already declines to send empty, and the user
    // half had no equivalent.
    if (user.length === 0) return "";

    // Enqueued as narration, not a new job class: chat still preempts, and the
    // existing scheduling contract is unchanged. Ordering between a severe line
    // and a routine summary is decided here, before enqueueing.
    return this.queue.enqueue("narration", async (signal) => {
      const backend = await backendForRole("monitor", this.settings);
      if (!backend) {
        throw new ProviderError("provider_unavailable", "The narration backend is not reachable.");
      }
      const provider = this.providerFactory(backend);
      let out = "";
      const stream = provider.chatStream({
        model,
        messages: [...systemMessages(system), { role: "user" as const, content: user }],
        signal,
        options: { num_ctx: await numCtxFor(backend, model, provider, this.settings.get(), NARRATION_NUM_CTX) },
        source: { kind: "monitor", id: monitor.id, label: monitor.label },
      });
      for await (const token of stream) out += token;
      return out;
    }, endpointForRole("monitor", s));
  }

  // Severe lines are spent first, then routine ones from the end of the batch.
  //
  // Position is not a reliable proxy for importance here: a Monitor's events
  // arrive in whatever order its source emits, and Get-WinEvent emits
  // newest-first. Taking "the tail" would then discard the newest lines —
  // including, on an interrupt, the very line that triggered it.
  private render(events: MonitorEvent[], alreadyDropped = 0): string {
    const line = (e: MonitorEvent) =>
      `${e.severity === "severe" ? "[severe] " : ""}${e.source ? `${e.source}: ` : ""}${e.text}`;

    const kept = new Set<MonitorEvent>();
    let used = 0;
    for (const e of events) {
      if (e.severity !== "severe") continue;
      used += line(e).length;
      kept.add(e);
    }
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const e = events[i]!;
      if (kept.has(e)) continue;
      const length = line(e).length;
      if (used + length > EVENT_BUDGET_CHARS && kept.size > 0) break;
      used += length;
      kept.add(e);
    }

    // Emitted in arrival order so the model sees the source's own sequence.
    const rendered = events.filter((e) => kept.has(e)).map(line);
    const omitted = events.length - rendered.length + alreadyDropped;
    return omitted > 0 ? `(${omitted} further lines omitted)\n${rendered.join("\n")}` : rendered.join("\n");
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
