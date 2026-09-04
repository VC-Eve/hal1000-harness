import type {
  BackendSlot,
  AdapterId,
  AdapterInfo,
  Conversation,
  ConversationMeta,
  Monitor,
  MonitorSuggestion,
  NarrationEntry,
  NarrationStatus,
  Readiness,
  ServerMessage,
  SessionState,
  SessionSummary,
  Settings,
  VisionObservation,
  PersonSummary,
  IdentityMatch,
  VisionAppearancesMessage,
  BiometricTallyMessage,
  VisionCandidate,
  CandidateOverflow,
  ShelfMatchTally,
  VisionEvent,
  VisionState,
  IncompleteClip,
  LibraryListing,
  LiveState,
  World,
  WorldReports,
  WorldSummary,
} from "../../shared/src/types";
import { VISION_TIMELINE_WINDOW } from "../../shared/src/types";
import type { ConnectionState } from "./ws-client";
import { DEFAULT_ADAPTER_COLOR } from "./palette";

// The four figures a purge deals in, taken from the wire contract rather than
// restated. `setAside` is renamed from the message's `candidatesSetAside` — it
// reads better beside `candidates` — but the rest are derived, so a fifth figure
// added to the message is a compile error here rather than a number the pane
// quietly stops showing. Hand-copying this shape is exactly how the vision pane
// fell behind the server once already.
type BiometricCounts = Pick<BiometricTallyMessage, "people" | "faces" | "candidates"> & { setAside: number };

