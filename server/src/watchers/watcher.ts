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

// One narration-relevant event extracted from a log entry.
export interface SessionEvent {
  at: string;
  kind: "user" | "assistant" | "system";
  text: string;
  toolUses: string[];
}

export type WatcherNotification =
  | { kind: "session-events"; sessionId: string; events: SessionEvent[] }
  | { kind: "session-state"; sessionId: string; state: SessionState }
  // Re-attached with missed activity (R14) or the file was replaced under us.
  | { kind: "gap"; sessionId: string }
  | { kind: "new-session"; session: SessionInfo }
  | { kind: "sessions"; sessions: SessionInfo[] };

export interface LogWatcher {
  discoverSessions(): Promise<SessionInfo[]>;
  attach(sessionId: string): Promise<void>;
  detach(): Promise<void>;
  watchedSessionId(): string | null;
  subscribe(listener: (n: WatcherNotification) => void): void;
  start(): void;
  stop(): void;
}
