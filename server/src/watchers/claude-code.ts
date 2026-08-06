import { promises as fs } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { SessionState } from "../../../shared/src/types.js";
import { readJson, writeJsonAtomic } from "../storage/atomic.js";
import type { LogWatcher, SessionEvent, SessionInfo, WatcherNotification } from "./watcher.js";

const TEXT_CLIP = 500;
// Tool traffic is the bulk of a session, so each piece gets a tighter budget
// than prose: enough to identify the target and the outcome, not to replay them.
const THINKING_CLIP = 300;
// A successful result only has to say what came back; a failure carries the
// message HAL should actually report, so it gets the wider budget.
const RESULT_OK_CLIP = 120;
const RESULT_ERROR_CLIP = 300;
const TOOL_DETAIL_CLIP = 80;

export interface ClaudeCodeWatcherOptions {
  projectsDir: string;
  stateFile: string;
  tailIntervalMs?: number;
  sweepIntervalMs?: number;
  liveMs?: number;
  idleMs?: number;
  parseErrorThreshold?: number;
}

interface PersistedState {
  sessionId: string;
  offset: number;
  fileId: string;
}

interface WatchedSession {
  id: string;
  file: string;
  offset: number;
  fileId: string;
  parseErrors: number;
  lastState: SessionState | null;
  // Bytes read but not yet parseable — a line still being written (no
  // trailing newline yet). Never counted as malformed.
  pending: string;
  // Stateful decoder so a multi-byte UTF-8 character split across two poll
  // reads decodes correctly instead of producing replacement chars.
  decoder: StringDecoder;
}

// Claude Code session watcher: polls ~/.claude/projects/<slug>/<uuid>.jsonl.
// Polling (not fs.watch) is deliberate — reliable cross-platform, and mtime
// doubles as the liveness signal (R13).
export class ClaudeCodeWatcher implements LogWatcher {
  private readonly opts: Required<ClaudeCodeWatcherOptions>;
  private readonly listeners = new Set<(n: WatcherNotification) => void>();
  private watched: WatchedSession | null = null;
  private tailTimer: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private knownSessionIds = new Set<string>();
  private lastSweepSnapshot = "";
  private ticking = false;

  constructor(opts: ClaudeCodeWatcherOptions) {
    this.opts = {
      tailIntervalMs: 1000,
      sweepIntervalMs: 20000,
      liveMs: 5 * 60_000,
      idleMs: 30 * 60_000,
      parseErrorThreshold: 20,
      ...opts,
    };
  }

  subscribe(listener: (n: WatcherNotification) => void): void {
    this.listeners.add(listener);
  }

  private emit(n: WatcherNotification): void {
    for (const l of this.listeners) l(n);
  }

  watchedSessionId(): string | null {
    return this.watched?.id ?? null;
  }

  start(): void {
    if (this.tailTimer) return;
    this.tailTimer = setInterval(() => void this.tailTick(), this.opts.tailIntervalMs);
    this.sweepTimer = setInterval(() => void this.sweepTick(), this.opts.sweepIntervalMs);
  }

