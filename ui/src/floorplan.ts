import type { Camera, World } from "../../shared/src/types";

/**
 * Turning a World into something drawable.
 *
 * Pure, and beside `layout.ts` and `lens.ts` for the same reason: the component
 * suite runs under jsdom, which implements no SVG layout at all — no `getBBox`,
 * no `getScreenCTM` — so anything computed inside the component could not be
 * asserted. What lives here is arithmetic; the component positions and renders.
 *
 * Note the two coordinate systems. A World's y grows the way a map's does, so
 * a camera facing 90° looks "up"; SVG's y grows downward. `flip` is the whole
 * of that conversion, and it is the only place the two systems meet.
 */

export interface Bounds {
  minX: number;
  minY: number;
  width: number;
  height: number;
}

const DEFAULT_HALF = 30;
const PADDING = 8;

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** A viewBox that holds everything the World has, with room to place more. */
export function planBounds(world: World | null): Bounds {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const p of world?.positions ?? []) {
    if (finite(p.x) && finite(p.y)) {
      xs.push(p.x);
      ys.push(p.y);
    }
  }
  for (const s of world?.scenes ?? []) {
    const c = s.camera;
    if (!finite(c?.x) || !finite(c?.y)) continue;
    const reach = finite(c.range) ? Math.abs(c.range) : 0;
    xs.push(c.x - reach, c.x + reach);
    ys.push(c.y - reach, c.y + reach);
  }
  if (xs.length === 0) {
    return { minX: -DEFAULT_HALF, minY: -DEFAULT_HALF, width: DEFAULT_HALF * 2, height: DEFAULT_HALF * 2 };
  }
  const minX = Math.min(...xs) - PADDING;
  const maxX = Math.max(...xs) + PADDING;
  const minY = Math.min(...ys) - PADDING;
  const maxY = Math.max(...ys) + PADDING;
  // A World with everything on one line would otherwise have a zero-height box
  // and nothing would render at all.
  return { minX, minY, width: Math.max(maxX - minX, 1), height: Math.max(maxY - minY, 1) };
}

/** World y to SVG y, inside the same box. */
export function flip(bounds: Bounds, y: number): number {
  return 2 * bounds.minY + bounds.height - y;
}

/** Where a click landed, in World coordinates. */
export function toWorld(
  bounds: Bounds,
  rect: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  // jsdom reports a zero-sized rect for everything, and a real collapsed
  // element would divide by zero the same way. The centre of the plan is the
  // honest answer for "somewhere in a box with no size".
  if (!(rect.width > 0) || !(rect.height > 0)) {
    return { x: bounds.minX + bounds.width / 2, y: bounds.minY + bounds.height / 2 };
  }
  const x = bounds.minX + ((clientX - rect.left) / rect.width) * bounds.width;
  const svgY = bounds.minY + ((clientY - rect.top) / rect.height) * bounds.height;
  return { x, y: flip(bounds, svgY) };
}

/**
 * The SVG path for a camera's cone.
 *
 * Drawn in SVG space, so the arc sweeps the other way round than the World's
 * counter-clockwise angles do — which is what the `0` sweep flag is.
 */
export function conePath(bounds: Bounds, camera: Camera): string | null {
  if (!finite(camera?.x) || !finite(camera?.y) || !finite(camera?.facing)) return null;
  if (!finite(camera.fov) || camera.fov <= 0 || !finite(camera.range) || camera.range <= 0) return null;
  const fov = Math.min(camera.fov, 359.9);
  const half = (fov / 2) * (Math.PI / 180);
  const facing = camera.facing * (Math.PI / 180);
  const cx = camera.x;
  const cy = flip(bounds, camera.y);
  const point = (angle: number) => {
    const x = cx + camera.range * Math.cos(angle);
    const y = cy - camera.range * Math.sin(angle);
    return `${x.toFixed(3)} ${y.toFixed(3)}`;
  };
  const largeArc = fov > 180 ? 1 : 0;
  return `M ${cx.toFixed(3)} ${cy.toFixed(3)} L ${point(facing + half)} A ${camera.range} ${camera.range} 0 ${largeArc} 0 ${point(facing - half)} Z`;
}

