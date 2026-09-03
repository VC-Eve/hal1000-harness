import { NODE_H, NODE_ROW_GAP, NODE_W, setMembers } from "../../shared/src/worlds";
import type { Transition, World, WorldReports, WorldState } from "../../shared/src/types";

/**
 * Laying the machine out as a graph.
 *
 * Pure, and beside `layout.ts` and `lens.ts` for the same reason: jsdom
 * implements no SVG layout, so anything computed inside the component could not
 * be asserted. What lives here is arithmetic; the component positions and
 * renders.
 *
 * Node positions come from the manifest — the author drags them and they are
 * saved. What this module supplies is a starting place for a State that has
 * none yet, and every line between them.
 */

export { NODE_H, NODE_W };
export const ANY_STATE_KEY = "__any__";

const MARGIN = 40;
const COL_GAP = 260;
const ROW_GAP = NODE_ROW_GAP;

/** How far apart two transitions between the same pair of nodes are drawn. */
const PARALLEL_GAP = 16;

export interface GraphNode {
  id: string;
  name: string;
  /** How many clips this State can draw from. Zero is a State that holds silently. */
  clipCount: number;
  x: number;
  y: number;
  isDefault: boolean;
  /** Reported as having no satisfiable way out for some Parameter value. */
  deadEnd: boolean;
  /** No path from the default State reaches it. */
  unreachable: boolean;
  /** Holds no clips at all. */
  missingClip: boolean;
  /** Holds clips, none of which will play — a different problem, and a different fix. */
  brokenClips: boolean;
}

export interface GraphLine {
  id: string;
  /** SVG path from the source node to the destination. */
  d: string;
  /** Where the arrowhead and the click target sit. */
  midX: number;
  midY: number;
  fromAny: boolean;
  muted: boolean;
  solo: boolean;
  selfLoop: boolean;
}

export interface Graph {
  nodes: GraphNode[];
  lines: GraphLine[];
  /** Where the Any State node sits, when any transition comes from it. */
  anyState: { x: number; y: number } | null;
  width: number;
  height: number;
}

/**
 * Where a State with no saved position goes.
 *
 * Staggered down a column rather than stacked at one point, so several States
 * created before anything is dragged are all clickable.
 */
