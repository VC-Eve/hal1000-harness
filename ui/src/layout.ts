/**
 * Which of the three body sections are collapsed, and where the two dividers
 * sit.
 *
 * Kept as a pure module rather than state inside `App` for the same reason
 * `lens.ts` and `monitors.ts` are: the rules worth asserting — the last-visible
 * guard, and what a corrupt stored payload does — have nothing to do with the
 * DOM, and testing them through a rendered tree would be slower and vaguer than
 * testing them directly.
 *
 * This state deliberately does not travel over the WS contract. `AGENTS.md`
 * requires meaningful behaviour to be reachable through `shared/src/types.ts`,
 * and collapsing a pane is not behaviour: no observation starts or stops, HAL
 * says nothing different. It changes what this browser draws, so this browser
 * is where it lives.
 */

export type SectionId = "conversation" | "webcam" | "observation";

export const SECTION_IDS: readonly SectionId[] = ["conversation", "webcam", "observation"];

export const SECTION_LABELS: Record<SectionId, string> = {
  conversation: "conversation",
  webcam: "webcam analysis",
  observation: "session observation",
};

export interface LayoutState {
  collapsed: Record<SectionId, boolean>;
  /** Left column width, percent of the body. */
  split: number;
  /** Conversation's share of the left column height, percent. */
  leftSplit: number;
}

const STORAGE_KEY = "hal1000.layout";

/** Matches the clamp the drag handlers apply, so a stored value can never
 *  restore a geometry the user could not have dragged to. */
const SPLIT_MIN = 20;
const SPLIT_MAX = 80;

export const defaultLayout = (): LayoutState => ({
  collapsed: { conversation: false, webcam: false, observation: false },
  split: 60,
  leftSplit: 60,
});

export const clampSplit = (pct: number): number => Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, pct));

export const visibleCount = (state: LayoutState): number => SECTION_IDS.filter((id) => !state.collapsed[id]).length;

/**
 * A section may be collapsed unless it is the only one left. Collapsing the
 * last one would leave three rails around an empty body, with nothing to
 * restore *to* — an end state no click sequence should be able to reach.
 */
export const canCollapse = (state: LayoutState, id: SectionId): boolean =>
  state.collapsed[id] || visibleCount(state) > 1;

/**
 * Toggle one section, returning the state unchanged when the guard forbids it.
 *
 * The guard lives here rather than only in the disabled button because a
 * caller that forgets to check `canCollapse` should not be able to produce the
 * empty body anyway. The disabled button is the affordance; this is the rule.
 */
export function toggleCollapse(state: LayoutState, id: SectionId): LayoutState {
  if (!canCollapse(state, id)) return state;
  return { ...state, collapsed: { ...state.collapsed, [id]: !state.collapsed[id] } };
}

/**
 * The grid tracks each layout resolves to.
 *
 * Derived here rather than in the component so the five distinct layouts can be
 * asserted directly. The tracks and the children have to agree — a rail column
 * that declares three tracks for two rails, or a track list that still reserves
 * a divider slot after the divider stopped rendering, is a class of bug no
 * "is this element present" test can see.
 *
 * `stackRows` is the same layout stacked for a narrow viewport, where the
 * dividers are display:none and so are not grid items at all. It is computed
 * here, alongside the wide tracks, because the stylesheet cannot know the
 * collapse state and the previous attempt to express it in CSS needed
 * `!important` overrides that silently contradicted these values.
 */
export interface LayoutTracks {
  columns: string;
  rows: string;
  stackRows: string;
}

const RAIL = "auto";
const FILL = "minmax(0, 1fr)";
const DIVIDER = "6px";

export const leftIsRails = (state: LayoutState): boolean => state.collapsed.conversation && state.collapsed.webcam;

/** A divider only earns its place with an expanded section on both sides of it. */
export const showVerticalDivider = (state: LayoutState): boolean => !leftIsRails(state) && !state.collapsed.observation;
export const showHorizontalDivider = (state: LayoutState): boolean => !state.collapsed.conversation && !state.collapsed.webcam;

export function deriveTracks(state: LayoutState): LayoutTracks {
  const { collapsed } = state;
  const leftTrack = leftIsRails(state) ? RAIL : collapsed.observation ? FILL : `minmax(0, ${state.split}%)`;
  const rightTrack = collapsed.observation ? RAIL : FILL;

  const columns = showVerticalDivider(state) ? `${leftTrack} ${DIVIDER} ${rightTrack}` : `${leftTrack} ${rightTrack}`;

  // Two rails share the column evenly so they fill it, rather than sitting as
  // two short buttons above empty background.
  const rows = leftIsRails(state)
    ? `${FILL} ${FILL}`
    : showHorizontalDivider(state)
      ? `minmax(0, ${state.leftSplit}%) ${DIVIDER} ${FILL}`
      : `${collapsed.conversation ? RAIL : FILL} ${collapsed.webcam ? RAIL : FILL}`;

  const stackRows = `${leftIsRails(state) ? RAIL : "minmax(0, 2fr)"} ${rightTrack}`;

  return { columns, rows, stackRows };
}

/**
 * Whether a left-column rail lies along the column's edge or across its width.
 *
 * A rail is only a vertical strip when the whole column has become rails. A
 * lone collapsed section still sits inside a full-width column, so a 26px
 * vertical strip there would leave a dead band beside it — it belongs across
 * the top or bottom instead.
 */
export const railIsVertical = (state: LayoutState, id: SectionId): boolean =>
  id === "observation" ? true : leftIsRails(state);

const isLayout = (value: unknown): value is LayoutState => {
  if (typeof value !== "object" || value === null) return false;
  const { collapsed, split, leftSplit } = value as Partial<LayoutState>;
  if (typeof split !== "number" || !Number.isFinite(split)) return false;
  if (typeof leftSplit !== "number" || !Number.isFinite(leftSplit)) return false;
  if (typeof collapsed !== "object" || collapsed === null) return false;
  return SECTION_IDS.every((id) => typeof (collapsed as Record<string, unknown>)[id] === "boolean");
};

/**
 * Read the stored layout, falling back to all-visible on anything unexpected.
 *
 * Every failure is the same failure as far as the user is concerned — they get
 * the default layout — so the parse, the shape check, and the access itself all
 * funnel to one fallback. `localStorage` throws outright under some privacy
 * settings, and a preference module that can take the whole UI down with it is
 * a far worse trade than a forgotten divider position.
 */
export function loadLayout(): LayoutState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return defaultLayout();
    const parsed: unknown = JSON.parse(raw);
    if (!isLayout(parsed)) return defaultLayout();
    // Shape-valid is not the same as reachable. `canCollapse` makes an
    // all-collapsed state impossible to click your way into, but storage is
    // editable by hand and survives across versions, so the invariant is
    // re-checked on the way in rather than trusted.
    if (visibleCount(parsed) === 0) return defaultLayout();
    return { ...parsed, split: clampSplit(parsed.split), leftSplit: clampSplit(parsed.leftSplit) };
  } catch {
    return defaultLayout();
  }
}

/** Persist the layout, silently giving up if storage refuses. Losing a
 *  preference is not worth an exception on a render path. */
export function saveLayout(state: LayoutState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage unavailable or full; the layout simply will not persist.
  }
}
