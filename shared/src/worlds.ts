// The World domain: an animation state machine over video clips.
//
// A World is a folder — a manifest plus a `clips/` directory — so every shape
// here is written to disk by one build and read by another. The store rebuilds
// a loaded World by spreading what it parsed rather than by naming these
// fields; see
// docs/solutions/rebuilding-a-cache-field-by-field-turns-a-read-into-a-delete.md.
//
// That spread protects a key one build has and another does not. It cannot
// protect a key whose *meaning* changed, which is what `WORLD_VERSION` is for.

/**
 * The manifest shape this build understands.
 *
 * Bumped when a field changes meaning rather than being added. Version 1 was
 * the camera model: `states` held Scene/Position pairings and `edges` held Pose,
 * Travel and Cut kinds. Reading one of those as a version 2 World would produce
 * a machine with no States and no explanation, so the store refuses instead.
 */
export const WORLD_VERSION = 2;

/** What a Parameter holds. */
export type ParameterType = "bool" | "int" | "float" | "trigger";

export const PARAMETER_TYPES: readonly ParameterType[] = ["bool", "int", "float", "trigger"];

/**
 * A Parameter's value.
 *
 * Bool and Trigger carry a boolean; Int and Float carry a number. The union is
 * deliberately narrow — a Parameter is a value conditions compare, not a place
 * to put arbitrary state.
 */
export type ParameterValue = boolean | number;

/**
 * A named value conditions read, and the only thing set from outside.
 *
 * A **Trigger** is a Bool that resets itself the moment a transition consumes
 * it, which is what makes a one-shot action expressible without a second
 * transition to clear the flag.
 */
export interface Parameter {
  name: string;
  type: ParameterType;
  defaultValue: ParameterValue;
}

/** Which operators a condition may use, per Parameter type. */
export type ConditionOp = "is" | "isNot" | "gt" | "lt" | "eq" | "neq";

export const BOOLEAN_OPS: readonly ConditionOp[] = ["is", "isNot"];
export const NUMERIC_OPS: readonly ConditionOp[] = ["gt", "lt", "eq", "neq"];

/** The operators a Parameter of this type may be compared with. */
export function opsFor(type: ParameterType): readonly ConditionOp[] {
  return type === "int" || type === "float" ? NUMERIC_OPS : BOOLEAN_OPS;
}

/**
 * One clause of a transition's condition. Clauses conjoin — all must hold.
 *
 * A Trigger's clause is `is true` like any Bool; what makes it a Trigger is the
 * reset that follows the transition, not the shape of the comparison.
 */
export interface Condition {
  parameter: string;
  op: ConditionOp;
  value: ParameterValue;
}

/**
 * A clip assignment: where the file is, and how long it runs.
 *
 * The duration is the server's timing authority. It is measured by the browser
 * at first play and reported, so the server stores a number it was given and
 * still inspects no video. `path` is relative to the World directory and is
 * confined at load.
 */
export interface ClipRef {
  path: string;
  durationMs: number;
}

/**
 * A State: a named node holding one looping clip.
 *
 * `x` and `y` are where the author dragged it. Layout is persisted because a
 * graph the author arranged and the machine forgot is worse than no arrangement
 * at all.
 */
export interface WorldState {
  id: string;
  name: string;
  clip: ClipRef | null;
  x: number;
  y: number;
}

/**
 * A way out of a State.
 *
 * `fromAny` is the Any State form: offered from every State rather than from
 * one. It is a flag rather than a pseudo-State in the manifest, because a
 * pseudo-State would need an id every consumer has to special-case.
 *
 * `hasExitTime` and `exitTime` are Unity's, and mean what they mean there.
 * `exitTime` is a fraction of the clip — 0.75 fires three seconds into a
 * four-second clip, and fires again on every loop.
 */
