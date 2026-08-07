import type {
  AdapterId,
  AdapterInfo,
  ClientMessage,
  ServerMessage,
  SettingsPatch,
  SessionSummary,
} from "../../../shared/src/types.js";
import type { WebSocket } from "ws";
import type { SettingsStore } from "../storage/settings.js";
import { toSessionSummary, type LogWatcher, type WatcherNotification } from "./watcher.js";

// Structural hub interface so tests can fake it; WsHub satisfies this.
export interface AdapterHub {
  broadcast(msg: ServerMessage): void;
  onMessage(handler: (msg: ClientMessage, client: WebSocket) => void): void;
  onConnection(greet: (client: WebSocket) => void): void;
  sendTo(client: WebSocket, msg: ServerMessage): void;
}

// One adapter as the registry is handed it. The label is the registry's, not
// the watcher's: `LogWatcher` stays adapter-agnostic (it is the seam codex and
// generic watchers slot into) and knows nothing about ids or presentation.
export interface AdapterRegistration {
  id: AdapterId;
  label: string;
  watcher: LogWatcher;
}

// The narration pipeline's view of the registry — the shape that replaced the
// single injected `LogWatcher`. Session shapes are already wire summaries here
// because only the registry knows which adapter owns what.
export interface WatcherRegistry {
  discoverSessions(): Promise<SessionSummary[]>;
  attach(sessionId: string): Promise<void>;
  detach(): Promise<void>;
  watchedSessionId(): string | null;
  // Every session under observation across all enabled adapters, not just the
  // selected one.
  followedSessionIds(): string[];
  // How an adapter names itself, for the per-session label the feed stamps on
  // an entry. Only the registry knows it: `LogWatcher` is deliberately
  // ignorant of ids and presentation.
  adapterLabel(adapterId: AdapterId | null): string;
  subscribe(listener: (n: WatcherNotification, adapterId: AdapterId) => void): void;
  // Fires while the disabled adapter is still attached, so the listener can run
  // the full watch teardown before polling stops.
  onDisabled(listener: (adapterId: AdapterId) => Promise<void> | void): void;
}

interface Entry extends AdapterRegistration {
  enabled: boolean;
}

// Owns every observation adapter and answers the adapter protocol (R7, R12).
// Discovery unions the enabled adapters and tags each summary with its owner;
// attach routes by that ownership; disable runs a full teardown (R8) but leaves
// recorded entries alone (R9) and never re-attaches on re-enable (R10).
export class AdapterRegistry implements WatcherRegistry {
  private readonly entries: Entry[];
  private readonly listeners = new Set<(n: WatcherNotification, adapterId: AdapterId) => void>();
  private readonly disabledListeners = new Set<(adapterId: AdapterId) => Promise<void> | void>();
  private readonly changedListeners = new Set<() => void>();
  // The adapter currently holding the watched session. At most one: the feed
  // narrates a single session at a time.
  private watched: AdapterId | null = null;

  constructor(
    private readonly hub: AdapterHub,
    private readonly settings: SettingsStore,
    registrations: AdapterRegistration[],
  ) {
    const stored = settings.get().adapters;
    this.entries = registrations.map((r) => ({ ...r, enabled: stored[r.id]?.enabled ?? true }));
    for (const entry of this.entries) {
      entry.watcher.subscribe((n) => {
        for (const l of this.listeners) l(n, entry.id);
      });
    }

    // Catch everything: an escaped rejection would crash the process.
    hub.onMessage((msg) => {
      this.handle(msg).catch((err: unknown) => {
        console.error(`adapter handler error: ${err instanceof Error ? err.message : String(err)}`);
      });
    });
    hub.onConnection((client) => hub.sendTo(client, { type: "adapters", adapters: this.list() }));
  }

  list(): AdapterInfo[] {
    // Every registered adapter, including ones the stored settings omit.
    return this.entries.map(({ id, label, enabled }) => ({ id, label, enabled }));
  }

  isEnabled(id: AdapterId): boolean {
    return this.entries.find((e) => e.id === id)?.enabled ?? false;
  }

  // Starts polling for every enabled adapter. Attaching is a separate,
  // user-driven act (R10).
  start(): void {
    for (const entry of this.entries) {
      if (entry.enabled) entry.watcher.start();
    }
  }

  stop(): void {
    for (const entry of this.entries) entry.watcher.stop();
  }

  subscribe(listener: (n: WatcherNotification, adapterId: AdapterId) => void): void {
    this.listeners.add(listener);
  }

