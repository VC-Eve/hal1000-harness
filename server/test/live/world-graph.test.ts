import { describe, it, expect } from "vitest";
import {
  allClipsUnusable,
  clampToRange,
  danglingEffects,
  longAtomicRuns,
  unusableRanges,
  usableRange,
  clauseHolds,
  conditionsHold,
  deadEnds,
  drawFrom,
  defaultValueOf,
  liveTransitions,
  statesWithoutClip,
  transitionsFrom,
  unreachable,
  valueFits,
  worldReports,
} from "../../../shared/src/world-graph.js";
import type {
  ClipRef,
  ClipSequence,
  Effect,
  Parameter,
  Transition,
  World,
  WorldState,
} from "../../../shared/src/types.js";
import { MAX_BRIDGE_MS, WORLD_VERSION, sequenceKey } from "../../../shared/src/worlds.js";

const state = (id: string, over: Partial<WorldState> = {}): WorldState => ({
  id,
  name: id,
  clips: [{ clips: [{ path: `clips/${id}.mp4`, durationMs: 2000 }] }],
  x: 0,
  y: 0,
  ...over,
});

const transition = (over: Partial<Transition> & Pick<Transition, "id" | "to">): Transition => ({
  clips: [],
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
      states: [...complete.states, state("draft", { clips: [] })],
    });
    const reports = worldReports(broken);
    expect(reports.worldId).toBe("lounge");
    expect(reports.statesWithoutClip).toEqual(["draft"]);
    expect(reports.unreachable).toEqual(["draft"]);
    expect(statesWithoutClip(broken)).toEqual(["draft"]);
  });
});

describe("reachability reads the same graph the machine does", () => {
  it("counts a State unreachable once solo silences the only way to it", () => {
    // Reading `muted` alone made this report disagree with what the runtime
    // offers: soloing one transition hides its siblings from the machine, but
    // they were still counted as ways through here.
    const w = world({
      states: [state("a"), state("b"), state("c")],
      defaultStateId: "a",
      transitions: [
        transition({ id: "solo", from: "a", to: "b", solo: true }),
        transition({ id: "silenced", from: "a", to: "c" }),
      ],
    });

    expect(unreachable(w)).toEqual(["c"]);
  });

  it("keeps both reachable when neither is soloed", () => {
    const w = world({
      states: [state("a"), state("b"), state("c")],
      defaultStateId: "a",
      transitions: [
        transition({ id: "one", from: "a", to: "b" }),
        transition({ id: "two", from: "a", to: "c" }),
      ],
    });

    expect(unreachable(w)).toEqual([]);
  });
});

describe("drawing a member from a set", () => {
  const set = (...names: string[]) => names.map((n) => ({ clips: [{ path: n, durationMs: 1000 }] }));
  /** The one path of a one-clip run, which is what these fixtures draw. */
  const drawn = (sequence: ClipSequence | null) => sequence?.clips[0]?.path;
  /** A source that walks a fixed sequence, so a draw is asserted rather than sampled. */
  const sequence = (values: number[]) => {
    let n = 0;
    return () => values[n++ % values.length]!;
  };

  it("takes the member the random source points at", () => {
    expect(drawn(drawFrom(set("a", "b", "c"), null, { random: sequence([0]) }))).toBe("a");
    expect(drawn(drawFrom(set("a", "b", "c"), null, { random: sequence([0.99]) }))).toBe("c");
  });

  it("never repeats the member that just played", () => {
    // The source always asks for the first of whatever pool it is given, so a
    // repeat would be certain if the exclusion were not applied.
    // The exclusion compares whole runs, so what it is given is a
    // `sequenceKey` — passing a bare path would silently never match.
    let last = sequenceKey(set("a")[0]!);
    for (let i = 0; i < 5; i += 1) {
      const picked = drawFrom(set("a", "b"), last, { random: sequence([0]) })!;
      expect(sequenceKey(picked)).not.toBe(last);
      last = sequenceKey(picked);
    }
  });

  it("plays the only member of a one-member set every time", () => {
    expect(drawn(drawFrom(set("a"), sequenceKey(set("a")[0]!), { random: sequence([0]) }))).toBe("a");
  });

  it("draws nothing from an empty set", () => {
    expect(drawFrom([], null)).toBeNull();
    expect(drawFrom(undefined, null)).toBeNull();
  });

  it("draws nothing when no member is usable", () => {
    expect(drawFrom(set("a", "b"), null, { usable: () => false })).toBeNull();
  });

  it("settles on the one usable member rather than starving it", () => {
    const usable = (s: ClipSequence) => s.clips[0]?.path === "a";
    for (let i = 0; i < 4; i += 1) {
      expect(drawn(drawFrom(set("a", "b", "c"), sequenceKey(set("a")[0]!), { usable, random: sequence([0]) }))).toBe("a");
    }
  });

  it("reaches every member of a five-member set", () => {
    const seen = new Set<string>();
    let last: string | null = null;
    for (let i = 0; i < 400; i += 1) {
      const picked: ClipSequence = drawFrom(set("a", "b", "c", "d", "e"), last)!;
      seen.add(drawn(picked)!);
      last = sequenceKey(picked);
    }
    expect(seen.size).toBe(5);
  });

  it("clamps a random source that returns 1", () => {
    expect(drawn(drawFrom(set("a", "b"), null, { random: () => 1 }))).toBe("b");
  });
});

