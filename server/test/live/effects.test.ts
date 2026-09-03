import { describe, it, expect } from "vitest";
import {
  EFFECT_SPECS,
  applyEffect,
  opApplies,
  opsForParameter,
  type BounceDirection,
  type EffectResult,
} from "../../../shared/src/effects.js";
import { EFFECT_OPS } from "../../../shared/src/worlds.js";
import type { Effect, EffectOp, Parameter, ParameterValue } from "../../../shared/src/types.js";

const param = (over: Partial<Parameter> = {}): Parameter => ({
  name: "swing",
  type: "int",
  defaultValue: 0,
  ...over,
});

const ranged = (min = 0, max = 2, over: Partial<Parameter> = {}): Parameter =>
  param({ min, max, ...over });

const effect = (op: EffectOp, over: Partial<Effect> = {}): Effect => ({
  parameter: "swing",
  op,
  intervalMs: 1000,
  ...over,
});

/** Apply once, with the range resolved the way the runtime resolves it. */
function apply(
  op: EffectOp,
  parameter: Parameter,
  current: ParameterValue,
  over: { operand?: unknown; direction?: BounceDirection; random?: () => number; source?: Parameter & { value: ParameterValue } } = {},
) {
  const range =
    typeof parameter.min === "number" && typeof parameter.max === "number"
      ? { min: parameter.min, max: parameter.max }
      : null;
  return applyEffect(effect(op, { operand: over.operand as never }), parameter, current, {
    type: parameter.type,
    range,
    direction: over.direction,
    random: over.random,
    source: over.source ? { value: over.source.value, type: over.source.type } : undefined,
  });
}

describe("the operation vocabulary", () => {
  it("registers exactly the ops the shared list names", () => {
    // One registration point is the whole design. A spec the list does not name,
    // or a name with no spec, is the drift this table exists to make impossible.
    expect(Object.keys(EFFECT_SPECS).sort()).toEqual([...EFFECT_OPS].sort());
  });

  it("offers no operation for a Trigger", () => {
    // Nothing lowers a Trigger except a transition consuming it, so an
    // Effect-raised one no transition takes would be a Bool stuck true.
    const trigger = param({ type: "trigger", defaultValue: false });
    expect(opsForParameter(trigger, false)).toEqual([]);
    for (const op of EFFECT_OPS) expect(opApplies(op, trigger, true)).toBe(false);
  });

  it("offers the range-dependent ops only where a range is declared", () => {
    expect(opsForParameter(ranged(), true)).toContain("bounce");
    expect(opsForParameter(ranged(), true)).toContain("random");
    expect(opsForParameter(param(), false)).not.toContain("bounce");
    expect(opsForParameter(param(), false)).not.toContain("random");
  });

  it("offers toggle for a Bool and for nothing else", () => {
    expect(opsForParameter(param({ type: "bool", defaultValue: false }), false)).toContain("toggle");
    expect(opsForParameter(param({ type: "int" }), false)).not.toContain("toggle");
    expect(opsForParameter(param({ type: "float" }), false)).not.toContain("toggle");
  });
});

describe("bounce", () => {
  it("walks a value up and back down between its bounds", () => {
    // The behaviour the operation exists for: every other numeric op pins at a
    // bound and stays there, which would leave the character at one deck.
    let value: ParameterValue = 0;
    let direction: BounceDirection | undefined;
    const seen: ParameterValue[] = [];
    for (let i = 0; i < 6; i += 1) {
      const result: EffectResult = apply("bounce", ranged(0, 2), value, { operand: 1, direction })!;
      value = result.value;
      direction = result.direction;
      seen.push(value);
    }
    expect(seen).toEqual([1, 2, 1, 0, 1, 2]);
  });

  it("travels the way it is told when it starts between the bounds", () => {
    expect(apply("bounce", ranged(0, 4), 2, { operand: 1, direction: -1 })?.value).toBe(1);
    expect(apply("bounce", ranged(0, 4), 2, { operand: 1, direction: 1 })?.value).toBe(3);
  });

  it("turns around at a bound whatever direction it was given", () => {
    // A run that resumes after a restart has no direction, and one that arrives
    // at a bound must not walk out through it.
    expect(apply("bounce", ranged(0, 2), 2, { operand: 1, direction: 1 })?.value).toBe(1);
    expect(apply("bounce", ranged(0, 2), 0, { operand: 1, direction: -1 })?.value).toBe(1);
  });

  it("lands on the bound rather than overshooting it", () => {
    const result = apply("bounce", ranged(0, 5), 4, { operand: 3, direction: 1 })!;
    expect(result.value).toBe(5);
    expect(result.direction).toBe(-1);
  });

  it("declines without a declared range", () => {
    expect(apply("bounce", param(), 0, { operand: 1 })).toBeNull();
  });
});

