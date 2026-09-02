import type { World, WorldReports } from "../../shared/src/types";

/**
 * Laying the World's state machine out as a graph.
 *
 * Pure, and beside `floorplan.ts` for the same reason: jsdom implements no SVG
 * layout, so anything computed inside the component could not be asserted. What
 * lives here is arithmetic; the component positions and renders.
 *
 * A node is a Scene/Position pairing, not a State — a pairing the cones derive
 * but nobody has assigned a clip to yet has no State id, and it still has to be
 * on screen, because "this node has no clip" is the thing the author is looking
 * for. Only a pairing that has become a State can be an endpoint of a
 * transition, which is why a node carries `stateId` separately from `key`.
 */

export const NODE_W = 190;
export const NODE_H = 56;
const COL_GAP = 300;
const ROW_GAP = 96;
const MARGIN = 40;

/** How far apart two transitions between the same pair of nodes are drawn. */
const PARALLEL_GAP = 16;

export interface GraphNode {
  key: string;
  sceneId: string;
  sceneName: string;
  positionId: string;
  positionName: string;
  pose?: string;
  /** Null until a clip has been assigned to the pairing, or the State declared. */
  stateId: string | null;
  clipPath: string | null;
  x: number;
  y: number;
  /** Reported as having no satisfiable edge out for some Parameter value. */
  deadEnd: boolean;
  /** The camera cone covers this pairing but no clip is assigned. */
  missingClip: boolean;
}

export interface GraphEdge {
  id: string;
  kind: string;
  /** SVG path from the source node to the target. */
  d: string;
  /** Where to put the arrowhead and the click target. */
  midX: number;
  midY: number;
  reversed: boolean;
  selfLoop: boolean;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  width: number;
  height: number;
}

export function nodeKey(sceneId: string, positionId: string, pose?: string): string {
  return `${sceneId}|${positionId}|${pose ?? ""}`;
}

/**
 * Nodes in a column per Scene.
 *
 * A Scene is one camera's view, so a column reads as "everything shot from
 * here" — which is also what makes a Cut visible at a glance: it is the
 * transition that crosses between columns.
 */