describe("owners whose clips are all unplayable", () => {
  const broken = (
    ownerId: string,
    index: number,
    kind: "state" | "transition" = "state",
    memberIndex = 0,
  ) => ({
    ownerId,
    ownerKind: kind,
    index,
    memberIndex,
    path: `clips/${ownerId}-${index}.mp4`,
    reason: "missing" as const,
  });

  it("names a State whose every member is broken", () => {
    const w = world({
      states: [{ ...state("a"), clips: [{ clips: [{ path: "x", durationMs: 1 }] }, { clips: [{ path: "y", durationMs: 1 }] }] }],
    });

    expect(allClipsUnusable(w, [broken("a", 0), broken("a", 1)])).toEqual([{ id: "a", kind: "state" }]);
  });

  it("does not name a State that still has one good member", () => {
    const w = world({
      states: [{ ...state("a"), clips: [{ clips: [{ path: "x", durationMs: 1 }] }, { clips: [{ path: "y", durationMs: 1 }] }] }],
    });

    expect(allClipsUnusable(w, [broken("a", 0)])).toEqual([]);
  });

  it("does not name a State that holds no clips — that is the other report", () => {
    const w = world({ states: [{ ...state("a"), clips: [] }] });

    expect(allClipsUnusable(w, [])).toEqual([]);
    expect(statesWithoutClip(w)).toEqual(["a"]);
  });

  it("names a transition as well, and says which kind it is", () => {
    const w = world({
      states: [state("a")],
      transitions: [transition({ id: "t", from: "a", to: "a", clips: [{ clips: [{ path: "x", durationMs: 1 }] }] })],
    });

    expect(allClipsUnusable(w, [broken("t", 0, "transition")])).toEqual([{ id: "t", kind: "transition" }]);
  });
});

describe("runs, and which of them can be drawn", () => {
  const seq = (...names: string[]) => ({ clips: names.map((n) => ({ path: n, durationMs: 1000 })) });
  const broken = (ownerId: string, index: number, memberIndex = 0) => ({
    ownerId,
    ownerKind: "state" as const,
    index,
    memberIndex,
    path: "gone.mp4",
    reason: "missing" as const,
  });

  it("draws a run whole rather than one of its clips", () => {
    const picked = drawFrom([seq("a", "b")], null, { random: () => 0 });
    expect(picked?.clips.map((c) => c.path)).toEqual(["a", "b"]);
  });

  it("does not draw a run with no members at all", () => {
    // A hand-edited manifest can hold one, and a run that plays nothing is a
    // silent gap rather than a gesture.
    expect(drawFrom([{ clips: [] }], null)).toBeNull();
  });

  it("avoids the run that just played, not merely its first clip", () => {
    // Two runs starting with the same clip. Keying the exclusion on a clip
    // would suppress both and make the draw fall back to the whole pool.
    const set = [seq("settle", "look"), seq("settle", "sigh")];
    const first = drawFrom(set, null, { random: () => 0 })!;
    const second = drawFrom(set, sequenceKey(first), { random: () => 0 })!;
    expect(sequenceKey(second)).not.toBe(sequenceKey(first));
  });

  it("names an owner only when every one of its runs holds a break", () => {
    const w = world({ states: [{ ...state("a"), clips: [seq("x", "y"), seq("z")] }] });

    // One break in the first run leaves the second drawable.
    expect(allClipsUnusable(w, [broken("a", 0, 1)])).toEqual([]);
    // Two breaks in the same run still leave it drawable-free but the other run
    // is untouched — counting members rather than runs called this unusable.
    expect(allClipsUnusable(w, [broken("a", 0, 0), broken("a", 0, 1)])).toEqual([]);
    // A break in each run leaves nothing to draw.
    expect(allClipsUnusable(w, [broken("a", 0, 0), broken("a", 1, 0)])).toEqual([{ id: "a", kind: "state" }]);
  });
});

