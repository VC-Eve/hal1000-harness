// The World domain: the durable shape of a live scene-world, shared by the
// server that persists and runs it and the client that draws and edits it.
//
// A World is a folder — a manifest plus a `clips/` directory — so every shape
// here is written to disk by one build and read by another. Nothing in this
// file may be removed or repurposed without the same care a wire contract
// takes, and the store rebuilds a loaded World by spreading what it parsed
// rather than by naming these fields; see
// docs/solutions/rebuilding-a-cache-field-by-field-turns-a-read-into-a-delete.md.

/** A camera's cone. Angles are degrees; 0° points along +x, growing counter-clockwise. */
export interface Camera {
  x: number;
  y: number;
  facing: number;
  /** Total field of view, not the half-angle. */
  fov: number;
  range: number;
}

/** A named place on the floorplan, independent of any camera (R7). */
export interface WorldPosition {
  id: string;
  name: string;
  x: number;
  y: number;
}

/** One camera's view. A Scene owns exactly one camera (R6). */
export interface Scene {
  id: string;
  name: string;
  camera: Camera;
}

/**
 * A clip assignment: where the file is, and how long it runs.
 *
 * The duration is the server's timing authority (KTD1a). It is captured by the
 * browser from `loadedmetadata` at assignment time and sent with the assign
 * message, so the server stores a number it was given and still inspects no
 * video. `path` is relative to the World directory and is confined at load.
 */
export interface ClipRef {
  path: string;
  durationMs: number;
}

/** A Position seen by a particular Scene in a particular pose (R10). */
export interface WorldState {
  id: string;
  sceneId: string;
  positionId: string;
  /** Distinguishes two States at one Position in one Scene. Absent is the base pose. */
  pose?: string;
  /** The looping clip that plays while the State holds (R11). */
  clip: ClipRef | null;
}

/** Which edge of frame a Cut leaves through and enters through (R15). */
export type FrameEdge = "left" | "right" | "top" | "bottom";

export const FRAME_EDGES: readonly FrameEdge[] = ["left", "right", "top", "bottom"];

export type ConditionOp = "eq" | "ne";

/** One clause of an edge's condition. Clauses conjoin. */
export interface Condition {
  parameter: string;
  op: ConditionOp;
  value: string;
}

/**
 * Pose changes pose inside one Scene, Travel moves between Positions inside one
 * Scene, and Cut changes Scene (R12–R14). Only a Cut plays two clips.
 */
export type EdgeKind = "pose" | "travel" | "cut";

export const EDGE_KINDS: readonly EdgeKind[] = ["pose", "travel", "cut"];

export interface Edge {
  id: string;
  kind: EdgeKind;
  /** State ids. */
  from: string;
  to: string;
  /** Every clause must hold. An empty list is unconditional. */
  conditions: Condition[];
  /** Whether the edge is offered when the current clip ends (R19). */
  onClipEnd: boolean;
  /** The single clip for a Pose or Travel edge; the exit clip for a Cut. */
  clip: ClipRef | null;
  /** The entry clip, Cut only — it plays after the camera change (R14). */
  entryClip?: ClipRef | null;
  /** Cut only: the frame edge left through and the one entered through (R15). */
  exitEdge?: FrameEdge | null;
  entryEdge?: FrameEdge | null;
}

/** A named value conditions read, with a finite value space and a default (R18). */
export interface Parameter {
  name: string;
  values: string[];
  defaultValue: string;
}

/** A Scene/Position pairing. Derived from coverage; struck by hand when geometry is wrong. */
export interface Pairing {
  sceneId: string;
  positionId: string;
}

/**
 * The manifest. `id` is the directory slug the server derived; `name` is what
 * the author typed and is the only one they see (KTD3).
 */
export interface World {
  id: string;
  name: string;
  positions: WorldPosition[];
  scenes: Scene[];
  states: WorldState[];
  edges: Edge[];
  parameters: Parameter[];
  /** Derived pairings the author excluded because geometry cannot see walls (R9). */
  struck: Pairing[];
}

/** What the picker lists (R2). `readable` is false for a manifest that will not parse. */
export interface WorldSummary {
  id: string;
  name: string;
  readable: boolean;
}

/** Why a clip path was refused, or that the file is simply not there (R17). */
export type IncompleteReason = "escapes-world" | "missing" | "not-a-path";

/**
 * A State or edge whose clip could not be used.
 *
 * The offending path is reported and left in the manifest untouched — a
 * rejected path is the author's work, and deleting it to make the World clean
 * is the loss the store exists to avoid.
 */
export interface IncompleteClip {
  kind: "state" | "edge";
  id: string;
  /** Which clip on that owner: a State has one, a Cut has two. */
  slot: "clip" | "entry";
  path: string;
  reason: IncompleteReason;
}

/** A Cut pair that reads as the character turning around rather than continuing (R27). */
export interface ReversedCut {
  edgeId: string;
  returnEdgeId: string;
  exitEdge: FrameEdge;
  returnExitEdge: FrameEdge;
}

/** A State with no satisfiable edge out while a Parameter holds this value (R28). */
export interface DeadEnd {
  stateId: string;
  parameter: string;
  value: string;
}

/**
 * What the plan view reports.
 *
 * Each field states what it claims and no more. `deadEnds` in particular is
 * "no satisfiable edge out for these enumerated values", never "this graph is
 * fine" — a World with no Parameters declared enumerates nothing.
 */
export interface WorldReports {
  worldId: string;
  /** Scene/Position pairings a cone covers, after strikes (R9, R10). */
  coverage: Pairing[];
  /** Covered pairings with no State clip assigned yet (AE1). */
  missingClips: Pairing[];
  /** Position ids no camera covers (R26). */
  uncoveredPositions: string[];
  /** Scene ids whose camera has a non-finite field and therefore covers nothing. */
  unusableCameras: string[];
  /** Strikes whose underlying pairing no longer exists — a camera moved, or a Position went. */
  staleStrikes: Pairing[];
  reversedCuts: ReversedCut[];
  deadEnds: DeadEnd[];
}

/** Where the runtime is, and what should be on screen (R29). */
export interface LiveState {
  worldId: string;
  stateId: string | null;
  sceneId: string | null;
  /** The clip playing now: a State's loop, or one half of a Cut. */
  clip: ClipRef | null;
  /** `cutting` is the entry half of a Cut, after the camera change. */
  phase: "holding" | "playing" | "cutting";
  parameters: Record<string, string>;
  /**
   * Bumped on every transition start and every supersede. A clip-end report
   * naming a stale generation changed nothing by the time it arrived.
   */
  generation: number;
  /** Set when a transition could not play — a clip that would not resolve. */
  fault: string | null;
}

/** What a client supplies to create a World: a name, never a path segment (KTD3). */
export interface WorldDraft {
  name: string;
}

/** Where a clip assignment lands. A State is named by its pairing, not by an id. */
export type ClipTarget =
  | { kind: "state"; sceneId: string; positionId: string; pose?: string }
  | { kind: "edge"; edgeId: string; slot: "clip" | "entry" };

/** What a client supplies to add an edge. Ids are server-generated. */
export interface EdgeDraft {
  kind: EdgeKind;
  from: string;
  to: string;
  conditions?: Condition[];
  onClipEnd?: boolean;
  exitEdge?: FrameEdge | null;
  entryEdge?: FrameEdge | null;
}

export type EdgePatch = Partial<Omit<Edge, "id">>;

/** Aiming a camera: any subset of its five numbers. */
export type CameraPatch = Partial<Camera>;
