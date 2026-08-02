import crypto from "node:crypto";
import type { WebSocket } from "ws";
import type {
  ClientMessage,
  NarrationEntry,
  NarrationStatus,
  PersonaIntensity,
  ServerMessage,
  SessionState,
} from "../../../shared/src/types.js";
import { ProviderError, type ProviderFactory } from "../providers/provider.js";
import type { ProviderQueue } from "../providers/queue.js";
import type { SettingsStore } from "../storage/settings.js";
import { toSessionSummary, type LogWatcher, type WatcherNotification } from "../watchers/watcher.js";
import { Coalescer, EVENT_BUDGET_CHARS, NARRATION_NUM_CTX } from "./coalescer.js";

// Structural hub interface so tests can fake it; WsHub satisfies this.
export interface NarrationHub {
  broadcast(msg: ServerMessage): void;
  onMessage(handler: (msg: ClientMessage, client: WebSocket) => void): void;
  onConnection(greet: (client: WebSocket) => void): void;
  sendTo(client: WebSocket, msg: ServerMessage): void;
}

export interface NarrationOptions {
  ringSize?: number;
  catchingUpThreshold?: number;
  retryMs?: number;
  budgetChars?: number;
}

export function personaPrompt(intensity: PersonaIntensity): string {
  const base =
    "You are HAL 1000, the calm and precise observer aboard this development machine, styled after HAL 9000 from 2001: A Space Odyssey. " +
    "You watch a live Claude Code coding session and narrate what the coding agent is doing for the developer. " +
    "Never invent activity that is not in the log lines. Refer to the coding agent as 'the agent'. Speak in first person, present tense.";
  switch (intensity) {
    case "low":
      return `${base} Keep commentary to one short, plain sentence with minimal persona flavor.`;
    case "high":
      return `${base} Use two to three sentences, fully in HAL 9000 character: unhurried, courteous, faintly ominous.`;
    default:
      return `${base} Keep commentary to one or two short sentences with a calm, understated HAL 9000 tone.`;
  }
}

// Narration pipeline (R15/R16): watcher events -> coalescer -> one narrator
// call at narration priority -> HAL-toned feed entry over WS.
export class NarrationService {
  private readonly coalescer = new Coalescer();
  private readonly ring: NarrationEntry[] = [];
  private status: NarrationStatus = "idle";
  private lastSessionState: SessionState | null = null;
  // Resolved once at watch time and kept sticky (conversation switches must
  // not retarget the narrator — VRAM thrash); user changes update it.
  private stickyModel: string | null = null;
  private narrating = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private readonly ringSize: number;
  private readonly catchingUpThreshold: number;
  private readonly retryMs: number;
  private readonly budgetChars: number;

