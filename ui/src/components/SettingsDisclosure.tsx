import { useState, type ReactNode } from "react";

/**
 * A collapsed block inside a settings section.
 *
 * The drawer's four subject sections each carry the exact wording HAL sends —
 * eight blocks in total, holding fifty-two editors between them. Stacked open
 * they bury the controls above them; the vision section alone would run past a
 * thousand lines of markup. So they arrive collapsed, and the header says what
 * is inside so a user can tell whether opening it is worth the click.
 *
 * Two behaviours here are load-bearing and easy to undo by accident.
 *
 * Nothing renders until the block is first opened. Role queries ignore the
 * seven inactive sections — they are `hidden`, so the accessibility tree skips
 * them — but the *active* one is fully visible to them, and two assertions in
 * `SettingsPanel.test.tsx` pick buttons out of the vision section by index.
 * Rendering fifty-two editors up front would move both. It also means no block
 * may default to open: one that did would put its buttons back in the tree.
 *
 * Once opened it stays mounted and hides with the `hidden` attribute rather
 * than unmounting. `TemplateField` and `PhraseField` each own their draft, so
 * unmounting on collapse would throw away text the user typed but had not
 * applied — the defect this component family already had once, when a draft
 * lived in two places and reset appeared to do nothing.
 */

/** What one contained editor contributes to the collapsed header. */
export interface ContainedState {
  /** Its stored text differs from the shipped default. */
  edited: boolean;
  /**
   * It is asking for something: behind a saved baseline whose shipped default
   * moved, or storing a template that names a slot a release withdrew. The
   * body is not rendered until opened, so the header is the only way either
   * notice can reach a user who has no reason to click.
   */
  needsAttention: boolean;
}

/**
 * The collapsed header's right-hand half. Worst state wins — a block holding
 * one withdrawn slot and two clean templates has a problem, not two successes.
 */
export function summarise(items: ContainedState[]): string {
  const attention = items.filter((i) => i.needsAttention).length;
  if (attention > 0) return `${items.length}, ${attention} needs attention`;
  const edited = items.filter((i) => i.edited).length;
  if (edited > 0) return `${items.length}, ${edited} edited`;
  return `${items.length}, shipped`;
}

export interface SettingsDisclosureProps {
  label: string;
  /** Usually from `summarise`. Shown beside the label while collapsed. */
  summary: string;
  /** Suffixes the testids, and the screenshot scenes depend on it. */
  testId: string;
  children: ReactNode;
}

export function SettingsDisclosure({ label, summary, testId, children }: SettingsDisclosureProps) {
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(false);

  const toggle = (): void => {
    setOpen(!open);
    setOpened(true);
  };

  return (
    <div className="settings-disclosure">
      <button
        className="settings-disclosure-toggle"
        aria-expanded={open}
        data-testid={`disclosure-${testId}`}
        onClick={toggle}
      >
        <span className="settings-disclosure-caret">{open ? "▾" : "▸"}</span>
        {label}
        <span className="settings-disclosure-summary">— {summary}</span>
      </button>
      {opened ? (
        <div className="settings-disclosure-body" data-testid={`disclosure-body-${testId}`} hidden={!open}>
          {children}
        </div>
      ) : null}
    </div>
  );
}
