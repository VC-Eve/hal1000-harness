// What is derivable about a machine, and what is wrong with it.
//
// Pure functions over the manifest, deliberately outside the UI. The server
// answers "what is wrong with this World" over the protocol from here, and the
// graph draws from the same result — one derivation, two callers. It is also
// the only way any of this is testable: the component suite runs under jsdom,
// which implements no SVG layout, so anything computed inside a component could
// not be asserted.

import type {
  ClipRef,
  Condition,
  DeadEnd,
  Parameter,
  ParameterType,
  ParameterValue,
  Transition,
  World,
  WorldReports,
} from "./worlds.js";

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

/** Whether every clause of a transition holds. An empty list is unconditional. */
export function conditionsHold(transition: Transition, values: Record<string, ParameterValue>): boolean {
  for (const clause of transition.conditions ?? []) {
    if (!clauseHolds(clause, values)) return false;
  }
  return true;
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
export function worldReports(world: World): WorldReports {
  return {
    worldId: world.id,
    statesWithoutClip: statesWithoutClip(world),
    unreachable: unreachable(world),
    deadEnds: deadEnds(world),
    sweptTypes: [...SWEPT_TYPES],
  };
}

/**
 * Choose which clip of a set plays next.
 *
 * Uniform among the members that can actually play, minus the one that just
 * played — because a set of ten idles that can repeat immediately still reads
 * as a loop. The exclusion yields when it would leave nothing: a one-member set
 * plays its member every time rather than deadlocking, and a set with one
 * usable member repeats it rather than stopping.
 *
 * The random source is supplied. `shared/` is read by the server and the
 * browser and has no business reaching for one of its own, and a caller that
 * passes a known sequence can assert which member comes out rather than a
 * distribution.
 */
export function drawFrom(
  clips: readonly ClipRef[] | undefined,
  lastPlayed: string | null,
  options: { usable?: (clip: ClipRef) => boolean; random?: () => number } = {},
): ClipRef | null {
  const usable = options.usable ?? (() => true);
  const random = options.random ?? Math.random;

  const playable = (clips ?? []).filter((clip) => clip && typeof clip.path === "string" && usable(clip));
  if (playable.length === 0) return null;

  const fresh = playable.filter((clip) => clip.path !== lastPlayed);
  const pool = fresh.length > 0 ? fresh : playable;
  const index = Math.min(Math.floor(random() * pool.length), pool.length - 1);
  return pool[index] ?? null;
}

/**
 * Owners whose clips are all assigned but none of them usable.
 *
 * Distinct from "no clips" on purpose: "you have not chosen one yet" and "the
 * files you chose are gone" need different actions from the author, and one
 * mark for both said neither.
 */
export function allClipsUnusable(world: World, usable: (clip: ClipRef) => boolean): string[] {
  const broken = (clips: readonly ClipRef[] | undefined): boolean =>
    Array.isArray(clips) && clips.length > 0 && clips.every((clip) => !usable(clip));

  return [
    ...(world.states ?? []).filter((s) => broken(s?.clips)).map((s) => s.id),
    ...(world.transitions ?? []).filter((t) => broken(t?.clips)).map((t) => t.id),
  ];
}
