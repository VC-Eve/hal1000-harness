// What is derivable about a machine, and what is wrong with it.
//
// Pure functions over the manifest, deliberately outside the UI. The server
// answers "what is wrong with this World" over the protocol from here, and the
// graph draws from the same result — one derivation, two callers. It is also
// the only way any of this is testable: the component suite runs under jsdom,
// which implements no SVG layout, so anything computed inside a component could
// not be asserted.

import { AUDIO_PLAYING, AUDIO_TRACK, AUDIO_TRACKS, isReservedName, readoutFor } from "./audio.js";
import { cleanSlot, slotsOf } from "./overlays.js";
import type { OverlaySlot } from "./overlays.js";
import type {
  AudioConditionNote,
  ClipSequence,
  Condition,
  ConditionOwner,
  DanglingCondition,
  DanglingEffect,
  DanglingSlotState,
  Effect,
  IncompleteClip,
  UnusableOwner,
  DeadEnd,
  Parameter,
  ParameterType,
  ParameterValue,
  PlaylistIndexNote,
  Transition,
  World,
  WorldReports,
} from "./worlds.js";
import { MAX_BRIDGE_MS, effectiveBlend, opsFor, runDuration, sequenceKey, setMembers } from "./worlds.js";

/** The value a Parameter starts at, coerced to something its type can hold. */
export function defaultValueOf(parameter: Parameter): ParameterValue {
  if (parameter.type === "bool" || parameter.type === "trigger") {
    return parameter.defaultValue === true;
  }
  const n = Number(parameter.defaultValue);
  if (!Number.isFinite(n)) return 0;
  return parameter.type === "int" ? Math.trunc(n) : n;
}

/** Whether a value is one this Parameter's type can hold. */
export function valueFits(type: ParameterType, value: unknown): value is ParameterValue {
  if (type === "bool" || type === "trigger") return typeof value === "boolean";
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  return type === "float" || Number.isInteger(value);
}

/**
 * A Parameter's bounds, or null when it declares none this build can use.
 *
 * Asked once, here, so no caller repeats the question and none of them answers it
 * differently. Three things are all "no range": neither bound declared, a bound
 * that is not a finite number, and a min above its max.
 *
 * The last is the one that matters. A World arrives from another machine with a
 * manifest nobody validated, and `min: 2, max: 0` would clamp every write to a
 * single value — a Parameter frozen with nothing saying why. Degrading to no range
 * and reporting it is the behaviour an author can act on.
 *
 * Written as positive tests. A guard phrased as a comparison against a bound would
 * pass NaN straight through, which is the failure
 * docs/solutions/a-threshold-guard-written-as-a-negation-fails-open-on-nan.md
 * records.
 */
export function usableRange(parameter: Parameter | undefined): { min: number; max: number } | null {
  if (!parameter) return null;
  if (parameter.type !== "int" && parameter.type !== "float") return null;
  const { min, max } = parameter;
  if (typeof min !== "number" || !Number.isFinite(min)) return null;
  if (typeof max !== "number" || !Number.isFinite(max)) return null;
  if (!(min <= max)) return null;
  return { min, max };
}

/**
 * Hold a value inside a Parameter's range.
 *
 * Returns the value unchanged when the Parameter declares no usable range, which
 * is every Parameter written before Effects existed.
 */
export function clampToRange(parameter: Parameter | undefined, value: ParameterValue): ParameterValue {
  const range = usableRange(parameter);
  if (!range || typeof value !== "number") return value;
  const held = Math.min(Math.max(value, range.min), range.max);
  // An Int stays an Int: a range of 0..2.5 must not turn 3 into 2.5.
  return parameter?.type === "int" ? Math.trunc(held) : held;
}

/**
 * Whether one clause holds.
 *
 * Acceptance-shaped throughout: a value that is missing, or of the wrong shape,
 * fails the clause rather than passing it. A guard phrased as a negation fails
 * open on the input nobody considered — see
 * docs/solutions/a-threshold-guard-written-as-a-negation-fails-open-on-nan.md.
 */
export function clauseHolds(condition: Condition, values: Record<string, ParameterValue>): boolean {
  const actual = values[condition.parameter];
  if (actual === undefined) return false;
  switch (condition.op) {
    case "is":
      return actual === (condition.value === true);
    case "isNot":
      return actual !== (condition.value === true);
    case "gt":
      return typeof actual === "number" && typeof condition.value === "number" && actual > condition.value;
    case "lt":
      return typeof actual === "number" && typeof condition.value === "number" && actual < condition.value;
    case "eq":
      return actual === condition.value;
    case "neq":
      return actual !== condition.value;
    default:
      return false;
  }
}

