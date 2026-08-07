import { SECTION_LABELS, type SectionId } from "../layout";

// The two halves of one affordance: the control that sends a section away, and
// the strip it leaves behind. They live in one file because neither means
// anything without the other — a collapse with no rail is a section the user
// cannot get back.

interface CollapseProps {
  id: SectionId;
  disabled: boolean;
  onCollapse: () => void;
}

/**
 * The control each section carries in its own header.
 *
 * Disabled rather than hidden when this is the last visible section: a control
 * that vanishes reads as a bug, while one that greys out says the rule is
 * deliberate. `title` carries the reason, since the disabled state alone does
 * not explain itself.
 */
export function CollapseButton({ id, disabled, onCollapse }: CollapseProps) {
  return (
    <button
      className="ghost collapse-button"
      onClick={onCollapse}
      disabled={disabled}
      aria-label={`Collapse ${SECTION_LABELS[id]}`}
      title={disabled ? "The last visible section cannot be collapsed" : `Collapse ${SECTION_LABELS[id]}`}
      data-testid={`collapse-${id}`}
    >
      ⇤
    </button>
  );
}

interface RailProps {
  id: SectionId;
  /** Vertical along a column edge, horizontal across a column's width. */
  orientation: "vertical" | "horizontal";
  onExpand: () => void;
}

/**
 * What a collapsed section becomes: a labelled strip on its own edge.
 *
 * The whole rail is the button rather than an icon inside one, so the target is
 * the full length of the strip — a 26px-thick control is hard enough to hit
 * without also being short. The label is rendered as text and turned on its
 * side by CSS when the rail is vertical, which keeps it readable to a screen
 * reader and searchable in the DOM.
 *
 * Orientation is passed in rather than inferred from a parent selector because
 * it is a fact about the layout, not about this element: the same collapsed
 * section is an edge strip when its whole column has become rails and a
 * full-width band when it has not.
 */
export function SectionRail({ id, orientation, onExpand }: RailProps) {
  return (
    <button
      className={`section-rail ${orientation}`}
      onClick={onExpand}
      aria-label={`Expand ${SECTION_LABELS[id]}`}
      title={`Expand ${SECTION_LABELS[id]}`}
      data-testid={`rail-${id}`}
    >
      <span className="rail-arrow" aria-hidden="true">
        ⇥
      </span>
      <span className="rail-label">{SECTION_LABELS[id]}</span>
    </button>
  );
}
