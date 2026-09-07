import { AUDIO_READOUTS, readoutFor } from "../../../shared/src/audio";
import { defaultValueOf } from "../../../shared/src/world-graph";
import { opsFor } from "../../../shared/src/worlds";
import type { Condition, ConditionOp, ParameterType, World } from "../../../shared/src/types";

/**
 * The clause rows, for either holder of clauses.
 *
 * Lifted out of `TransitionPanel` when overlay slots gained conditions, rather
 * than written a second time. One implementation is the whole point: the picker
 * and the reports already share `opsFor` so that a report cannot disagree with
 * the editor about what is legal, and two condition editors would have put that
 * agreement back at risk on the side nobody was looking at.
 *
 * Pure over `(conditions, world, editable, onChange)`. The caller decides what a
 * change means — a `update-transition` patch on one side, a whole-list
 * `set-world-overlays` on the other — which is the only thing that differs.
 *
 * `owner` is not decoration. The labels used to read `condition 0 parameter`
 * with nothing saying whose, and with a transition's rows and a slot's on screen
 * at once that names two controls the same thing — for a screen reader and for
 * every test that queries by label.
 *
 * `emptyLabel` likewise: a transition with no clauses is "offered whenever it is
 * evaluated", and a slot is neither offered nor evaluated — it is drawn. The
 * component that serves both cannot hold one holder's vocabulary.
 */
export interface ConditionRowsProps {
  conditions: readonly Condition[];
  world: World;
  editable: boolean;
  /** What names these rows in a label, e.g. a transition's name or `slot 2`. */
  owner: string;
  /** What to say when there are none, in the holder's own words. */
  emptyLabel: string;
  onChange: (conditions: Condition[]) => void;
}

export const OP_LABEL: Record<ConditionOp, string> = {
  is: "is",
  isNot: "is not",
  gt: ">",
  lt: "<",
  eq: "==",
  neq: "!=",
};

/**
 * What a fresh clause starts as.
 *
 * The World's own first, because that is what the author declared; the readouts
 * are the fallback so a World that declares nothing can still condition on
 * audio. Complete from the moment it is added — there is no half-authored state
 * for a write filter to delete, which
 * docs/solutions/a-lenient-load-and-a-strict-write-need-a-filter-between-them.md
 * is the reason to care about.
 */
export function seedCondition(world: World): Condition {
  const first = world.parameters[0];
  if (first) return { parameter: first.name, op: opsFor(first.type)[0]!, value: defaultValueOf(first) };
  const readout = AUDIO_READOUTS[0]!;
  return { parameter: readout.name, op: opsFor(readout.type)[0]!, value: readout.idle };
}

/**
 * The type a name compares as: declared, then reserved, then bool.
 *
 * The reserved lookup is not optional. `audio.remaining` is an int and is
 * deliberately absent from `world.parameters`, so a fallback that skipped the
 * readouts would offer `is` and `is not` for a number — a clause that can never
 * hold, which is exactly the defect `repoint` exists to stop.
 */
export function typeOf(world: World, name: string): ParameterType {
  return world.parameters.find((p) => p.name === name)?.type ?? readoutFor(name)?.type ?? "bool";
}

/**
 * A clause re-pointed at a different Parameter.
 *
 * The operator and the value have to come with it. Spreading the old clause and
 * swapping only the name kept an `is` from a bool onto an int, which
 * `clauseHolds` reads as "equals false" — a clause that can never hold, on a
 * transition that then silently never fires. A World in use collected three of
 * them this way, one authored *after* the operator picker was fixed, because the
 * picker only decides what is offered and this decides what is kept. See
 * docs/solutions/a-fix-to-what-a-picker-offers-is-not-a-fix-to-what-it-keeps.md.
 *
 * Kept when the type has not changed, so re-pointing `energy > 75` at another
 * int leaves the comparison the author already wrote.
 */