/**
 * Whether every clause in a list holds. Absent and empty are both unconditional.
 *
 * The rule lives here rather than at each owner, because "no conditions means
 * always" is one decision and two holders of clauses would otherwise each get
 * their own slightly different version of it.
 */
export function clausesHold(
  conditions: readonly Condition[] | undefined,
  values: Record<string, ParameterValue>,
): boolean {
  for (const clause of conditions ?? []) {
    if (!clauseHolds(clause, values)) return false;
  }
  return true;
}

/** Whether every clause of a transition holds. An empty list is unconditional. */
export function conditionsHold(transition: Transition, values: Record<string, ParameterValue>): boolean {
  return clausesHold(transition.conditions, values);
}

/**
 * The values a clause is evaluated against, composed the one way.
 *
 * A declared Parameter wins over a reserved readout of the same name. In a World
 * that came through the store this cannot happen — `write` refuses a reserved
 * name and the store drops a reserved declaration — so this is belt and braces
 * for a World built in memory. It is stated anyway because the machine and every
 * browser drawing a conditioned slot both compose these two maps, and one rule
 * written once is cheaper than two sides guessing the same way by accident.
 */
export function conditionValues(
  readouts: Record<string, ParameterValue>,
  parameters: Record<string, ParameterValue>,
): Record<string, ParameterValue> {
  return { ...readouts, ...parameters };
}

/**
 * Whether an overlay slot is drawn right now, and if not, which half said no.
 *
 * The two halves a transition has, asked in the order a transition asks them:
 * where the machine is, then whether the clauses hold. Naming no States means
 * every State — `fromAny` by another name — and carrying no clauses means
 * always, so a slot that says neither is drawn exactly as it was before any of
 * this existed.
 *
 * Here rather than in `overlays.ts` because it needs `clausesHold`, and
 * `world-graph.ts` already imports the overlay guards — the other direction
 * would make a cycle out of a question this file exists to answer.
 *
 * The *reason* is part of the answer, not a debugging aid. A slot that is not
 * drawn looks identical to one that is unfilled, one the guard refused, and one
 * on a client that has not been told where the machine is; the editor can only
 * tell the operator which of those it is if this says so.
 */
export function slotDrawn(
  slot: OverlaySlot,
  stateId: string | null,
  values: Record<string, ParameterValue>,
): { drawn: true } | { drawn: false; because: "state" | "clause" } {
  const states = slot.states;
  if (states !== undefined && states.length > 0) {
    // A client with no `stateId` holds no opinion about where the machine is,
    // and absent fails — the direction `clauseHolds` already takes.
    if (stateId === null || !states.includes(stateId)) return { drawn: false, because: "state" };
  }
  if (!clausesHold(slot.conditions, values)) return { drawn: false, because: "clause" };
  return { drawn: true };
}

/** The transitions leaving a State: its own, plus every Any State transition. */
export function transitionsFrom(world: World, stateId: string | null): Transition[] {
  const all = world.transitions ?? [];
  // Any State first, and that ordering is the rule rather than an accident:
  // a transition offered from everywhere outranks one offered from here.
  const any = all.filter((t) => t.fromAny).sort(byOrder);
  const own = stateId ? all.filter((t) => !t.fromAny && t.from === stateId).sort(byOrder) : [];
  return [...any, ...own];
}

function byOrder(a: Transition, b: Transition): number {
  return (a.order ?? 0) - (b.order ?? 0);
}

/**
 * The transitions actually eligible to be considered, honouring mute and solo.
 *
 * Solo is scoped to one source: soloing a transition out of a State silences
 * that State's other transitions, not the whole machine. Any State is its own
 * source for this purpose, so soloing there does not silence a State's own.
 */
/**
 * `liveTransitions` for every State at once.
 *
 * Same answer, grouped in one pass. Asking per State re-filters and re-sorts the
 * whole transition array each time, which is fine for the runtime — it asks
 * about one State — and quadratic for a report that asks about all of them.
 */
export function liveTransitionsByState(world: World): Map<string, Transition[]> {
  const all = world.transitions ?? [];
  const any = all.filter((t) => t.fromAny).sort(byOrder);
  const own = new Map<string, Transition[]>();
  for (const t of all) {
    if (t.fromAny || !t.from) continue;
    const list = own.get(t.from);
    if (list) list.push(t);
    else own.set(t.from, [t]);
  }
  for (const list of own.values()) list.sort(byOrder);

  const out = new Map<string, Transition[]>();
  for (const state of world.states ?? []) {
    out.set(state.id, live([...any, ...(own.get(state.id) ?? [])]));
  }
  return out;
}

