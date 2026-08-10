import { useMemo, useRef, useState } from "react";
import type { SlotSpec, TemplateBaseline, TemplateRole } from "../../../shared/src/types";
import { validateTemplate, type TemplateError } from "../../../shared/src/templates";
import { renderPreview } from "../templatePreview";

export interface TemplateFieldProps {
  role: TemplateRole;
  label: string;
  /** What this template is for, in one line. */
  note: string;
  /** The stored value: null means never edited. */
  stored: string | null | undefined;
  /** What the current release ships for this role. */
  shipped: string;
  slots: readonly SlotSpec[];
  baseline: TemplateBaseline | undefined;
  onApply: (text: string) => void;
  onReset: () => void;
  onSaveBaseline: (text: string) => void;
  onRevertToBaseline: () => void;
}

type State = "shipped" | "baseline" | "edited";

/** Which of the three things this template currently is. */
function stateOf(text: string, shipped: string, baseline: TemplateBaseline | undefined): State {
  if (text === shipped) return "shipped";
  if (baseline && text === baseline.text) return "baseline";
  return "edited";
}

const STATE_LABEL: Record<State, string> = {
  shipped: "shipped default",
  baseline: "your baseline",
  edited: "edited",
};

/**
 * One template editor.
 *
 * Deliberately more than a textarea. The whole feature exists so that text
 * reaching a model stops being hidden, and a language nobody can discover is
 * hidden by another route — so the slots a role accepts are listed here with
 * what each one means and what its wording is protecting, rather than being
 * learned by typing something wrong and reading the rejection.
 */
export function TemplateField({
  role,
  label,
  note,
  stored,
  shipped,
  slots,
  baseline,
  onApply,
  onReset,
  onSaveBaseline,
  onRevertToBaseline,
}: TemplateFieldProps) {
  const resolved = stored ?? shipped;
  const [draft, setDraft] = useState(resolved);
  const [showSlots, setShowSlots] = useState(false);
  const area = useRef<HTMLTextAreaElement | null>(null);

  const errors = useMemo(() => validateTemplate(draft, role), [draft, role]);
  const preview = useMemo(() => renderPreview(role, draft), [draft, role]);
  // Degradation is about the STORED template, not the draft. A name being
  // typed wrong is a misspelling and the error list above says so; a stored
  // template naming a slot a release withdrew is a different thing the user
  // did not do, and it is the one worth a standing notice.
  const degraded = useMemo(
    () =>
      stored == null
        ? []
        : validateTemplate(stored, role)
            .filter((e) => e.kind === "unknown-slot")
            .map((e) => e.name ?? ""),
    [stored, role],
  );
  const state = stateOf(resolved, shipped, baseline);
  const dirty = draft !== resolved;
  const behind = baseline !== undefined && baseline.shippedDefault !== shipped;
  const identitySlots = slots.filter((s) => s.identity);
  const usesIdentity = identitySlots.some((s) => draft.includes(`{${s.name}}`) || draft.includes(`{#${s.name}}`));

  // The offending span is selected rather than described, because "position
  // 214" against a six-line textarea is a number the reader cannot use.
  const pointAt = (at: number): void => {
    const el = area.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(at, Math.min(at + 1, draft.length));
  };

  const insert = (name: string, isCondition: boolean): void => {
    const el = area.current;
    const snippet = isCondition ? `{#${name}}{/}` : `{${name}}`;
    if (!el) {
      setDraft(draft + snippet);
      return;
    }
    const start = el.selectionStart;
    const end = el.selectionEnd;
    setDraft(draft.slice(0, start) + snippet + draft.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      const caret = start + (isCondition ? name.length + 3 : snippet.length);
      el.setSelectionRange(caret, caret);
    });
  };

  return (
    <div className="field template-field" data-testid={`template-${role}`}>
      <div className="template-head">
        <span className="template-label">{label}</span>
        <span className="template-state" data-testid={`template-state-${role}`}>
          {STATE_LABEL[state]}
        </span>
      </div>

      {behind ? (
        <div className="template-behind" data-testid={`template-behind-${role}`}>
          <strong>the shipped default for this template changed.</strong> your text is unaffected; taking the
          new default replaces it, which is what your baseline is for.
          <details>
            <summary>what changed</summary>
            <div className="template-diff">
              <pre className="was">{baseline?.shippedDefault}</pre>
              <pre className="now">{shipped}</pre>
            </div>
          </details>
          <button className="ghost" onClick={() => onApply(shipped)}>
            take the new default
          </button>
        </div>
      ) : null}

      <textarea
        ref={area}
        className="prompt-input template-input"
        rows={10}
        value={draft}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
      />

      {errors.length > 0 ? (
        <ul className="template-errors" data-testid={`template-errors-${role}`}>
          {errors.map((err: TemplateError, i) => (
            <li key={i}>
              <button className="linkish" onClick={() => pointAt(err.at)}>
                {err.message}
              </button>
              {err.kind === "unknown-slot" && err.valid ? (
                <span className="template-valid"> valid here: {err.valid.join(", ")}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {degraded.length > 0 ? (
        <p className="template-degraded" data-testid={`template-degraded-${role}`}>
          this stored template is degraded: {degraded.join(", ")} no longer exists, and renders as nothing.
        </p>
      ) : null}

      {usesIdentity ? (
        <p className="template-identity" data-testid={`template-identity-${role}`}>
          this template places a reading that may be uncertain. wording around it can assert more than the
          reading supports — &ldquo;confirmed present&rdquo; ahead of a match reads as certainty the number does
          not carry.
        </p>
      ) : null}

      <div className="prompt-actions">
        <button className="ghost" onClick={() => setShowSlots((s) => !s)}>
          {showSlots ? "hide slots" : `slots (${slots.length})`}
        </button>
        <button className="ghost" disabled={!dirty || errors.length > 0} onClick={() => onApply(draft)}>
          apply
        </button>
        <button className="ghost" disabled={state === "shipped" && !dirty} onClick={onReset}>
          reset
        </button>
        <button className="ghost" disabled={errors.length > 0 || draft === baseline?.text} onClick={() => onSaveBaseline(draft)}>
          save as baseline
        </button>
        {baseline ? (
          <button className="ghost" disabled={draft === baseline.text} onClick={onRevertToBaseline}>
            revert to baseline
          </button>
        ) : null}
      </div>

      {showSlots ? (
        <ul className="template-slots" data-testid={`template-slots-${role}`}>
          {slots.map((slot) => (
            <li key={slot.name}>
              <button className="linkish" onClick={() => insert(slot.name, Boolean(slot.condition))}>
                {slot.condition ? `{#${slot.name}}…{/}` : `{${slot.name}}`}
              </button>
              <span className="slot-meaning">{slot.meaning}</span>
              {slot.count ? <span className="slot-flag">takes a [count]</span> : null}
              <details className="slot-note">
                <summary>why it is worded this way</summary>
                <p>{slot.note}</p>
              </details>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="template-preview" data-testid={`template-preview-${role}`}>
        <span className="preview-label">renders as</span>
        <pre>{preview.text.length > 0 ? preview.text : "(nothing — every block dropped)"}</pre>
        {preview.dropped.length > 0 ? (
          <small>dropped, because their slot had nothing to say: {preview.dropped.join(", ")}</small>
        ) : null}
      </div>

      <small>{note}</small>
    </div>
  );
}