describe("atomic runs that hold the World a long time", () => {
  const longSeq = (ms: number) => ({ clips: [{ path: "a.mp4", durationMs: ms }] });

  it("names a State whose atomic run outlasts the bridge ceiling", () => {
    const w = world({ states: [{ ...state("a"), atomic: true, clips: [longSeq(MAX_BRIDGE_MS + 1)] }] });
    expect(longAtomicRuns(w)).toEqual(["a"]);
  });

  it("says nothing about the same run when the State is interruptible", () => {
    // An interruptible run of any length is evaluated at every clip boundary,
    // so it holds nothing and there is nothing to warn about.
    const w = world({ states: [{ ...state("a"), atomic: false, clips: [longSeq(MAX_BRIDGE_MS + 1)] }] });
    expect(longAtomicRuns(w)).toEqual([]);
  });

  it("adds up the members of a run rather than looking at one", () => {
    const w = world({
      states: [
        {
          ...state("a"),
          atomic: true,
          clips: [
            {
              clips: [
                { path: "one.mp4", durationMs: MAX_BRIDGE_MS * 0.6 },
                { path: "two.mp4", durationMs: MAX_BRIDGE_MS * 0.6 },
              ],
            },
          ],
        },
      ],
    });
    expect(longAtomicRuns(w)).toEqual(["a"]);
  });

  it("says nothing about a short atomic run", () => {
    const w = world({ states: [{ ...state("a"), atomic: true, clips: [longSeq(2000)] }] });
    expect(longAtomicRuns(w)).toEqual([]);
  });
});

describe("a Parameter's declared range", () => {
  const p = (over: Partial<Parameter> = {}): Parameter => ({
    name: "swing",
    type: "int",
    defaultValue: 0,
    ...over,
  });

  it("is usable when both bounds are finite and in order", () => {
    expect(usableRange(p({ min: 0, max: 2 }))).toEqual({ min: 0, max: 2 });
    expect(usableRange(p({ min: -2, max: -1 }))).toEqual({ min: -2, max: -1 });
    expect(usableRange(p({ min: 1, max: 1 }))).toEqual({ min: 1, max: 1 });
  });

  it("is absent when only one bound is declared", () => {
    expect(usableRange(p({ min: 0 }))).toBeNull();
    expect(usableRange(p({ max: 2 }))).toBeNull();
    expect(usableRange(p())).toBeNull();
  });

  it("refuses a min above its max rather than pinning the Parameter", () => {
    // A World arrives from another machine with a manifest nobody validated.
    // Clamping to 2..0 would hold the value at one number with nothing saying why.
    expect(usableRange(p({ min: 2, max: 0 }))).toBeNull();
  });

  it("refuses a bound that is not a finite number", () => {
    // Written as positive tests: a comparison against the bound would pass NaN
    // straight through, which is the failure the solutions doc records.
    expect(usableRange(p({ min: Number.NaN, max: 2 }))).toBeNull();
    expect(usableRange(p({ min: 0, max: Number.NaN }))).toBeNull();
    expect(usableRange(p({ min: 0, max: Number.POSITIVE_INFINITY }))).toBeNull();
    expect(usableRange(p({ min: "0" as never, max: 2 }))).toBeNull();
  });

  it("declares no range for a Bool or a Trigger, whatever the manifest says", () => {
    expect(usableRange(p({ type: "bool", defaultValue: false, min: 0, max: 1 }))).toBeNull();
    expect(usableRange(p({ type: "trigger", defaultValue: false, min: 0, max: 1 }))).toBeNull();
  });

  it("clamps a value into the range", () => {
    expect(clampToRange(p({ min: 0, max: 2 }), 7)).toBe(2);
    expect(clampToRange(p({ min: 0, max: 2 }), -7)).toBe(0);
    expect(clampToRange(p({ min: 0, max: 2 }), 1)).toBe(1);
  });

  it("leaves a value alone when there is no usable range", () => {
    expect(clampToRange(p(), 7)).toBe(7);
    expect(clampToRange(p({ min: 2, max: 0 }), 7)).toBe(7);
    expect(clampToRange(undefined, 7)).toBe(7);
  });

  it("keeps an Int an Int when the bound is fractional", () => {
    // A range of 0..2.5 must not turn 3 into 2.5 on an Int.
    expect(clampToRange(p({ type: "int", min: 0, max: 2.5 }), 3)).toBe(2);
    expect(clampToRange(p({ type: "float", min: 0, max: 2.5 }), 3)).toBe(2.5);
  });

  it("leaves a Bool alone", () => {
    expect(clampToRange(p({ type: "bool", defaultValue: false }), true)).toBe(true);
  });
});

