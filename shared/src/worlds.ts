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
 *
 * Version 3 made a clip set a bag of `ClipRef`. Version 4 makes it a bag of
 * *sequences*, so a member of the set can be a run of clips rather than one —
 * the same field name holding a different shape, which is exactly what a
 * version is for.
 */
export const WORLD_VERSION = 4;

/**
 * The size of a State's box on the graph, and the vertical rhythm between them.
 *
 * Shared because both sides need it: the UI draws boxes this size, and the
 * server has to know it to avoid placing one State on top of another.
 */
export const NODE_W = 190;
export const NODE_H = 56;
export const NODE_ROW_GAP = 96;

/**
 * The longest a crossing may hold the machine.
 *
 * Much shorter than a clip's ceiling, because the two cost different things: a
 * long clip merely plays for a long time, while a long *bridge* evaluates
 * nothing for its whole length — no Parameter, no Any State, no exit time. A
 * duration that was mismeasured or hostile would otherwise freeze the World,
 * and survive a restart because it lives in the manifest.
 *
 * Here rather than in the runtime because the reports use it too: an atomic
 * State run is refused nothing, but a run longer than this freezes the World
 * the way a bridge would and the author is told so.
 */
export const MAX_BRIDGE_MS = 30_000;

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
  /**
   * The bounds an Int or Float is held within.
   *
   * Optional, and absent on every Parameter written before Effects existed, which
   * is what makes an old World behave exactly as it did. When present, the clamp
   * applies to *every* write — an Effect, an agent over the protocol, the panel,
   * and the seeding of this very default when the World starts — so the range is
   * a property of the value rather than a rule each writer remembers.
   *
   * A bound that is not a finite number, or a min above its max, is treated as no
   * range at all and reported. A World arrives from another machine with a
   * manifest nobody validated, and a min above a max would otherwise pin the
   * Parameter to one value with nothing saying why.
   */
  min?: number;
  max?: number;
}

/**
 * What an Effect does to a Parameter.
 *
 * A closed union with one registration point — `shared/src/effects.ts` — so
 * validation, the panel's offer rule, the reports and the runtime all learn a new
 * operation from the same edit. Deliberately not an expression language:
 * `shared/src/templates.ts` is this repo's one language and its design note is
 * about not growing expressions, and a second evaluator would be a second sandbox
 * to be wrong about.
 */
export type EffectOp = "set" | "add" | "multiply" | "random" | "copy" | "toggle" | "bounce";

export const EFFECT_OPS: readonly EffectOp[] = [
  "set",
  "add",
  "multiply",
  "random",
  "copy",
  "toggle",
  "bounce",
];

/**
 * One thing a World does to one of its own Parameters, on a repeat.
 *
 * The machine already advances on its own clock — an exit time and a clip end
 * both fire from the server's timer. What an Effect adds is a *Parameter* that
 * changes with time, so conditions, reports and other regions of the graph can
 * respond to something having happened rather than to something outside setting a
 * value.
 *
 * An Effect fires on its interval and never on arrival: entering a State starts
 * the clock and the first write lands one interval later. That is what keeps an
 * arrival from writing, evaluating and moving again, which is the cascade this
 * subsystem has no appetite for.
 */
