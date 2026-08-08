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
  // A concrete copy of the chat default taken at creation, never a live
  // reference to it — editing the default must not rewrite existing threads.
  // Absent on Conversations written before prompts existed; absent reads as
  // blank, which is exactly how chat behaved then.
  systemPrompt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Conversation extends ConversationMeta {
  messages: StoredMessage[];
}

// ---------------------------------------------------------------------------
// Monitors
//
// The second observation role. A Session is discovered and narrated; a Monitor
// is configured by the user, stands indefinitely, and is usually quiet. They
// deliberately do not share a type: `SessionEvent` names coding-agent concepts
// a log line has none of.
// ---------------------------------------------------------------------------

// quiet: one summary per cycle, plus immediate speech on a severe line.
// full: narrated as events arrive, like a Session.
export type MonitorVerbosity = "quiet" | "full";

export type MonitorSeverity = "routine" | "severe";

export interface MonitorFileSource {
  kind: "file";
  path: string;
}

// `sinceTemplate` is substituted with the previous poll time before the command
// runs, so a source that supports incremental output (journalctl --since,
// Get-WinEvent's time filter) narrows at the source instead of re-emitting.
export interface MonitorCommandSource {
  kind: "command";
  command: string;
  intervalMs: number;
  sinceTemplate?: string;
}

export type MonitorSource = MonitorFileSource | MonitorCommandSource;

// How a Monitor decides a line is severe enough to interrupt its cycle.
//
// Per Monitor because severity is source-specific: llama.cpp writes "checkpoint
// check failed" as completely routine output, so a shared keyword list either
// cries wolf on that log or goes deaf on every other one.
//
// A level the source itself states still wins for `default` and `pattern` —
// Get-WinEvent's LevelDisplayName is authoritative and needs no guessing.
// `never` overrides everything, because it is an explicit instruction.
export type MonitorSeverityRule =
  | { kind: "default" }
  | { kind: "pattern"; pattern: string }
  | { kind: "never" };

export interface Monitor {
  id: string;
  label: string;
  source: MonitorSource;
  verbosity: MonitorVerbosity;
  // How long a quiet monitor accumulates before summarising. A cycle with no
  // new events produces no entry at all — an all-clear on a timer is noise.
  cycleMs: number;
  color: string;
  enabled: boolean;
  // Absent means the shipped keyword rule.
  severity?: MonitorSeverityRule;
}

// What a client supplies to create one. Everything but label and source has a
// default, so a suggestion becomes a Monitor without the user filling a form.
export interface MonitorDraft {
  label: string;
  source: MonitorSource;
  verbosity?: MonitorVerbosity;
  cycleMs?: number;
  color?: string;
  severity?: MonitorSeverityRule;
}

export type MonitorPatch = Partial<Omit<Monitor, "id">>;

// One observation from a Monitor. `source` is the emitting component when the
// log states one (an event provider, a systemd unit); plain text tails have none.
export interface MonitorEvent {
  at: string;
  text: string;
  severity: MonitorSeverity;
  source?: string;
}

// A shipped suggestion. `available` is probed per request rather than cached —
// a target can appear after an install without a restart.
export interface MonitorSuggestion {
  id: string;
  label: string;
  reason: string;
  source: MonitorSource;
  available: boolean;
  // What this source should treat as severe, when the shipped keyword list is
  // known to be wrong for it. Absent means the keyword list is fine.
  severity?: MonitorSeverityRule;
}

// ---------------------------------------------------------------------------
// Vision
//
// The third observation role: HAL watches the desk through a webcam. A local
// captioner outside Ollama turns each frame into an observation; the HAL model
// summarises a cycle of them into one feed entry, or into nothing.
// ---------------------------------------------------------------------------

// How readily the summariser speaks. `always` produces an entry every cycle;
// the rest ask the model to stay silent unless the cycle earned a remark, at
// descending eagerness. Where that line sits is taste, so it is a dial rather
// than a rule.
export const VISION_SENSITIVITIES = ["always", "high", "medium", "low"] as const;

export type VisionSensitivity = (typeof VISION_SENSITIVITIES)[number];

// One person HAL has been told about, and the faces held for them.
//
// A person accumulates faces rather than being defined by one (R16). Names are
// not keys: two people may share a name and stay distinct records.
export interface Person {
  id: string;
  name: string;
  createdAt: string;
  faces: PersonFace[];
}

