import path from "node:path";
import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import type { Monitor, MonitorDraft, MonitorPatch, MonitorSource } from "../../../shared/src/types.js";
import { DEFAULT_CYCLE_MS, DEFAULT_POLL_MS, MIN_POLL_MS } from "../monitors/monitor.js";
import { MAX_SEVERITY_PATTERN } from "../monitors/severity.js";
import { readJson, writeJsonAtomic } from "./atomic.js";
import { normalizeColor } from "./colors.js";

// Distinct from the adapter default so a Monitor is not mistaken for an
// observation from the Claude Code adapter at a glance. Normalization still
// applies, so this is a starting point rather than a guarantee.
const DEFAULT_MONITOR_COLOR = "#9ec5d8";

const LABEL_MAX = 60;

// A stored entry that survives a hand edit: anything structurally unusable is
// dropped on load rather than crashing the process, matching how a malformed
// colour is dropped rather than stored.
function usable(value: unknown): value is Monitor {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Partial<Monitor>;
  if (typeof m.id !== "string" || m.id.length === 0) return false;
  if (typeof m.label !== "string") return false;
  const src = m.source;
  if (typeof src !== "object" || src === null) return false;
  if (src.kind === "file") return typeof src.path === "string" && src.path.trim().length > 0;
  if (src.kind === "command") return typeof src.command === "string" && src.command.trim().length > 0;
  return false;
}

// An interval of zero, negative, or NaN turns a command monitor into a
// continuous shell-exec loop. Clamped here rather than trusted from the client:
// the UI's completeness check does not bind an agent speaking the protocol.
function normalizeSource(source: MonitorSource): MonitorSource {
  if (source.kind !== "command") return source;
  const interval = typeof source.intervalMs === "number" && Number.isFinite(source.intervalMs) ? source.intervalMs : DEFAULT_POLL_MS;
  return { ...source, intervalMs: Math.max(MIN_POLL_MS, interval) };
}

// A rule that would not compile is dropped back to the shipped keyword list.
// Storing it would leave the monitor permanently deaf with nothing on screen to
// explain why — worse than being noisy.
function normalizeSeverity(rule: Monitor["severity"]): Monitor["severity"] {
  if (!rule || typeof rule !== "object") return undefined;
  if (rule.kind === "never" || rule.kind === "default") return rule;
  if (rule.kind !== "pattern" || typeof rule.pattern !== "string") return undefined;
  const pattern = rule.pattern.trim();
  if (pattern.length === 0 || pattern.length > MAX_SEVERITY_PATTERN) return undefined;
  try {
    new RegExp(pattern, "i");
  } catch {
    return undefined;
  }
  return { kind: "pattern", pattern };
}

function normalize(m: Monitor): Monitor {
  return {
    ...m,
    label: m.label.slice(0, LABEL_MAX),
    source: normalizeSource(m.source),
    severity: normalizeSeverity(m.severity),
    verbosity: m.verbosity === "full" ? "full" : "quiet",
    // A non-positive cycle would busy-loop the narrator.
    cycleMs: typeof m.cycleMs === "number" && m.cycleMs > 0 ? m.cycleMs : DEFAULT_CYCLE_MS,
    // Normalized on load as well as write, so a hand-edited file or a value
    // stored before the thresholds were tuned is corrected rather than trusted.
    color: normalizeColor(m.color) ?? DEFAULT_MONITOR_COLOR,
    enabled: m.enabled !== false,
  };
}

// One JSON file holding every Monitor. Mutations serialize through a single
// lock rather than one per id: the file is the unit of write, so per-id locking
// would still interleave two writes of the whole list.
export class MonitorStore {
  private readonly file: string;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "monitors.json");
  }

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async list(): Promise<Monitor[]> {
    const stored = await readJson<unknown[]>(this.file);
    if (!Array.isArray(stored)) return [];
    return stored.filter(usable).map(normalize);
  }

  async add(draft: MonitorDraft): Promise<Monitor> {
    return this.withLock(async () => {
      const monitors = await this.list();
      // Server-generated: a Monitor id is never a client-supplied path segment,
      // which is what lets it skip the UUID guard conversations need.
      const monitor = normalize({
        id: crypto.randomUUID(),
        label: draft.label,
        source: draft.source,
        verbosity: draft.verbosity ?? "quiet",
        cycleMs: draft.cycleMs ?? DEFAULT_CYCLE_MS,
        color: draft.color ?? DEFAULT_MONITOR_COLOR,
        enabled: true,
        severity: draft.severity,
      });
      await this.save([...monitors, monitor]);
      return monitor;
    });
  }

  async update(id: string, patch: MonitorPatch): Promise<Monitor | null> {
    return this.withLock(async () => {
      const monitors = await this.list();
      const index = monitors.findIndex((m) => m.id === id);
      if (index === -1) return null;
      // Keys are merged individually rather than spread wholesale so a patch
      // carrying one field cannot drop the source of a monitor it did not name.
      const previous = monitors[index]!;
      const updated = normalize({
        ...previous,
        ...patch,
        id: previous.id,
        source: patch.source ?? previous.source,
      });
      monitors[index] = updated;
      await this.save(monitors);
      return updated;
    });
  }

  async remove(id: string): Promise<boolean> {
    return this.withLock(async () => {
      const monitors = await this.list();
      const remaining = monitors.filter((m) => m.id !== id);
      if (remaining.length === monitors.length) return false;
      await this.save(remaining);
      return true;
    });
  }

  private async save(monitors: Monitor[]): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await writeJsonAtomic(this.file, monitors);
  }
}
