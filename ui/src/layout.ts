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