export interface AppState {
  connection: ConnectionState;
  readiness: Readiness | null;
  // Per backend, because a model list belongs to a server. One flat list let
  // the narration picker offer the chat backend's models.
  models: Record<BackendSlot, string[]>;
  // Each model's window in tokens, for the models the provider could say.
  // Absent entries fall back to the shared conservative default, the same one
  // the server falls back to — so the label and the request agree.
  modelWindows: Record<string, number>;
  // Where the window figures came from: HAL requests it per request (Ollama),
  // the server reports a fixed one, or nothing could say. The context control
  // renders this, because the control means a different thing in each case.
  modelWindowSource: "requested" | "reported" | "unknown";
  modelsError: Record<BackendSlot, boolean>;
  settings: Settings | null;
  conversations: ConversationMeta[];
  active: Conversation | null;
  // Accumulating streamed reply for the active conversation.
  streaming: string | null;
  chatError: { code: "provider_unavailable" | "model_not_found"; message: string } | null;
  // Per-conversation drafts survive switching (U4 scenario).
  drafts: Record<string, string>;
  sessions: SessionSummary[];
  // The session the feed is centred on: its entries are highlighted and it
  // gets first call on the narration lane. Null means nothing is selected,
  // which does not mean nothing is observed.
  watchedSessionId: string | null;
  // Every session under observation. HAL follows all live ones, so this is
  // usually larger than the selection.
  followedSessionIds: string[];
  sessionState: SessionState | null;
  narration: NarrationEntry[];
  narrationStatus: NarrationStatus;
  newSession: SessionSummary | null;
  // The full adapter roster as the registry advertises it — including
  // adapters the stored settings have never seen.
  adapters: AdapterInfo[];
  // Configured Monitors, and the shipped suggestions with their availability
  // as probed on this machine.
  monitors: Monitor[];
  monitorSuggestions: MonitorSuggestion[];
  // Vision. Observations are the raw captions, kept separately from the feed:
  // the feed carries what HAL said about a cycle, the pane carries what it was
  // told. Seeing both is what makes the sensitivity dial tunable.
  visionState: VisionState;
  visionDetail: string | null;
  visionObservations: VisionObservation[];
  visionFrame: { at: string; dataUrl: string } | null;
  visionDevices: string[];
  // The enrolled roster, and who recognition currently sees. Appearances turn
  // over on the detection interval while observations arrive on the capture
  // interval, so the pane needs the faster one to offer enrolment against what
  // is actually on screen.
  visionPeople: PersonSummary[];
  // What a biometric purge would destroy, once asked for. Null until then,
  // and null again after the purge.
  //
  // `setAside` is carried separately rather than folded into `candidates`,
  // which is the total. "Faces you set aside to decide about later" and "faces
  // you never looked at" are different losses, and the one irreversible action
  // in the feature is the last place to merge them.
  biometricTally: BiometricCounts | null;
  // What the last purge destroyed, measured at deletion time rather than when
  // the confirmation was opened. Null until a purge happens in this session.
  biometricPurged: BiometricCounts | null;
  // The last roster edit's outcome, keyed by which action it answers. Keyed
  // rather than a single field because a rename refusal and a prune refusal
  // would otherwise overwrite each other, and R15 wants the reason at the point
  // of the action.
  visionRosterResult: Partial<Record<"rename" | "remove-face" | "add-face" | "profile" | "operator" | "confirm", { ok: boolean; error?: string; note?: string }>>;
  // Taken from the wire contract rather than restated. Hand-copying the shape
  // here is what let the pane fall behind when the server started sending the
  // live reading and the weight: the message carried them, this type did not,
  // and the compiler had no way to say so.
  visionAppearances: VisionAppearancesMessage["appearances"];
  // The last enrolment outcome, so a refusal can be explained. Every refusal
  // has a reason the user can act on.
  visionEnrolError: string | null;
  // Faces waiting to be named, newest first, and what the bound discarded
  // before anyone looked.
  visionCandidates: VisionCandidate[];
  visionCandidateOverflow: CandidateOverflow;
  visionSetAsideOverflow: CandidateOverflow;
  visionShelfMatches: ShelfMatchTally;
  // What HAL saw, oldest first: every recognition check and every caption, each
  // stamped when it happened. Distinct from `visionObservations`, which is the
  // caption feed alone and says nothing about when a face was recognised.
  visionTimeline: VisionEvent[];
  // How many events this holds, sent by the server so the pane can say what its
  // bound is without a second copy of the number.
  visionTimelineWindow: number;
  // Live scene-worlds. The picker's list, the open World's whole graph, what is
  // wrong with it, and where the runtime currently is.
  //
  // Every one of these is server-owned. The graph draws the broadcast World
  // and never a local copy it edited optimistically: the store is the authority
  // on the manifest, and a plan showing an edit the server refused would be
  // lying about a folder on disk.
  worlds: WorldSummary[];
  worldsLastOpenId: string | null;
  world: World | null;
  worldReadable: boolean;
  /** Why the open World cannot be written to, when it cannot. */
  worldReadOnlyReason: string | null;
  worldIncomplete: IncompleteClip[];
  worldReports: WorldReports | null;
  worldLive: LiveState | null;
  /** The folder the clip browser is showing. Null until it has browsed once. */
  clipLibrary: LibraryListing | null;
  // The last World action's outcome, keyed by which action it answers, so a
  // refused create and a refused mutation do not overwrite each other.
  worldResults: Record<string, { ok: boolean; error?: string }>;
}

export const initialState: AppState = {
  connection: "connecting",
  readiness: null,
  models: { chat: [], observation: [] },
  modelWindows: {},
  modelWindowSource: "requested",
  modelsError: { chat: false, observation: false },
  settings: null,
  conversations: [],
  active: null,
  streaming: null,
  chatError: null,
  drafts: {},
  sessions: [],
  watchedSessionId: null,
  followedSessionIds: [],
  sessionState: null,
  narration: [],
  narrationStatus: "idle",
  newSession: null,
  adapters: [],
  monitors: [],
  monitorSuggestions: [],
  visionState: "off",
  visionDetail: null,
  visionObservations: [],
  visionFrame: null,
  visionDevices: [],
  visionPeople: [],
  biometricTally: null,
  biometricPurged: null,
  visionRosterResult: {},
  visionAppearances: [],
  visionEnrolError: null,
  visionCandidates: [],
  visionCandidateOverflow: { dropped: 0, since: null },
  visionSetAsideOverflow: { dropped: 0, since: null },
  visionShelfMatches: { matched: 0, since: null },
  visionTimeline: [],
  visionTimelineWindow: VISION_TIMELINE_WINDOW,
  worlds: [],
  worldsLastOpenId: null,
  world: null,
  worldReadable: true,
  worldReadOnlyReason: null,
  worldIncomplete: [],
  worldReports: null,
  worldLive: null,
  clipLibrary: null,
  worldResults: {},
};

