import crypto from "node:crypto";
import type { WebSocket } from "ws";
import type {
  AdapterId,
  ClientMessage,
  NarrationEntry,
  NarrationStatus,
  ServerMessage,
  SessionState,
} from "../../../shared/src/types.js";
import { DEFAULT_NARRATION_PROMPT, isBlankPrompt, resolvePrompt } from "../../../shared/src/prompts.js";
import { ProviderError, type ProviderFactory } from "../providers/provider.js";
import type { ProviderQueue } from "../providers/queue.js";
import type { SettingsStore } from "../storage/settings.js";
import type { ObservationLog } from "../storage/observations.js";
import type { WatcherRegistry } from "../watchers/registry.js";
import { toSessionSummary, type WatcherNotification } from "../watchers/watcher.js";
import { Coalescer, EVENT_BUDGET_CHARS, NARRATION_NUM_CTX } from "./coalescer.js";

// Structural hub interface so tests can fake it; WsHub satisfies this.
export interface NarrationHub {
  broadcast(msg: ServerMessage): void;
  onMessage(handler: (msg: ClientMessage, client: WebSocket) => void): void;
  onConnection(greet: (client: WebSocket) => void): void;
  sendTo(client: WebSocket, msg: ServerMessage): void;
}

// How many turns in a row the selected session may take before it yields one
// to a background session. Three keeps the watched feed clearly first while
// bounding how long another session can wait to a few narration calls.
const SELECTED_STREAK = 3;

export interface NarrationOptions {
  ringSize?: number;
  catchingUpThreshold?: number;
  retryMs?: number;
  budgetChars?: number;
  // Where the feed is persisted. Optional so a test gets the pre-existing
  // memory-only behaviour without a temp directory; the app always supplies it.
  observations?: ObservationLog;
}

// Narration pipeline (R15/R16): watcher events -> coalescer -> one narrator
// call at narration priority -> HAL-toned feed entry over WS.
export class NarrationService {
  // One coalescer per followed session. Sessions are narrated separately
  // because a batch mixing two agents' events produces one paragraph about
  // neither — the events only make sense against the session they came from.
  private readonly coalescers = new Map<string, Coalescer>();
  private readonly ring: NarrationEntry[] = [];
  private status: NarrationStatus = "idle";
  // Per session, since several are observed at once. The feed header shows the
  // selected one's.
  private readonly sessionStates = new Map<string, SessionState>();
  // Round-robin cursor over the unselected sessions, and how many turns the
  // selected session has taken in a row. Together they implement the priority
  // rule: the selected session goes first, but not forever — under sustained
  // load it yields a turn so a background session cannot be starved silently.
  private lastNarrated: string | null = null;
  private consecutiveSelected = 0;
  // Resolved once at watch time and kept sticky (conversation switches must
  // not retarget the narrator — VRAM thrash); user changes update it.
  private stickyModel: string | null = null;
  private narrating = false;
  private retryTimer: NodeJS.Timeout | null = null;
  // Bumped by every teardown. `pump()` awaits the provider queue and appends
  // afterwards, so a batch can outlive the attachment that produced it; the
  // token it captured before the await is how that batch knows to drop its
  // result instead of narrating a session nobody is watching any more.
  private watchEpoch = 0;
  private readonly ringSize: number;
  private readonly catchingUpThreshold: number;
  private readonly retryMs: number;
  private readonly budgetChars: number;
  private readonly observations: ObservationLog | null;

  constructor(
    private readonly hub: NarrationHub,
    private readonly registry: WatcherRegistry,
    private readonly settings: SettingsStore,
    private readonly queue: ProviderQueue,
    private readonly providerFactory: ProviderFactory,
    opts: NarrationOptions = {},
  ) {
    this.ringSize = opts.ringSize ?? 200;
    this.catchingUpThreshold = opts.catchingUpThreshold ?? 25;
    this.retryMs = opts.retryMs ?? 10_000;
    this.budgetChars = opts.budgetChars ?? EVENT_BUDGET_CHARS;
    this.observations = opts.observations ?? null;

    registry.subscribe((n, adapterId) => this.onWatcher(n, adapterId));
    // Disabling an adapter stops observation outright, unlike an unwatch —
    // which now only moves the highlight (R8).
    registry.onDisabled(() => this.teardownAdapter());
    // Catch everything: an escaped rejection would crash the process.
    hub.onMessage((msg) => {
      this.handle(msg).catch((err: unknown) => {
        console.error(`narration handler error: ${err instanceof Error ? err.message : String(err)}`);
      });
    });
    hub.onConnection((client) =>
      hub.sendTo(client, {
        type: "narration-backlog",
        entries: this.ring,
        watchedSessionId: this.registry.watchedSessionId(),
        status: this.status,
        sessionState: this.selectedSessionState(),
        followedSessionIds: this.registry.followedSessionIds(),
      }),
    );
  }

