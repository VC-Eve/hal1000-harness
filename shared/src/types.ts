// Shared WebSocket message contract between the HAL core (server) and its
// clients (web UI now, desktop shell later). Both sides compile against this
// file; it is the single source of truth for wire shapes.

export const HAL_VERSION = "0.1.0";

export type SessionState = "live" | "idle" | "ended" | "unreadable";

export type PersonaIntensity = "low" | "medium" | "high";

// ---------------------------------------------------------------------------
// Data shapes
// ---------------------------------------------------------------------------

export interface StoredMessage {
  role: "user" | "assistant";
  content: string;
  at: string;
  // Set when a streamed reply was cut off (provider died mid-stream).
  interrupted?: boolean;
}

export interface ConversationMeta {
  id: string;
  title: string;
  model: string;
  createdAt: string;
  updatedAt: string;
}

export interface Conversation extends ConversationMeta {
  messages: StoredMessage[];
}

export interface Settings {
  providerEndpoint: string;
  chatModel: string | null;
  narrationModel: string | null;
  personaIntensity: PersonaIntensity;
  watchedSessionId: string | null;
}

export interface SessionSummary {
  id: string;
  projectSlug: string;
  projectName: string;
  state: SessionState;
  lastActivity: string;
}

export interface NarrationEntry {
  id: string;
  at: string;
  // narration: HAL-generated commentary; gap: "while I was away" notice;
  // status: in-feed condition report (e.g. provider unavailable).
  kind: "narration" | "gap" | "status";
  text: string;
}

export type NarrationStatus =
  | "idle"
  | "narrating"
  | "catching-up"
  | "paused-missing-model"
  | "provider-unavailable";

// First-run readiness (R17): each leg maps to a distinct guided UI state.
export interface Readiness {
  ollama: "ok" | "unreachable";
  models: "ok" | "none" | "unknown";
  claudeLogs: "ok" | "missing";
}

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

export interface HelloMessage {
  type: "hello";
  app: "hal1000";
  version: string;
}

export interface ErrorMessage {
  type: "error";
  code: string;
  message: string;
}

export interface ConversationsMessage {
  type: "conversations";
  conversations: ConversationMeta[];
}

export interface ConversationMessage {
  type: "conversation";
  conversation: Conversation;
}

export interface ChatTokenMessage {
  type: "chat-token";
  conversationId: string;
  token: string;
}

export interface ChatDoneMessage {
  type: "chat-done";
  conversationId: string;
  message: StoredMessage;
}

export interface ChatErrorMessage {
  type: "chat-error";
  conversationId: string;
  code: "provider_unavailable" | "model_not_found";
  message: string;
}

export interface ModelsMessage {
  type: "models";
  models: string[];
  // Distinguishes "Ollama down" (error) from "no models pulled" (empty list).
  error?: "provider_unavailable";
}

export interface SettingsMessage {
  type: "settings";
  settings: Settings;
}

export interface SessionsMessage {
  type: "sessions";
  sessions: SessionSummary[];
}

export interface SessionStatusMessage {
  type: "session-status";
  sessionId: string;
  state: SessionState;
}

export interface NarrationEntryMessage {
  type: "narration-entry";
  entry: NarrationEntry;
}

// Replay of the feed ring buffer, sent on WS (re)connect so a page reload
// does not lose the narration feed.
export interface NarrationBacklogMessage {
  type: "narration-backlog";
  entries: NarrationEntry[];
  watchedSessionId: string | null;
  status: NarrationStatus;
  sessionState: SessionState | null;
}

export interface NarrationStatusMessage {
  type: "narration-status";
  status: NarrationStatus;
}

export interface WatchStartedMessage {
  type: "watch-started";
  sessionId: string;
}

export interface WatchStoppedMessage {
  type: "watch-stopped";
}

export interface NewSessionAvailableMessage {
  type: "new-session-available";
  session: SessionSummary;
}

export interface ReadinessMessage {
  type: "readiness";
  readiness: Readiness;
}

export type ServerMessage =
  | HelloMessage
  | ErrorMessage
  | ConversationsMessage
  | ConversationMessage
  | ChatTokenMessage
  | ChatDoneMessage
  | ChatErrorMessage
  | ModelsMessage
  | SettingsMessage
  | SessionsMessage
  | SessionStatusMessage
  | NarrationEntryMessage
  | NarrationBacklogMessage
  | NarrationStatusMessage
  | WatchStartedMessage
  | WatchStoppedMessage
  | NewSessionAvailableMessage
  | ReadinessMessage;

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

export interface PingMessage {
  type: "ping";
}

export interface ListConversationsMessage {
  type: "list-conversations";
}

export interface OpenConversationMessage {
  type: "open-conversation";
  conversationId: string;
}

export interface NewConversationMessage {
  type: "new-conversation";
  model: string;
}

export interface DeleteConversationMessage {
  type: "delete-conversation";
  conversationId: string;
}

export interface SendChatMessage {
  type: "send-message";
  conversationId: string;
  content: string;
}

// Re-runs generation from current history, dropping a trailing interrupted reply.
export interface RegenerateMessage {
  type: "regenerate";
  conversationId: string;
}

// Changes one conversation's model only; it does not touch the global
// Settings.chatModel default. The web UI pairs this with an update-settings
// patch as a convenience — other clients may choose either behavior.
export interface SelectModelMessage {
  type: "select-model";
  conversationId: string;
  model: string;
}

export interface ListModelsMessage {
  type: "list-models";
}

export interface GetSettingsMessage {
  type: "get-settings";
}

export interface UpdateSettingsMessage {
  type: "update-settings";
  patch: Partial<Settings>;
}

export interface ListSessionsMessage {
  type: "list-sessions";
}

export interface WatchSessionMessage {
  type: "watch-session";
  sessionId: string;
}

export interface UnwatchMessage {
  type: "unwatch";
}

export interface CheckReadinessMessage {
  type: "check-readiness";
}

export type ClientMessage =
  | PingMessage
  | ListConversationsMessage
  | OpenConversationMessage
  | NewConversationMessage
  | DeleteConversationMessage
  | SendChatMessage
  | RegenerateMessage
  | SelectModelMessage
  | ListModelsMessage
  | GetSettingsMessage
  | UpdateSettingsMessage
  | ListSessionsMessage
  | WatchSessionMessage
  | UnwatchMessage
  | CheckReadinessMessage;