export interface Transition {
  id: string;
  /** The source State. Absent when `fromAny` is set. */
  from?: string;
  fromAny?: boolean;
  to: string;
  conditions: Condition[];
  hasExitTime: boolean;
  exitTime: number;
  /** Disabled entirely. An authoring aid, and persisted. */
  muted?: boolean;
  /** When any transition out of a source is soloed, only soloed ones are considered. */
  solo?: boolean;
  /** Position among the transitions out of one source. First satisfied wins. */
  order: number;
}

/** The manifest. `id` is the directory slug the server derived. */
export interface World {
  version: number;
  id: string;
  name: string;
  /** Where the runtime starts. Null only before the first State exists. */
  defaultStateId: string | null;
  states: WorldState[];
  transitions: Transition[];
  parameters: Parameter[];
}

/** What the picker lists. `readable` is false for a manifest that will not load. */
export interface WorldSummary {
  id: string;
  name: string;
  readable: boolean;
}

/** Why a clip path was refused, or that the file is simply not there. */
export type IncompleteReason = "escapes-world" | "missing" | "not-a-path";

/**
 * A State whose clip could not be used.
 *
 * The offending path is reported and left in the manifest untouched — a
 * rejected path is the author's work, and deleting it to make the World clean
 * is the loss the store exists to avoid.
 */
export interface IncompleteClip {
  stateId: string;
  path: string;
  reason: IncompleteReason;
}

/** A State with no satisfiable way out while a Parameter holds this value. */
export interface DeadEnd {
  stateId: string;
  parameter: string;
  value: ParameterValue;
}

/**
 * What the graph reports.
 *
 * Each field states what it claims and no more. `deadEnds` in particular is a
 * claim about the *enumerated* types only — `sweptTypes` names them, because
 * Int and Float have no value space to sweep and a report that pretended
 * otherwise would be inventing gaps it cannot prove.
 */
export interface WorldReports {
  worldId: string;
  /** States holding no clip. */
  statesWithoutClip: string[];
  /** States no path from the default State reaches. */
  unreachable: string[];
  deadEnds: DeadEnd[];
  sweptTypes: ParameterType[];
}

/** Where the runtime is, and what should be on screen. */
export interface LiveState {
  worldId: string;
  stateId: string | null;
  clip: ClipRef | null;
  parameters: Record<string, ParameterValue>;
  /**
   * Bumped for every clip issued and every supersede. A clip-end report naming
   * a stale generation changed nothing by the time it arrived.
   */
  generation: number;
  /** Set when a transition could not play — a clip that would not resolve. */
  fault: string | null;
}

/** What a client supplies to create a World: a name, never a path segment. */
export interface WorldDraft {
  name: string;
}

/** What a client supplies to add a State. Ids are server-generated. */
export interface StateDraft {
  name: string;
  x: number;
  y: number;
}

export type StatePatch = Partial<Pick<WorldState, "name" | "clip" | "x" | "y">>;

/** What a client supplies to add a transition. */
export interface TransitionDraft {
  from?: string;
  fromAny?: boolean;
  to: string;
  conditions?: Condition[];
  hasExitTime?: boolean;
  exitTime?: number;
}

export type TransitionPatch = Partial<Pick<Transition, "conditions" | "hasExitTime" | "exitTime" | "muted" | "solo">>;

// ---------------------------------------------------------------------------
// The clip library
//
// Browsing lists one folder at a time rather than walking a root: a recursive
// sweep of a directory the user named is an unbounded amount of work behind one
// message, on a protocol with no way to cancel it.
// ---------------------------------------------------------------------------

/** One video file the browser found. */
export interface LibraryClip {
  name: string;
  /** Absolute, as the server read it. The client sends this back to import. */
  path: string;
  sizeBytes: number;
}

export interface LibraryFolder {
  name: string;
  path: string;
}

/** One folder's contents. `parent` is null at a filesystem root. */
export interface LibraryListing {
  folder: string;
  parent: string | null;
  folders: LibraryFolder[];
  clips: LibraryClip[];
  /** Set when the folder could not be read, in place of throwing. */
  error?: string;
}