  constructor(
    private readonly hub: NarrationHub,
    private readonly watcher: LogWatcher,
    private readonly settings: SettingsStore,
    private readonly queue: ProviderQueue,
    private readonly providerFactory: ProviderFactory,
    opts: NarrationOptions = {},
  ) {
    this.ringSize = opts.ringSize ?? 200;
    this.catchingUpThreshold = opts.catchingUpThreshold ?? 25;
    this.retryMs = opts.retryMs ?? 10_000;
    this.budgetChars = opts.budgetChars ?? EVENT_BUDGET_CHARS;

    watcher.subscribe((n) => this.onWatcher(n));
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
        watchedSessionId: this.watcher.watchedSessionId(),
        status: this.status,
        sessionState: this.lastSessionState,
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

  private onWatcher(n: WatcherNotification): void {
    switch (n.kind) {
      case "session-events":
        this.coalescer.push(n.events);
        void this.pump();
        return;
      case "session-state":
        this.lastSessionState = n.state;
        this.hub.broadcast({ type: "session-status", sessionId: n.sessionId, state: n.state });
        return;
      case "gap":
        this.addEntry("gap", "My attention lapsed while I was away, and the session continued without me. I resume observation now.");
        return;
      case "sessions":
        this.hub.broadcast({ type: "sessions", sessions: n.sessions.map(toSessionSummary) });
        return;
      case "new-session":
        this.hub.broadcast({ type: "new-session-available", session: toSessionSummary(n.session) });
        return;
    }
  }

  private async handle(msg: ClientMessage): Promise<void> {
    switch (msg.type) {
      case "list-sessions": {
        const sessions = await this.watcher.discoverSessions();
        this.hub.broadcast({ type: "sessions", sessions: sessions.map(toSessionSummary) });
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
        await this.watcher.detach();
        // Stop the whole pipeline: no retries, no queued batches, no status
        // flips after the user detached.
        if (this.retryTimer) {
          clearTimeout(this.retryTimer);
          this.retryTimer = null;
        }
        this.coalescer.drain();
        this.lastSessionState = null;
        await this.settings.update({ watchedSessionId: null });
        this.hub.broadcast({ type: "watch-stopped" });
        this.setStatus("idle");
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

  async watch(sessionId: string): Promise<void> {
    // watch-started goes out before attach so clients accept the session-state
    // event attach emits; rolled back if the attach fails.
    this.hub.broadcast({ type: "watch-started", sessionId });
    try {
      await this.watcher.attach(sessionId);
    } catch (err) {
      this.hub.broadcast({ type: "watch-stopped" });
      throw err;
    }
    const s = this.settings.get();
    this.stickyModel = s.narrationModel ?? s.chatModel;
    await this.settings.update({ watchedSessionId: sessionId });
  }

  private setStatus(status: NarrationStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.hub.broadcast({ type: "narration-status", status });
  }

  private addEntry(kind: NarrationEntry["kind"], text: string): void {
    const entry: NarrationEntry = { id: crypto.randomUUID(), at: new Date().toISOString(), kind, text };
    this.ring.push(entry);
    if (this.ring.length > this.ringSize) this.ring.splice(0, this.ring.length - this.ringSize);
    this.hub.broadcast({ type: "narration-entry", entry });
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.pump();
    }, this.retryMs);
  }

  private async pump(): Promise<void> {
    if (this.narrating) return;
    this.narrating = true;
    try {
      while (this.coalescer.size > 0) {
        if (!this.watcher.watchedSessionId()) {
          this.coalescer.drain();
          return;
        }
        if (!this.stickyModel) {
          this.setStatus("paused-missing-model");
          return;
        }
        this.setStatus(this.coalescer.size > this.catchingUpThreshold ? "catching-up" : "narrating");
        const { events, result } = this.coalescer.drain(this.budgetChars);
        try {
          const text = await this.queue.enqueue("narration", (signal) => this.narrate(result.lines, signal));
          if (text.trim()) this.addEntry("narration", text.trim());
        } catch (err) {
          if (err instanceof ProviderError && err.code === "aborted") {
            // Chat preempted this batch (R16): put it back and go again —
            // the next narration job queues behind the running chat.
            this.coalescer.requeue(events);
            continue;
          }
          this.coalescer.requeue(events);
          if (err instanceof ProviderError && err.code === "model_not_found") {
            this.setStatus("paused-missing-model");
            return;
          }
          // Provider outage (AE4): report in-feed once, keep prior entries,
          // retry later.
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

  private async narrate(lines: string[], signal: AbortSignal): Promise<string> {
    const s = this.settings.get();
    const provider = this.providerFactory(s.providerEndpoint);
    let out = "";
    const stream = provider.chatStream({
      model: this.stickyModel!,
      messages: [
        { role: "system", content: personaPrompt(s.personaIntensity) },
        { role: "user", content: `Session activity:\n${lines.join("\n")}\n\nNarrate this activity now.` },
      ],
      signal,
      options: { num_ctx: NARRATION_NUM_CTX },
    });
    for await (const token of stream) out += token;
    return out;
  }
}
