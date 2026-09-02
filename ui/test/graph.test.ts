import { describe, it, expect } from "vitest";
import { graphLayout, nodeKey, NODE_W } from "../src/graph";
import { worldReports } from "../../shared/src/world-geometry";
import type { Edge, World } from "../../shared/src/types";

const edge = (over: Partial<Edge> & Pick<Edge, "id" | "from" | "to">): Edge => ({
  kind: "travel",
  conditions: [],
  onClipEnd: true,
  clip: null,
  ...over,
});

function world(over: Partial<World> = {}): World {
  return {
    id: "lounge",
    name: "Lounge",
    positions: [
      { id: "p-couch", name: "couch", x: 0, y: 5 },
      { id: "p-booth", name: "booth", x: 0, y: -5 },
    ],
    // One cone wide enough to see both, so coverage derives two pairings.
    scenes: [{ id: "cam", name: "couch cam", camera: { x: 0, y: 0, facing: 90, fov: 360, range: 40 } }],
    states: [
      { id: "s-couch", sceneId: "cam", positionId: "p-couch", clip: { path: "clips/couch.mp4", durationMs: 1000 } },
      { id: "s-booth", sceneId: "cam", positionId: "p-booth", clip: { path: "clips/booth.mp4", durationMs: 1000 } },
    ],
    edges: [],
    parameters: [],
    struck: [],
    ...over,
  };
}

const layout = (w: World) => graphLayout(w, worldReports(w));

describe("nodes", () => {
  it("draws one per Scene/Position pairing the cones derive", () => {
    const g = layout(world());
    expect(g.nodes.map((n) => n.key).sort()).toEqual([nodeKey("cam", "p-booth"), nodeKey("cam", "p-couch")].sort());
  });

  it("draws a covered pairing that is not a State yet, with no id to reference", () => {
    // The node has to exist even before a clip is assigned: "this one has no
    // clip" is the thing the author is looking for.
    const g = layout(world({ states: [] }));
    expect(g.nodes).toHaveLength(2);
    expect(g.nodes.every((n) => n.stateId === null)).toBe(true);
    expect(g.nodes.every((n) => n.missingClip)).toBe(true);
  });

  it("keeps a State whose camera has since been aimed away", () => {
    // Dropping it would silently hide the edges that still reference it.
    const narrow = world({
      scenes: [{ id: "cam", name: "couch cam", camera: { x: 100, y: 100, facing: 0, fov: 10, range: 1 } }],
    });
    const g = layout(narrow);
    expect(g.nodes.map((n) => n.stateId).sort()).toEqual(["s-booth", "s-couch"]);
  });

  it("gives each Scene its own column, so a Cut is the arrow that crosses one", () => {
    const two = world({
      scenes: [
        { id: "cam-a", name: "a", camera: { x: 0, y: 0, facing: 90, fov: 360, range: 40 } },
        { id: "cam-b", name: "b", camera: { x: 0, y: 0, facing: 90, fov: 360, range: 40 } },
      ],
      states: [
        { id: "s1", sceneId: "cam-a", positionId: "p-couch", clip: null },
        { id: "s2", sceneId: "cam-b", positionId: "p-couch", clip: null },
      ],
    });
    const g = layout(two);
    const a = g.nodes.find((n) => n.sceneId === "cam-a")!;
    const b = g.nodes.find((n) => n.sceneId === "cam-b")!;
    expect(a.x).not.toBe(b.x);
  });

  it("stacks nodes in one Scene rather than piling them at one point", () => {
    const g = layout(world());
    const [a, b] = g.nodes;
    expect(a!.x).toBe(b!.x);
    expect(a!.y).not.toBe(b!.y);
  });

  it("sizes the canvas to hold everything it drew", () => {
    const g = layout(world());
    for (const n of g.nodes) {
      expect(g.width).toBeGreaterThanOrEqual(n.x + NODE_W);
      expect(g.height).toBeGreaterThan(n.y);
    }
  });

  it("is empty and finite for a World with nothing in it", () => {
    const g = graphLayout(world({ positions: [], scenes: [], states: [] }), null);
    expect(g.nodes).toEqual([]);
    expect(Number.isFinite(g.width)).toBe(true);
    expect(Number.isFinite(g.height)).toBe(true);
  });

  it("draws nothing at all for no World", () => {
    expect(graphLayout(null, null).nodes).toEqual([]);
  });
});

describe("transitions", () => {
  it("draws an arrow between the two nodes an edge connects", () => {
    const g = layout(world({ edges: [edge({ id: "e1", from: "s-couch", to: "s-booth" })] }));
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]!.d).toMatch(/^M /);
    expect(g.edges[0]!.selfLoop).toBe(false);
  });

  it("fans a transition and its return apart rather than drawing them on top of each other", () => {
    const g = layout(
      world({
        edges: [edge({ id: "there", from: "s-couch", to: "s-booth" }), edge({ id: "back", from: "s-booth", to: "s-couch" })],
      }),
    );
    const [a, b] = g.edges;
    expect(a!.midX).not.toBeCloseTo(b!.midX);
  });

  it("anchors a transition inside one Scene vertically, so a mirrored pair is not drawn as an X", () => {
    // Anchoring them left-and-right made both leave the same side and wrap
    // back, crossing over each other across the column.
    const g = layout(
      world({
        edges: [edge({ id: "down", from: "s-couch", to: "s-booth" }), edge({ id: "up", from: "s-booth", to: "s-couch" })],
      }),
    );
    const nodes = g.nodes;
    expect(nodes[0]!.x).toBe(nodes[1]!.x);

    // Both arrows stay within the column's horizontal span rather than
    // swinging out past either edge of the boxes.
    const left = nodes[0]!.x;
    for (const line of g.edges) {
      expect(line.midX).toBeGreaterThan(left);
      expect(line.midX).toBeLessThan(left + NODE_W);
    }
  });

  it("loops a transition whose two ends are the same State above the node", () => {
    const g = layout(world({ edges: [edge({ id: "pose", kind: "pose", from: "s-couch", to: "s-couch" })] }));
    const [loop] = g.edges;
    expect(loop!.selfLoop).toBe(true);
    const node = g.nodes.find((n) => n.stateId === "s-couch")!;
    expect(loop!.midY).toBeLessThan(node.y);
  });

  it("puts the arrowhead on the curve rather than at the control point", () => {
    // The point at t=0.5 on a quadratic is the average of the ends and the
    // control point, not the control point itself.
    const g = layout(world({ edges: [edge({ id: "e1", from: "s-couch", to: "s-booth" })] }));
    const line = g.edges[0]!;
    const from = g.nodes.find((n) => n.stateId === "s-couch")!;
    const to = g.nodes.find((n) => n.stateId === "s-booth")!;
    expect(line.midY).toBeGreaterThan(Math.min(from.y, to.y));
    expect(line.midY).toBeLessThan(Math.max(from.y, to.y) + 100);
  });

  it("skips an edge whose States are not on screen, without throwing", () => {
    const g = layout(world({ edges: [edge({ id: "e1", from: "gone", to: "s-booth" })] }));
    expect(g.edges).toEqual([]);
  });
});