export interface PlanEdge {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  kind: string;
  /** True for an edge whose two States sit at one Position — a re-frame or a pose change. */
  inPlace: boolean;
}

/** How far apart, in World units, two edges over the same pair of Positions sit. */
const PARALLEL_GAP = 1.2;

/**
 * Where the stub for an edge that travels nowhere sits, in World units.
 *
 * It starts clear of the Position's own dot and of the report rings drawn
 * around it — a stub crossing them is a stub the Position intercepts every
 * click for.
 */
const STUB_INNER = 5.5;
const STUB_OUTER = 10;

/**
 * Edges as lines between the Positions their States sit at.
 *
 * An edge whose two States share a Position — a pose change, or a Cut that
 * re-frames without moving anyone — has no line to draw between two points, so
 * it gets a short stub off the Position instead. Leaving it out would have made
 * the central Cut of an authored circuit, floor seen from one camera to floor
 * seen from the other, the one edge the plan view could not select at all.
 *
 * Edges over the same pair of Positions are fanned apart perpendicular to the
 * line they share. Without that they are drawn exactly on top of each other and
 * only the last one can be selected — and every hop in an authored circuit has
 * a mirrored return, so half of every World's edges would be unreachable in the
 * one view that edits them.
 */
export function planEdges(bounds: Bounds, world: World | null): PlanEdge[] {
  if (!world) return [];
  const states = new Map(world.states.map((s) => [s.id, s]));
  const positions = new Map(world.positions.map((p) => [p.id, p]));
  const drawn = new Map<string, number>();
  const out: PlanEdge[] = [];
  for (const edge of world.edges) {
    const from = positions.get(states.get(edge.from)?.positionId ?? "");
    const to = positions.get(states.get(edge.to)?.positionId ?? "");
    if (!from || !to) continue;
    if (!finite(from.x) || !finite(from.y) || !finite(to.x) || !finite(to.y)) continue;

    // Unordered, so an edge and its return share a lane and fan apart from
    // each other rather than each starting over.
    const lane = [from.id, to.id].sort().join(" ");
    const index = drawn.get(lane) ?? 0;
    drawn.set(lane, index + 1);

    const y1 = flip(bounds, from.y);
    const y2 = flip(bounds, to.y);

    if (from.id === to.id) {
      // Fanned around the Position so several in-place edges stay apart.
      const angle = (index * 2 * Math.PI) / 5;
      out.push({
        id: edge.id,
        kind: edge.kind,
        inPlace: true,
        x1: from.x + STUB_INNER * Math.cos(angle),
        y1: y1 + STUB_INNER * Math.sin(angle),
        x2: from.x + STUB_OUTER * Math.cos(angle),
        y2: y1 + STUB_OUTER * Math.sin(angle),
      });
      continue;
    }

    const dx = to.x - from.x;
    const dy = y2 - y1;
    const length = Math.hypot(dx, dy) || 1;
    // Alternating either side of the shared line: 0, +1, -1, +2, -2…
    const step = Math.ceil(index / 2) * (index % 2 === 1 ? 1 : -1) * PARALLEL_GAP;
    const ox = (-dy / length) * step;
    const oy = (dx / length) * step;

    out.push({ id: edge.id, kind: edge.kind, inPlace: false, x1: from.x + ox, y1: y1 + oy, x2: to.x + ox, y2: y2 + oy });
  }
  return out;
}

/** How a State reads on the plan: its Scene and Position, by name. */
export function stateLabel(world: World, stateId: string): string {
  const state = world.states.find((s) => s.id === stateId);
  if (!state) return stateId;
  const scene = world.scenes.find((s) => s.id === state.sceneId)?.name ?? "?";
  const position = world.positions.find((p) => p.id === state.positionId)?.name ?? "?";
  return state.pose ? `${position} (${state.pose}) · ${scene}` : `${position} · ${scene}`;
}
