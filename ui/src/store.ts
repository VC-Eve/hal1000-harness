import type {
  Conversation,
  ConversationMeta,
  NarrationEntry,
  NarrationStatus,
  Readiness,
  ServerMessage,
  SessionState,
  SessionSummary,
  Settings,
} from "../../shared/src/types";
import type { ConnectionState } from "./ws-client";

export interface AppState {
  connection: ConnectionState;
  readiness: Readiness | null;
  models: string[];
  modelsError: boolean;
  settings: Settings | null;
  conversations: ConversationMeta[];
  active: Conversation | null;
  // Accumulating streamed reply for the active conversation.
  streaming: string | null;
  chatError: { code: "provider_unavailable" | "model_not_found"; message: string } | null;
  // Per-conversation drafts survive switching (U4 scenario).
  drafts: Record<string, string>;
  sessions: SessionSummary[];
  watchedSessionId: string | null;
  sessionState: SessionState | null;
  narration: NarrationEntry[];
  narrationStatus: NarrationStatus;
  newSession: SessionSummary | null;
}

export const initialState: AppState = {
  connection: "connecting",
  readiness: null,
  models: [],
  modelsError: false,
  settings: null,
  conversations: [],
  active: null,
  streaming: null,
  chatError: null,
  drafts: {},
  sessions: [],
  watchedSessionId: null,
  sessionState: null,
  narration: [],
  narrationStatus: "idle",
  newSession: null,
};

export type Action =
  | { type: "server"; msg: ServerMessage }
  | { type: "conn"; value: ConnectionState }
  | { type: "draft"; conversationId: string; value: string }
  | { type: "close-conversation" }
  | { type: "clear-chat-error" }
  | { type: "dismiss-new-session" };

const NARRATION_UI_CAP = 500;

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "conn":
      // A reconnect may have missed chat-done/chat-error; clear the phantom
      // stream — the resync fetch restores the persisted reply.
      if (action.value === "open") return { ...state, connection: action.value, streaming: null };
      return { ...state, connection: action.value };
    case "draft":
      return { ...state, drafts: { ...state.drafts, [action.conversationId]: action.value } };
    case "close-conversation":
      return { ...state, active: null, streaming: null, chatError: null };
    case "clear-chat-error":
      return { ...state, chatError: null };
    case "dismiss-new-session":
      return { ...state, newSession: null };
    case "server":
      return onServer(state, action.msg);
  }
}

function onServer(state: AppState, msg: ServerMessage): AppState {
  switch (msg.type) {
    case "hello":
      return state;
    case "error":
      return state;
    case "conversations":
      return { ...state, conversations: msg.conversations };
    case "conversation": {
      // Single-user tool: adopt the broadcast conversation as active unless a
      // different conversation is mid-stream.
      if (state.streaming !== null && state.active && state.active.id !== msg.conversation.id) return state;
      return { ...state, active: msg.conversation };
    }
    case "chat-token": {
      if (state.active?.id !== msg.conversationId) return state;
      return { ...state, streaming: (state.streaming ?? "") + msg.token, chatError: null };
    }
    case "chat-done": {
      if (state.active?.id !== msg.conversationId) return { ...state, streaming: null };
      return {
        ...state,
        streaming: null,
        active: { ...state.active, messages: [...state.active.messages, msg.message] },
      };
    }
    case "chat-error":
      return { ...state, streaming: null, chatError: { code: msg.code, message: msg.message } };
    case "models":
      return { ...state, models: msg.models, modelsError: msg.error === "provider_unavailable" };
    case "settings":
      return { ...state, settings: msg.settings, watchedSessionId: msg.settings.watchedSessionId };
    case "sessions":
      return { ...state, sessions: msg.sessions };
    case "session-status":
      if (msg.sessionId !== state.watchedSessionId) return state;
      return { ...state, sessionState: msg.state };
    case "narration-entry":
      return { ...state, narration: [...state.narration, msg.entry].slice(-NARRATION_UI_CAP) };
    case "narration-backlog":
      return {
        ...state,
        narration: msg.entries,
        watchedSessionId: msg.watchedSessionId,
        narrationStatus: msg.status,
        sessionState: msg.sessionState,
      };
    case "narration-status":
      return { ...state, narrationStatus: msg.status };
    case "watch-started":
      return { ...state, watchedSessionId: msg.sessionId, sessionState: null, newSession: null };
    case "watch-stopped":
      return { ...state, watchedSessionId: null, sessionState: null };
    case "new-session-available":
      return { ...state, newSession: msg.session };
    case "readiness":
      return { ...state, readiness: msg.readiness };
  }
}