  async restoreWatch(): Promise<void> {
    const sessionId = this.settings.get().watchedSessionId;
    if (!sessionId) return;
    try {
      await this.watch(sessionId);
    } catch {
      // Session is gone since last run; the picker will offer current ones.
      await this.settings.update({ watchedSessionId: null });
    }
  }

  private onWatcher(n: WatcherNotification, adapterId: AdapterId): void {
    switch (n.kind) {
      case "session-events": {
        // The owning adapter enters the pipeline here and travels with the
        // batch; nothing downstream re-resolves it (R14).
        const coalescer = this.coalescers.get(n.sessionId) ?? new Coalescer();
        this.coalescers.set(n.sessionId, coalescer);
        coalescer.push(n.events, adapterId);
        void this.pump();
        return;
      }
      case "session-state":
        this.sessionStates.set(n.sessionId, n.state);
        this.hub.broadcast({ type: "session-status", sessionId: n.sessionId, state: n.state });
        return;
      case "gap":
        // Named but not attributed. With several sessions followed, "my
        // attention lapsed" about an unnamed one is unreadable — so the entry
        // carries the session label. It still carries a null `adapterId`:
        // colour marks whose voice is speaking, and a gap is HAL speaking
        // about himself, not an observation about a session (R15).
        this.record({
          id: crypto.randomUUID(),
          at: new Date().toISOString(),
          kind: "gap",
          text: "My attention lapsed while I was away, and the session continued without me. I resume observation now.",
          adapterId: null,
          sessionId: n.sessionId,
          sessionLabel: this.sessionLabel(adapterId, n.sessionId),
        });
        return;
      case "followed": {
        // Reconciled against the full set rather than a delta: a session that
        // is no longer followed must not leave a coalescer holding events that
        // would surface later as narration about a log nobody is reading.
        const live = new Set(n.sessionIds);
        for (const id of [...this.coalescers.keys()]) {
          if (!live.has(id)) {
            this.coalescers.delete(id);
            this.sessionStates.delete(id);
          }
        }
        this.hub.broadcast({ type: "followed-sessions", sessionIds: this.registry.followedSessionIds() });
        return;
      }
      case "sessions":
        this.hub.broadcast({
          type: "sessions",
          sessions: n.sessions.map((s) => ({ ...toSessionSummary(s), adapterId })),
        });
        return;
      case "new-session":
        this.hub.broadcast({
          type: "new-session-available",
          session: { ...toSessionSummary(n.session), adapterId },
        });
        return;
    }
  }

  private async handle(msg: ClientMessage): Promise<void> {
    switch (msg.type) {
      case "list-sessions": {
        // Already wire summaries, already tagged with their owning adapter.
        this.hub.broadcast({ type: "sessions", sessions: await this.registry.discoverSessions() });
        return;
      }
      case "watch-session":
        try {
          await this.watch(msg.sessionId);
        } catch (err) {
          this.hub.broadcast({ type: "error", code: "watch_failed", message: err instanceof Error ? err.message : String(err) });
        }
        return;
      case "unwatch":
        await this.teardownWatch();
        return;
      case "update-settings":
        // Explicit narration-model change updates the sticky model (R19
        // resume). In follow mode (no explicit narration model), picking a
        // chat model also resolves a paused narrator — otherwise
        // paused-missing-model is a one-way door.
        if ("narrationModel" in msg.patch) {
          this.stickyModel = msg.patch.narrationModel ?? this.settings.get().chatModel ?? null;
        } else if ("chatModel" in msg.patch && !this.settings.get().narrationModel && !this.stickyModel) {
          this.stickyModel = msg.patch.chatModel ?? null;
        } else {
          return;
        }
        if (this.status === "paused-missing-model" && this.stickyModel) {
          this.setStatus("idle");
          void this.pump();
        }
        return;
      default:
        return;
    }
  }

  /**
   * Clears the selection. Observation continues.
   *
   * This used to stop the whole pipeline, because the selected session was the
   * only one being observed. It no longer is: every live session is followed,
   * so an unwatch means "stop centring the feed on this one", and dropping
   * queued batches here would silently deafen HAL to sessions the user never
   * said anything about. Stopping observation outright is `teardownAdapter`,
   * which is what disabling an adapter runs.
   */
  async teardownWatch(): Promise<void> {
    await this.registry.detach();
    await this.settings.update({ watchedSessionId: null });
    this.hub.broadcast({ type: "watch-stopped" });
  }

