// What an Effect can do to a Parameter, and the one place a new operation is
// added.
//
// Every consumer reads this table: the store validates against it, the panel
// offers from it, the reports check against it, and the runtime applies through
// it. That is the whole point of a closed vocabulary — an eighth operation is an
// entry here and nothing else, and no consumer can drift out of step with the set
// because none of them holds its own copy.
//
// Pure, and in `shared/` because both sides read it. The randomness is injected
// for the reason the clip draw injects it: a test asserts which value came out
// rather than a distribution.

import type { Effect, EffectOp, Parameter, ParameterType, ParameterValue } from "./worlds.js";

/** Which way a `bounce` is currently travelling. */
export type BounceDirection = 1 | -1;

/**
 * What an operation needs to know beyond the value it is changing.
 *
 * `range` is already resolved to a usable pair or null by the caller, so no
 * operation has to repeat the "is this range nonsense" question — see
 * `usableRange` in `world-graph.ts`.
 */
export interface EffectContext {
  /** The type of the Parameter being written. `random` needs it to pick a whole number for an Int. */
  type: ParameterType;
  range: { min: number; max: number } | null;
  /** The value of the Parameter a `copy` reads, and its type. */
  source?: { value: ParameterValue; type: ParameterType };
  /** Which way this Effect was last travelling, for `bounce`. */
  direction?: BounceDirection;
  random?: () => number;
}

/**
 * What an operation produced.
 *
 * `null` means "nothing to write" and is the discard path: a `multiply` that
 * lands between two integers, an `add` that reaches infinity, a `copy` from a
 * type that will not fit. Discarded rather than coerced, because a coercion is
 * the machine inventing a value the author did not ask for — and reported, so an
 * Effect that fires and changes nothing is not silent.
 */
export interface EffectResult {
  value: ParameterValue;
  /** Set by `bounce`, so the caller can remember which way to go next. */
  direction?: BounceDirection;
}

interface OpSpec {
  /** The Parameter types this operation can be applied to. */
  types: readonly ParameterType[];
  /** Whether the target Parameter must declare a usable range. */
  needsRange: boolean;
  /** What the author supplies: a number, a Bool, another Parameter's name, or nothing. */
  operand: "number" | "boolean" | "parameter" | "none";
  apply(current: ParameterValue, operand: unknown, ctx: EffectContext): EffectResult | null;
}

const NUMERIC: readonly ParameterType[] = ["int", "float"];

/**
 * A number the target type can actually hold, or null.
 *
 * Every numeric operation ends here, so the "an Int cannot hold 1.5" rule is
 * stated once. A Trigger never reaches this — no operation lists it.
 */
