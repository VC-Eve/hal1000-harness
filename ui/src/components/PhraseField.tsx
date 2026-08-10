import { useMemo, useRef, useState } from "react";
import type { PhraseSpec } from "../../../shared/src/types";
import { renderTemplateText, validateTemplate } from "../../../shared/src/templates";

// One illustrative value per field name, so the preview reads like a real line
// rather than like a form. Shared across phrases because the field names are
// consistent — a `{name}` is a name wherever it appears.
const SAMPLE: Record<string, string> = {
  who: "Creator 74%",
  held: "set",
  age: "6 minutes",
  run: "set",
  strength: "steadily across that whole run",
  name: "Creator",
  percent: " 74%",
  profile: "builds HAL, prefers blunt answers",
  count: "3",
  plural: "s",
  stamp: "18:14:51",
  text: "I see it reading the router.",
  label: "Claude Code [a408c0a1]",
  clock: "18:22:04",
  when: "12 seconds ago at 18:21:52",
  caption: "A person sits at a desk, facing the screen.",
};

export interface PhraseFieldProps {
  spec: PhraseSpec;
  stored: string | null | undefined;
  onApply: (text: string) => void;
  onReset: () => void;
}

/**
 * One line's wording.
 *
 * Lighter than a template editor on purpose: a phrase is a single line with a
 * handful of fields, so it gets one row of input, its fields listed inline, and
 * the rendered result underneath. The heavier apparatus — baselines, the
 * behind-a-release diff — belongs to whole messages, not to one sentence.
 */
export function PhraseField({ spec, stored, onApply, onReset }: PhraseFieldProps) {
  const resolved = stored ?? spec.shipped;
  const [draft, setDraft] = useState(resolved);
  const area = useRef<HTMLTextAreaElement | null>(null);

  // Re-seed when the stored value changes underneath, for the reason the
  // template editor does: otherwise reset appears to do nothing.
  const [seen, setSeen] = useState(resolved);
  if (seen !== resolved) {
    setSeen(resolved);
    setDraft(resolved);
  }

  const errors = useMemo(() => validateTemplate(draft, spec.fields), [draft, spec.fields]);
  const preview = useMemo(
    () =>
      renderTemplateText(draft, {
        vocabulary: spec.fields,
        resolve: (req) => ({ text: SAMPLE[req.name] ?? "" }),
      }).text,
    [draft, spec.fields],
  );

  const edited = stored != null && stored !== spec.shipped;
  const dirty = draft !== resolved;

  return (
    <div className="phrase-field" data-testid={`phrase-${spec.id}`}>
      <div className="phrase-head">
        <span className="phrase-label">{spec.label}</span>
        {edited ? <span className="phrase-state">edited</span> : null}
      </div>
      <small className="phrase-meaning">{spec.meaning}</small>

      <textarea
        ref={area}
        className="prompt-input phrase-input"
        rows={2}
        value={draft}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
      />

      {errors.length > 0 ? (
        <ul className="template-errors" data-testid={`phrase-errors-${spec.id}`}>
          {errors.map((err, i) => (
            <li key={i}>
              {err.message}
              {err.valid ? <span className="template-valid"> fields here: {err.valid.join(", ")}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}

      {spec.fields.length > 0 ? (
        <div className="phrase-fields">
          {spec.fields.map((f) => (
            <span key={f.name} className="phrase-chip" title={f.meaning}>
              {f.condition ? `{#${f.name}}…{/}` : `{${f.name}}`}
            </span>
          ))}
        </div>
      ) : null}

      {/* A phrase with no fields renders to itself, so a preview under it would
          be the same sentence twice. Shown only when something is substituted. */}
      {spec.fields.length > 0 ? (
        <div className="phrase-preview" data-testid={`phrase-preview-${spec.id}`}>
          <pre>{preview.length > 0 ? preview : "(nothing)"}</pre>
        </div>
      ) : null}

      <div className="prompt-actions">
        <button className="ghost" disabled={!dirty || errors.length > 0} onClick={() => onApply(draft)}>
          apply
        </button>
        <button className="ghost" disabled={!edited && !dirty} onClick={onReset}>
          reset
        </button>
      </div>

      <details className="slot-note">
        <summary>why it is worded this way</summary>
        <p>{spec.note}</p>
      </details>
    </div>
  );
}
