import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { waitFor } from "../wait.js";
import { pinnedSettings } from "../settings.js";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import type { WebSocket } from "ws";
import { MonitorService, type MonitorHub } from "../../src/monitors/service.js";
import { MonitorNarrator } from "../../src/monitors/narrator.js";
import { MonitorStore } from "../../src/storage/monitors.js";
import { ProviderQueue } from "../../src/providers/queue.js";
import { SettingsStore } from "../../src/storage/settings.js";
import type { ChatStreamOptions, Provider, ProviderFactory } from "../../src/providers/provider.js";
import type { ClientMessage, NarrationEntry, ServerMessage } from "../../../shared/src/types.js";

class FakeHub implements MonitorHub {
  readonly broadcasts: ServerMessage[] = [];
  readonly sent: ServerMessage[] = [];
  private readonly handlers: ((msg: ClientMessage, c: WebSocket) => void)[] = [];
  private readonly greeters: ((c: WebSocket) => void)[] = [];

  broadcast(msg: ServerMessage): void {
    this.broadcasts.push(msg);
  }
  onMessage(h: (msg: ClientMessage, c: WebSocket) => void): void {
    this.handlers.push(h);
  }
  onConnection(g: (c: WebSocket) => void): void {
    this.greeters.push(g);
  }
  sendTo(_c: WebSocket, msg: ServerMessage): void {
    this.sent.push(msg);
  }
  dispatch(msg: ClientMessage): void {
    for (const h of this.handlers) h(msg, null as unknown as WebSocket);
  }
  connect(): void {
    for (const g of this.greeters) g(null as unknown as WebSocket);
  }
}

let dir: string;
let file: string;
let hub: FakeHub;
let store: MonitorStore;
let entries: NarrationEntry[];
let service: MonitorService | null;

const provider = (): ProviderFactory => () => ({
  async listModels() {
    return [];
  },
  async *chatStream(_opts: ChatStreamOptions): AsyncIterable<string> {
    yield "Observed.";
  },
});

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hal1000-msvc-"));
  file = path.join(dir, "watched.log");
  await fs.writeFile(file, "pre-existing\n", "utf8");
  hub = new FakeHub();
  store = new MonitorStore(dir);
  entries = [];
  const settings = await pinnedSettings(dir);
  await settings.update({ chatModel: "fake" });
  const narrator = new MonitorNarrator(
    { record: (e) => entries.push(e) },
    settings,
    new ProviderQueue(),
    provider(),
  );
  service = new MonitorService(hub, store, narrator);
});

afterEach(() => {
  service?.stop();
  service = null;
});

const monitors = () => hub.broadcasts.filter((m): m is Extract<ServerMessage, { type: "monitors" }> => m.type === "monitors");

