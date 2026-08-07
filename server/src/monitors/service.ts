import type { ClientMessage, Monitor, ServerMessage } from "../../../shared/src/types.js";
import type { WebSocket } from "ws";
import type { MonitorStore } from "../storage/monitors.js";
import type { MonitorNarrator } from "./narrator.js";
import { CommandMonitorRunner, FileMonitorRunner } from "./runner.js";
import { pollIntervalMs, type MonitorRunner } from "./monitor.js";
import { suggestions } from "./catalog.js";

// Structural hub interface so tests can fake it; WsHub satisfies this.
export interface MonitorHub {
  broadcast(msg: ServerMessage): void;
  onMessage(handler: (msg: ClientMessage, client: WebSocket) => void): void;
  onConnection(greet: (client: WebSocket) => void): void;
  sendTo(client: WebSocket, msg: ServerMessage): void;
}

interface Active {
  monitor: Monitor;
  runner: MonitorRunner;
  timer: NodeJS.Timeout;
  polling: boolean;
}

// How often cycle deadlines are checked. A cycle is minutes, so a few seconds
// is cheap; one sweep for all monitors avoids a timer per monitor to leak.
const SWEEP_MS = 5_000;

// Only these change what the runner or the schedule should be. A colour or a
// label does not, and respawning for one would discard a pending cycle.
function needsRespawn(before: Monitor | undefined, after: Monitor): boolean {
  if (!before) return true;
  return (
    before.enabled !== after.enabled ||
    before.verbosity !== after.verbosity ||
    before.cycleMs !== after.cycleMs ||
    JSON.stringify(before.severity) !== JSON.stringify(after.severity) ||
    JSON.stringify(before.source) !== JSON.stringify(after.source)
  );
}

// Owns the Monitors and their schedules.
//
// Mirrors AdapterRegistry's role — hold the sources, answer their protocol,
// broadcast on connect — without its single-watched constraint. That constraint
// is what makes a Session a Session; a Monitor is configured, plural, and
// standing, so it deliberately does not pass through the registry at all.
export class MonitorService {
  private readonly active = new Map<string, Active>();
  private started = false;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly hub: MonitorHub,
    private readonly store: MonitorStore,
    private readonly narrator: MonitorNarrator,
  ) {
    // Catch everything: an escaped rejection from a fire-and-forget handler
    // would crash the process.
    hub.onMessage((msg) => {
      this.handle(msg).catch((err: unknown) => {
        console.error(`monitor handler error: ${err instanceof Error ? err.message : String(err)}`);
      });
    });
    hub.onConnection((client) => {
      void this.list()
        .then((monitors) => hub.sendTo(client, { type: "monitors", monitors }))
        .catch(() => {});
    });
  }

  // Resumes stored monitors on boot. Each starts at the present (R3) because
  // its runner is constructed fresh — no offset or line window survives a
  // restart, so nothing replays.
  async start(): Promise<void> {
    this.started = true;
    for (const monitor of await this.store.list()) {
      if (monitor.enabled) this.spawn(monitor);
    }
    // Establish "the present" now rather than at the first interval: otherwise
    // everything written between boot and the first poll is swallowed as
    // pre-existing, which is up to a full interval of real activity.
    await this.pollNow();
    this.sweepTimer ??= setInterval(() => {
      void this.sweep().catch((err: unknown) => {
        console.error(`monitor sweep error: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, SWEEP_MS);
    this.sweepTimer.unref?.();
    await this.broadcast();
  }

  stop(): void {
    this.started = false;
    for (const [id] of [...this.active]) this.despawn(id);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  async list(): Promise<Monitor[]> {
    return this.store.list();
  }

  private spawn(monitor: Monitor): void {
    this.despawn(monitor.id);
    // The severity rule rides with the runner, so a change to it respawns and
    // recompiles rather than being re-read per line.
    const runner: MonitorRunner =
      monitor.source.kind === "file"
        ? new FileMonitorRunner(monitor.source, monitor.severity)
        : new CommandMonitorRunner(monitor.source, {}, monitor.severity);

    const interval = pollIntervalMs(monitor.source);
    const timer = setInterval(() => {
      void this.pollOne(monitor.id);
    }, interval);
    timer.unref?.();
    this.active.set(monitor.id, { monitor, runner, timer, polling: false });
  }

  private despawn(id: string): void {
    const entry = this.active.get(id);
    if (!entry) return;
    clearInterval(entry.timer);
    this.active.delete(id);
    // Buffered work from a monitor the user just turned off must not surface
    // afterwards.
    this.narrator.forget(id);
  }

  private async pollOne(id: string): Promise<void> {
    const entry = this.active.get(id);
    // Skip rather than queue: a source slower than its interval would otherwise
    // stack polls until one of them wins a race to the same offset.
    if (!entry || entry.polling) return;
    entry.polling = true;
    try {
      const result = await entry.runner.poll();
      // Compare the entry, not the id: an update respawns under the same id, so
      // an id check would let a poll started by the old runner feed the new one.
      if (this.active.get(id) !== entry) return;
      await this.narrator.ingest(entry.monitor, result);
    } catch (err) {
      console.error(`monitor ${id} poll error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      entry.polling = false;
    }
  }

  // Polls every active monitor once, now. The scheduler normally drives this;
  // exposing it keeps tests deterministic instead of sleeping past an interval.
  async pollNow(): Promise<void> {
    await Promise.all([...this.active.keys()].map((id) => this.pollOne(id)));
  }

  // Checks cycle deadlines against the monitors that actually exist right now,
  // which is why the service owns this rather than the narrator.
  async sweep(): Promise<void> {
    await this.narrator.sweepDue([...this.active.values()].map((a) => a.monitor));
  }

  private async handle(msg: ClientMessage): Promise<void> {
    switch (msg.type) {
      case "list-monitors":
        await this.broadcast();
        return;
      case "add-monitor": {
        const monitor = await this.store.add(msg.monitor);
        if (this.started && monitor.enabled) {
          this.spawn(monitor);
          // Start at the moment it was added, not at the first interval.
          await this.pollOne(monitor.id);
        }
        await this.broadcast();
        return;
      }
      case "update-monitor": {
        const before = this.active.get(msg.monitorId)?.monitor;
        const updated = await this.store.update(msg.monitorId, msg.patch);
        if (!updated) return;
        if (this.started && needsRespawn(before, updated)) {
          // Respawn rather than mutate: a changed source, interval, or
          // verbosity means the runner and schedule are no longer the right
          // ones. Re-enabling resumes at the present rather than replaying.
          this.despawn(updated.id);
          if (updated.enabled) {
            this.spawn(updated);
            await this.pollOne(updated.id);
          }
        } else {
          // Cosmetic change — a colour or a label. Swapping the runner would
          // throw away a quiet monitor's accumulated cycle for nothing.
          const entry = this.active.get(updated.id);
          if (entry) entry.monitor = updated;
        }
        await this.broadcast();
        return;
      }
      case "remove-monitor": {
        // Despawn first and unconditionally: if the store no longer lists it,
        // a `removed === false` early return would leave its timer polling
        // forever with no way to reach it again.
        this.despawn(msg.monitorId);
        await this.store.remove(msg.monitorId);
        await this.broadcast();
        return;
      }
      case "list-monitor-suggestions":
        this.hub.broadcast({ type: "monitor-suggestions", suggestions: await suggestions() });
        return;
      default:
        return;
    }
  }

  private async broadcast(): Promise<void> {
    this.hub.broadcast({ type: "monitors", monitors: await this.list() });
  }
}