// A face belonging to a person. The embedding is what matching compares; the
// thumbnail exists so a roster is reviewable by eye rather than by id.
export interface PersonFace {
  id: string;
  addedAt: string;
  // Unit-length, as the recogniser returns it, so comparison is a dot product
  // and no unnormalised vector can enter the gallery.
  embedding: number[];
}

// What the client is told about a person. The embeddings stay server-side —
// they are the biometric payload and a roster does not need them.
export interface PersonSummary {
  id: string;
  name: string;
  createdAt: string;
  faceCount: number;
  // Data URL of one face, for the roster. Absent when the thumbnail is gone.
  thumbnail?: string;
}

// A recognised identity behind an observation, for the user rather than the
// model. R24 makes the confidence behind a named identity visible; the model
// only ever sees the hedged string in `identity`.
export interface IdentityMatch {
  personId: string;
  name: string;
  confidence: number;
}

// One capture, as the captioner described it.
//
// `identity` is the seam the webcam brief reserved (its R21), now with a
// producer. It holds the SHIPPED HEDGED FORM, never a bare name — R23 puts the
// hedge in the input rather than in a prompt rule, so every consumer of this
// field is correct by construction. `identityMatch` carries the name and
// confidence for the UI, and is an array because two people in frame are two
// appearances.
export interface VisionObservation {
  at: string;
  caption: string;
  identity: string | null;
  identityMatch?: IdentityMatch[];
}

// What Vision is doing right now. `off` is a choice, not a fault, and must not
// render as an error.
export type VisionState =
  | "off"
  | "idle"
  | "capturing"
  | "captioning"
  | "narrating"
  | "no-camera"
  | "no-captioner"
  // Recognition is on and the recogniser cannot be reached. Vision keeps
  // capturing, captioning and summarising — an absent recogniser degrades the
  // feature rather than disabling it (R7).
  | "no-recogniser"
  // Reachable, but cannot answer fast enough to sustain the detection
  // interval. Distinct from unreachable on purpose (R8): the two send a user
  // looking in completely different places.
  | "recogniser-slow"
  | "error";

export interface VisionSettings {
  enabled: boolean;
  // ffmpeg device name. Null means "the first video device this OS reports",
  // which is what makes a fresh install work without picking anything.
  device: string | null;
  captionerEndpoint: string;
  // Seconds between captures. Minutes-scale by default: a capture costs a
  // captioner run, and the scene rarely changes faster than that.
  intervalSeconds: number;
  // Seconds of observations gathered before the summariser is asked to speak.
  cycleSeconds: number;
  sensitivity: VisionSensitivity;
  // The colour Vision's entries render in, the way an Adapter and a Monitor
  // each carry one. Colour is how this feed carries provenance, so a role
  // without one is a role the reader cannot place.
  color: string;
  // How many captured frames to keep on disk. Zero keeps none.
  retainFrames: number;
  // HAL's voice for a Vision cycle, and the instruction handed to the
  // captioner. Both null-means-shipped-default, like every other prompt.
  prompt: string | null;
  captionPrompt: string | null;

  // Recognition (R31). Its own toggle, subordinate to `enabled`: recognition
  // never causes camera access on its own and does nothing while Vision is
  // off, but the preference survives Vision being toggled.
  recognitionEnabled: boolean;
  // The recogniser sidecar HAL points at but never starts (R2). Loopback by
  // default; pointing it elsewhere sends whole camera frames off the machine,
  // which is why R10's acknowledgement is owed before that is safe.
  recogniserEndpoint: string;
  // Seconds between detection attempts, separate from the capture interval and
  // the cycle length (R30). Seconds-scale: a face costs single-digit
  // milliseconds, so watching often is cheap.
  detectionIntervalSeconds: number;
  // Cosine similarity at or above which a face is that person (R9). Below it
  // the face is unrecognised — never a guess at the nearest person.
  confidenceThreshold: number;
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
  // Monitors narrate from their own prompt: the narration prompt's tag glossary
  // describes coding-agent log entries and would mislead about a log line.
  monitorPrompt: string | null;
  // Interface copy tone only: picks the row in `ui/src/persona.ts`. It no
  // longer composes the narration prompt — that is `narrationPrompt` now.
  personaIntensity: PersonaIntensity;
  watchedSessionId: string | null;
  adapters: Record<AdapterId, AdapterSettings>;
  chatColors: ChatColors;
  vision: VisionSettings;
}