export interface Effect {
  /** The Parameter written. A Trigger is never a legal target. */
  parameter: string;
  op: EffectOp;
  /**
   * What the operation needs: a number for `add`, a Parameter name for `copy`,
   * nothing for `toggle`, `random` and `bounce`.
   */
  operand?: ParameterValue | string;
  intervalMs: number;
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
 * One member of a clip set: a run of clips played in order.
 *
 * A sequence is what the draw picks and what "never the one that just played"
 * now avoids. A sequence of one is exactly the single clip a version 3 set held,
 * which is what lets a migrated World behave identically.
 *
 * A wrapper rather than a bare `ClipRef[]` so a property of the run — a name, a
 * weight, an atomicity of its own — can be added later without a second version
 * bump. It carries no id: two sequences holding the same clips in the same order
 * are the same run, and the draw's avoid-repeat memory keys on exactly that.
 */
export interface ClipSequence {
  clips: ClipRef[];
}

/** The clips a set holds, in order, across all of its sequences. */
export function setMembers(sequences: readonly ClipSequence[] | undefined): ClipRef[] {
  const out: ClipRef[] = [];
  for (const sequence of sequences ?? []) {
    if (!Array.isArray(sequence?.clips)) continue;
    for (const clip of sequence.clips) if (clip) out.push(clip);
  }
  return out;
}

/**
 * What the draw's avoid-repeat memory compares.
 *
 * Derived from the members rather than stored, so it survives a set being
 * rewritten by an edit that did not change this run.
 *
 * Serialised rather than joined on a separator. A path can contain very nearly
 * anything, so any separator character makes the run ["a b"] and the run
 * ["a", "b"] the same key — and the draw would then refuse to play one because
 * the other just did. The obvious separator that a path cannot hold is a NUL,
 * and a raw control byte in a source file makes it binary to grep, which
 * silently breaks every search of this file.
 */
export function sequenceKey(sequence: ClipSequence | null | undefined): string {
  if (!sequence || !Array.isArray(sequence.clips)) return "";
  return JSON.stringify(sequence.clips.map((clip) => clip?.path ?? ""));
}

/** A set holding one clip per sequence — what a version 3 set becomes. */
export function sequencesOf(clips: readonly ClipRef[]): ClipSequence[] {
  return clips.map((clip) => ({ clips: [clip] }));
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
  /**
   * The sequences this State can loop, in the order the author put them.
   *
   * One is drawn each time the run comes round, so a State reads as alive
   * rather than as one gesture repeating. An empty set is legal and means the
   * State holds silently — the same thing `clip: null` meant at version 2.
   */
  clips: ClipSequence[];
  /**
   * Whether a drawn run plays whole.
   *
   * Absent or false is what every set did before sequences existed: a
   * transition without Has Exit Time cuts the current clip, and an exit time is
   * a fraction of the clip playing now. True means the machine evaluates
   * nothing at all until the run ends — no wake point, no Parameter, not Any
   * State — which is the bridge's rule applied to a State that asked for it.
   *
   * Optional, and default-false, because that is what makes every World written
   * before this field behave exactly as it did.
   */
  atomic?: boolean;
  /**
   * What this State does to Parameters while the machine is in it.
   *
   * Live only during a visit: entering from elsewhere starts their intervals, and
   * they stop the moment a transition is taken. A State re-drawing its own run at
   * the end of a pass is not an arrival, or a five-second Effect on a
   * three-second clip would never fire at all.
   */
  effects?: Effect[];
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
  /**
   * The sequences this transition can play as a bridge.
   *
   * Empty — the default, and what every transition written before version 3
   * has — means the transition is taken instantly, as it always was. One or
   * more means a run is drawn and played whole before the destination State
   * begins, so a move between States can be seen rather than cut to.
   *
   * There is no atomicity switch here. A crossing evaluates nothing while it is
   * live, which is the subsystem's load-bearing invariant; a multi-clip bridge
   * is a longer freeze, not a different kind of one.
   */
  clips: ClipSequence[];
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
  /**
   * What the World does to its own Parameters, wherever the machine is.
   *
   * The other scope, and not expressible as the first: a World Effect written as
   * a State Effect would have to be copied onto every State and would still stop
   * during a crossing. It runs from start to stop — except under a fault, where
   * the machine rests deliberately and a writer would re-enter the failing
   * transition on every interval.
   */
  effects?: Effect[];
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
/**
 * Which owner a clip that cannot be used belongs to.
 *
 * A set can hold several independently broken members, and a transition is a
 * new owner of clip paths — neither of which a single `stateId` could say.
 */
export interface IncompleteClip {
  /** The State or transition holding it. */
  ownerId: string;
  ownerKind: "state" | "transition";
  /** Which sequence of that owner's set it sits in, so the author can find it. */
  index: number;
  /**
   * Where in that sequence the clip sits.
   *
   * Separate from `index` rather than folded into it: a run of three broken in
   * the middle and three runs of one all broken are different situations, and a
   * single number could not tell the author which they have.
   */
  memberIndex: number;
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
/** A State or transition whose clips are all assigned and none of them playable. */
export interface UnusableOwner {
  id: string;
  kind: "state" | "transition";
}

export interface WorldReports {
  worldId: string;
  /** States holding no clip at all. */
  statesWithoutClip: string[];
  /**
   * Owners holding clips of which none can be played.
   *
   * Separate from `statesWithoutClip` because the two need different actions:
   * one is a State nobody has finished authoring, the other is one whose files
   * have moved.
   */
  allClipsUnusable: UnusableOwner[];
  /** States no path from the default State reaches. */
  unreachable: string[];
  deadEnds: DeadEnd[];
  sweptTypes: ParameterType[];
  /**
   * States whose atomic runs hold the World longer than a bridge is allowed to.
   *
   * A warning, never a refusal. An atomic run freezes evaluation exactly as a
   * bridge does, but a bridge is a move stuck part way while a run is the idle
   * the author chose — so the cost is stated and the choice is theirs.
   */
  longAtomicRuns: string[];
  /**
   * Effects that write a Parameter this World does not declare.
   *
   * The failure this catches is silence: an Effect naming a deleted Parameter
   * fires on its interval, finds nothing to write, and does nothing — for as long
   * as the author stares at a value that will not move.
   */
  danglingEffects: DanglingEffect[];
  /**
   * Parameters whose declared range this build cannot use.
   *
   * A min above its max, or a bound that is not a finite number. The range is
   * ignored, so the Parameter behaves as though it declared none — reported
   * because the author wrote bounds and is entitled to know they are not in force.
   */
  unusableRanges: string[];
}

/** One Effect whose target is not declared, and where it lives. */
export interface DanglingEffect {
  ownerId: string;
  ownerKind: "state" | "world";
  /** Where in that owner's list it sits, so the author can find it. */
  index: number;
  parameter: string;
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
  /**
   * The transition being crossed, when the machine is between States.
   *
   * Null while a State is holding. Naming the source State during a bridge
   * would have the graph highlight a node while different footage plays, and
   * naming the destination early would contradict the conditions being
   * evaluated on arrival.
   */
  transitionId?: string | null;
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

/** Which set a clip belongs to: a State's, or a transition's bridge. */
export interface ClipOwner {
  kind: "state" | "transition";
  id: string;
}

export type StatePatch = Partial<Pick<WorldState, "name" | "clips" | "atomic" | "effects" | "x" | "y">>;

/** What a client supplies to add a transition. */
export interface TransitionDraft {
  from?: string;
  fromAny?: boolean;
  to: string;
  conditions?: Condition[];
  hasExitTime?: boolean;
  exitTime?: number;
}

export type TransitionPatch = Partial<
  Pick<Transition, "clips" | "conditions" | "hasExitTime" | "exitTime" | "muted" | "solo">
>;

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
  /** Set when the folder held more than one listing shows. */
  truncated?: boolean;
  folder: string;
  parent: string | null;
  folders: LibraryFolder[];
  clips: LibraryClip[];
  /** Set when the folder could not be read, in place of throwing. */
  error?: string;
}