  // Stops the pipeline: no retries, no in-flight batch appending later, and
  // nothing for restoreWatch() to re-attach on the next boot. The per-session
  // coalescers are pruned by the `followed` notification the stopping watcher
  // emits, so they are deliberately not cleared here.
  async teardownAdapter(): Promise<void> {
    await this.registry.detach();
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.watchEpoch += 1;
    await this.settings.update({ watchedSessionId: null });
    this.hub.broadcast({ type: "watch-stopped" });
    this.setStatus("idle");
  }

  async watch(sessionId: string): Promise<void> {
    // watch-started goes out before attach so clients accept the session-state
    // event attach emits; rolled back if the attach fails.
    this.hub.broadcast({ type: "watch-started", sessionId });
    try {
      await this.registry.attach(sessionId);
    } catch (err) {
      this.hub.broadcast({ type: "watch-stopped" });
      throw err;
    }
    const s = this.settings.get();
    this.stickyModel = s.narrationModel ?? s.chatModel;
    await this.settings.update({ watchedSessionId: sessionId });
  }

  private selectedSessionState(): SessionState | null {
    const selected = this.registry.watchedSessionId();
    return selected ? this.sessionStates.get(selected) ?? null : null;
  }

  // `Claude Code [a3f9c21e]`. Stamped onto the entry rather than resolved when
  // it renders, so an observation about a session that has since ended still
  // names the session it was about.
  private sessionLabel(adapterId: AdapterId | null, sessionId: string): string {
    return `${this.registry.adapterLabel(adapterId)} [${sessionId.slice(0, 8)}]`;
  }

  private setStatus(status: NarrationStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.hub.broadcast({ type: "narration-status", status });
  }

  // `adapterId` defaults to null: gap and status entries are HAL's own voice
  // and keep HAL's colour whatever is attached (R15). Only a narration entry
  // passes the id its batch carried.
  private addEntry(
    kind: NarrationEntry["kind"],
    text: string,
    adapterId: AdapterId | null = null,
    sessionId: string | null = null,
  ): void {
    this.record({
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      kind,
      text,
      adapterId,
      ...(sessionId ? { sessionId, sessionLabel: this.sessionLabel(adapterId, sessionId) } : {}),
    });
  }

  // The seam Monitors reach the feed through. They are a separate role with
  // their own cadence and prompt, but they share one feed — so they share the
  // ring too, or a reload would drop everything a Monitor has said.
  record(entry: NarrationEntry): void {
    this.ring.push(entry);
    if (this.ring.length > this.ringSize) this.ring.splice(0, this.ring.length - this.ringSize);
    this.hub.broadcast({ type: "narration-entry", entry });
    // Fire-and-forget, and after the broadcast: persistence is what gives the
    // feed a history across app sessions, but a slow or failing disk must not
    // hold up the entry reaching the clients watching right now.
    void this.observations?.append(entry);
  }