describe("Effects the World cannot carry out", () => {
  const swing: Parameter = { name: "swing", type: "int", defaultValue: 0, min: 0, max: 2 };
  const fx = (parameter: string): Effect => ({ parameter, op: "add", operand: 1, intervalMs: 1000 });

  it("names a World Effect writing a Parameter that is not declared", () => {
    // The failure this catches is silence: the Effect fires on its interval,
    // finds nothing to write, and does nothing, for as long as the author stares
    // at a value that will not move.
    const w = world({ parameters: [swing], effects: [fx("gone")] });

    expect(danglingEffects(w)).toEqual([
      { ownerId: w.id, ownerKind: "world", index: 0, parameter: "gone" },
    ]);
  });

  it("names a State's Effect, and says which State", () => {
    const w = world({
      states: [{ ...state("a"), effects: [fx("swing"), fx("gone")] }],
      parameters: [swing],
    });

    expect(danglingEffects(w)).toEqual([
      { ownerId: "a", ownerKind: "state", index: 1, parameter: "gone" },
    ]);
  });

  it("names nothing when every target is declared", () => {
    const w = world({
      states: [{ ...state("a"), effects: [fx("swing")] }],
      parameters: [swing],
      effects: [fx("swing")],
    });

    expect(danglingEffects(w)).toEqual([]);
  });

  it("passes over an Effect with no target at all rather than throwing", () => {
    // A hand-edited manifest carries one, and the store deliberately keeps it.
    const w = world({ parameters: [swing], effects: [{ op: "add", intervalMs: 1000 } as Effect] });

    expect(danglingEffects(w)).toEqual([]);
  });

  it("reports a World with Effects and no Parameters at all", () => {
    const w = world({ parameters: [], effects: [fx("swing")] });

    expect(danglingEffects(w)).toHaveLength(1);
  });
});

describe("ranges the author wrote that are not in force", () => {
  const p = (over: Partial<Parameter>): Parameter => ({
    name: "swing",
    type: "int",
    defaultValue: 0,
    ...over,
  });

  it("names a Parameter whose min is above its max", () => {
    // Otherwise invisible: the range is ignored and the value simply never clamps.
    expect(unusableRanges(world({ parameters: [p({ min: 2, max: 0 })] }))).toEqual(["swing"]);
  });

  it("names a Parameter with a bound that is not a finite number", () => {
    expect(unusableRanges(world({ parameters: [p({ min: 0, max: Number.NaN })] }))).toEqual(["swing"]);
  });

  it("names a Parameter that declares one bound only", () => {
    // A half-declared range does not clamp, and the author who wrote it is
    // entitled to know that.
    expect(unusableRanges(world({ parameters: [p({ min: 0 })] }))).toEqual(["swing"]);
  });

  it("says nothing about a Parameter with no bounds at all", () => {
    // The ordinary case, not a problem.
    expect(unusableRanges(world({ parameters: [p({})] }))).toEqual([]);
  });

  it("says nothing about a usable range", () => {
    expect(unusableRanges(world({ parameters: [p({ min: 0, max: 2 })] }))).toEqual([]);
  });

  it("says nothing about bounds on a Bool, which has no range to declare", () => {
    expect(
      unusableRanges(world({ parameters: [p({ type: "bool", defaultValue: false, min: 0, max: 1 })] })),
    ).toEqual([]);
  });
});