// Patch shape for `update-settings`. Nested maps are partial all the way
// down so a client can send one adapter's colour without restating the rest;
// the store merges per adapter id rather than replacing the map.
export type SettingsPatch = Partial<Omit<Settings, "adapters" | "chatColors" | "vision">> & {
  adapters?: Partial<Record<AdapterId, Partial<AdapterSettings>>>;
  chatColors?: Partial<ChatColors>;
  vision?: Partial<VisionSettings>;
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
  // Set instead of `adapterId` when a Monitor produced this entry. The two are
  // never both set: an entry comes from one role or the other.
  monitorId?: string | null;
  // Set when Vision produced this entry. Exclusive with the other two for the
  // same reason — an entry comes from exactly one observation role.
  fromVision?: boolean;
  // The observed session this entry is about. Set alongside `adapterId`: the
  // adapter says which kind of log it came from, this says which log. Present
  // because several sessions are followed at once, so "which one is this?" is
  // no longer answered by "the one that is attached".
  sessionId?: string | null;
  // How that session is named in the feed, e.g. `Claude [a3f9c21e]`. Stamped
  // when the entry is made rather than derived at render time, so an entry
  // about a session that has since ended still says what it was about.
  sessionLabel?: string;
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
  // The Vision captioner. "disabled" when Vision is off, for the same reason:
  // nobody wants the prerequisite, so its absence is not a fault.
  captioner: "ok" | "unreachable" | "disabled";
  // The recogniser sidecar. "disabled" when recognition is off, for the same
  // reason as the other two three-valued legs. "degraded" is reachable but
  // unable to match — the recogniser reports its detector and embedder
  // separately, and a failed model fetch is a different thing to tell the user
  // than a process that is not running.
  recogniser: "ok" | "degraded" | "unreachable" | "disabled";
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

// One shipped narration preset as advertised to clients.
export interface NarrationPresetInfo {
  id: string;
  label: string;
  text: string;
}

// The shipped prompt text, carried as data rather than left in a module only
// TypeScript clients can import. Without this a protocol-only client reading
// `narrationPrompt: null` cannot tell what HAL is actually sending, cannot
// discover presets, and cannot reproduce a reset.
export interface PromptCatalog {
  narrationDefault: string;
  chatDefault: string;
  visionDefault: string;
  visionCaptionDefault: string;
  narrationPresets: readonly NarrationPresetInfo[];
}

export interface SettingsMessage {
  type: "settings";
  settings: Settings;
  prompts: PromptCatalog;
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
  // The selected session: the one the user picked, highlighted in the feed.
  // Null means nothing is selected, which no longer means nothing is observed.
  watchedSessionId: string | null;
  status: NarrationStatus;
  sessionState: SessionState | null;
  // Every session currently being followed, selected or not. Optional until
  // the server sends it; absent reads as "only the selected one", which is how
  // the feed behaved before concurrent following.
  followedSessionIds?: string[];
}

// Which sessions HAL is following right now. Broadcast when that set changes —
// a session going live is picked up automatically, and one that ends is
// dropped, neither of which the user did anything to cause.
export interface FollowedSessionsMessage {
  type: "followed-sessions";
  sessionIds: string[];
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

export interface MonitorsMessage {
  type: "monitors";
  monitors: Monitor[];
}

export interface MonitorSuggestionsMessage {
  type: "monitor-suggestions";
  suggestions: MonitorSuggestion[];
}

export interface VisionObservationMessage {
  type: "vision-observation";
  observation: VisionObservation;
}

export interface VisionStatusMessage {
  type: "vision-status";
  state: VisionState;
  // Present only when the state is a fault, and already phrased for a reader.
  detail?: string;
}

// The most recent frame, as a data URL. Sent on capture rather than held in the
// observation so the feed's history stays text — a ring buffer of images would
// cost megabytes to replay on every reconnect.
export interface VisionFrameMessage {
  type: "vision-frame";
  at: string;
  dataUrl: string;
}

// Camera names as this OS reports them, so a client can offer a choice without
// knowing how any platform enumerates devices.
export interface VisionDevicesMessage {
  type: "vision-devices";
  devices: string[];
  error?: string;
}

// The enrolled roster. Broadcast on change and on connection, like adapters and
// monitors, so a reconnecting client is never blank.
export interface VisionPeopleMessage {
  type: "vision-people";
  people: PersonSummary[];
}

// Who is in front of the camera right now, as recognition currently sees it.
// Separate from the observation because appearances turn over on the detection
// interval while observations arrive on the capture interval — the pane needs
// the faster one to offer enrolment against what is actually on screen.
export interface VisionAppearancesMessage {
  type: "vision-appearances";
  appearances: {
    id: string;
    match: IdentityMatch | null;
    // False when the recogniser could detect but not embed, so the client can
    // explain why enrolment is unavailable rather than appearing broken.
    embedded: boolean;
  }[];
}

// The outcome of an enrolment attempt. Failure is a first-class reply rather
// than a generic error because every refusal here has a reason the user can act
// on — two faces in frame, no face, a recogniser that cannot embed.
export interface VisionEnrolResultMessage {
  type: "vision-enrol-result";
  ok: boolean;
  personId?: string;
  error?: string;
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
  | FollowedSessionsMessage
  | WatchStartedMessage
  | WatchStoppedMessage
  | NewSessionAvailableMessage
  | ReadinessMessage
  | AdaptersMessage
  | MonitorsMessage
  | MonitorSuggestionsMessage
  | VisionObservationMessage
  | VisionStatusMessage
  | VisionFrameMessage
  | VisionDevicesMessage
  | VisionPeopleMessage
  | VisionAppearancesMessage
  | VisionEnrolResultMessage;

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

// Replaces one Conversation's system prompt. There is no reset variant: a
// Conversation's prompt is a copy taken at creation, so "reset" means sending
// the current resolved chat default, which any client can read from settings.
export interface SetConversationPromptMessage {
  type: "set-conversation-prompt";
  conversationId: string;
  prompt: string;
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

// Monitor ids are server-generated, so unlike a conversation id they are never
// a client-supplied path segment and need no UUID guard.
export interface ListMonitorsMessage {
  type: "list-monitors";
}

export interface AddMonitorMessage {
  type: "add-monitor";
  monitor: MonitorDraft;
}

export interface UpdateMonitorMessage {
  type: "update-monitor";
  monitorId: string;
  patch: MonitorPatch;
}

export interface RemoveMonitorMessage {
  type: "remove-monitor";
  monitorId: string;
}

export interface ListMonitorSuggestionsMessage {
  type: "list-monitor-suggestions";
}

// Captures immediately instead of waiting for the interval, and summarises the
// cycle straight after. This is how a client tunes sensitivity without sitting
// through a cycle, and how an agent asks HAL to look right now.
export interface CaptureVisionNowMessage {
  type: "vision-capture-now";
}

export interface ListVisionDevicesMessage {
  type: "list-vision-devices";
}

export interface ClearVisionFramesMessage {
  type: "clear-vision-frames";
}

// Enrol the face currently in frame under a name. One-shot: this slice has no
// triage queue, so there is no other way into the gallery.
//
// Everything here is reachable over the protocol rather than the UI alone
// (agent-native parity). That includes biometric mutation, over a hub whose
// per-boot token is still outstanding — see
// docs/residual-review-findings/feat-recognition-loop.md for what was accepted
// and why.
export interface EnrolPersonMessage {
  type: "enrol-person";
  name: string;
}

export interface DeletePersonMessage {
  type: "delete-person";
  id: string;
}

export interface ListPeopleMessage {
  type: "list-people";
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
  | SetConversationPromptMessage
  | ListModelsMessage
  | GetSettingsMessage
  | UpdateSettingsMessage
  | ListSessionsMessage
  | WatchSessionMessage
  | UnwatchMessage
  | CheckReadinessMessage
  | ListAdaptersMessage
  | SetAdapterEnabledMessage
  | ListMonitorsMessage
  | AddMonitorMessage
  | UpdateMonitorMessage
  | RemoveMonitorMessage
  | ListMonitorSuggestionsMessage
  | CaptureVisionNowMessage
  | ListVisionDevicesMessage
  | ClearVisionFramesMessage
  | EnrolPersonMessage
  | DeletePersonMessage
  | ListPeopleMessage;