export function placeFor(index: number): { x: number; y: number } {
  const column = Math.floor(index / 5);
  const row = index % 5;
  return { x: MARGIN + COL_GAP + column * COL_GAP, y: MARGIN + row * ROW_GAP };
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

export function graphLayout(world: World | null, reports: WorldReports | null): Graph {
  if (!world) return { nodes: [], lines: [], anyState: null, width: MARGIN * 2, height: MARGIN * 2 };

  const deadEnds = new Set((reports?.deadEnds ?? []).map((d) => d.stateId));
  const unreachable = new Set(reports?.unreachable ?? []);
  const noClip = new Set(reports?.statesWithoutClip ?? []);
  const allBroken = new Set(
    (reports?.allClipsUnusable ?? []).filter((o) => o.kind === "state").map((o) => o.id),
  );

  const nodes: GraphNode[] = (world.states ?? []).map((state: WorldState, index) => {
    // A State whose stored position is not a number is placed rather than
    // dropped: it is still the author's State, and a NaN would take the whole
    // canvas with it.
    const placed = finite(state.x) && finite(state.y) ? { x: state.x, y: state.y } : placeFor(index);
    return {
      id: state.id,
      name: state.name,
      clipCount: setMembers(state.clips).length,
      x: placed.x,
      y: placed.y,
      isDefault: state.id === world.defaultStateId,
      deadEnd: deadEnds.has(state.id),
      unreachable: unreachable.has(state.id),
      missingClip: noClip.has(state.id),
      brokenClips: allBroken.has(state.id),
    };
  });

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const usesAny = (world.transitions ?? []).some((t) => t.fromAny);
  // The Any State node sits in its own column to the left of everything, which
  // is where Unity puts it and what makes "from anywhere" read at a glance.
  const anyState = usesAny
    ? { x: MARGIN, y: Math.min(...nodes.map((n) => n.y), MARGIN) }
    : null;

  const lanes = new Map<string, number>();
  const lines: GraphLine[] = [];

  for (const t of world.transitions ?? []) {
    const to = byId.get(t.to);
    if (!to) continue;
    const from = t.fromAny ? anyState : byId.get(t.from ?? "");
    if (!from) continue;

    const fromKey = t.fromAny ? ANY_STATE_KEY : t.from!;
    const shared = {
      id: t.id,
      fromAny: t.fromAny === true,
      muted: t.muted === true,
      solo: t.solo === true,
    };

    if (fromKey === t.to) {
      // A transition back into its own State: Unity draws a loop above the
      // node, and so does this.
      const cx = to.x + NODE_W / 2;
      const top = to.y;
      const index = lanes.get(fromKey) ?? 0;
      lanes.set(fromKey, index + 1);
      const lift = 34 + index * 16;
      lines.push({
        ...shared,
        selfLoop: true,
        d: `M ${cx - 26} ${top} C ${cx - 26} ${top - lift}, ${cx + 26} ${top - lift}, ${cx + 26} ${top}`,
        midX: cx,
        midY: top - lift * 0.75,
      });
      continue;
    }

    // Anchored on the facing sides, so an arrow leaves the side of a node
    // nearest its destination. Two nodes in the same column take the vertical
    // pair instead: anchoring them left-and-right made a transition and its
    // return leave the same side and wrap back, drawing the pair as an X.
    const sameColumn = Math.abs(to.x - from.x) < NODE_W;
    const downward = to.y >= from.y;
    const rightward = to.x >= from.x;
    const x1 = sameColumn ? from.x + NODE_W / 2 : from.x + (rightward ? NODE_W : 0);
    const y1 = sameColumn ? from.y + (downward ? NODE_H : 0) : from.y + NODE_H / 2;
    const x2 = sameColumn ? to.x + NODE_W / 2 : to.x + (rightward ? 0 : NODE_W);
    const y2 = sameColumn ? to.y + (downward ? 0 : NODE_H) : to.y + NODE_H / 2;

    // Unordered, so a transition and its return share a lane and fan apart
    // rather than being drawn on top of one another.
    const lane = [fromKey, t.to].sort().join("~");
    const index = lanes.get(lane) ?? 0;
    lanes.set(lane, index + 1);
    const step = Math.ceil(index / 2) * (index % 2 === 1 ? 1 : -1) * PARALLEL_GAP;

    const dx = x2 - x1;
    const dy = y2 - y1;
    const length = Math.hypot(dx, dy) || 1;
    const cx = (x1 + x2) / 2 + (-dy / length) * step;
    const cy = (y1 + y2) / 2 + (dx / length) * step;

    lines.push({
      ...shared,
      selfLoop: false,
      d: `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`,
      // On a quadratic the point at t=0.5 is the average of the ends and the
      // control point, not the control point itself.
      midX: (x1 + 2 * cx + x2) / 4,
      midY: (y1 + 2 * cy + y2) / 4,
    });
  }

  const xs = [...nodes.map((n) => n.x + NODE_W), anyState ? anyState.x + NODE_W : 0];
  const ys = [...nodes.map((n) => n.y + NODE_H), anyState ? anyState.y + NODE_H : 0];
  return {
    nodes,
    lines,
    anyState,
    width: Math.max(Math.max(...xs, 0) + MARGIN, MARGIN * 2),
    height: Math.max(Math.max(...ys, 0) + MARGIN, MARGIN * 2),
  };
}

/** The transitions out of one source, in the order the machine will try them. */
export function outbound(world: World | null, fromKey: string | null): Transition[] {
  if (!world || !fromKey) return [];
  return (world.transitions ?? [])
    .filter((t) => (fromKey === ANY_STATE_KEY ? t.fromAny === true : t.fromAny !== true && t.from === fromKey))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/** A State's name, or something readable when it has gone. */
export function stateName(world: World, stateId: string | undefined): string {
  if (!stateId) return "—";
  return (world.states ?? []).find((s) => s.id === stateId)?.name ?? "a State that has gone";
}

/** How a transition reads in a list: where it comes from and where it goes. */
export function transitionLabel(world: World, transition: Transition): string {
  const from = transition.fromAny ? "Any State" : stateName(world, transition.from);
  return `${from} → ${stateName(world, transition.to)}`;
}
