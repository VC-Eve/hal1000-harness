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

// The narrowest the hedged band may be squeezed (R3). Shared because the server
// enforces it and the settings panel explains it, and two copies of a rule are
// how the explanation drifts from the behaviour.
export const MIN_BAND_SEPARATION = 0.05;

// The longest a character profile may be (R23).
//
// Shared because the server enforces it and the editor counts against it. The
// size is chosen against a measured failure rather than for tidiness: the
// vision prompt was three times longer once and worked worse, with a small
// local model narrating the rules back instead of the room. A profile is
// standing context competing for the same attention, so it is a paragraph
// rather than a biography.
export const MAX_PROFILE_CHARS = 600;

// Which of the three things HAL can say about a face.
//
// Defined here rather than beside the formatter in prompts.ts because the
// vision timeline records bands as data, and a second copy of the union is how
// the two drift.
export type IdentityBand = "unrecognised" | "hedged" | "stated";

// ---------------------------------------------------------------------------
// The vision timeline
//
// What HAL saw, as distinct from what it said. Recognition checks and captions
// as timestamped events in one ordered stream, so "when was the face
// recognised versus when was the image described" has an answer after the fact.
// ---------------------------------------------------------------------------

// One face as a check found it. Everything but presence is optional: a face can
// be detected without being identified, and identified without a weight yet.
export interface VisionCheckFace {
  personId?: string;
  name?: string;
  confidence?: number;
  band?: IdentityBand;
  // The person's weight after this check.
  weight?: number;
  // The band weight would have chosen, against the thresholds in force now.
  // Recorded rather than derived later, because those thresholds are settings
  // and the value of the record is what WOULD have happened at the time.
  weightedBand?: IdentityBand;
  // How wide the face was in the frame, as recorded for enrolment.
  sourceWidth?: number;
  // False when the recogniser could detect but not describe.
  embedded: boolean;
}

// One pass of the detector. `faces` empty means it looked and found nobody,
// which is information rather than an absence of it.
export interface VisionCheckEvent {
  kind: "check";
  at: string;
  faces: VisionCheckFace[];
}

// One captioner result. Deliberately carries no identity: that is the checks'
// job, and a second slower answer to the same question would only disagree.
export interface VisionCaptionEvent {
  kind: "caption";
  at: string;
  caption: string;
}

export type VisionEvent = VisionCheckEvent | VisionCaptionEvent;

// How many events the pane holds and renders.
//
// The record itself is unbounded — nothing here expires. This is a rendering
// bound: a check every few seconds is a few thousand rows a day, and a pane
// nobody can read is not a record anyone consults. The pane says when it is
// full rather than truncating in silence.
export const VISION_TIMELINE_WINDOW = 200;

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
  // Who this person is, in the user's own words. Reaches a model through a
  // system prompt and never through a caption line (R17, R19).
  //
  // Optional, and absent on every record written before profiles existed —
  // absent reads as "nothing said about them", which is what was true then.
  profile?: string;
  // Whether this is the person HAL is talking to (R18). At most one record
  // carries it; the store moves the mark rather than allowing two.
  isOperator?: boolean;
}

// A face belonging to a person. The embedding is what matching compares; the
// thumbnail exists so a roster is reviewable by eye rather than by id.
export interface PersonFace {
  id: string;
  addedAt: string;
  // How wide the face was in the frame it came from, in pixels.
  //
  // Every stored crop is normalised to 160x160, so the file itself cannot say
  // whether it was upscaled from a distant face or downscaled from a close one.
  // This is that missing number, and it is the one that predicts whether the
  // embedding is any good — a face detected 40px wide is upscaled into mush,
  // and a vague embedding sits close to everyone.
  //
  // Absent on faces enrolled before this was recorded.
  sourceWidth?: number;
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
  // Every face, so one can be picked out and pruned (R11). Carries no
  // embeddings — those are the biometric payload and a roster does not need
  // them to let someone point at a bad crop.
  faces: { id: string; addedAt: string; thumbnail?: string; sourceWidth?: number }[];
  profile?: string;
  isOperator?: boolean;
}