export function graphLayout(world: World | null, reports: WorldReports | null): Graph {
  if (!world) return { nodes: [], edges: [], width: MARGIN * 2, height: MARGIN * 2 };

  const deadEnds = new Set((reports?.deadEnds ?? []).map((d) => d.stateId));
  const reversed = new Set((reports?.reversedCuts ?? []).flatMap((r) => [r.edgeId, r.returnEdgeId]));
  const missing = new Set((reports?.missingClips ?? []).map((p) => nodeKey(p.sceneId, p.positionId)));

  // Every pairing the cones derive, plus every State the manifest already has.
  // The union matters: a State whose camera has since been aimed away is not in
  // coverage any more, and dropping it would silently hide edges that still
  // reference it.
  const seen = new Map<string, { sceneId: string; positionId: string; pose?: string }>();
  for (const p of reports?.coverage ?? []) seen.set(nodeKey(p.sceneId, p.positionId), { sceneId: p.sceneId, positionId: p.positionId });
  for (const s of world.states) {
    seen.set(nodeKey(s.sceneId, s.positionId, s.pose), { sceneId: s.sceneId, positionId: s.positionId, pose: s.pose });
  }

  const sceneOrder = world.scenes.map((s) => s.id);
  const rows = new Map<string, number>();
  const nodes: GraphNode[] = [];

  for (const [key, at] of seen) {
    const state = world.states.find(
      (s) => s.sceneId === at.sceneId && s.positionId === at.positionId && (s.pose ?? "") === (at.pose ?? ""),
    );
    // A Scene the manifest no longer has still gets a column, at the end, so
    // its nodes do not pile up on top of the first one.
    const column = sceneOrder.indexOf(at.sceneId) === -1 ? sceneOrder.length : sceneOrder.indexOf(at.sceneId);
    const row = rows.get(at.sceneId) ?? 0;
    rows.set(at.sceneId, row + 1);

    nodes.push({
      key,
      sceneId: at.sceneId,
      sceneName: world.scenes.find((s) => s.id === at.sceneId)?.name ?? "no camera",
      positionId: at.positionId,
      positionName: world.positions.find((p) => p.id === at.positionId)?.name ?? "gone",
      ...(at.pose ? { pose: at.pose } : {}),
      stateId: state?.id ?? null,
      clipPath: state?.clip?.path ?? null,
      x: MARGIN + column * COL_GAP,
      y: MARGIN + row * ROW_GAP,
      deadEnd: !!state && deadEnds.has(state.id),
      missingClip: missing.has(key),
    });
  }

  const byState = new Map(nodes.filter((n) => n.stateId).map((n) => [n.stateId!, n]));
  const lanes = new Map<string, number>();
  const edges: GraphEdge[] = [];

  for (const edge of world.edges) {
    const from = byState.get(edge.from);
    const to = byState.get(edge.to);
    // An edge whose States are not on screen cannot be drawn. It is still in
    // the manifest and still reported; it simply has no line.
    if (!from || !to) continue;

    if (from.key === to.key) {
      // A pose change on the spot: Unity draws this as a loop above the node,
      // and so does this.
      const cx = from.x + NODE_W / 2;
      const top = from.y;
      const index = lanes.get(from.key) ?? 0;
      lanes.set(from.key, index + 1);
      const lift = 34 + index * 16;
      edges.push({
        id: edge.id,
        kind: edge.kind,
        d: `M ${cx - 26} ${top} C ${cx - 26} ${top - lift}, ${cx + 26} ${top - lift}, ${cx + 26} ${top}`,
        midX: cx,
        midY: top - lift * 0.75,
        reversed: reversed.has(edge.id),
        selfLoop: true,
      });
      continue;
    }

    // Anchored on the facing sides, so an arrow leaves the side of a node
    // nearest its destination and arrives on the side nearest its source.
    //
    // Two nodes in the same column need the vertical pair instead. Anchoring
    // them left-and-right made a transition and its return leave the same side
    // and wrap back, so every mirrored pair inside one Scene was drawn as an X
    // across the column rather than as two arrows between two boxes.
    const sameColumn = Math.abs(to.x - from.x) < 1;
    const downward = to.y >= from.y;
    const rightward = to.x >= from.x;
    const x1 = sameColumn ? from.x + NODE_W / 2 : from.x + (rightward ? NODE_W : 0);
    const y1 = sameColumn ? from.y + (downward ? NODE_H : 0) : from.y + NODE_H / 2;
    const x2 = sameColumn ? to.x + NODE_W / 2 : to.x + (rightward ? 0 : NODE_W);
    const y2 = sameColumn ? to.y + (downward ? 0 : NODE_H) : to.y + NODE_H / 2;

    // Unordered, so a transition and its return share a lane and fan apart from
    // each other rather than being drawn on top of one another.
    const lane = [from.key, to.key].sort().join("~");
    const index = lanes.get(lane) ?? 0;
    lanes.set(lane, index + 1);
    const step = Math.ceil(index / 2) * (index % 2 === 1 ? 1 : -1) * PARALLEL_GAP;

    const dx = x2 - x1;
    const dy = y2 - y1;
    const length = Math.hypot(dx, dy) || 1;
    const ox = (-dy / length) * step;
    const oy = (dx / length) * step;
    const cx = (x1 + x2) / 2 + ox;
    const cy = (y1 + y2) / 2 + oy;

    edges.push({
      id: edge.id,
      kind: edge.kind,
      d: `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`,
      // On a quadratic curve the point at t=0.5 is the average of the ends and
      // the control point, not the control point itself.
      midX: (x1 + 2 * cx + x2) / 4,
      midY: (y1 + 2 * cy + y2) / 4,
      reversed: reversed.has(edge.id),
      selfLoop: false,
    });
  }

  const width = Math.max(...nodes.map((n) => n.x + NODE_W), 0) + MARGIN;
  const height = Math.max(...nodes.map((n) => n.y + NODE_H), 0) + MARGIN;
  return { nodes, edges, width: Math.max(width, MARGIN * 2), height: Math.max(height, MARGIN * 2) };
}