describe("add and multiply", () => {
  it("pins at the bound where bounce reflects", () => {
    // Not the operation's own doing — the clamp is the writer's. This asserts the
    // op keeps adding, which is what makes the clamp visible as a pin.
    expect(apply("add", ranged(0, 2), 2, { operand: 1 })?.value).toBe(3);
  });

  it("declines a result an Int cannot hold rather than rounding it", () => {
    // A coercion here would be the machine inventing a value the author did not
    // ask for, and the author would see an Int drifting by halves.
    expect(apply("multiply", param({ type: "int" }), 3, { operand: 1.5 })).toBeNull();
    expect(apply("multiply", param({ type: "float" }), 3, { operand: 1.5 })?.value).toBe(4.5);
  });

  it("declines a result that is not finite", () => {
    expect(apply("add", param({ type: "float" }), Number.MAX_VALUE, { operand: Number.MAX_VALUE })).toBeNull();
  });

  it("declines an operand that is not a number", () => {
    expect(apply("add", param(), 0, { operand: "two" })).toBeNull();
    expect(apply("add", param(), 0, { operand: undefined })).toBeNull();
  });
});

describe("random", () => {
  it("draws a whole number inside an Int's range", () => {
    // Drawing a float and letting the type check discard it would make this an
    // Effect that fires and almost never writes.
    const seen = new Set<ParameterValue>();
    for (const pick of [0, 0.34, 0.5, 0.99]) {
      const value = apply("random", ranged(0, 2), 0, { random: () => pick })!.value;
      expect(Number.isInteger(value)).toBe(true);
      expect(value as number).toBeGreaterThanOrEqual(0);
      expect(value as number).toBeLessThanOrEqual(2);
      seen.add(value);
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it("draws within a Float's range", () => {
    const value = apply("random", ranged(0, 1, { type: "float" }), 0, { random: () => 0.25 })!.value;
    expect(value).toBeCloseTo(0.25);
  });

  it("declines without a declared range", () => {
    expect(apply("random", param(), 0, {})).toBeNull();
  });
});

describe("copy and toggle", () => {
  it("copies another Parameter's value", () => {
    const source = { ...param({ name: "other", type: "int" }), value: 4 as ParameterValue };
    expect(apply("copy", param({ type: "int" }), 0, { source })?.value).toBe(4);
  });

  it("declines a copy whose source value the target cannot hold", () => {
    // A hand-edited manifest can name a Bool source for an Int target; the panel
    // will not offer it, and the runtime must not coerce it.
    const source = { ...param({ name: "flag", type: "bool" }), value: true as ParameterValue };
    expect(apply("copy", param({ type: "int" }), 0, { source })).toBeNull();
  });

  it("declines a copy with no source at all", () => {
    expect(apply("copy", param({ type: "int" }), 0, {})).toBeNull();
  });

  it("flips a Bool", () => {
    const bool = param({ type: "bool", defaultValue: false });
    expect(apply("toggle", bool, false)?.value).toBe(true);
    expect(apply("toggle", bool, true)?.value).toBe(false);
  });

  it("declines a toggle on a number", () => {
    expect(apply("toggle", param({ type: "int" }), 1)).toBeNull();
  });
});

describe("an operation this build does not know", () => {
  it("declines rather than throwing", () => {
    // A World from a newer build carries one, and the store deliberately keeps it.
    const fromTheFuture = { parameter: "swing", op: "teleport" as EffectOp, intervalMs: 1000 };
    expect(applyEffect(fromTheFuture, ranged(), 0, { type: "int", range: { min: 0, max: 2 } })).toBeNull();
  });
});