function fits(value: number, type: ParameterType): EffectResult | null {
  if (!Number.isFinite(value)) return null;
  if (type === "int" && !Number.isInteger(value)) return null;
  return { value };
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * The vocabulary.
 *
 * A Trigger appears in no `types` list. Nothing lowers a Trigger except a
 * transition consuming it, so an Effect-raised one that no transition takes would
 * stay armed and behave as a Bool stuck true rather than the one-shot a Trigger
 * is — which is a worse thing to have than not having it.
 */
export const EFFECT_SPECS: Record<EffectOp, OpSpec> = {
  set: {
    types: ["bool", "int", "float"],
    needsRange: false,
    operand: "number",
    apply(_current, operand) {
      if (typeof operand === "boolean") return { value: operand };
      const n = num(operand);
      // The type check is `applyEffect`'s, once, for every operation.
      return n === null ? null : { value: n };
    },
  },

  add: {
    types: NUMERIC,
    needsRange: false,
    operand: "number",
    apply(current, operand) {
      const by = num(operand);
      if (by === null || typeof current !== "number") return null;
      return { value: current + by };
    },
  },

  multiply: {
    types: NUMERIC,
    needsRange: false,
    operand: "number",
    apply(current, operand) {
      const by = num(operand);
      if (by === null || typeof current !== "number") return null;
      return { value: current * by };
    },
  },

  random: {
    types: NUMERIC,
    needsRange: true,
    operand: "none",
    apply(_current, _operand, ctx) {
      if (!ctx.range) return null;
      const pick = (ctx.random ?? Math.random)();
      // An Int draws a whole number from the inclusive range. Drawing a float and
      // letting the type check discard it would make `random` on an Int an Effect
      // that fires and almost never writes.
      if (ctx.type === "int") {
        const span = Math.floor(ctx.range.max) - Math.ceil(ctx.range.min);
        if (span < 0) return null;
        return { value: Math.ceil(ctx.range.min) + Math.min(Math.floor(pick * (span + 1)), span) };
      }
      return { value: ctx.range.min + pick * (ctx.range.max - ctx.range.min) };
    },
  },

  copy: {
    types: ["bool", "int", "float"],
    needsRange: false,
    operand: "parameter",
    apply(_current, _operand, ctx) {
      // Offerability already requires the two types to match, so a mismatch here
      // is a hand-edited manifest rather than something the panel produced.
      return ctx.source ? { value: ctx.source.value } : null;
    },
  },

  toggle: {
    types: ["bool"],
    needsRange: false,
    operand: "none",
    apply(current) {
      return typeof current === "boolean" ? { value: !current } : null;
    },
  },

  bounce: {
    types: NUMERIC,
    needsRange: true,
    operand: "number",
    apply(current, operand, ctx) {
      if (!ctx.range || typeof current !== "number") return null;
      const step = Math.abs(num(operand) ?? 1);
      // The direction is carried in rather than derived, because a value between
      // the bounds says nothing about which way it was going. At a bound it is
      // derived, so a run that starts there heads the only way it can.
      let direction: BounceDirection = ctx.direction ?? 1;
      if (current >= ctx.range.max) direction = -1;
      else if (current <= ctx.range.min) direction = 1;
      const next = current + step * direction;
      // Reflected rather than clamped: that reflection is the whole reason this
      // operation exists, since every other numeric one pins at a bound and stays.
      if (next > ctx.range.max) return { value: ctx.range.max, direction: -1 };
      if (next < ctx.range.min) return { value: ctx.range.min, direction: 1 };
      return { value: next, direction };
    },
  },
};

/** Whether an operation can be applied to a Parameter at all. */
export function opApplies(op: EffectOp, parameter: Parameter, hasRange: boolean): boolean {
  const spec = EFFECT_SPECS[op];
  if (!spec) return false;
  if (!spec.types.includes(parameter.type)) return false;
  return !spec.needsRange || hasRange;
}

/** The operations offerable for one Parameter, which is what the panel lists. */
export function opsForParameter(parameter: Parameter, hasRange: boolean): EffectOp[] {
  return (Object.keys(EFFECT_SPECS) as EffectOp[]).filter((op) => opApplies(op, parameter, hasRange));
}

/**
 * Apply one Effect, or decline.
 *
 * Declining covers three different things and deliberately looks the same to the
 * caller: an operation this build does not know, one that cannot apply to this
 * Parameter, and a result the type cannot hold. All three mean "no write", and
 * the caller reports rather than guessing at a value.
 */
export function applyEffect(
  effect: Effect,
  parameter: Parameter,
  current: ParameterValue,
  ctx: EffectContext,
): EffectResult | null {
  const spec = EFFECT_SPECS[effect.op];
  if (!spec) return null;
  if (!opApplies(effect.op, parameter, ctx.range !== null)) return null;
  const result = spec.apply(current, effect.operand, ctx);
  if (result === null) return null;
  if (typeof result.value === "boolean") {
    return parameter.type === "bool" ? result : null;
  }
  const held = fits(result.value, parameter.type);
  return held === null ? null : { value: held.value, direction: result.direction };
}
