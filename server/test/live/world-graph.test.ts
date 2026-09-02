import { describe, it, expect } from "vitest";
import {
  clauseHolds,
  conditionsHold,
  deadEnds,
  defaultValueOf,
  liveTransitions,
  statesWithoutClip,
  transitionsFrom,
  unreachable,
  valueFits,
  worldReports,
} from "../../../shared/src/world-graph.js";
import type { Parameter, Transition, World, WorldState } from "../../../shared/src/types.js";
import { WORLD_VERSION } from "../../../shared/src/worlds.js";

const state = (id: string, over: Partial<WorldState> = {}): WorldState => ({
  id,
  name: id,
  clip: { path: `clips/${id}.mp4`, durationMs: 2000 },
  x: 0,
  y: 0,
  ...over,
});

const transition = (over: Partial<Transition> & Pick<Transition, "id" | "to">): Transition => ({
  conditions: [],
  hasExitTime: true,
  exitTime: 1,
  order: 0,
  ...over,
});

const bool = (name: string, defaultValue = false): Parameter => ({ name, type: "bool", defaultValue });
const trigger = (name: string): Parameter => ({ name, type: "trigger", defaultValue: false });
const float = (name: string, defaultValue = 0): Parameter => ({ name, type: "float", defaultValue });

function world(over: Partial<World> = {}): World {
  return {
    version: WORLD_VERSION,
    id: "lounge",
    name: "Lounge",
    defaultStateId: null,
    states: [],
    transitions: [],
    parameters: [],
    ...over,
  };
}

describe("values and types", () => {
  it("coerces a declared default into something its type can hold", () => {
    // Only a literal `true` is true. Treating any truthy value as true would
    // make a hand-edited `1` mean something the author cannot see in the file.
    expect(defaultValueOf({ name: "a", type: "bool", defaultValue: 3 })).toBe(false);
    expect(defaultValueOf({ name: "a", type: "bool", defaultValue: true })).toBe(true);
    expect(defaultValueOf({ name: "a", type: "int", defaultValue: 2.7 })).toBe(2);
    expect(defaultValueOf({ name: "a", type: "float", defaultValue: Number.NaN })).toBe(0);
    expect(defaultValueOf({ name: "a", type: "trigger", defaultValue: false })).toBe(false);
  });

  it("accepts only values of the right shape", () => {
    expect(valueFits("bool", true)).toBe(true);
    expect(valueFits("bool", 1)).toBe(false);
    expect(valueFits("int", 3)).toBe(true);
    expect(valueFits("int", 3.5)).toBe(false);
    expect(valueFits("float", 3.5)).toBe(true);
    // Acceptance-shaped: a non-finite number is not a value any type can hold.
    expect(valueFits("float", Number.NaN)).toBe(false);
  });
});

describe("conditions", () => {
  it("holds and fails a Bool clause, and inverts it", () => {
    expect(clauseHolds({ parameter: "ready", op: "is", value: true }, { ready: true })).toBe(true);
    expect(clauseHolds({ parameter: "ready", op: "is", value: true }, { ready: false })).toBe(false);
    expect(clauseHolds({ parameter: "ready", op: "isNot", value: true }, { ready: false })).toBe(true);
  });

  it("compares numbers", () => {
    expect(clauseHolds({ parameter: "energy", op: "gt", value: 0.5 }, { energy: 0.7 })).toBe(true);
    expect(clauseHolds({ parameter: "energy", op: "lt", value: 0.5 }, { energy: 0.7 })).toBe(false);
    expect(clauseHolds({ parameter: "energy", op: "eq", value: 3 }, { energy: 3 })).toBe(true);
    expect(clauseHolds({ parameter: "energy", op: "neq", value: 3 }, { energy: 3 })).toBe(false);
  });

  it("fails a clause whose Parameter has no value rather than passing it", () => {
    // A guard phrased as a negation fails open on the input nobody considered.
    expect(clauseHolds({ parameter: "gone", op: "is", value: true }, {})).toBe(false);
    expect(clauseHolds({ parameter: "gone", op: "isNot", value: true }, {})).toBe(false);
    expect(clauseHolds({ parameter: "gone", op: "gt", value: 0 }, {})).toBe(false);
  });

  it("fails a numeric comparison against a value that is not a number", () => {
    expect(clauseHolds({ parameter: "ready", op: "gt", value: 0 }, { ready: true })).toBe(false);
  });

  it("conjoins clauses, and an empty list is unconditional", () => {
    const t = transition({
      id: "t",
      to: "b",
      conditions: [
        { parameter: "ready", op: "is", value: true },
        { parameter: "energy", op: "gt", value: 0.5 },
      ],
    });
    expect(conditionsHold(t, { ready: true, energy: 0.7 })).toBe(true);
    expect(conditionsHold(t, { ready: true, energy: 0.2 })).toBe(false);
    expect(conditionsHold(transition({ id: "u", to: "b" }), {})).toBe(true);
  });
});

