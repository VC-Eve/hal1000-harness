// Shared WebSocket message contract between the HAL core (server) and its
// clients (web UI now, desktop shell later). Both sides compile against this
// file; it is the single source of truth for wire shapes.

import type { SlotSpec, TemplateRole } from "./templates.js";
import type { PhraseSettings, PhraseSpec } from "./phrases.js";
export type { SlotSpec, TemplateRole, PhraseSettings, PhraseSpec };

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
  // Whether that prompt is a template rather than literal text.
  //
  // Absent on every Conversation written before templates existed, and absent
  // reads as literal — braces in a prompt written when braces meant braces must
  // not start disappearing as unknown slots. A thread opts in by being saved
  // through the editor, which escapes its braces on the way.
  promptIsTemplate?: boolean;
  // Which observation sources this thread receives, and how much of each.
  //
  // Absent reads as both off, which is what makes a Conversation written
  // before this feature behave exactly as it did — no migration, and no
  // thread silently gaining the camera because the product changed.
  context?: ConversationContext;
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
// A pending candidate is held until the user names it or dismisses it, and
// both outcomes end it. A candidate that has been SET ASIDE is held until the
// user acts, with no expiry — that is a gallery of unrecognised people, which
// HAL now keeps deliberately because the user chose it over a bounded clock.
// The pools are bounded and both report what they discarded; see
// docs/residual-review-findings/ for the trade as accepted.
export interface VisionCandidate {
  id: string;
  // When the face was seen. The user is triaging visits, not files.
  at: string;
  // Data URL of the face crop, so a roster is reviewable by eye.
  thumbnail: string;
  // How wide the face was in the frame, in pixels. See PersonFace.sourceWidth.
  sourceWidth?: number;
  // When the user shelved this face. Absent means it is still in the active
  // queue — the original kind of candidate.
  setAsideAt?: string;
  // When a shelved face was last seen again. A returning face does not make a
  // second item; it stamps this and, when the new capture is wider, replaces
  // the crop. Absent means it has not been seen since it was shelved.
  lastSeenAt?: string;
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

/**
 * How often an arriving face was absorbed by one already on the shelf.
 *
 * The duplicate check is what stops a face you set aside re-queueing on every
 * visit. It compares an arrival against everything held, and the shelf never
 * empties on its own — so the set it compares against only grows, and with it
 * the chance that a genuinely new visitor resembles something enough to be
 * taken for it. When that happens the queue never mentions them, and the queue
 * is the only way a stranger is ever surfaced.
 *
 * Counted rather than guessed at. If this climbs, the threshold is too loose
 * for a pool that does not turn over, and the number to replace it with will
 * be one somebody measured.
 */
export interface ShelfMatchTally {
  matched: number;
  since: string | null;
}

// Which tally the user has read. Three counters, three separate notices, and
// clearing one must not clear the others.
export type OverflowKind = "pending" | "setAside" | "shelfMatches";

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

// ---------------------------------------------------------------------------
// Conversation context
//
// How much of what HAL observes reaches a Conversation, per source.
// ---------------------------------------------------------------------------

// How much of a source a Conversation takes. `off` is the absence of the
// source, not a zero-sized amount of it.
export const CONTEXT_LEVELS = ["off", "small", "medium", "large"] as const;

export type ContextLevel = (typeof CONTEXT_LEVELS)[number];

// What each level takes, as a share of the usable window.
//
// A share rather than a character count because the window belongs to the
// model and the user picks the model per Conversation: locally installed models
// span 2,048 to 262,144 tokens, so one fixed count would be 0.6% of one window
// and 73% of another. The control still reads in characters — the number is
// computed for the model in use rather than stored.
//
// Both sources at `large` take half the window, leaving the rest for the
// System Prompt and the history. 25% is just inside a ratio this codebase
// already runs on: EVENT_BUDGET_CHARS against NARRATION_NUM_CTX is about 37%
// at four characters per token.
export const CONTEXT_LEVEL_SHARES: Record<ContextLevel, number> = {
  off: 0,
  small: 0.05,
  medium: 0.12,
  large: 0.25,
};

// The window assumed for a model that will not say what its own is.
//
// Deliberately small. Unknown must fail toward sending too little rather than
// toward evicting the System Prompt, which is what overflow costs.
export const FALLBACK_CONTEXT_TOKENS = 4096;

// Rough characters per token. The same approximation the narration budget
// already runs on; the level shares leave half the window free, which is the
// margin that absorbs a token-dense prompt.
export const CHARS_PER_TOKEN = 4;

// What a Conversation takes from each source.
//
// Levels rather than character counts: a count stored here would be true only
// for the model in use when it was picked, and would silently mean something
// else after switching models.
export interface ConversationContext {
  vision: ContextLevel;
  session: ContextLevel;
  /**
   * What HAL has lately been saying about the Monitors.
   *
   * The third observation role, and the one a Conversation could not see at
   * all: the narration feed has always carried Monitor entries and the session
   * block structurally excluded them, because it filters on a session id they
   * do not have.
   *
   * Optional, and absent reads as `off`. That is what keeps a thread written
   * before this unchanged, and it is why the shipped context template can carry
   * the slot without changing what any existing install sends — an off source
   * renders empty and takes its block with it.
   */
  monitor?: ContextLevel;
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
  // Recognition Weight, decayed to the moment this snapshot was taken.
  //
  // How much this person's presence is supported by a run of checks rather than
  // by one frame. It still decides nothing — banding, narration, profile
  // delivery and the candidate queue all read the current frame's confidence —
  // but a Conversation is told about it, because "recognised steadily for two
  // minutes" is the evidence a reader needs to conclude anything at all, and
  // withholding it left HAL unable to say who was in front of it while
  // watching them continuously.
  weight?: number;
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
  // Whether Vision's cycle summary reaches the Narration Feed.
  //
  // Separate from `enabled`, and separate from everything the Vision pane
  // shows. Off, the camera still watches, captions still land on the Vision
  // Timeline, recognition still runs and the pane is unchanged — only the
  // commentary stops, so a feed being read for coding-session activity is not
  // interleaved with remarks about the room. The summariser is skipped
  // entirely rather than run and discarded: it is a model call on the same
  // card as everything else, and nobody is going to read the result.
  narrateToFeed: boolean;
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
  // Whether each of those is a Template rather than literal text.
  //
  // Absent reads as literal, the same convention a Conversation's prompt
  // follows: a prompt written when braces meant braces must keep them. Saving
  // through the editor escapes the braces and sets this, so nothing is
  // converted behind anyone's back.
  //
  // These two live here rather than beside the other four because their prompts
  // do — and they merge through `mergeVision`, not `merge`, which nothing will
  // type-error about if it is missed.
  promptIsTemplate?: boolean;
  captionPromptIsTemplate?: boolean;

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
  // How many shelved faces are kept. Its own bound, so a stranger arriving
  // never displaces a face the user deliberately chose to keep. Small on
  // purpose: every shelved face is another comparison an arrival must survive
  // before it is queued at all.
  setAsideFaces: number;
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

// Which wire protocol a model server speaks.
//
// Two, not one, and not a vendor name: `openai` here means the
// `/v1/chat/completions` shape that llama.cpp, LM Studio, vLLM and the hosted
// APIs all answer, so one implementation reaches all of them. Ollama keeps its
// native API rather than being routed through its own `/v1` compatibility
// layer, because that layer has no field for `num_ctx` and every request HAL
// makes sets one.
export type BackendProtocol = "ollama" | "openai";

// What the user chose, which is not the same as what was decided. "auto" means
// the endpoint is probed; naming a protocol overrides the probe permanently.
// Kept distinct from `BackendProtocol` so "auto" can never reach a factory that
// has to switch on a real answer.
export type ProtocolPreference = "auto" | BackendProtocol;

/**
 * One configured backend, as stored and as a client sees it.
 *
 * Carries no credential, and that absence is the design. Settings are
 * broadcast wholesale — on every connection and after every update — so a key
 * living here would have to be redacted at each of those points, and missing
 * one is the failure `docs/solutions/a-gate-that-checks-one-direction-is-half-a-gate.md`
 * records: the check covered requests and gave the pushes away. Keys are held
 * in their own store instead, so there is nothing here to leak.
 */
export interface BackendSettings {
  endpoint: string;
  protocol: ProtocolPreference;
  // Whether a key is held for this backend, which is all a client is told.
  hasKey: boolean;
}

/**
 * Which of HAL's two destinations a slot is.
 *
 * Named for what sends there rather than for how they relate. An earlier shape
 * called one of them `shared` and made the other an override switched off by
 * default, which hid the more important fact: there are two destinations, and a
 * user is entitled to see both at once. "Shared" also only described a
 * relationship that held while the other was off.
 */
export type BackendSlot = "chat" | "observation";

export const BACKEND_SLOTS: readonly BackendSlot[] = ["chat", "observation"];

/** What each slot serves, for labelling and for readiness. */
export const BACKEND_SLOT_LABELS: Record<BackendSlot, string> = {
  chat: "chat",
  observation: "narration, log monitors and vision",
};

/**
 * The two backends HAL sends inference to.
 *
 * Independent, always configured, and always shown. The three observation roles
 * share one destination because they are the unattended ones — they run whether
 * or not anybody is watching, and splitting them further would multiply the
 * endpoints nobody is checking the bill for. Chat is the role a person is
 * waiting on, so it gets its own.
 *
 * Both default to the same endpoint, which is the ordinary single-server setup.
 * They do not track each other after that: changing one leaves the other where
 * it was, and `copyFrom` on a patch is how a setting moves between them
 * deliberately rather than by inheritance nobody can see.
 */
export interface Backends {
  chat: BackendSettings;
  observation: BackendSettings;
}

/**
 * Where a chat request goes.
 *
 * Shared between server and client rather than duplicated, because they must
 * not disagree: the server withholds identity context based on this endpoint,
 * and the client's notice tells the user that is about to happen. Two copies of
 * the rule is how the notice ends up describing a request that did not occur.
 *
 * A blank chat endpoint falls back to the observation one. That is a repair
 * rather than a feature — settings are hand-editable and an install that
 * predates this shape may hold one — and it keeps a blank field from failing
 * every send.
 */
export function chatBackendOf(backends: Backends): BackendSettings {
  return backends.chat.endpoint.trim().length > 0 ? backends.chat : backends.observation;
}

/**
 * Inbound only.
 *
 * `apiKey` has no outbound counterpart by design — a string sets the
 * credential, null clears it, and omitting it leaves the stored one alone.
 *
 * `copyFrom` takes the other slot's endpoint, protocol and key in one move.
 * The key is why this is a server-side operation rather than the client reading
 * one field and writing another: a client is never told a credential, so a copy
 * it performed itself would silently drop the one part that is tedious to
 * retype.
 */
export interface BackendPatch {
  endpoint?: string;
  protocol?: ProtocolPreference;
  apiKey?: string | null;
  copyFrom?: BackendSlot;
}

/**
 * The message templates, keyed by role.
 *
 * `null` and absent both mean "never edited", so the shipped default resolves
 * at render time and an improved one arrives on its own — the same convention
 * the prompt settings have always used. Any string, including "", is the
 * user's and is rendered verbatim.
 */
export type TemplateSettings = Partial<Record<TemplateRole, string | null>>;

/**
 * A template the user saved as their own starting point.
 *
 * `shippedDefault` records what the product shipped at the moment it was
 * saved, which is what makes "a release moved this default" answerable without
 * storing a version number that would mean nothing after a downgrade.
 */
export interface TemplateBaseline {
  text: string;
  shippedDefault: string;
}

export type TemplateBaselines = Partial<Record<TemplateRole, TemplateBaseline>>;

export interface Settings {
  backends: Backends;
  chatModel: string | null;
  narrationModel: string | null;
  // The two settings-level system prompts. `null` means "never edited": the
  // shipped default in `shared/src/prompts.ts` resolves at read time, so a
  // release that changes a default reaches anyone who left it alone. Any
  // string — including "" — is the user's and is used verbatim.
  narrationPrompt: string | null;
  // Whether each settings-level prompt is a Template rather than literal text.
  // Absent reads as literal — see the two on `VisionSettings` for why.
  narrationPromptIsTemplate?: boolean;
  chatDefaultPromptIsTemplate?: boolean;
  monitorPromptIsTemplate?: boolean;
  chatContextPreambleIsTemplate?: boolean;
  // Copied onto a Conversation at creation, never consulted again by an
  // existing one. Editing it must not rewrite threads already under way.
  chatDefaultPrompt: string | null;
  // Monitors narrate from their own prompt: the narration prompt's tag glossary
  // describes coding-agent log entries and would mislead about a log line.
  monitorPrompt: string | null;
  // What a Conversation is told the injected observation context is, ahead of
  // it. Null means never edited and resolves to the shipped text. Blank sends
  // no preamble — the context then arrives unintroduced, which is what it did
  // before this was a setting.
  chatContextPreamble: string | null;
  // Interface copy tone only: picks the row in `ui/src/persona.ts`. It no
  // longer composes the narration prompt — that is `narrationPrompt` now.
  personaIntensity: PersonaIntensity;
  watchedSessionId: string | null;
  // Tokens a chat request may allocate, which `num_ctx` is set from. Capped
  // here rather than taken from the model, because a model's advertised window
  // is what it was trained for and not what this machine can hold.
  chatContextCap: number;
  // Whether the user has accepted that identity data may leave the machine.
  // Read at send time against the provider actually in effect, so configuring a
  // remote provider after the fact cannot bypass it.
  offMachineAcknowledged: boolean;
  adapters: Record<AdapterId, AdapterSettings>;
  chatColors: ChatColors;
  vision: VisionSettings;
  templates: TemplateSettings;
  templateBaselines: TemplateBaselines;
  /**
   * The single lines a slot renderer builds, keyed by phrase id.
   *
   * Same convention as everything else here: absent or `null` means never
   * edited and resolves to what shipped.
   */
  phrases: PhraseSettings;
}

// Patch shape for `update-settings`. Nested maps are partial all the way
// down so a client can send one adapter's colour without restating the rest;
// the store merges per adapter id rather than replacing the map.
export type SettingsPatch = Partial<
  Omit<Settings, "adapters" | "chatColors" | "vision" | "backends" | "templates" | "templateBaselines">
> & {
  adapters?: Partial<Record<AdapterId, Partial<AdapterSettings>>>;
  chatColors?: Partial<ChatColors>;
  vision?: Partial<VisionSettings>;
  // Merged per role, so setting one template does not clear the rest.
  templates?: TemplateSettings;
  // Merged per phrase id; null on one restores what shipped for that line.
  phrases?: PhraseSettings;
  // A role set to null here forgets its baseline; the role is left alone when
  // the key is absent, the way every other nested map behaves.
  templateBaselines?: Partial<Record<TemplateRole, TemplateBaseline | null>>;
  // Per slot and per field, so setting an endpoint does not clear a key and
  // changing one destination does not restate the other.
  backends?: Partial<Record<BackendSlot, BackendPatch>>;
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
  /**
   * The backend narration, monitors and Vision all send to.
   *
   * Replaces the old `ollama` leg rather than sitting beside it: that name
   * asserted a backend the user may not be running, and HAL now reaches
   * llama.cpp, LM Studio, vLLM and hosted APIs through the same slot.
   * "unreachable" covers both nothing listening and an endpoint whose protocol
   * could not be determined — from the user's side those are one condition
   * with one remedy, and reporting "undetermined protocol" as its own state
   * would name a distinction they cannot act on differently.
   */
  observationBackend: "ok" | "unreachable";
  /** Where chat sends. Always configured, so always probed. */
  chatBackend: "ok" | "unreachable";
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
  /**
   * Which backend these models are on.
   *
   * A model list belongs to a server, not to the app. Without this the
   * narration picker offered the chat backend's models — invisible while both
   * slots named the same machine, and wrong the moment they did not, in the
   * same way a window cached by model name alone was wrong.
   */
  slot: BackendSlot;
  models: string[];
  // Each model's window in tokens, for the models the provider could say.
  //
  // Sent because the client has to print what a context level buys on the
  // model in use, and it cannot derive that from a name. A model missing here
  // is one nothing could establish a window for, and both sides fall back to
  // the same conservative default rather than to different guesses.
  windows?: Record<string, number>;
  /**
   * Where the window figure came from, which is not the same question as what
   * it is.
   *
   * `requested` — HAL asks for this size per request, so the number is a
   * promise it keeps. Only Ollama's native API can do this.
   * `reported` — the server was started with this size and says so. HAL cannot
   * change it; a request that needs more simply overflows.
   * `unknown` — nothing could establish one, and the conservative default is in
   * use.
   *
   * Sent because the control's meaning changes with the backend, and a control
   * whose meaning changes silently is the failure the per-request window was
   * added to prevent one level down.
   */
  // Chat only: Context Level is a property of a conversation's request, and
  // nothing sizes a narration prompt against a window the user picked.
  windowSource?: "requested" | "reported" | "unknown";
  // Distinguishes "provider down" (error) from "no models pulled" (empty list).
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
  // The Monitor's shipped prompt. Absent until now, which left a
  // protocol-only client unable to read what HAL sends a Monitor or to
  // reproduce a reset of it — the one prompt the catalog never carried.
  monitorDefault: string;
  // Already sent by the server; the interface simply never declared it, so a
  // client compiling against this file could not see a field it was receiving.
  contextPreambleDefault: string;
  narrationPresets: readonly NarrationPresetInfo[];
  // Every editable line, with its fields and what its wording protects.
  phrases: readonly PhraseSpec[];
  // The shipped template for every role, and the slots each role accepts with
  // what they mean and what their wording is protecting. Carried as data for
  // the same reason the prompts are: without it a client that speaks only the
  // protocol cannot author a template, cannot say what a reset restores, and
  // cannot tell the user why a sentence is phrased the way it is.
  templateDefaults: Record<TemplateRole, string>;
  // A role's OWN readings. Not the whole vocabulary a role accepts — the
  // universal tier below is the rest of it, carried separately so a client can
  // render the two under their own headings rather than as one flat list.
  templateSlots: Record<TemplateRole, readonly SlotSpec[]>;
  // The readings every role accepts without listing them. Sent for the same
  // reason the role slots are: a protocol-only client cannot author what it
  // cannot read, and a slot missing from the catalog is a slot the editor
  // refuses on apply with no way for the user to find out it existed.
  universalSlots: readonly SlotSpec[];
  // What each of the six settings-level prompts may name, now that they are
  // Templates too. They are not roles, so `templateSlots` has no place for
  // them — and without this a protocol-only client can read the shipped text of
  // a prompt but not author one, which is the gap the catalog exists to close.
  promptSlots: Record<string, readonly SlotSpec[]>;
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
    // The standing decision, made when the appearance opened and never
    // revisited. It is what banding reads, so the pane's band cannot flicker
    // between "Alice" and "someone who looks like Alice" mid-visit.
    match: IdentityMatch | null;
    // What THIS check found for this appearance. Null when the frame matched
    // nobody, undefined when the appearance claimed no face this frame.
    //
    // Sent because `match` cannot change for the life of a visit: a pane
    // rendering it alone showed one frozen percentage while the timeline beside
    // it moved every few seconds. Displaying the standing value as though it
    // were a live reading is the defect
    // docs/solutions/a-value-frozen-for-one-caller-is-stale-for-the-next.md
    // records, arriving in a second consumer after the first was fixed.
    currentConfidence?: number | null;
    // Recognition Weight, decayed to the moment of this broadcast.
    weight?: number;
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
  // The shelf's own eviction count, and how often an arrival was taken for a
  // face already on it. Three separate notices, because they say three
  // different things about what the user is not being shown.
  setAsideOverflow: CandidateOverflow;
  shelfMatches: ShelfMatchTally;
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
  // Of that total, how many the user deliberately shelved. Named apart from
  // the rest because it is the half a purge confirmation most needs to show.
  candidatesSetAside: number;
}

// The purge happened. Carries what it destroyed so the client can say so after
// the fact, since by then there is nothing left to count.
export interface BiometricPurgedMessage {
  type: "biometric-purged";
  people: number;
  faces: number;
  candidates: number;
  // Of that total, how many the user deliberately shelved. Named apart from
  // the rest because it is the half a purge confirmation most needs to show.
  candidatesSetAside: number;
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
// The user has been told what identity data leaves the machine, and accepted.
//
// Not per Conversation: the exposure is the same whichever thread carries it,
// and the recogniser endpoint is a second route for the same data. Carries no
// payload — the acknowledgement is the act, and what was acknowledged is fixed
// by the copy shown at the time.
export interface AcknowledgeOffMachineMessage {
  type: "acknowledge-off-machine";
  accepted: boolean;
}

// Set one or both context switches on a Conversation.
//
// Partial so a client can move one source without restating the other, the
// way the settings patch merges per adapter rather than replacing the map.
export interface SetConversationContextMessage {
  type: "set-conversation-context";
  conversationId: string;
  context: Partial<ConversationContext>;
}

export interface SetConversationPromptMessage {
  type: "set-conversation-prompt";
  conversationId: string;
  prompt: string;
  /**
   * Whether to read this prompt as a template from now on.
   *
   * Set by an editor that has escaped any literal braces on the way in.
   * Omitted leaves the Conversation literal, which is what an older client
   * sending a plain prompt means and what it should keep meaning.
   */
  isTemplate?: boolean;
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
  // Which of the three tallies was read. Absent means the active queue's, so a
  // client written before the shelf existed still clears what it meant to.
  which?: OverflowKind;
}

export interface DismissCandidateMessage {
  type: "dismiss-candidate";
  id: string;
}

// Shelve one, to decide about later. The face keeps its crop and its place in
// the duplicate check, which is what stops its owner re-queueing every visit.
export interface SetAsideCandidateMessage {
  type: "set-aside-candidate";
  id: string;
}

// Put one back in the active queue. Refused when that queue is full, so unlike
// the others this one answers.
export interface RestoreCandidateMessage {
  type: "restore-candidate";
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
  | SetConversationContextMessage
  | AcknowledgeOffMachineMessage
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
  | SetAsideCandidateMessage
  | RestoreCandidateMessage
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