  onDisabled(listener: (adapterId: AdapterId) => Promise<void> | void): void {
    this.disabledListeners.add(listener);
  }

  // Seam for the readiness probe: U4 makes readiness adapter-aware, and this is
  // how a toggle reaches it without the registry importing readiness.
  onChanged(listener: () => void): void {
    this.changedListeners.add(listener);
  }

  async discoverSessions(): Promise<SessionSummary[]> {
    const enabled = this.entries.filter((e) => e.enabled);
    const legs = await Promise.allSettled(enabled.map((e) => e.watcher.discoverSessions()));
    const sessions: SessionSummary[] = [];
    legs.forEach((leg, i) => {
      const { id } = enabled[i]!;
      if (leg.status !== "fulfilled") {
        console.error(`adapter ${id} discovery failed: ${leg.reason instanceof Error ? leg.reason.message : String(leg.reason)}`);
        return;
      }
      // Tagged here because ownership is the registry's knowledge alone; the
      // picker routes an attach by it and the feed resolves a colour from it.
      for (const info of leg.value) sessions.push({ ...toSessionSummary(info), adapterId: id });
    });
    return sessions;
  }

  async attach(sessionId: string): Promise<void> {
    const owner = await this.ownerOf(sessionId);
    if (!owner) {
      // Thrown, not swallowed: the caller turns this into a watch-failure the
      // client can see, rather than silently watching nothing.
      throw new Error(`No enabled adapter owns session ${sessionId}.`);
    }
    if (this.watched && this.watched !== owner.id) await this.detach();
    await owner.watcher.attach(sessionId);
    this.watched = owner.id;
  }

  async detach(): Promise<void> {
    const entry = this.entries.find((e) => e.id === this.watched);
    this.watched = null;
    if (entry) await entry.watcher.detach();
  }

  watchedSessionId(): string | null {
    const entry = this.entries.find((e) => e.id === this.watched);
    return entry?.watcher.watchedSessionId() ?? null;
  }

  followedSessionIds(): string[] {
    return this.entries.filter((e) => e.enabled).flatMap((e) => e.watcher.followedSessionIds());
  }

  adapterLabel(adapterId: AdapterId | null): string {
    if (!adapterId) return "session";
    return this.entries.find((e) => e.id === adapterId)?.label ?? adapterId;
  }

  watchedAdapterId(): AdapterId | null {
    return this.watched;
  }

  async setEnabled(id: AdapterId, enabled: boolean): Promise<void> {
    const entry = this.entries.find((e) => e.id === id);
    // Toggling to the state an adapter is already in must not restart polling:
    // a redundant start() would re-arm timers and re-sweep for no reason.
    if (!entry || entry.enabled === enabled) {
      this.broadcastAdapters();
      return;
    }
    entry.enabled = enabled;
    await this.settings.update({ adapters: { [id]: { enabled } } as SettingsPatch["adapters"] });

    if (enabled) {
      // Polling only (R10): the user chooses a session, nothing auto-resumes.
      entry.watcher.start();
    } else {
      // Detaching and stopping the poll is not enough — a queued batch, a
      // pending retry, and the persisted watched session all outlive it. The
      // listener (the narration service) runs that teardown while this adapter
      // is still the watched one.
      if (this.watched === id) {
        for (const l of this.disabledListeners) await l(id);
      }
      entry.watcher.stop();
    }

    this.broadcastAdapters();
    for (const l of this.changedListeners) l();
  }

  private async handle(msg: ClientMessage): Promise<void> {
    switch (msg.type) {
      case "list-adapters":
        this.broadcastAdapters();
        return;
      case "set-adapter-enabled":
        await this.setEnabled(msg.adapterId, msg.enabled);
        return;
      default:
        return;
    }
  }

  private broadcastAdapters(): void {
    this.hub.broadcast({ type: "adapters", adapters: this.list() });
  }

  // A disabled adapter owns nothing, so its sessions are unreachable — that is
  // what makes a stale `watchedSessionId` fail to restore rather than silently
  // re-attach to a source the user turned off.
  private async ownerOf(sessionId: string): Promise<Entry | null> {
    for (const entry of this.entries) {
      if (!entry.enabled) continue;
      try {
        const sessions = await entry.watcher.discoverSessions();
        if (sessions.some((s) => s.id === sessionId)) return entry;
      } catch {
        // A discovery failure is not ownership; try the next adapter.
      }
    }
    return null;
  }
}
