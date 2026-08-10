import { useMemo, useRef, useState, type ReactNode } from "react";
import type { SlotSpec, TemplateBaseline, TemplateRole } from "../../../shared/src/types";
import {
  escapeLiteralBraces,
  isUniversalSlot,
  validateTemplate,
  type TemplateError,
} from "../../../shared/src/templates";
import { renderPreview } from "../templatePreview";

export interface TemplateFieldProps {
  /**
   * The role, when this template is one.
   *
   * Optional because the six settings-level prompts are Templates too and none
   * of them is a role. Everything that used to be derived from it now comes
   * from `slots` and `id`, so the two kinds of editor differ in what they are
   * given rather than in which component renders them.
   */
  role?: TemplateRole;
  /** Stable key for test ids and the preview's sample. Defaults to the role. */
  id?: string;
  /**
   * Whether the stored text is already read as a Template.
   *
   * Only the six settings-level prompts pass this — a role's template always
   * is one. When it is false and the text carries braces the parser would
   * refuse, the editor offers to escape them rather than leaving the user with
   * an error they cannot act on.
   */
  isTemplate?: boolean;
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
  /**
   * Baselines, when this template has them.
   *
   * Optional because they are keyed by role, and the six settings-level prompts
   * are not roles. They get validation, the slot list and the preview; saving a
   * second thing to fall back to is a role's affordance until the store learns
   * to key by something else.
   */
  onSaveBaseline?: (text: string) => void;
  onRevertToBaseline?: () => void;
  /**
   * Extra controls in the action row — the narration presets are the only user.
   *
   * A render prop rather than a node, because the preset picker has to know
   * whether the draft is dirty before it offers to replace it. Checking only
   * the stored value would discard whatever the user typed but had not applied.
   */
  extraActions?: (ctx: { dirty: boolean }) => ReactNode;
}

type State = "shipped" | "baseline" | "edited";

/**
 * Split a vocabulary into the groups the reader thinks in.
 *
 * A flat list was fine at three names. A Conversation prompt is about to hold
 * roughly eighteen drawn from three different sources plus the universal tier,
 * and the complaint this whole feature started from was that a reading existed
 * and could not be found. Grouping is what keeps that from being reintroduced
 * at larger scale.
 *
 * By Observation Source rather than alphabetically, because the source is what
 * a reading belongs to — it decides which Context Level pays for it, and two
 * readings from the same source truncate together.
 */
const SOURCE_TITLE: Record<string, string> = {
  vision: "what I can see",
  session: "the session I am watching",
  monitor: "the logs I watch",
};

export function groupSlots(slots: readonly SlotSpec[]): { title: string; slots: SlotSpec[] }[] {
  const own = slots.filter((s) => !isUniversalSlot(s.name));
  const universal = slots.filter((s) => isUniversalSlot(s.name));
  const groups: { title: string; slots: SlotSpec[] }[] = [];

  const unsourced = own.filter((s) => s.source === undefined);
  if (unsourced.length > 0) groups.push({ title: "this message", slots: unsourced });

  // In the order the shipped context template places them, not alphabetically:
  // a list that reads in the order the message is built is a list you can scan
  // against the message.
  for (const source of ["session", "vision", "monitor"]) {
    const inSource = own.filter((s) => s.source === source);
    if (inSource.length > 0) groups.push({ title: SOURCE_TITLE[source] ?? source, slots: inSource });
  }

  if (universal.length > 0) groups.push({ title: "everywhere", slots: universal });
  return groups;
}

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
  id,
  isTemplate,
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
  extraActions,
}: TemplateFieldProps) {
  const key = id ?? role ?? "template";
  const resolved = stored ?? shipped;
  const [draft, setDraft] = useState(resolved);
  const [showSlots, setShowSlots] = useState(false);
  const area = useRef<HTMLTextAreaElement | null>(null);

  // Re-seed the draft when the stored template changes underneath it.
  //
  // Without this the textarea keeps whatever was last typed, so reset, revert
  // to baseline, and take-the-new-default all appear to do nothing — and
  // pressing apply afterwards stores the text the user had just discarded.
  // Tracked as last-seen rather than in an effect so the corrected value is
  // rendered on the same pass, with no frame showing the stale text.
  const [seen, setSeen] = useState(resolved);
  if (seen !== resolved) {
    setSeen(resolved);
    setDraft(resolved);
  }

  // Validated against the slot list this editor is showing, not against the
  // role. They are the same thing when a role is given, and when one is not
  // there is no role to ask — but more importantly, validating against
  // anything other than what the user can see is how a slot gets refused with
  // no way to find out it existed.
  const errors = useMemo(() => validateTemplate(draft, slots), [draft, slots]);
  const preview = useMemo(() => renderPreview(key, draft, slots), [key, draft, slots]);
  // Degradation is about the STORED template, not the draft. A name being
  // typed wrong is a misspelling and the error list above says so; a stored
  // template naming a slot a release withdrew is a different thing the user
  // did not do, and it is the one worth a standing notice.
  const degraded = useMemo(
    () =>
      stored == null
        ? []
        : validateTemplate(stored, slots)
            .filter((e) => e.kind === "unknown-slot")
            .map((e) => e.name ?? ""),
    [stored, slots],
  );
  // A prompt that has not opted in yet, carrying braces this vocabulary would
  // refuse. Escaping is offered rather than applied: the braces might be a JSON
  // example the user wants kept, or the start of a slot they are typing.
  const needsEscaping = isTemplate === false && errors.length > 0 && /[{}]/.test(draft);
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
    <div className="field template-field" data-testid={`template-${key}`}>
      <div className="template-head">
        <span className="template-label">{label}</span>
        <span className="template-state" data-testid={`template-state-${key}`}>
          {STATE_LABEL[state]}
        </span>
      </div>

      {behind ? (
        <div className="template-behind" data-testid={`template-behind-${key}`}>
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
        <ul className="template-errors" data-testid={`template-errors-${key}`}>
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

      {needsEscaping ? (
        <div className="template-escape" data-testid={`template-escape-${key}`}>
          <strong>this prompt was written before it was a template.</strong> its braces are read as slots
          now, and a name that is not one is dropped rather than shown. escaping turns every brace into a
          literal one, which is what it used to be.
          <button className="ghost" onClick={() => setDraft(escapeLiteralBraces(draft))}>
            escape the braces
          </button>
        </div>
      ) : null}

      {degraded.length > 0 ? (
        <p className="template-degraded" data-testid={`template-degraded-${key}`}>
          this stored template is degraded: {degraded.join(", ")} no longer exists, and renders as nothing.
        </p>
      ) : null}

      {usesIdentity ? (
        <p className="template-identity" data-testid={`template-identity-${key}`}>
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
        {onSaveBaseline ? (
          <button
            className="ghost"
            disabled={errors.length > 0 || draft === baseline?.text}
            onClick={() => onSaveBaseline(draft)}
          >
            save as baseline
          </button>
        ) : null}
        {baseline && onRevertToBaseline ? (
          <button className="ghost" disabled={draft === baseline.text} onClick={onRevertToBaseline}>
            revert to baseline
          </button>
        ) : null}
        {extraActions?.({ dirty })}
      </div>

      {showSlots ? (
        <div className="template-slots" data-testid={`template-slots-${key}`}>
          {groupSlots(slots).map((group) => (
            <section key={group.title}>
              <h5 className="slot-group">{group.title}</h5>
              <ul>
                {group.slots.map((slot) => (
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
            </section>
          ))}
        </div>
      ) : null}

      <div className="template-preview" data-testid={`template-preview-${key}`}>
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