  /**
   * Refills the ring from disk at boot, so the observation tab opens with the
   * history from previous app sessions instead of an empty feed.
   *
   * Called before `restoreWatch()`: restored entries must be older than
   * anything this run produces, and a gap notice emitted by a re-attach
   * belongs after them.
   */
  async restoreHistory(): Promise<void> {
    if (!this.observations) return;
    try {
      const entries = await this.observations.recent(this.ringSize);
      // Prepended rather than assigned: nothing should have recorded yet at
      // boot, but an entry that did is newer than every stored one and must
      // not be dropped by the restore.
      this.ring.unshift(...entries);
      if (this.ring.length > this.ringSize) this.ring.splice(0, this.ring.length - this.ringSize);
    } catch (err) {
      // An unreadable history is a feed that starts empty, not a boot failure.
      console.error(`observation history restore failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.pump();
    }, this.retryMs);
  }

  // Total events waiting across every followed session — what "catching up"
  // is really about, since one lane serves all of them.
  private get pendingTotal(): number {
    let total = 0;
    for (const c of this.coalescers.values()) total += c.size;
    return total;
  }

  /**
   * Which session narrates next.
   *
   * The selected session goes first, so the feed the reader is centred on
   * stays responsive no matter how many others are live. It does not go first
   * forever: after `SELECTED_STREAK` consecutive turns it yields one to the
   * round-robin, because a busy selected session would otherwise hold the
   * single lane indefinitely and a background session's events would age out
   * of relevance without ever being narrated.
   *
   * The round-robin walks the ids in sorted order from wherever it left off,
   * which makes the rotation deterministic and starvation-free rather than
   * dependent on Map insertion order.
   */
  private nextSession(): string | null {
    const pending = [...this.coalescers.entries()].filter(([, c]) => c.size > 0).map(([id]) => id).sort();
    if (pending.length === 0) return null;

    const selected = this.registry.watchedSessionId();
    const others = selected ? pending.filter((id) => id !== selected) : pending;
    const selectedPending = selected !== null && pending.includes(selected);

    if (selectedPending && (others.length === 0 || this.consecutiveSelected < SELECTED_STREAK)) {
      this.consecutiveSelected += 1;
      return selected;
    }
    this.consecutiveSelected = 0;
    if (others.length === 0) return selectedPending ? selected : null;
    const after = others.findIndex((id) => id > (this.lastNarrated ?? ""));
    return others[after === -1 ? 0 : after]!;
  }

  private async pump(): Promise<void> {
    if (this.narrating) return;
    this.narrating = true;
    try {
      for (;;) {
        const sessionId = this.nextSession();
        if (!sessionId) break;
        const coalescer = this.coalescers.get(sessionId)!;
        // Resolved here as well as at watch time. Sessions are followed and
        // narrated without anything being selected, so a model resolved only
        // by `watch()` left a fresh boot observing every live session and
        // narrating none of them — silent, and reporting itself as paused for
        // a model that was in fact configured.
        this.stickyModel ??= this.settings.get().narrationModel ?? this.settings.get().chatModel;
        if (!this.stickyModel) {
          this.setStatus("paused-missing-model");
          return;
        }
        this.setStatus(this.pendingTotal > this.catchingUpThreshold ? "catching-up" : "narrating");
        // The adapter id is captured here, with the batch, rather than looked
        // up after the await below: a detach or a disable landing mid-inference
        // would resolve to null, and a null id renders as HAL red — an
        // observation about a session masquerading as HAL's own voice (R14).
        const { events, result, adapterId } = coalescer.drain(this.budgetChars);
        this.lastNarrated = sessionId;
        // The queue cannot cancel a job that is already running, so a batch
        // sitting in it survives a teardown. Captured here, checked after the
        // await: a stale batch drops its result rather than narrating a
        // session that stopped being followed or an adapter that was disabled.
        const epoch = this.watchEpoch;
        const stale = () => epoch !== this.watchEpoch || !this.coalescers.has(sessionId);
        try {
          const text = await this.queue.enqueue("narration", (signal) => this.narrate(result.lines, signal, sessionId));
          if (stale()) continue;
          if (text.trim()) this.addEntry("narration", text.trim(), adapterId, sessionId);
        } catch (err) {
          // Same rule on the failure path: no requeue, no status flip, and
          // above all no retry timer armed after the session went away.
          if (stale()) continue;
          if (err instanceof ProviderError && err.code === "aborted") {
            // Chat preempted this batch (R16): put it back and go again —
            // the next narration job queues behind the running chat.
            coalescer.requeue(events, adapterId);
            continue;
          }
          coalescer.requeue(events, adapterId);
          if (err instanceof ProviderError && err.code === "model_not_found") {
            this.setStatus("paused-missing-model");
            return;
          }
          // Provider outage (AE4): report in-feed once, keep prior entries,
          // retry later. Reported once for the pipeline, not once per session
          // — the lane is shared, so the outage is one condition.
          this.setStatus("provider-unavailable");
          if (this.ring.at(-1)?.kind !== "status") {
            this.addEntry("status", "I am unable to reach the model provider at the moment. My observations continue; narration will resume when contact is restored.");
          }
          this.scheduleRetry();
          return;
        }
      }
      this.setStatus("idle");
    } finally {
      this.narrating = false;
    }
  }

  private async narrate(lines: string[], signal: AbortSignal, sessionId: string | null): Promise<string> {
    const s = this.settings.get();
    const provider = this.providerFactory(s.providerEndpoint);
    let out = "";
    // Resolved per request, like every other setting: an edit lands on the next
    // narration and never rewrites an entry already in the feed (R6). A blanked
    // prompt omits the system message rather than sending an empty one, the
    // same rule chat follows.
    const prompt = resolvePrompt(s.narrationPrompt, DEFAULT_NARRATION_PROMPT);
    const stream = provider.chatStream({
      model: this.stickyModel!,
      messages: [
        ...(isBlankPrompt(prompt) ? [] : [{ role: "system" as const, content: prompt }]),
        { role: "user" as const, content: `Session activity:\n${lines.join("\n")}\n\nNarrate this activity now.` },
      ],
      signal,
      options: { num_ctx: NARRATION_NUM_CTX },
      // Keyed by the session whose events produced this batch, so each
      // followed log gets its own inference file rather than one interleaved
      // stream that has to be split apart before it can be read.
      source: { kind: "session", id: sessionId, label: sessionId ? `Claude ${sessionId}` : "session" },
    });
    for await (const token of stream) out += token;
    return out;
  }
}
