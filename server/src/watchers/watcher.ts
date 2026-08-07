import type { SessionState, SessionSummary } from "../../../shared/src/types.js";

// Log-watcher seam (R9): the narration pipeline consumes this interface, so
// Codex logs or a generic file tail can slot in later without touching it.

export interface SessionInfo {
  id: string;
  projectSlug: string;
  projectName: string;
  file: string;
  state: SessionState;
  lastActivity: string;
}

// Wire shape: SessionInfo minus the local file path.
export function toSessionSummary({ file: _file, ...summary }: SessionInfo): SessionSummary {
  return summary;
}

// One narration-relevant event extracted from a log entry. A single entry can
// yield several (an assistant turn that thinks, speaks, and calls tools).
export interface SessionEvent {
  at: string;
  kind: "user" | "assistant" | "thinking" | "system" | "tool-result";
  text: string;
  // Rendered as `Name(target)` — the target is what makes narration concrete
  // ("reading server/src/app.ts", not "using a tool").
  toolUses: string[];
}

export type WatcherNotification =
  | { kind: "session-events"; sessionId: string; events: SessionEvent[] }
  | { kind: "session-state"; sessionId: string; state: SessionState }
  // Re-attached with missed activity (R14) or the file was replaced under us.
  | { kind: "gap"; sessionId: string }
  | { kind: "new-session"; session: SessionInfo }
  | { kind: "sessions"; sessions: SessionInfo[] }
  // The set of followed sessions changed — a live one was picked up, or one
  // that stopped being live was let go. Carries the whole set rather than a
  // delta: the pipeline holds per-session state and reconciling against a
  // full list is what keeps it from leaking a coalescer per dead session.
  | { kind: "followed"; sessionIds: string[] };

export interface LogWatcher {
  discoverSessions(): Promise<SessionInfo[]>;
  // Selects a session. Following is automatic and covers every live session,
  // so this marks the one the user cares about rather than starting the only
  // observation there is.
  attach(sessionId: string): Promise<void>;
  // Deselects. Following continues — stopping observation altogether is what
  // disabling the adapter is for.
  detach(): Promise<void>;
  // The selected session, if any.
  watchedSessionId(): string | null;
  // Every session being tailed right now, selected or not.
  followedSessionIds(): string[];
  subscribe(listener: (n: WatcherNotification) => void): void;
  start(): void;
  stop(): void;
}