export type Action =
  | { type: "server"; msg: ServerMessage }
  | { type: "conn"; value: ConnectionState }
  | { type: "draft"; conversationId: string; value: string }
  | { type: "close-conversation" }
  | { type: "clear-chat-error" }
  | { type: "dismiss-new-session" };

const NARRATION_UI_CAP = 500;

// Smaller than the narration cap: a caption is long, arrives every interval,
// and only the recent ones are useful for judging whether sensitivity is set
// right. Observations are not replayed on reconnect, so this is a session view.
const VISION_UI_CAP = 50;

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
      return {
        ...state,
        models: { ...state.models, [msg.slot]: msg.models },
        modelsError: { ...state.modelsError, [msg.slot]: msg.error === "provider_unavailable" },
        // Chat's alone — the server sends them only on chat's message, and a
        // narration list arriving must not blank what the context control reads.
        ...(msg.slot === "chat"
          ? { modelWindows: msg.windows ?? {}, modelWindowSource: msg.windowSource ?? "requested" }
          : {}),
      };
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
        followedSessionIds: msg.followedSessionIds ?? [],
      };
    case "followed-sessions":
      return { ...state, followedSessionIds: msg.sessionIds };
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
    case "adapters":
      return { ...state, adapters: msg.adapters };
    case "monitors":
      return { ...state, monitors: msg.monitors };
    case "monitor-suggestions":
      return { ...state, monitorSuggestions: msg.suggestions };
    case "vision-status":
      return { ...state, visionState: msg.state, visionDetail: msg.detail ?? null };
    case "vision-observation":
      return {
        ...state,
        visionObservations: [...state.visionObservations, msg.observation].slice(-VISION_UI_CAP),
      };
    case "vision-frame":
      return { ...state, visionFrame: { at: msg.at, dataUrl: msg.dataUrl } };
    case "vision-devices":
      return { ...state, visionDevices: msg.devices };
    case "vision-people":
      return { ...state, visionPeople: msg.people };
    case "vision-roster-result":
      return {
        ...state,
        visionRosterResult: {
          ...state.visionRosterResult,
          [msg.action]: {
            ok: msg.ok,
            ...(msg.error ? { error: msg.error } : {}),
            ...(msg.note ? { note: msg.note } : {}),
          },
        },
      };
    case "biometric-tally":
      // Held so the confirmation can state real numbers. Counted server-side at
      // the moment it was asked for, not derived from the roster the client
      // happens to be holding.
      return {
        ...state,
        biometricTally: {
          people: msg.people,
          faces: msg.faces,
          candidates: msg.candidates,
          setAside: msg.candidatesSetAside,
        },
      };
    case "biometric-purged":
      // The tally is cleared with it: it described a world that no longer
      // exists, and leaving it would let a second confirmation quote it.
      //
      // What the purge actually destroyed is kept, because by then there is
      // nothing left to count and this message is the only record. The server
      // has always sent these figures and nothing read them, so the confirmation
      // the user was left with was the snapshot taken before they clicked.
      return {
        ...state,
        biometricTally: null,
        biometricPurged: {
          people: msg.people,
          faces: msg.faces,
          candidates: msg.candidates,
          setAside: msg.candidatesSetAside,
        },
      };
    case "vision-timeline": {
      // A greet replaces; a live event extends. Trimmed from the front, so the
      // window always holds the newest — the record on disk keeps everything,
      // and this is only what the pane can usefully render.
      const events = msg.append ? [...state.visionTimeline, ...msg.events] : msg.events;
      return {
        ...state,
        visionTimeline: events.slice(-msg.window),
        visionTimelineWindow: msg.window,
      };
    }
    case "vision-candidates":
      return {
        ...state,
        visionCandidates: msg.candidates,
        visionCandidateOverflow: msg.overflow,
        visionSetAsideOverflow: msg.setAsideOverflow,
        visionShelfMatches: msg.shelfMatches,
      };
    case "vision-appearances":
      return { ...state, visionAppearances: msg.appearances };
    case "worlds":
      return { ...state, worlds: msg.worlds, worldsLastOpenId: msg.lastOpenId };
    case "world":
      return {
        ...state,
        world: msg.world,
        worldReadable: msg.readable,
        worldReadOnlyReason: msg.readOnlyReason ?? null,
        worldIncomplete: msg.incomplete,
        worldReports: msg.reports,
        // A broadcast for a World this client is not showing must not blank the
        // live State of the one it is.
        worldLive: state.worldLive?.worldId === msg.world.id ? state.worldLive : null,
      };
    case "world-live":
      return { ...state, worldLive: msg.live };
    case "clip-library":
      return { ...state, clipLibrary: msg.listing };
    case "world-result":
      return {
        ...state,
        worldResults: { ...state.worldResults, [msg.action]: { ok: msg.ok, ...(msg.error ? { error: msg.error } : {}) } },
      };
    case "vision-enrol-result":
      // A success clears the previous refusal, so a corrected second attempt
      // does not leave the first attempt's complaint on screen.
      return { ...state, visionEnrolError: msg.ok ? null : (msg.error ?? "Enrolment failed.") };
    // The audio store reaches the client before anything here renders it: the
    // playlist editor and the track browser are later units. Ignored on purpose rather than held —
    // state nothing reads looks shipped and is not — and the exhaustiveness
    // check below is what makes the reader impossible to forget.
    case "audio-library":
    // The transport's own message. Ignored here until the player exists; the
    // case is present because a `ServerMessage` variant with no case is a
    // compile error, which is the enforcement this switch is for.
    case "audio-transport-state":
    case "playlists":
    case "playlist":
    case "playlist-result":
      return state;
    default: {
      /**
       * A message this build has never heard of.
       *
       * The assignment is the compile-time half and is the reason this branch
       * exists at all: `msg` narrows to `never` here only when every variant of
       * `ServerMessage` has a case above, so adding a server message without
       * handling it is still a compile error — the enforcement AGENTS.md
       * describes is unchanged.
       *
       * Returning the state unchanged is the runtime half, and it is not
       * theoretical. Falling off the end of the switch returned `undefined`,
       * which became the whole app state, and the next render died reading a
       * field of it — a blank page with an opaque error. That is what a browser
       * holding a cached bundle older than the server actually does, and
       * `index.html` is served `no-store` precisely because that pairing
       * happens. An old client should degrade to ignoring what it cannot read,
       * not take the page down.
       */
      const unhandled: never = msg;
      void unhandled;
      return state;
    }
  }
}

// One adapter as the settings drawer renders it: the roster's identity and
// enabled state joined to the colour the server actually stored.
export interface AdapterRow {
  id: AdapterId;
  label: string;
  enabled: boolean;
  color: string;
}

/**
 * Join the adapter roster to stored settings for display.
 *
 * The roster is the source of truth for which adapters exist and whether
 * each is on — the registry owns lifecycle and answers `list-adapters`. The
 * colour comes from settings, which the server normalizes on write and
 * echoes back, so what this returns is always the stored value and never a
 * value the client merely submitted. An adapter the settings file has not
 * seen falls back to the default colour rather than rendering blank.
 */
export function adapterRows(state: AppState): AdapterRow[] {
  return state.adapters.map((adapter) => ({
    id: adapter.id,
    label: adapter.label,
    enabled: adapter.enabled,
    color: state.settings?.adapters?.[adapter.id]?.color ?? DEFAULT_ADAPTER_COLOR,
  }));
}