describe("which transitions are offered", () => {
  const w = () =>
    world({
      states: [state("a"), state("b")],
      transitions: [
        transition({ id: "own2", from: "a", to: "b", order: 1 }),
        transition({ id: "own1", from: "a", to: "b", order: 0 }),
        transition({ id: "any", fromAny: true, to: "b", order: 0 }),
        transition({ id: "other", from: "b", to: "a", order: 0 }),
      ],
    });

  it("puts Any State first, then the State's own in their stored order", () => {
    expect(transitionsFrom(w(), "a").map((t) => t.id)).toEqual(["any", "own1", "own2"]);
  });

  it("offers only Any State from nowhere", () => {
    expect(transitionsFrom(w(), null).map((t) => t.id)).toEqual(["any"]);
  });

  it("skips a muted transition", () => {
    const muted = world({
      ...w(),
      transitions: w().transitions.map((t) => (t.id === "own1" ? { ...t, muted: true } : t)),
    });
    expect(liveTransitions(muted, "a").map((t) => t.id)).toEqual(["any", "own2"]);
  });

  it("considers only soloed transitions among a State's own", () => {
    const soloed = world({
      ...w(),
      transitions: w().transitions.map((t) => (t.id === "own2" ? { ...t, solo: true } : t)),
    });
    // Solo is scoped to one source, so the Any State transition survives it.
    expect(liveTransitions(soloed, "a").map((t) => t.id)).toEqual(["any", "own2"]);
  });

  it("scopes a solo on Any State to the Any State group", () => {
    const soloed = world({
      ...w(),
      transitions: w().transitions.map((t) => (t.id === "any" ? { ...t, solo: true } : t)),
    });
    expect(liveTransitions(soloed, "a").map((t) => t.id)).toEqual(["any", "own1", "own2"]);
  });
});

describe("unreachable States", () => {
  it("reports a State with a way out but no way in", () => {
    // Covers AE7.
    const w = world({
      defaultStateId: "a",
      states: [state("a"), state("b"), state("orphan")],
      transitions: [
        transition({ id: "t1", from: "a", to: "b" }),
        transition({ id: "t2", from: "orphan", to: "a" }),
      ],
    });
    expect(unreachable(w)).toEqual(["orphan"]);
  });

  it("never reports the default State", () => {
    const w = world({ defaultStateId: "a", states: [state("a")] });
    expect(unreachable(w)).toEqual([]);
  });

  it("counts a State reachable only through Any State", () => {
    const w = world({
      defaultStateId: "a",
      states: [state("a"), state("wave")],
      transitions: [transition({ id: "t", fromAny: true, to: "wave" })],
    });
    expect(unreachable(w)).toEqual([]);
  });

  it("does not count a muted transition as a way in", () => {
    const w = world({
      defaultStateId: "a",
      states: [state("a"), state("b")],
      transitions: [transition({ id: "t", from: "a", to: "b", muted: true })],
    });
    expect(unreachable(w)).toEqual(["b"]);
  });

  it("reports every State when there is no default to walk from", () => {
    const w = world({ states: [state("a"), state("b")] });
    expect(unreachable(w).sort()).toEqual(["a", "b"]);
  });
});