/** The mute and solo rule, over transitions already gathered for one source. */
function live(offered: Transition[]): Transition[] {
  const kept = offered.filter((t) => t.muted !== true);
  const anySoloed = kept.some((t) => t.fromAny && t.solo);
  const ownSoloed = kept.some((t) => !t.fromAny && t.solo);
  return kept.filter((t) => {
    if (t.fromAny) return anySoloed ? t.solo === true : true;
    return ownSoloed ? t.solo === true : true;
  });
}

export function liveTransitions(world: World, stateId: string | null): Transition[] {
  const offered = transitionsFrom(world, stateId).filter((t) => t.muted !== true);
  const anySoloed = offered.some((t) => t.fromAny && t.solo);
  const ownSoloed = offered.some((t) => !t.fromAny && t.solo);
  return offered.filter((t) => {
    if (t.fromAny) return anySoloed ? t.solo === true : true;
    return ownSoloed ? t.solo === true : true;
  });
}

/**
 * Which Parameter types have a value space small enough to sweep.
 *
 * Bool and Trigger have two values each. Int and Float have no enumerable
 * space, so a dead-end report cannot claim anything about them — and saying so
 * is the difference between a report and a guess.
 */
export const SWEPT_TYPES: readonly ParameterType[] = ["bool", "trigger"];

/**
 * How many assignments the sweep will enumerate before giving up.
 *
 * The cross-product multiplies: fourteen Bools is already sixteen thousand
 * assignments walked per State, computed on every mutation and every greeting.
 * The bound exists so a hand-edited manifest cannot stall the server, and the
 * report says nothing rather than something wrong when it bites.
 */
export const MAX_VALUE_SPACE = 4096;

function valueSpace(world: World): Record<string, ParameterValue>[] {
  let space: Record<string, ParameterValue>[] = [{}];
  for (const parameter of world.parameters ?? []) {
    if (!SWEPT_TYPES.includes(parameter.type)) continue;
    if (space.length * 2 > MAX_VALUE_SPACE) return [];
    space = space.flatMap((assignment) => [
      { ...assignment, [parameter.name]: false },
      { ...assignment, [parameter.name]: true },
    ]);
  }
  return space;
}

/**
 * Whether a clause could hold for *some* value, given what the sweep covers.
 *
 * A clause over a swept Parameter is decided by the assignment. A clause over
 * an Int or Float is treated as satisfiable, because nothing here can prove it
 * is not.
 */
function clauseSatisfiable(
  condition: Condition,
  values: Record<string, ParameterValue>,
  swept: Set<string>,
): boolean {
  if (!swept.has(condition.parameter)) return true;
  return clauseHolds(condition, values);
}

/**
 * States with no satisfiable way out for some allowed Parameter value.
 *
 * The honest reading is exactly that: no way out *for these enumerated values*.
 * It is not a claim that the machine is otherwise fine, and a World declaring
 * only numeric Parameters enumerates nothing.
 */
/**
 * The most clause evaluations one report is worth.
 *
 * `MAX_VALUE_SPACE` bounds the assignments; states and transitions are
 * unbounded, and the product is what actually gets walked — on every mutation
 * and every greeting. Past this the report says nothing rather than spending
 * the event loop that is also serving the clip route.
 */
const MAX_SWEEP_STEPS = 200_000;

export function deadEnds(world: World): DeadEnd[] {
  const space = valueSpace(world);
  if (space.length === 0) return [];
  const size = (world.states ?? []).length * space.length * (world.transitions ?? []).length;
  if (size > MAX_SWEEP_STEPS) return [];
  const swept = new Set(
    (world.parameters ?? []).filter((p) => SWEPT_TYPES.includes(p.type)).map((p) => p.name),
  );
  if (swept.size === 0) return [];

  const out: DeadEnd[] = [];
  const reported = new Set<string>();

  for (const state of world.states ?? []) {
    const outbound = liveTransitions(world, state.id);
    for (const assignment of space) {
      const anyOut = outbound.some((t) =>
        (t.conditions ?? []).every((c) => clauseSatisfiable(c, assignment, swept)),
      );
      if (anyOut) continue;
      // Reported one Parameter at a time so the graph can say "no way out while
      // ready is false" rather than naming a tuple. That is a weaker claim than
      // the tuple it came from, and is phrased as a condition rather than a
      // cause.
      for (const [parameter, value] of Object.entries(assignment)) {
        const key = `${state.id} ${parameter} ${String(value)}`;
        if (reported.has(key)) continue;
        reported.add(key);
        out.push({ stateId: state.id, parameter, value });
      }
    }
  }
  return out;
}

