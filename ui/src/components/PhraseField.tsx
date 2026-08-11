import { useMemo, useRef, useState } from "react";
import type { PhraseSpec } from "../../../shared/src/types";
import { renderPhrase } from "../../../shared/src/phrases";
import { validateTemplate } from "../../../shared/src/templates";

// One illustrative value per field name, so the preview reads like a real line
// rather than like a form. Shared across phrases because the field names are
// consistent — a `{name}` is a name wherever it appears.
export const SAMPLE: Record<string, string> = {
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
  // A Monitor's label. Every phrase with a `{label}` field is a Monitor one —
  // the Session's name is not a field anywhere, because it is a format. This
  // sampled a session label until the Monitor status lines were added and made
  // the mismatch obvious; the remark line had been previewing it wrongly since
  // phrases shipped.
  label: "windows event log",
  clock: "18:22:04",
  time: "18:21:52",
  // Was missing, so the recently-seen line has been previewing as
  // "last seen  ago" since phrases shipped.
  ago: "4 minutes",
  when: "12 seconds ago at 18:21:52",
  caption: "A person sits at a desk, facing the screen.",
  // The log lines the narrator and the Monitors read. A field with no sample
  // renders empty, which made the tag in `[{kind}] {text}` preview as `[]` —
  // the preview looking broken while the phrase was correct.
  kind: "assistant",
  // `tools` is the bare joined list; `tool_list` is the whole rendered
  // annotation. They are separate keys because they are separate things — the
  // preview samples by field name, so one key could only be right for one of
  // them, and being right for the wrong one is how a preview lies.
  tools: "Read(router.ts), Edit(router.ts)",
  tool_list: " (tools: Read(router.ts), Edit(router.ts))",
  kinds: "2 assistant, 1 tool-result",
  severity_marker: "[severe] ",
  source: "kernel",
  path: "C:/logs/service.log",
  source_label: "kernel: ",
  reason: "fetch failed",
  seconds: "30",
  code: "1",
  exit_clause: " (exit 1)",
  // The Vision caption line, where one name and two read differently enough
  // that the sample uses two.
  names: "Creator 74% and someone who looks like Ada 55%",
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
  // Rendered through `renderPhrase` with the draft standing in as the stored
  // value, rather than through a second call to the engine configured by hand.
  // The hand-configured one omitted `normalize: false` and therefore TRIMMED —
  // so ` (tools: {tools})` and `{source}: ` previewed without the edge space
  // they exist to supply, and the fix a user would make from that preview is to
  // add a space that then ships doubled. Two calls to a renderer with different
  // options is the same defect as two copies of a rule; this is one call.
  const preview = useMemo(
    () => renderPhrase(spec.id, { [spec.id]: draft }, SAMPLE),
    [spec.id, draft],
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