describe("dead ends", () => {
  it("reports a State whose only way out needs a Bool the sweep can falsify", () => {
    const w = world({
      defaultStateId: "a",
      parameters: [bool("ready")],
      states: [state("a"), state("b")],
      transitions: [
        transition({ id: "t", from: "a", to: "b", conditions: [{ parameter: "ready", op: "is", value: true }] }),
      ],
    });
    expect(deadEnds(w)).toContainEqual({ stateId: "a", parameter: "ready", value: false });
    expect(deadEnds(w).some((d) => d.stateId === "a" && d.value === true)).toBe(false);
  });

  it("says nothing about a State with an unconditional way out", () => {
    const w = world({
      defaultStateId: "a",
      parameters: [bool("ready")],
      states: [state("a"), state("b")],
      transitions: [transition({ id: "t", from: "a", to: "b" })],
    });
    expect(deadEnds(w).some((d) => d.stateId === "a")).toBe(false);
  });

  it("treats a numeric condition as satisfiable rather than claiming a gap it cannot prove", () => {
    const w = world({
      defaultStateId: "a",
      parameters: [bool("ready"), float("energy")],
      states: [state("a"), state("b")],
      transitions: [
        transition({ id: "t", from: "a", to: "b", conditions: [{ parameter: "energy", op: "gt", value: 0.5 }] }),
        transition({ id: "back", from: "b", to: "a" }),
      ],
    });
    // Nothing here can prove `energy` never exceeds 0.5, so `a` is not a gap.
    expect(deadEnds(w)).toEqual([]);
  });

  it("names only the types it actually swept", () => {
    const w = world({ parameters: [bool("ready"), float("energy")] });
    expect(worldReports(w).sweptTypes).toEqual(["bool", "trigger"]);
  });

  it("reports nothing when no Parameter has an enumerable space", () => {
    const w = world({
      defaultStateId: "a",
      parameters: [float("energy")],
      states: [state("a")],
    });
    expect(deadEnds(w)).toEqual([]);
  });

  it("counts a Trigger's two values", () => {
    const w = world({
      defaultStateId: "a",
      parameters: [trigger("wave")],
      states: [state("a"), state("b")],
      transitions: [
        transition({ id: "t", from: "a", to: "b", conditions: [{ parameter: "wave", op: "is", value: true }] }),
      ],
    });
    expect(deadEnds(w)).toContainEqual({ stateId: "a", parameter: "wave", value: false });
  });

  it("says nothing rather than something wrong when the sweep would explode", () => {
    // The cross-product multiplies; a hand-edited manifest must not stall the
    // server on every mutation and every greeting.
    const many = Array.from({ length: 16 }, (_, i) => bool(`b${i}`));
    const w = world({ defaultStateId: "a", parameters: many, states: [state("a")] });

    const started = Date.now();
    expect(deadEnds(w)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("ignores a muted transition when deciding there is no way out", () => {
    const w = world({
      defaultStateId: "a",
      parameters: [bool("ready")],
      states: [state("a"), state("b")],
      transitions: [transition({ id: "t", from: "a", to: "b", muted: true })],
    });
    expect(deadEnds(w).some((d) => d.stateId === "a")).toBe(true);
  });
});

describe("the whole report", () => {
  it("names States with no clip, and stays quiet on a complete machine", () => {
    const complete = world({
      defaultStateId: "a",
      parameters: [bool("ready")],
      states: [state("a"), state("b")],
      transitions: [
        transition({ id: "t1", from: "a", to: "b" }),
        transition({ id: "t2", from: "b", to: "a" }),
      ],
    });
    const clean = worldReports(complete);
    expect(clean.statesWithoutClip).toEqual([]);
    expect(clean.unreachable).toEqual([]);
    expect(clean.deadEnds).toEqual([]);

    const broken = world({
      ...complete,
      states: [...complete.states, state("draft", { clip: null })],
    });
    const reports = worldReports(broken);
    expect(reports.worldId).toBe("lounge");
    expect(reports.statesWithoutClip).toEqual(["draft"]);
    expect(reports.unreachable).toEqual(["draft"]);
    expect(statesWithoutClip(broken)).toEqual(["draft"]);
  });
});