describe("MonitorService", () => {
  it("resumes stored monitors on boot and starts them at the present (R4, R3)", async () => {
    await store.add({ label: "log", source: { kind: "file", path: file }, verbosity: "full" });
    await service!.start();

    await waitFor(() => monitors().length > 0, "the boot monitor broadcast");
    // Content that existed before boot is never replayed.
    expect(entries).toEqual([]);
    expect(monitors().at(-1)!.monitors.map((m) => m.label)).toEqual(["log"]);
  });

  it("adding a monitor starts it without a restart", async () => {
    await service!.start();
    hub.dispatch({ type: "add-monitor", monitor: { label: "added", source: { kind: "file", path: file } } });
    await waitFor(() => monitors().at(-1)!.monitors.some((x) => x.label === "added"), "the added monitor to be broadcast");
    expect(monitors().at(-1)!.monitors.map((m) => m.label)).toEqual(["added"]);
  });

  it("removing a monitor stops it and drops it from the broadcast", async () => {
    const m = await store.add({ label: "temp", source: { kind: "file", path: file } });
    await service!.start();

    hub.dispatch({ type: "remove-monitor", monitorId: m.id });
    await waitFor(() => monitors().at(-1)!.monitors.length === 0, "the removal to be broadcast");
    // Its buffered work is dropped too, so nothing surfaces afterwards.
    await service!.sweep();
    expect(entries).toEqual([]);
  });

  it("disabling a monitor stops it but keeps it configured", async () => {
    const m = await store.add({ label: "toggle", source: { kind: "file", path: file } });
    await service!.start();

    hub.dispatch({ type: "update-monitor", monitorId: m.id, patch: { enabled: false } });
    await waitFor(() => monitors().at(-1)!.monitors[0]?.enabled === false, "the disabled monitor to be broadcast");
    const listed = monitors().at(-1)!.monitors;
    expect(listed).toHaveLength(1);
    expect(listed[0]!.enabled).toBe(false);
  });

  it("handles an update or removal for a monitor that does not exist", async () => {
    const m = await store.add({ label: "real", source: { kind: "file", path: file } });
    await service!.start();

    const seen = monitors().length;
    hub.dispatch({ type: "update-monitor", monitorId: "nope", patch: { verbosity: "full" } });
    hub.dispatch({ type: "remove-monitor", monitorId: "nope" });
    await waitFor(() => monitors().length > seen, "a broadcast for the monitor that does not exist");

    // No crash, and the real monitor is untouched. Removal is idempotent and
    // still broadcasts — it despawns before consulting the store so a monitor
    // the store has already lost cannot keep a timer running unreachably.
    const listed = monitors().at(-1)!.monitors;
    expect(listed.map((x) => x.id)).toEqual([m.id]);
  });

  it("removing a monitor the store no longer lists still stops its timer", async () => {
    const m = await store.add({ label: "orphan", source: { kind: "file", path: file }, verbosity: "full" });
    await service!.start();
    // The store loses it behind the service's back — a hand-edited file, or a
    // concurrent removal.
    await store.remove(m.id);

    const before = monitors().length;
    hub.dispatch({ type: "remove-monitor", monitorId: m.id });
    await waitFor(() => monitors().length > before, "the orphan removal broadcast");

    await fs.appendFile(file, "after orphan removal\n", "utf8");
    await service!.pollNow();
    expect(entries).toEqual([]);
  });

  it("broadcasts the monitor list on client connect", async () => {
    await store.add({ label: "greeted", source: { kind: "file", path: file } });
    await service!.start();
    hub.connect();
    await waitFor(() => hub.sent.some((m) => m.type === "monitors"), "the monitor list sent on connect");
    const greeting = hub.sent.filter((m): m is Extract<ServerMessage, { type: "monitors" }> => m.type === "monitors");
    expect(greeting.at(-1)!.monitors.map((m) => m.label)).toEqual(["greeted"]);
  });

  it("answers a suggestions request", async () => {
    await service!.start();
    hub.dispatch({ type: "list-monitor-suggestions" });
    await waitFor(() => hub.broadcasts.some((m) => m.type === "monitor-suggestions"), "the suggestions reply");
    const suggested = hub.broadcasts.filter((m): m is Extract<ServerMessage, { type: "monitor-suggestions" }> => m.type === "monitor-suggestions");
    expect(suggested).toHaveLength(1);
    expect(suggested[0]!.suggestions.length).toBeGreaterThan(0);
  });

  it("narrates appended lines for a full-verbosity monitor (R18)", async () => {
    await store.add({ label: "live", source: { kind: "file", path: file }, verbosity: "full" });
    await service!.start();

    // No Watched Session exists in this harness at all — monitors run anyway.
    await fs.appendFile(file, "something happened\n", "utf8");
    await service!.pollNow();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("narration");
  });

  it("reports an unreadable source without stopping the schedule (R5)", async () => {
    await store.add({ label: "vanishing", source: { kind: "file", path: file }, verbosity: "full" });
    await service!.start();
    await service!.pollNow();

    await fs.rm(file);
    await service!.pollNow();
    expect(entries.some((e) => e.kind === "status" && /cannot read/i.test(e.text))).toBe(true);

    // Still scheduled: the source returning is picked up without a restart.
    await fs.writeFile(file, "", "utf8");
    await service!.pollNow();
    await fs.appendFile(file, "back again\n", "utf8");
    await service!.pollNow();
    expect(entries.some((e) => e.kind === "narration")).toBe(true);
  });

  it("survives a runner that throws without stopping other monitors", async () => {
    await store.add({ label: "bad", source: { kind: "command", command: "definitely-not-a-real-command-xyz", intervalMs: 1000 }, verbosity: "full" });
    await store.add({ label: "good", source: { kind: "file", path: file }, verbosity: "full" });
    await service!.start();

    await fs.appendFile(file, "still working\n", "utf8");
    await service!.pollNow();
    // The failing command reports a problem; the healthy monitor still narrates.
    expect(entries.some((e) => e.kind === "narration")).toBe(true);
  });
});
