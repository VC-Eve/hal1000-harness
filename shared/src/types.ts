// Shared WebSocket message contract between the HAL core (server) and its
// clients (web UI now, desktop shell later). Both sides compile against this
// file; it is the single source of truth for wire shapes.

export const HAL_VERSION = "0.1.0";

export type SessionState = "live" | "idle" | "ended" | "unreadable";

export type PersonaIntensity = "low" | "medium" | "high";

// Observation sources HAL can watch. One today; the registry seam
// (`server/src/watchers/watcher.ts`) exists so codex/generic land later.
export const ADAPTER_IDS = ["claude-code"] as const;

export type AdapterId = (typeof ADAPTER_IDS)[number];

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

// One adapter as advertised to clients: everything a settings UI needs to
// render a row without knowing any adapter id in particular.
export interface AdapterInfo {
  id: AdapterId;
  label: string;
  enabled: boolean;
}

// Persisted per-adapter state. `color` is the text colour its observations
// render in — the only carrier of provenance in the feed. Values are
// normalized server-side (readability floor + distance from HAL's reserved
// colours), so the stored value may differ from the submitted one.
export interface AdapterSettings {
  enabled: boolean;
  color: string;
}

export interface ChatColors {
  user: string;
  assistant: string;
}

export interface Settings {
  providerEndpoint: string;
  chatModel: string | null;
  narrationModel: string | null;
  // The two settings-level system prompts. `null` means "never edited": the
  // shipped default in `shared/src/prompts.ts` resolves at read time, so a
  // release that changes a default reaches anyone who left it alone. Any
  // string — including "" — is the user's and is used verbatim.
  narrationPrompt: string | null;
  // Copied onto a Conversation at creation, never consulted again by an
  // existing one. Editing it must not rewrite threads already under way.
  chatDefaultPrompt: string | null;
  // Interface copy tone only: picks the row in `ui/src/persona.ts`. It no
  // longer composes the narration prompt — that is `narrationPrompt` now.
  personaIntensity: PersonaIntensity;
  watchedSessionId: string | null;
  adapters: Record<AdapterId, AdapterSettings>;
  chatColors: ChatColors;
}

// Patch shape for `update-settings`. Nested maps are partial all the way
// down so a client can send one adapter's colour without restating the rest;
// the store merges per adapter id rather than replacing the map.
export type SettingsPatch = Partial<Omit<Settings, "adapters" | "chatColors">> & {
  adapters?: Partial<Record<AdapterId, Partial<AdapterSettings>>>;
  chatColors?: Partial<ChatColors>;
};

export interface SessionSummary {
  id: string;
  projectSlug: string;
  projectName: string;
  state: SessionState;
  lastActivity: string;
  // The adapter that discovered this session — the picker routes an attach
  // by it. Optional until the registry stamps it (U2); readers must tolerate
  // its absence on older payloads.
  adapterId?: AdapterId;
}

export interface NarrationEntry {
  id: string;
  at: string;
  // narration: HAL-generated commentary; gap: "while I was away" notice;
  // status: in-feed condition report (e.g. provider unavailable).
  kind: "narration" | "gap" | "status";
  text: string;
  // The adapter whose events produced this observation, captured when the
  // batch is drained so a detach mid-inference cannot erase it. Null for the
  // gap and status kinds: those are HAL's own voice and keep HAL's colour.
  // Optional until the narrator stamps it (U3); absent reads as null.
  adapterId?: AdapterId | null;
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
  // "disabled": no enabled adapter wants these logs, so their absence is not
  // a fault. Clients must treat this leg as three-valued.
  claudeLogs: "ok" | "missing" | "disabled";
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

// The full adapter roster, including adapters absent from stored settings.
// Broadcast on connect, on list-adapters, and after any enabled change.
export interface AdaptersMessage {
  type: "adapters";
  adapters: AdapterInfo[];
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
  | ReadinessMessage
  | AdaptersMessage;

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
  patch: SettingsPatch;
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

export interface ListAdaptersMessage {
  type: "list-adapters";
}

// Adapter lifecycle rides its own message rather than an update-settings
// patch: starting and stopping watchers must not be a side effect of a
// settings write. Colour stays on update-settings.
export interface SetAdapterEnabledMessage {
  type: "set-adapter-enabled";
  adapterId: AdapterId;
  enabled: boolean;
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
  | CheckReadinessMessage
  | ListAdaptersMessage
  | SetAdapterEnabledMessage;
