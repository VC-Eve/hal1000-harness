/**
 * Where `/live`'s two seams sit, and whether the clip player is mounted.
 *
 * A sibling of `layout.ts` rather than a second use of it. The three-pane body
 * and the World surface share a gesture — drag a bar, remember where it landed
 * — and share nothing else: there is no collapse here, no rails, no
 * last-visible guard, and one of the three columns is a video that can be
 * dismissed outright. Sharing the module would mean a state shape where half
 * the fields are inapplicable on either surface, so what is shared is the
 * discipline: a pure module for the rules worth asserting, a clamp used by both
 * the drag and the load path, and a `localStorage` access that cannot take the
 * UI down with it.
 *
 * Its own storage key for the same reason. A schema change on one surface must
 * not hand the other a shape it will reject.
 *
 * Like `layout.ts`, this state deliberately does not travel over the WS
 * contract — see the note on `video` below, which is the one field where that
 * needed thinking about rather than asserting.
 */

export interface LiveLayoutState {
  /** Stage column width, percent of the body. */
  stage: number;
  /** Sidebar width, percent of the body. */
  side: number;
  /**
   * Whether the clip player is mounted.
   *
   * Stored here, per browser, and not on the wire. Hiding the video is not
   * purely a drawing decision the way collapsing a pane is: the `<video>` is
   * the only thing that ever measures a clip's real length
   * (`useClipStage`'s `report-clip-duration`, which `/broadcast` is refused as
   * an observer), so a World worked on with the picture off keeps running
   * unmeasured clips at the runtime's default. That cost is surfaced in the
   * stage column rather than hidden.
   *
   * It stays local anyway, because no *agent-reachable* capability disappears
   * with it — the World, its clips and the transport are all still on the
   * protocol — and because a per-browser render preference on the wire would
   * be a second authority over what each client mounts.
   */
  video: boolean;
}

const STORAGE_KEY = "hal1000.live-layout";

/**
 * The clamps, which the drag and the load path share so a stored value can
 * never restore a geometry the user could not have dragged to.
 *
 * The two ranges are deliberately compatible with `CANVAS_MIN`: the widest
 * stage beside the narrowest sidebar is 65, and the widest sidebar beside the
 * narrowest stage is 60, both inside the 70 the canvas leaves. So the joint
 * rule below always has a solution and never has to give up on one of its own
 * bounds.
 */
const STAGE_MIN = 15;
const STAGE_MAX = 50;
const SIDE_MIN = 15;
const SIDE_MAX = 45;

/** The canvas is the thing being worked in, and no pair of drags may take it
 *  below this share of the body. */
const CANVAS_MIN = 30;

const DIVIDER = "6px";

/** `minmax(0, 1fr)` rather than a bare `1fr`, as `layout.ts` does. A grid item
 *  defaults to a min size of auto and will refuse to shrink below its content;
 *  `.graph-canvas` happens to carry `min-width: 0` today, but that would put
 *  the safety in the stylesheet rather than in the track it applies to. */
const FILL = "minmax(0, 1fr)";

/**
 * The pixel floor each side column keeps whatever percentage it is dragged to.
 *
 * Not decoration. A playlist track row is seven items of which exactly one
 * flexes, so the flexible one — the track's name — absorbs the whole deficit
 * whenever the row is over-subscribed; at 262px it rendered a filename one
 * character per line, and as a button it collapsed to no width at all. A drag
 * that can narrow this column is a drag that can reproduce that, and this is
 * what stops it. See `docs/solutions/a-label-may-be-squeezed-a-control-may-not.md`.
 */
const COLUMN_FLOOR = "240px";

/**
 * The stage at 26% and the sidebar at 25%, which is what `/live` renders today.
 *
 * The 25 is arithmetic rather than the number in the stylesheet. `.state-graph`
 * declares its sidebar at `34%`, but of *itself* — and it is the `1fr`
 * remainder of a body whose first column is 26% — so the sidebar has always
 * been about 34% of 74%, near enough a quarter of the body. Flattening the two
 * grids into one is what makes the difference visible: carrying the 34 across
 * unchanged would have started the sidebar a third wider than it has ever been
 * while claiming to reproduce it.
 */