/**
 * States no path from the default State reaches.
 *
 * A transition is an edge whether or not its conditions can hold — this asks
 * whether the author drew a way in at all, not whether a value could satisfy
 * it. An Any State transition makes its destination reachable from everywhere,
 * so it counts.
 *
 * Mute and solo *are* honoured, because both are ways of saying "not this one,
 * for now" and the machine will not offer what they silence. That makes the
 * report answer the question the author is actually asking while they solo
 * something — what can I still get to from here — and keeps it agreeing with
 * `deadEnds` and with the runtime, which read the same `liveTransitions`.
 */
export function unreachable(world: World): string[] {
  const states = world.states ?? [];
  const start = world.defaultStateId;
  if (!start || !states.some((s) => s.id === start)) {
    // With no default there is nowhere to walk from, so every State is
    // unreachable — which is true, and is what the author needs told.
    return states.map((s) => s.id);
  }

  // Through `liveTransitions`, so mute *and* solo are honoured. Reading `muted`
  // alone made this report disagree with what the machine offers and with what
  // `deadEnds` sweeps — soloing one transition hides its siblings from the
  // runtime but left them counted as ways through here.
  const live = liveTransitionsByState(world);
  const byFrom = new Map<string, string[]>();
  for (const state of states) {
    byFrom.set(state.id, (live.get(state.id) ?? []).map((t) => t.to));
  }

  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const at = queue.shift()!;
    for (const next of byFrom.get(at) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return states.filter((s) => !seen.has(s.id)).map((s) => s.id);
}

/** States holding no clip. A State can hold silently, but the author should know. */
export function statesWithoutClip(world: World): string[] {
  // An empty set, which is what `clip: null` meant before a State could hold
  // more than one. A State whose clips are all *broken* is a different report —
  // see `allClipsUnusable` — because it needs a different fix.
  return (world.states ?? [])
    .filter((s) => !Array.isArray(s?.clips) || s.clips.length === 0)
    .map((s) => s.id);
}

/** Every derivation the graph renders, in one pass. */
export function worldReports(
  world: World,
  incomplete: readonly IncompleteClip[] = [],
  // Null rather than `[]`, because the two say different things: an empty store
  // is evidence a reference is dangling and "nobody asked" is not, and a default
  // of `[]` would have every caller that has no audio store report every World's
  // playlist as missing.
  playlists: readonly string[] | null = null,
): WorldReports {
  return {
    worldId: world.id,
    statesWithoutClip: statesWithoutClip(world),
    allClipsUnusable: allClipsUnusable(world, incomplete),
    unreachable: unreachable(world),
    deadEnds: deadEnds(world),
    sweptTypes: [...SWEPT_TYPES],
    longAtomicRuns: longAtomicRuns(world),
    longBridges: longBridges(world),
    shortForBlend: shortForBlend(world),
    danglingEffects: danglingEffects(world),
    danglingConditions: danglingConditions(world),
    danglingSlotStates: danglingSlotStates(world),
    unusableRanges: unusableRanges(world),
    reservedDeclarations: reservedDeclarations(world),
    audioWithoutPlaying: audioWithoutPlaying(world),
    audioEquality: audioEquality(world),
    mismatchedOperators: mismatchedOperators(world),
    missingPlaylist: missingPlaylist(world, playlists),
  };
}

/**
 * The playlist this World names that the store does not hold (R15).
 *
 * The ordinary case for a World folder copied from another machine, so it is
 * reported and never repaired: the reference stays in the manifest, the World
 * runs silently, and importing the playlist under that id makes it true again.
 */
export function missingPlaylist(world: World, playlists: readonly string[] | null): string | null {
  if (playlists === null) return null;
  const id = world.playlistId;
  if (typeof id !== "string" || id.length === 0) return null;
  return playlists.includes(id) ? null : id;
}

/**
 * Reserved names the manifest declared, which the store dropped on load.
 *
 * Read from the manifest the loader produced, so this is empty for every World
 * the store rebuilt — which is the point. It is populated by the store handing
 * the dropped names forward, not by finding them still in `parameters`.
 */
export function reservedDeclarations(world: World): string[] {
  return (world.droppedReserved ?? [])
    .map((parameter) => parameter?.name)
    .filter((name): name is string => typeof name === "string");
}

/**
 * Every clause in the World, with the holder it belongs to.
 *
 * The one walk. A World has two holders of clauses now — transitions and overlay
 * slots — and five reports read them; adding "...and also the slots" to each of
 * the five is how a report comes to cover one holder and not the other, which is
 * the shape docs/solutions/a-completeness-guard-is-only-as-honest-as-its-exemptions.md
 * is about. A sixth report reads this or it reads nothing.
 *
 * Slots come from `slotsOf`, not from `world.overlays`: the two differ for a
 * World that stores none, and only the first gives the positions the editor's
 * own labels use. A slot the strict guard refuses contributes nothing — it is
 * reported as broken where it is edited, not as five condition faults here.
 */
export function conditionSources(world: World): { owner: ConditionOwner; condition: Condition }[] {
  const out: { owner: ConditionOwner; condition: Condition }[] = [];
  for (const transition of world.transitions ?? []) {
    if (typeof transition?.id !== "string") continue;
    for (const condition of transition.conditions ?? []) {
      if (condition && typeof condition.parameter === "string") {
        out.push({ owner: { kind: "transition", id: transition.id }, condition });
      }
    }
  }
  for (const [index, stored] of slotsOf(world).entries()) {
    const slot = cleanSlot(stored);
    if (slot === null) continue;
    for (const condition of slot.conditions ?? []) {
      out.push({ owner: { kind: "slot", index }, condition });
    }
  }
  return out;
}

const clauses = conditionSources;

/**
 * Numeric audio conditions with no `audio.playing` clause beside them.
 *
 * Per transition rather than per clause for the playing test: clauses conjoin, so
 * one `audio.playing is true` anywhere in the transition protects every other
 * clause in it.
 */
export function audioWithoutPlaying(world: World): AudioConditionNote[] {
  const out: AudioConditionNote[] = [];
  // Grouped by holder rather than read clause by clause: one `audio.playing`
  // anywhere in a conjunction protects the rest of it, and a slot's clause list
  // is a conjunction in exactly the same way a transition's is.
  const byOwner = new Map<string, { owner: ConditionOwner; conditions: Condition[] }>();
  for (const { owner, condition } of conditionSources(world)) {
    const key = owner.kind === "transition" ? `t:${owner.id}` : `s:${owner.index}`;
    const held = byOwner.get(key) ?? { owner, conditions: [] };
    held.conditions.push(condition);
    byOwner.set(key, held);
  }
  for (const { owner, conditions } of byOwner.values()) {
    if (conditions.some((c) => c.parameter === AUDIO_PLAYING)) continue;
    for (const condition of conditions) {
      // `audio.playing` itself is a bool and cannot be the unguarded numeric this
      // reports; an owner testing only it is already saying what it means.
      if (!isReservedName(condition.parameter)) continue;
      if (readoutFor(condition.parameter)?.type === "bool") continue;
      out.push({ owner, parameter: condition.parameter });
    }
  }
  return out;
}

/**
 * Clauses naming a Parameter nothing declares and no readout provides.
 *
 * `danglingEffects`' shape and its reason: reported, never repaired. Reserved
 * names are skipped — a readout exists whether or not the World mentions it.
 *
 * On a transition this is a move that never fires, which the graph's own marks
 * already hint at. On an overlay slot it is a caption that never appears, and
 * the picture says nothing at all about why, which is why the report covers both
 * holders rather than only the new one.
 */
export function danglingConditions(world: World): DanglingCondition[] {
  const declared = new Set((world.parameters ?? []).map((p) => p?.name));
  return conditionSources(world)
    .filter(({ condition }) => !declared.has(condition.parameter))
    .filter(({ condition }) => !isReservedName(condition.parameter))
    .map(({ owner, condition }) => ({ owner, parameter: condition.parameter }));
}

/**
 * Overlay slots naming a State the World does not hold.
 *
 * Slots only. A transition names States too, but a transition out of a State
 * that is gone is already `unreachable` and `deadEnds`; a slot scoped to one has
 * no equivalent, and draws nowhere with nothing saying so.
 */
export function danglingSlotStates(world: World): DanglingSlotState[] {
  const held = new Set((world.states ?? []).map((s) => s?.id));
  const out: DanglingSlotState[] = [];
  for (const [index, stored] of slotsOf(world).entries()) {
    const slot = cleanSlot(stored);
    if (slot === null) continue;
    for (const stateId of slot.states ?? []) {
      if (!held.has(stateId)) out.push({ index, stateId });
    }
  }
  return out;
}

/**
 * Audio conditions written as an equality.
 *
 * `eq` and `neq` both, because both name a single value of a readout that moves
 * a step at a time — `neq` is the one that is *false* for exactly one second, and
 * a transition that must not fire during that second is the same fragility
 * inverted.
 */
/**
 * Conditions whose operator its Parameter's type does not offer.
 *
 * Not a warning — a clause of this shape does not compare anything. `is` and
 * `isNot` are the *boolean* operators, and `clauseHolds` reads them as
 * `actual === (value === true)`: against a number, the right-hand side collapses
 * to `false`, so `remaining is 90` asks whether a number equals `false` and can
 * never hold, while `remaining isNot 90` asks whether it differs from `false`
 * and always holds. Either way the number in the clause is never looked at.
 *
 * Asked of every Parameter, declared and reserved alike, through the same
 * `opsFor` the picker offers from — so the report cannot disagree with the
 * editor about what is legal. Reserved readouts are how these reach a manifest
 * today (the picker briefly resolved an undeclared name's type as `bool` and
 * offered the boolean operators for an int), but a hand edit or an older build
 * can put one on a declared Parameter just as easily, and the failure reads the
 * same from the outside: a transition that never fires, or one that always does.
 */
export function mismatchedOperators(world: World): AudioConditionNote[] {
  const declared = new Map((world.parameters ?? []).map((p) => [p?.name, p?.type]));
  const out: AudioConditionNote[] = [];
  for (const { owner, condition } of clauses(world)) {
    const type = declared.get(condition.parameter) ?? readoutFor(condition.parameter)?.type;
    // A name nothing declares and no readout provides is a dangling condition,
    // which `clauseHolds` already fails closed on. Not this report's business.
    if (!type) continue;
    if (!opsFor(type).includes(condition.op)) {
      out.push({ owner, parameter: condition.parameter });
    }
  }
  return out;
}

export function audioEquality(world: World): AudioConditionNote[] {
  return clauses(world)
    .filter(({ condition }) => isReservedName(condition.parameter))
    .filter(({ condition }) => condition.op === "eq" || condition.op === "neq")
    .map(({ owner, condition }) => ({ owner, parameter: condition.parameter }));
}

/**
 * The two readouts that name a playlist's shape rather than a track's contents.
 *
 * `audio.track` is one-based — the transport publishes `index + 1` — so a
 * playlist of `n` tracks reaches 1 through n and nothing else while it plays.
 * `audio.tracks` is `n` itself.
 */
const INDEX_READOUTS = new Set<string>([AUDIO_TRACK, AUDIO_TRACKS]);

/**
 * Conditions on a playlist position that no length of playlist could satisfy
 * once it holds `trackCount` tracks (origin R16, R17).
 *
 * Answered by *evaluation* rather than by arithmetic on the operator: every
 * value the playlist can produce is enumerated and handed to `clauseHolds`, the
 * same function the runtime evaluates with. Reimplementing "is `gt 8`
 * satisfiable below 9" per operator is how a report comes to disagree with the
 * machine it reports on, and the machine is the one that decides.
 *
 * The enumeration is cheap and bounded — a playlist is capped well below a
 * thousand tracks — and it is exhaustive, which the arithmetic would not be for
 * an operator added later.
 *
 * Silent about a World naming a different playlist: the caller filters, because
 * only the caller knows which playlist was edited.
 */
export function unreachableIndexConditions(world: World, trackCount: number): PlaylistIndexNote[] {
  const count = Number.isFinite(trackCount) && trackCount > 0 ? Math.floor(trackCount) : 0;
  return indexConditions(world).filter(({ parameter, op, value }) => {
    const condition: Condition = { parameter, op, value };
    if (parameter === AUDIO_TRACKS) return !clauseHolds(condition, { [AUDIO_TRACKS]: count });
    // Position one through n. Zero — the empty transport — is deliberately not
    // in the set: a condition satisfied only while nothing is playing is not a
    // position this playlist reaches, and reporting it as reachable would hide
    // exactly the removal that stranded it.
    for (let track = 1; track <= count; track += 1) {
      if (clauseHolds(condition, { [AUDIO_TRACK]: track })) return false;
    }
    return true;
  });
}

/**
 * Every condition that names a playlist position at all.
 *
 * What a *reorder* invalidates, where a removal invalidates a subset: nothing
 * becomes unsatisfiable when tracks change places, but every one of these now
 * points at a different track than the author wrote it against. R17 asks for
 * both edits to be answered, and pretending a reorder breaks nothing would be
 * the more dangerous of the two answers.
 */
export function indexConditions(world: World): PlaylistIndexNote[] {
  return clauses(world)
    .filter(({ condition }) => INDEX_READOUTS.has(condition.parameter))
    .map(({ owner, condition }) => ({
      owner,
      parameter: condition.parameter,
      op: condition.op,
      value: condition.value,
    }));
}

/**
 * Effects whose target Parameter is not declared.
 *
 * Reported rather than repaired. An Effect naming a Parameter the author deleted
 * is still the shape of something they meant, and deleting it to make the World
 * tidy is the loss the store's rebuild exists to avoid — the same reason a clip
 * path that will not resolve is reported and left in the manifest.
 */
export function danglingEffects(world: World): DanglingEffect[] {
  const declared = new Set((world.parameters ?? []).map((p) => p?.name));
  const out: DanglingEffect[] = [];
  const scan = (ownerId: string, ownerKind: "state" | "world", effects: readonly Effect[] | undefined) => {
    for (const [index, effect] of (effects ?? []).entries()) {
      if (!effect || typeof effect.parameter !== "string") continue;
      // A reserved readout is not a dangling target. It exists and it is simply
      // not writable — reporting it as dangling would send the author looking for
      // a Parameter they never deleted. The panel refusing to offer it, and the
      // runtime refusing to write it, are what say no here.
      if (isReservedName(effect.parameter)) continue;
      if (!declared.has(effect.parameter)) {
        out.push({ ownerId, ownerKind, index, parameter: effect.parameter });
      }
    }
  };
  scan(world.id, "world", world.effects);
  for (const state of world.states ?? []) {
    if (typeof state?.id === "string") scan(state.id, "state", state.effects);
  }
  return out;
}

/**
 * Parameters that declare bounds this build will not honour.
 *
 * A Parameter with no bounds at all is not here — that is the ordinary case, not
 * a problem. This names the ones where the author wrote a range and it is not in
 * force, which is otherwise invisible: the value simply never clamps.
 */
export function unusableRanges(world: World): string[] {
  return (world.parameters ?? [])
    .filter((parameter) => {
      if (!parameter || (parameter.type !== "int" && parameter.type !== "float")) return false;
      const declared = parameter.min !== undefined || parameter.max !== undefined;
      return declared && usableRange(parameter) === null;
    })
    .map((parameter) => parameter.name);
}

/** Whether any run in a set will be waited on for longer than the ceiling. */
function holdsTooLong(clips: ClipSequence[] | undefined): boolean {
  if (!Array.isArray(clips)) return false;
  return clips.some((sequence) => runDuration(sequence) > MAX_BRIDGE_MS);
}

/**
 * States whose longest atomic run outlasts the bridge ceiling.
 *
 * Only atomic sets: an interruptible run of the same length is evaluated at
 * every clip boundary and holds nothing. Transitions are reported separately by
 * `longBridges`, which has no atomicity to check.
 *
 * The length comes from `runDuration` rather than from summing the stored
 * numbers, so a member nobody has played yet counts as what the machine will
 * actually wait on. Reading the manifest directly made an unmeasured clip free,
 * and a run of them totalled nothing however long it really was.
 */
export function longAtomicRuns(world: World): string[] {
  return (world.states ?? [])
    .filter((state) => state?.atomic === true && holdsTooLong(state.clips))
    .map((state) => state.id);
}

/**
 * Clips a World's blend length would clamp, by path.
 *
 * Reported per clip rather than per State or transition, because the fix is to
 * the footage or to the number — not to whatever happens to hold it. Measured
 * through `effectiveDuration`, so a clip nobody has played yet is judged on
 * what the machine will really wait on rather than counted as zero and reported
 * for a blend it can actually carry.
 *
 * Silent when the World asks for no blend: nothing is clamped, so there is
 * nothing to say.
 */
export function shortForBlend(world: World): string[] {
  const blendMs = world.blendMs;
  if (typeof blendMs !== "number" || !Number.isFinite(blendMs) || blendMs <= 0) return [];
  const seen = new Set<string>();
  const owners = [...(world.states ?? []), ...(world.transitions ?? [])];
  for (const owner of owners) {
    for (const clip of setMembers(owner?.clips)) {
      if (effectiveBlend(blendMs, clip) < blendMs) seen.add(clip.path);
    }
  }
  return [...seen];
}

/**
 * Transitions whose bridge holds the World longer than a crossing is meant to.
 *
 * No atomicity to check: a crossing evaluates nothing for its whole length,
 * always. The ceiling used to clamp a crossing, so this could not have anything
 * to say; clamping cut the author's last clip in half instead, and the cost of
 * a long bridge is now reported rather than silently taken out of the video.
 *
 * Reported per transition rather than per run. Any of a set's runs may be
 * drawn, so what the author needs to know is that this crossing can hold the
 * World — not which draw does it.
 */
export function longBridges(world: World): string[] {
  return (world.transitions ?? [])
    .filter((transition) => holdsTooLong(transition?.clips))
    .map((transition) => transition.id);
}

/**
 * Choose which sequence of a set plays next.
 *
 * Uniform among the runs that can actually play, minus the one that just
 * played — because a set of ten idles that can repeat immediately still reads
 * as a loop. The exclusion yields when it would leave nothing: a one-member set
 * plays its member every time rather than deadlocking, and a set with one
 * usable run repeats it rather than stopping.
 *
 * A run rather than a clip is the unit, so "never the one that just played"
 * keeps meaning a whole gesture. Two runs holding the same clips in the same
 * order are the same run to this exclusion, which is what `sequenceKey` says.
 *
 * The random source is supplied. `shared/` is read by the server and the
 * browser and has no business reaching for one of its own, and a caller that
 * passes a known sequence can assert which run comes out rather than a
 * distribution.
 */
export function drawFrom(
  sequences: readonly ClipSequence[] | undefined,
  lastPlayed: string | null,
  options: { usable?: (sequence: ClipSequence) => boolean; random?: () => number } = {},
): ClipSequence | null {
  const usable = options.usable ?? (() => true);
  const random = options.random ?? Math.random;

  // A run with no members is not a silent run, it is nothing to play at all —
  // the store drops one on the way in, and a hand-edited manifest is why the
  // draw checks rather than trusts.
  const playable = (sequences ?? []).filter(
    (sequence) =>
      sequence &&
      Array.isArray(sequence.clips) &&
      sequence.clips.length > 0 &&
      sequence.clips.every((clip) => clip && typeof clip.path === "string") &&
      usable(sequence),
  );
  if (playable.length === 0) return null;

  const fresh = playable.filter((sequence) => sequenceKey(sequence) !== lastPlayed);
  const pool = fresh.length > 0 ? fresh : playable;
  const index = Math.min(Math.floor(random() * pool.length), pool.length - 1);
  return pool[index] ?? null;
}

/**
 * Owners that hold clips of which not one can be played.
 *
 * Distinct from "no clips" on purpose: "you have not chosen one yet" and "the
 * files you chose are gone" need different actions from the author, and a
 * single mark for both said neither.
 *
 * Derived from the list the store already produced by resolving every member,
 * rather than from a predicate of its own — this module is pure, and the
 * filesystem answer has been fetched once already.
 */
export function allClipsUnusable(world: World, incomplete: readonly IncompleteClip[]): UnusableOwner[] {
  // Keyed by kind as well as id. A World is untrusted input that travels
  // between machines, and a State and a transition that share an id would
  // otherwise have their broken members summed into one count.
  const key = (kind: string, id: string) => `${kind}:${id}`;
  // Which *runs* hold a broken member, not how many members are broken. A
  // sequence is excluded from the draw whole, so two breaks in one run of three
  // still leave the other runs playable — counting members said otherwise and
  // would mark a healthy set unusable.
  const brokenSequences = new Map<string, Set<number>>();
  for (const entry of incomplete ?? []) {
    const k = key(entry.ownerKind, entry.ownerId);
    const seen = brokenSequences.get(k) ?? new Set<number>();
    seen.add(entry.index);
    brokenSequences.set(k, seen);
  }

  const allBroken = (kind: string, id: string, clips: readonly ClipSequence[] | undefined): boolean =>
    Array.isArray(clips) && clips.length > 0 && (brokenSequences.get(key(kind, id))?.size ?? 0) >= clips.length;

  return [
    ...(world.states ?? [])
      .filter((s) => allBroken("state", s?.id, s?.clips))
      .map((s) => ({ id: s.id, kind: "state" as const })),
    ...(world.transitions ?? [])
      .filter((t) => allBroken("transition", t?.id, t?.clips))
      .map((t) => ({ id: t.id, kind: "transition" as const })),
  ];
}