export function repoint(world: World, condition: Condition, parameter: string): Condition {
  const was = typeOf(world, condition.parameter);
  const now = typeOf(world, parameter);
  if (was === now && opsFor(now).includes(condition.op)) return { ...condition, parameter };
  const declared = world.parameters.find((p) => p.name === parameter);
  const value = declared ? defaultValueOf(declared) : (readoutFor(parameter)?.idle ?? false);
  return { parameter, op: opsFor(now)[0]!, value };
}

export function ConditionRows({ conditions, world, editable, owner, emptyLabel, onChange }: ConditionRowsProps) {
  const at = (index: number, next: Condition) => onChange(conditions.map((c, i) => (i === index ? next : c)));

  return (
    <>
      {conditions.length === 0 && <p className="muted">{emptyLabel}</p>}
      {conditions.map((condition, index) => {
        const type = typeOf(world, condition.parameter);
        return (
          <div key={index} className="condition">
            <select
              aria-label={`condition ${index} parameter — ${owner}`}
              disabled={!editable}
              value={condition.parameter}
              onChange={(e) => at(index, repoint(world, condition, e.target.value))}
            >
              {/* Grouped so the qualifier reads as a namespace rather than as six
                  oddly-named Parameters somebody declared. */}
              {world.parameters.length > 0 && (
                <optgroup label="declared">
                  {world.parameters.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.name}
                    </option>
                  ))}
                </optgroup>
              )}
              <optgroup label="audio">
                {AUDIO_READOUTS.map((readout) => (
                  <option key={readout.name} value={readout.name}>
                    {readout.name}
                  </option>
                ))}
              </optgroup>
            </select>
            <select
              aria-label={`condition ${index} operator — ${owner}`}
              disabled={!editable}
              value={condition.op}
              onChange={(e) => at(index, { ...condition, op: e.target.value as ConditionOp })}
            >
              {opsFor(type).map((op) => (
                <option key={op} value={op}>
                  {OP_LABEL[op]}
                </option>
              ))}
            </select>
            {type === "bool" || type === "trigger" ? (
              <select
                aria-label={`condition ${index} value — ${owner}`}
                disabled={!editable}
                value={condition.value === true ? "true" : "false"}
                onChange={(e) => at(index, { ...condition, value: e.target.value === "true" })}
              >
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            ) : (
              <input
                type="number"
                aria-label={`condition ${index} value — ${owner}`}
                disabled={!editable}
                value={typeof condition.value === "number" ? condition.value : 0}
                step={type === "float" ? 0.1 : 1}
                onChange={(e) => {
                  // Refused where it is typed, never written. A number input
                  // takes `1e999`, which is `Infinity`; `isCondition` then
                  // refuses the clause, `cleanSlot` refuses the slot, and the
                  // editor's write filter drops it from the list — so a
                  // keystroke in an unbounded field deleted the slot's words,
                  // font, colour and picture with no warning. `commitSize`,
                  // `commitOpacity` and the fade field all refuse in place for
                  // the same reason.
                  // An empty field is a value being retyped, not a zero. Writing
                  // one sends a whole `set-world-overlays` — a manifest write
                  // and a broadcast to every client — for a number the operator
                  // is in the middle of changing.
                  const raw = e.target.value.trim();
                  if (raw.length === 0) return;
                  const asked = Number(raw);
                  if (!Number.isFinite(asked)) return;
                  at(index, { ...condition, value: asked });
                }}
              />
            )}
            <button
              className="ghost"
              aria-label={`remove condition ${index} — ${owner}`}
              disabled={!editable}
              onClick={() => onChange(conditions.filter((_, i) => i !== index))}
            >
              remove
            </button>
          </div>
        );
      })}
      <button
        className="ghost"
        aria-label={`add condition — ${owner}`}
        disabled={!editable}
        onClick={() => onChange([...conditions, seedCondition(world)])}
      >
        add condition
      </button>
    </>
  );
}