// An unrecognised face HAL saw and kept, so it can be named later.
//
// The brief refuses a standing gallery of unrecognised people, and this is the
// pending item it allows instead: held until the user names it or dismisses
// it, and gone the moment they do. What makes it a queue rather than a gallery
// is that neither outcome leaves anything behind.
//
// No expiry yet — a deliberate choice, recorded in
// docs/residual-review-findings/. An expiry sweep can be added without
// changing this shape.
export interface VisionCandidate {
  id: string;
  // When the face was seen. The user is triaging visits, not files.
  at: string;
  // Data URL of the face crop, so a roster is reviewable by eye.
  thumbnail: string;
  // How wide the face was in the frame, in pixels. See PersonFace.sourceWidth.
  sourceWidth?: number;
  // Present when this face matched someone already enrolled, but only in the
  // hedged band — recognised, not confidently. The question is "is this Steve?"
  // rather than "who is this?", and the answer adds a face to a person who
  // already exists rather than creating one.
  suspected?: { personId: string; name: string; confidence: number };
}

// What HAL dropped before anyone looked at it.
//
// The buffer is bounded, and a bound means the oldest candidate falls off when
// it fills. Stating the count is what stops an empty queue reading as a quiet
// week when it was a missed one — the same reasoning the brief applies to
// expiry, applied to eviction.
export interface CandidateOverflow {
  dropped: number;
  since: string | null;
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

// One person in front of the camera right now, for a caller that needs the
// live set rather than the record of it.
export interface VisionPresenceFace {
  // The Appearance's standing decision — what HAL acts on. Null means present
  // and unrecognised, which is a decision rather than a pending state.
  match: IdentityMatch | null;
  // What the most recent check found for this Appearance, which drifts across
  // a visit while `match` cannot. Null when this frame's face matched nobody,
  // undefined when the Appearance claimed no face this frame.
  currentConfidence?: number | null;
  // When the Appearance opened, so a caller can say how long someone has been
  // there without holding the tracker.
  since: string;
}

// Who is in view, as of the last detection.
//
// Distinct from `VisionObservation`, which is one capture as the captioner
// described it, and from the Vision Timeline, which is the record. This is the
// present tense, read straight from appearance continuity.
export interface VisionPresence {
  // Whether HAL is looking at all — Vision on AND recognition on. False and an
  // empty set means "not looking"; true and an empty set means "nobody here".
  // A caller that conflates them reports an empty room HAL never checked.
  watching: boolean;
  present: VisionPresenceFace[];
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
  // Cosine similarity at or above which HAL states the bare name rather than
  // hedging it (R1, R2). Between this and `confidenceThreshold` an identity is
  // attributed — "someone who looks like Dave" — and above it asserted.
  //
  // Always strictly greater than `confidenceThreshold` by at least
  // MIN_BAND_SEPARATION, so the hedged band can never be configured away.
  statementThreshold: number;
  // How many unrecognised faces to keep waiting to be named. Zero keeps none,
  // which turns triage off without touching recognition. The oldest falls off
  // when the buffer fills, and the count of what fell off is reported rather
  // than discarded silently.
  candidateFaces: number;
  // Whether an uncertain match — recognised, but only in the hedged band — is
  // also kept for review, so it can be confirmed and become another face for
  // that person.
  //
  // Off by default. It improves matching when confirmations are right and
  // degrades it when they are wrong, and the hedged band is by definition where
  // HAL is least sure, so this is opt-in rather than assumed.
  queueUncertainMatches: boolean;
  // How long a person's recognition weight takes to halve while they are not
  // being seen. Decay is against wall-clock, so this governs how quickly a gap
  // reads as absence.
  weightHalfLifeSeconds: number;
  // How far one recognition moves the weight toward its ceiling, scaled by the
  // confidence of that match.
  weightGain: number;
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

// Faces waiting to be named or dismissed, newest first, with whatever the
// bound discarded before anyone got to it.
export interface VisionCandidatesMessage {
  type: "vision-candidates";
  candidates: VisionCandidate[];
  overflow: CandidateOverflow;
}

// What HAL saw, oldest first.
//
// Greeted whole on connection and extended one event at a time after that. A
// full rebroadcast is what the roster and the candidate queue do, but they
// change on a human action; this changes every few seconds, and resending two
// hundred events each time to add one is a cost with no reader.
export interface VisionTimelineMessage {
  type: "vision-timeline";
  events: VisionEvent[];
  // How many the client should hold. Sent rather than assumed so the pane can
  // say what its bound is without a second source of the number.
  window: number;
  // True when these EXTEND what the client holds. Absent means replace, which
  // is the greet.
  append?: boolean;
}

// The outcome of a roster edit. Typed, and carrying which action it answers,
// because a single shared error field lets two unrelated actions overwrite each
// other's message — and R15 wants the reason at the point of the action.
export interface VisionRosterResultMessage {
  type: "vision-roster-result";
  action: "rename" | "remove-face" | "add-face" | "profile" | "operator" | "confirm";
  ok: boolean;
  personId?: string;
  error?: string;
  // What happened, when it is worth saying — a merge is not what the user
  // literally asked for, so it says so.
  note?: string;
}

// What a purge would destroy, so the confirmation can say it rather than ask
// the user to take it on faith (R39). Counted at the moment it is asked for —
// a stale count on a destructive confirmation is worse than none.
export interface BiometricTallyMessage {
  type: "biometric-tally";
  people: number;
  faces: number;
  candidates: number;
}

// The purge happened. Carries what it destroyed so the client can say so after
// the fact, since by then there is nothing left to count.
export interface BiometricPurgedMessage {
  type: "biometric-purged";
  people: number;
  faces: number;
  candidates: number;
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
  | VisionEnrolResultMessage
  | VisionCandidatesMessage
  | VisionTimelineMessage
  | BiometricTallyMessage
  | BiometricPurgedMessage
  | VisionRosterResultMessage;

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
  // Name a face HAL kept earlier instead of whoever is in front of the camera
  // now. This is what makes enrolment work when two people are in frame — the
  // face is chosen rather than assumed — and what lets someone be named after
  // they have walked away.
  candidateId?: string;
}

// The other half of triage. Deletes the candidate and its crop, and records
// nothing about the face: someone who merely walked past leaves no trace.
// Confirm that a queued uncertain match really is who HAL suspected. The face
// joins that person; the queue item goes.
export interface ConfirmCandidateMessage {
  type: "confirm-candidate";
  id: string;
  personId: string;
}

// The user has read the "N faces were dropped" tally. Resets it, so a later
// drop starts a fresh count rather than adding to one nobody can clear.
export interface AcknowledgeOverflowMessage {
  type: "acknowledge-overflow";
}

export interface DismissCandidateMessage {
  type: "dismiss-candidate";
  id: string;
}

export interface ListCandidatesMessage {
  type: "list-candidates";
}

export interface DeletePersonMessage {
  type: "delete-person";
  id: string;
}

export interface ListPeopleMessage {
  type: "list-people";
}

export interface RenamePersonMessage {
  type: "rename-person";
  id: string;
  name: string;
}

export interface SetProfileMessage {
  type: "set-profile";
  id: string;
  // Empty clears it. There is no separate "forget what I said about them".
  profile: string;
}

// Null clears the mark without naming a replacement.
export interface SetOperatorMessage {
  type: "set-operator";
  id: string | null;
}

export interface RemoveFaceMessage {
  type: "remove-face";
  personId: string;
  faceId: string;
}

// Add a face from a picture the user already has (R13).
//
// The bytes cross as a base64 JPEG because the protocol is JSON — this is the
// first sizeable client-to-server payload, and the client transcodes before
// sending so the server receives one format regardless of what was picked.
export interface AddFaceFromImageMessage {
  type: "add-face-from-image";
  personId: string;
  // Base64 JPEG, no data-URL prefix.
  jpegBase64: string;
}

// Ask what a purge would cost. Separate from the purge itself so the
// confirmation states real numbers rather than the client's stale copy.
export interface CountBiometricsMessage {
  type: "count-biometrics";
}

// R39. Everything biometric: the gallery, the queue, and every crop of both.
export interface PurgeBiometricsMessage {
  type: "purge-biometrics";
}

// The handshake. Must be the first message on a socket; anything else closes it.
//
// The token is minted per boot and left in the data dir as `ws-token`, so an
// agent connecting without a browser reads it from there. That is what keeps the
// no-Origin path — the one AGENTS.md protects for protocol clients — open.
export interface AuthenticateMessage {
  type: "authenticate";
  token: string;
}

export type ClientMessage =
  | AuthenticateMessage
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
  | ListPeopleMessage
  | DismissCandidateMessage
  | ListCandidatesMessage
  | CountBiometricsMessage
  | PurgeBiometricsMessage
  | RenamePersonMessage
  | RemoveFaceMessage
  | AddFaceFromImageMessage
  | SetProfileMessage
  | SetOperatorMessage
  | ConfirmCandidateMessage
  | AcknowledgeOverflowMessage;