export const defaultLiveLayout = (): LiveLayoutState => ({ stage: 26, side: 25, video: true });

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/**
 * Both widths at once, because they are not independent.
 *
 * CSS cannot enforce the canvas minimum on its own: `minmax(240px, 26%)` caps a
 * track at a share of the container, and giving the canvas `minmax(30%, 1fr)`
 * does not rescue it — grid resolves the track minimums and then overflows the
 * container, which is a 125% grid rather than a clamped one. So the rule lives
 * here.
 *
 * `dragged` names the seam under the hand, and the *other* one gives way. The
 * seam being dragged must not fight back: a bar that stops following the
 * pointer while there is still room in the layout reads as broken, and the
 * room in question belongs to the column nobody is touching.
 *
 * `null` is the load path, where no hand is on either seam and the tiebreak
 * still has to be stated — storage is editable by hand and survives across
 * versions. The sidebar gives way there, matching what a stage drag does,
 * so a hand-edited file resolves the way the commoner gesture would.
 *
 * Deliberately *not* handled here: recovering the width the pressured seam gave
 * up. Dragging out and back must leave it where it started, and that is a fact
 * about one gesture rather than about a pair of numbers — the value to recover
 * to is remembered by the drag, and this function stays pure.
 */
export function clampLiveLayout(next: LiveLayoutState, dragged: "stage" | "side" | null): LiveLayoutState {
  const stage = clamp(next.stage, STAGE_MIN, STAGE_MAX);
  const side = clamp(next.side, SIDE_MIN, SIDE_MAX);
  const room = 100 - CANVAS_MIN;
  if (stage + side <= room) return { ...next, stage, side };

  // `side` is the branch, not `stage`, so that `null` falls in with the stage
  // drag: the sidebar is what gives way unless the sidebar is the seam being
  // held.
  return dragged === "side"
    ? { ...next, stage: clamp(room - side, STAGE_MIN, STAGE_MAX), side }
    : { ...next, stage, side: clamp(room - stage, SIDE_MIN, SIDE_MAX) };
}

/**
 * The five grid tracks `.live-body` resolves to.
 *
 * Five, not three: the dividers are grid items, so a track list that declared
 * only the three columns would place the sidebar into a 6px divider track and
 * the trailing divider into the sidebar's. That failure draws a plausible
 * layout and breaks no test — jsdom has no grid — so the count is the thing to
 * keep honest.
 *
 * Written as a custom property the stylesheet reads, never as an inline
 * `grid-template-columns`. An inline style beats a stylesheet rule, so a media
 * query would then need `!important` to restyle the grid, and that is exactly
 * how the body layout once ended up with a rule contradicting the comment above
 * it while every check passed. See
 * `docs/solutions/css-tracks-with-two-sources-of-truth.md`.
 */
export function deriveLiveTracks(state: LiveLayoutState): string {
  const stage = `minmax(${COLUMN_FLOOR}, ${state.stage}%)`;
  const side = `minmax(${COLUMN_FLOOR}, ${state.side}%)`;
  return `${stage} ${DIVIDER} ${FILL} ${DIVIDER} ${side}`;
}

const isLiveLayout = (value: unknown): value is LiveLayoutState => {
  if (typeof value !== "object" || value === null) return false;
  const { stage, side, video } = value as Partial<LiveLayoutState>;
  if (typeof stage !== "number" || !Number.isFinite(stage)) return false;
  if (typeof side !== "number" || !Number.isFinite(side)) return false;
  return typeof video === "boolean";
};

/**
 * Read the stored geometry, falling back to the default on anything
 * unexpected.
 *
 * Every failure is the same failure as far as the user is concerned, so the
 * access, the parse and the shape check all funnel to one fallback.
 * `localStorage` throws outright under some privacy settings, and a preference
 * module that can take `/live` down with it is a far worse trade than a
 * forgotten divider position.
 */
export function loadLiveLayout(): LiveLayoutState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return defaultLiveLayout();
    const parsed: unknown = JSON.parse(raw);
    if (!isLiveLayout(parsed)) return defaultLiveLayout();
    // Shape-valid is not the same as reachable, so the clamp runs on the way in
    // as well as during a drag.
    return clampLiveLayout(parsed, null);
  } catch {
    return defaultLiveLayout();
  }
}

/** Persist the geometry, silently giving up if storage refuses. Losing a
 *  preference is not worth an exception on a render path. */
export function saveLiveLayout(state: LiveLayoutState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage unavailable or full; the layout simply will not persist.
  }
}