  stop(): void {
    if (this.tailTimer) clearInterval(this.tailTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.tailTimer = null;
    this.sweepTimer = null;
  }

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  async discoverSessions(): Promise<SessionInfo[]> {
    const sessions: SessionInfo[] = [];
    let projectDirs: string[];
    try {
      projectDirs = await fs.readdir(this.opts.projectsDir);
    } catch {
      return [];
    }
    for (const slug of projectDirs) {
      const dir = path.join(this.opts.projectsDir, slug);
      let entries: string[];
      try {
        entries = await fs.readdir(dir);
      } catch {
        continue;
      }
      // Skip project dirs with no session logs (observed: some contain only memory/).
      const logs = entries.filter((e) => e.endsWith(".jsonl"));
      for (const log of logs) {
        const file = path.join(dir, log);
        try {
          const stat = await fs.stat(file);
          sessions.push({
            id: path.basename(log, ".jsonl"),
            projectSlug: slug,
            projectName: decodeSlug(slug),
            file,
            state: this.classify(stat.mtimeMs),
            lastActivity: new Date(stat.mtimeMs).toISOString(),
          });
        } catch {
          // File vanished between readdir and stat — skip.
        }
      }
    }
    return sessions.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
  }

  private classify(mtimeMs: number): SessionState {
    const age = Date.now() - mtimeMs;
    if (age < this.opts.liveMs) return "live";
    if (age < this.opts.idleMs) return "idle";
    return "ended";
  }

  // -------------------------------------------------------------------------
  // Attach / detach
  // -------------------------------------------------------------------------

  async attach(sessionId: string): Promise<void> {
    const sessions = await this.discoverSessions();
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found.`);

    const stat = await fs.stat(session.file, { bigint: true });
    const fileId = `${stat.dev}:${stat.ino}`;
    const size = Number(stat.size);

    // R14: fresh attaches and re-attaches both start at EOF — narration is
    // about "now", not history. A persisted offset below EOF means we missed
    // activity: emit one gap notice instead of replaying.
    const persisted = await readJson<PersistedState>(this.opts.stateFile);
    const missedActivity = persisted?.sessionId === sessionId && persisted.fileId === fileId && persisted.offset < size;

    this.watched = {
      id: sessionId,
      file: session.file,
      offset: size,
      fileId,
      parseErrors: 0,
      lastState: null,
      pending: "",
      decoder: new StringDecoder("utf8"),
    };
    await this.persist();
    if (missedActivity) this.emit({ kind: "gap", sessionId });
    const state = this.classify(Number(stat.mtimeMs));
    this.emit({ kind: "session-state", sessionId, state });
    this.watched.lastState = state;
  }

  async detach(): Promise<void> {
    this.watched = null;
    await fs.rm(this.opts.stateFile, { force: true });
  }

  private async persist(): Promise<void> {
    if (!this.watched) return;
    const state: PersistedState = {
      sessionId: this.watched.id,
      offset: this.watched.offset,
      fileId: this.watched.fileId,
    };
    await writeJsonAtomic(this.opts.stateFile, state);
  }

  // -------------------------------------------------------------------------
  // Tail loop
  // -------------------------------------------------------------------------

  private async tailTick(): Promise<void> {
    if (this.ticking || !this.watched) return;
    this.ticking = true;
    try {
      await this.tail();
    } catch {
      // Never let the tail loop die on an unexpected error.
    } finally {
      this.ticking = false;
    }
  }

  private async tail(): Promise<void> {
    const w = this.watched;
    if (!w) return;

    let stat;
    try {
      stat = await fs.stat(w.file, { bigint: true });
    } catch {
      this.setState(w, "unreadable");
      return;
    }

    const fileId = `${stat.dev}:${stat.ino}`;
    const size = Number(stat.size);

    if (fileId !== w.fileId) {
      // File replaced under us (new inode): clean re-sync at EOF with a gap
      // notice instead of parsing another file's bytes at a stale offset.
      w.fileId = fileId;
      w.offset = size;
      w.pending = "";
      w.decoder = new StringDecoder("utf8");
      w.parseErrors = 0;
      await this.persist();
      this.emit({ kind: "gap", sessionId: w.id });
      return;
    }

    if (size < w.offset) {
      this.setState(w, "unreadable");
      w.offset = size;
      w.pending = "";
      w.decoder = new StringDecoder("utf8");
      await this.persist();
      return;
    }

    const hadNewData = size > w.offset;
    if (hadNewData) {
      // offset tracks bytes consumed from disk; pending holds the tail of a
      // line still being written (no newline yet). Pending text is parsed only
      // once its newline arrives — never counted as malformed.
      const chunk = w.decoder.write(await this.readRange(w.file, w.offset, size));
      w.offset = size;
      const combined = w.pending + chunk;
      const lastNewline = combined.lastIndexOf("\n");
      const errorsBefore = w.parseErrors;
      if (lastNewline >= 0) {
        w.pending = combined.slice(lastNewline + 1);
        const events = this.parseLines(w, combined.slice(0, lastNewline));
        // A clean batch proves the stream is healthy again — heal the counter
        // so transient garbage can't latch the session unreadable forever.
        if (events.length > 0 && w.parseErrors === errorsBefore) w.parseErrors = 0;
        if (events.length > 0) this.emit({ kind: "session-events", sessionId: w.id, events });
      } else {
        w.pending = combined;
      }
      await this.persist();
      if (w.parseErrors > this.opts.parseErrorThreshold) {
        this.setState(w, "unreadable");
        return;
      }
    }

    const state = this.classify(Number(stat.mtimeMs));
    // Recover from unreadable only when new data flowed and parsed sanely.
    if (w.lastState !== "unreadable" || hadNewData) this.setState(w, state);
  }

  private setState(w: WatchedSession, state: SessionState): void {
    if (w.lastState !== state) {
      w.lastState = state;
      this.emit({ kind: "session-state", sessionId: w.id, state });
    }
  }

  private async readRange(file: string, from: number, to: number): Promise<Buffer> {
    const handle = await fs.open(file, "r");
    try {
      const length = to - from;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, from);
      return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  private parseLines(w: WatchedSession, block: string): SessionEvent[] {
    const events: SessionEvent[] = [];
    for (const line of block.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        events.push(...extractEvents(entry));
      } catch {
        w.parseErrors += 1;
      }
    }
    return events;
  }

  // -------------------------------------------------------------------------
  // Discovery sweep loop
  // -------------------------------------------------------------------------

  private async sweepTick(): Promise<void> {
    try {
      const sessions = await this.discoverSessions();
      // Broadcast the list only when it actually changed — otherwise every
      // connected client gets an identical full list every sweep forever.
      const snapshot = JSON.stringify(sessions.map((s) => [s.id, s.state, s.lastActivity]));
      if (snapshot !== this.lastSweepSnapshot) {
        this.lastSweepSnapshot = snapshot;
        this.emit({ kind: "sessions", sessions });
      }
      const w = this.watched;
      if (w) {
        const watchedSlug = sessions.find((s) => s.id === w.id)?.projectSlug;
        for (const session of sessions) {
          if (
            session.projectSlug === watchedSlug &&
            session.id !== w.id &&
            !this.knownSessionIds.has(session.id) &&
            session.state === "live"
          ) {
            this.emit({ kind: "new-session", session });
          }
        }
      }
      this.knownSessionIds = new Set(sessions.map((s) => s.id));
    } catch {
      // Sweep failures are non-fatal; next sweep retries.
    }
  }
}

// Project slugs encode paths lossily (hyphens vs separators are ambiguous).
// Best-effort readable label; the last segment is usually the project name.
export function decodeSlug(slug: string): string {
  const drive = /^([A-Za-z])--(.*)$/.exec(slug);
  const rest = drive ? drive[2]! : slug;
  const segments = rest.split("-").filter(Boolean);
  return segments.at(-1) ?? slug;
}

function clip(text: string, limit = TEXT_CLIP): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function oneLine(text: string, limit: number): string {
  return clip(text.replace(/\s+/g, " ").trim(), limit);
}

// Fields that identify what a tool acted on, most specific first. Unknown tools
// (MCP servers, plugins) fall through to the first short string argument.
const TOOL_TARGET_KEYS = [
  "file_path",
  "notebook_path",
  "path",
  "command",
  "pattern",
  "url",
  "query",
  "skill",
  "subagent_type",
  "description",
  "prompt",
];

// Absolute paths dominate the line budget and say little; the tail is the part
// a developer recognizes.
function shortenPath(value: string): string {
  const segments = value.split(/[\\/]/).filter(Boolean);
  return segments.length > 2 ? segments.slice(-2).join("/") : value;
}

export function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  for (const key of TOOL_TARGET_KEYS) {
    const value = record[key];
    if (typeof value !== "string" || !value.trim()) continue;
    const isPath = key === "file_path" || key === "notebook_path" || key === "path";
    return oneLine(isPath ? shortenPath(value) : value, TOOL_DETAIL_CLIP);
  }
  for (const value of Object.values(record)) {
    if (typeof value === "string" && value.trim()) return oneLine(value, TOOL_DETAIL_CLIP);
  }
  return "";
}

function toolUseLabel(block: Record<string, unknown>): string {
  const name = typeof block.name === "string" ? block.name : "tool";
  const detail = summarizeToolInput(block.input);
  return detail ? `${name}(${detail})` : name;
}

// tool_result content is a string or a list of text blocks.
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Record<string, unknown>[])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

interface ParsedBlocks {
  text: string;
  thinking: string;
  toolUses: string[];
  results: { ok: boolean; text: string }[];
}

function parseBlocks(content: unknown): ParsedBlocks {
  const parsed: ParsedBlocks = { text: "", thinking: "", toolUses: [], results: [] };
  if (typeof content === "string") return { ...parsed, text: content };
  if (!Array.isArray(content)) return parsed;
  const texts: string[] = [];
  const thinking: string[] = [];
  for (const block of content as Record<string, unknown>[]) {
    switch (block.type) {
      case "text":
        if (typeof block.text === "string") texts.push(block.text);
        break;
      // Claude Code persists thinking blocks with their content redacted
      // (signature only); take it when a log does carry it, skip it otherwise.
      case "thinking":
        if (typeof block.thinking === "string" && block.thinking.trim()) thinking.push(block.thinking);
        break;
      case "tool_use":
        parsed.toolUses.push(toolUseLabel(block));
        break;
      case "tool_result":
        parsed.results.push({ ok: block.is_error !== true, text: resultText(block.content) });
        break;
    }
  }
  parsed.text = texts.join("\n");
  parsed.thinking = thinking.join("\n");
  return parsed;
}

// Only user/assistant/system entries feed narration; metadata entry types and
// sidechain (subagent) traffic are skipped in v1 (KTD: tolerant parsing).
// One entry can produce several events — an assistant turn that thinks, speaks
// and calls tools is three distinct things for HAL to observe.
export function extractEvents(entry: Record<string, unknown>): SessionEvent[] {
  if (entry.isSidechain === true || entry.isMeta === true) return [];
  const at = typeof entry.timestamp === "string" ? entry.timestamp : "";
  const events: SessionEvent[] = [];
  switch (entry.type) {
    case "user": {
      const message = entry.message as Record<string, unknown> | undefined;
      const { text, results } = parseBlocks(message?.content);
      if (text.trim()) events.push({ at, kind: "user", text: clip(text), toolUses: [] });
      // Tool outcomes are what turn "the agent ran a command" into "the command
      // failed" — without them narration can only describe intent.
      for (const result of results) {
        const body = oneLine(result.text, result.ok ? RESULT_OK_CLIP : RESULT_ERROR_CLIP) || "(no output)";
        events.push({ at, kind: "tool-result", text: result.ok ? body : `failed: ${body}`, toolUses: [] });
      }
      return events;
    }
    case "assistant": {
      const message = entry.message as Record<string, unknown> | undefined;
      const { text, thinking, toolUses } = parseBlocks(message?.content);
      if (thinking.trim()) events.push({ at, kind: "thinking", text: oneLine(thinking, THINKING_CLIP), toolUses: [] });
      if (text.trim() || toolUses.length > 0) {
        events.push({ at, kind: "assistant", text: clip(text), toolUses });
      }
      return events;
    }
    case "system": {
      const text = typeof entry.content === "string" ? entry.content : "";
      if (text.trim()) events.push({ at, kind: "system", text: clip(text), toolUses: [] });
      return events;
    }
    default:
      return events;
  }
}
