import { describe, it, expect } from "vitest";
import { conePath, flip, planBounds, planEdges, stateLabel, toWorld } from "../src/floorplan";
import type { World } from "../../shared/src/types";

const world = (over: Partial<World> = {}): World => ({
  id: "lounge",
  name: "Lounge",
  positions: [],
  scenes: [],
  states: [],
  edges: [],
  parameters: [],
  struck: [],
  ...over,
});

describe("planBounds", () => {
  it("gives an empty World a box to place the first Position in", () => {
    const bounds = planBounds(world());
    expect(bounds.width).toBeGreaterThan(0);
    expect(bounds.height).toBeGreaterThan(0);
  });

  it("holds every Position and the whole reach of every camera", () => {
    const bounds = planBounds(
      world({
        positions: [{ id: "p", name: "couch", x: 10, y: 10 }],
        scenes: [{ id: "c", name: "cam", camera: { x: 0, y: 0, facing: 0, fov: 90, range: 30 } }],
      }),
    );
    expect(bounds.minX).toBeLessThanOrEqual(-30);
    expect(bounds.minX + bounds.width).toBeGreaterThanOrEqual(30);
  });

  it("never returns a zero-sized box for a World laid out on one line", () => {
    const bounds = planBounds(
      world({
        positions: [
          { id: "a", name: "a", x: 0, y: 0 },
          { id: "b", name: "b", x: 10, y: 0 },
        ],
      }),
    );
    expect(bounds.height).toBeGreaterThan(0);
  });

  it("ignores a Position with a non-finite coordinate rather than sizing to NaN", () => {
    const bounds = planBounds(
      world({ positions: [{ id: "a", name: "a", x: 0, y: 0 }, { id: "b", name: "b", x: Number.NaN, y: 0 }] }),
    );
    expect(Number.isFinite(bounds.width)).toBe(true);
    expect(Number.isFinite(bounds.minX)).toBe(true);
  });
});

describe("the two coordinate systems", () => {
  it("flips World y into SVG y and back to the same place", () => {
    const bounds = planBounds(world({ positions: [{ id: "a", name: "a", x: 0, y: 12 }] }));
    expect(flip(bounds, flip(bounds, 12))).toBeCloseTo(12);
  });

  it("answers with the centre of the plan when the element has no size", () => {
    // jsdom reports a zero-sized rect for everything, and a real collapsed
    // element divides by zero the same way.
    const bounds = planBounds(world());
    const point = toWorld(bounds, { left: 0, top: 0, width: 0, height: 0 }, 40, 40);
    expect(point.x).toBeCloseTo(bounds.minX + bounds.width / 2);
    expect(point.y).toBeCloseTo(bounds.minY + bounds.height / 2);
  });

  it("maps a click in a sized element to the World point under it", () => {
    const bounds = { minX: 0, minY: 0, width: 100, height: 100 };
    const rect = { left: 0, top: 0, width: 200, height: 200 };
    // Top-left of the element is the top of the plan, which is high World y.
    expect(toWorld(bounds, rect, 0, 0)).toEqual({ x: 0, y: 100 });
    expect(toWorld(bounds, rect, 200, 200)).toEqual({ x: 100, y: 0 });
  });
});

describe("conePath", () => {
  it("draws nothing for a camera whose numbers will not describe a cone", () => {
    const bounds = planBounds(world());
    expect(conePath(bounds, { x: 0, y: 0, facing: Number.NaN, fov: 90, range: 10 })).toBeNull();
    expect(conePath(bounds, { x: 0, y: 0, facing: 0, fov: 0, range: 10 })).toBeNull();
    expect(conePath(bounds, { x: 0, y: 0, facing: 0, fov: 90, range: 0 })).toBeNull();
  });

  it("marks a wide cone as the large arc", () => {
    const bounds = planBounds(world());
    expect(conePath(bounds, { x: 0, y: 0, facing: 0, fov: 270, range: 10 })).toMatch(/A 10 10 0 1 0/);
    expect(conePath(bounds, { x: 0, y: 0, facing: 0, fov: 90, range: 10 })).toMatch(/A 10 10 0 0 0/);
  });
});

describe("planEdges", () => {
  const twoStates = world({
    positions: [
      { id: "p1", name: "couch", x: 0, y: 5 },
      { id: "p2", name: "booth", x: 0, y: -5 },
    ],
    states: [
      { id: "s1", sceneId: "cam", positionId: "p1", clip: null },
      { id: "s2", sceneId: "cam", positionId: "p2", clip: null },
      { id: "s3", sceneId: "cam2", positionId: "p1", clip: null },
    ],
  });

  it("draws a line between the Positions of an edge's two States", () => {
    const w = { ...twoStates, edges: [{ id: "e1", kind: "travel" as const, from: "s1", to: "s2", conditions: [], onClipEnd: true, clip: null }] };
    const bounds = planBounds(w);
    const [line] = planEdges(bounds, w);
    expect(line!.id).toBe("e1");
    expect(line!.y1).not.toBe(line!.y2);
  });

  it("fans two edges over the same pair of Positions apart", () => {
    // Drawn on top of each other, only the last is selectable — and every hop
    // in an authored circuit has a mirrored return, so half of a World's edges
    // would be unreachable in the one view that edits them.
    const w = {
      ...twoStates,
      edges: [
        { id: "there", kind: "travel" as const, from: "s1", to: "s2", conditions: [], onClipEnd: true, clip: null },
        { id: "back", kind: "travel" as const, from: "s2", to: "s1", conditions: [], onClipEnd: true, clip: null },
      ],
    };
    const [a, b] = planEdges(planBounds(w), w);
    expect(a!.x1).not.toBeCloseTo(b!.x2);
    expect(Math.abs(a!.x1 - b!.x2)).toBeGreaterThan(0.5);
  });

  it("gives an edge whose two States share a Position a clickable stub", () => {
    // The central Cut of an authored circuit is floor seen from one camera to
    // floor seen from the other. Leaving it out made the one edge that matters
    // most the one edge the plan view could not select.
    const w = { ...twoStates, edges: [{ id: "e1", kind: "cut" as const, from: "s1", to: "s3", conditions: [], onClipEnd: true, clip: null }] };
    const [line] = planEdges(planBounds(w), w);
    expect(line!.inPlace).toBe(true);
    expect(Math.hypot(line!.x2 - line!.x1, line!.y2 - line!.y1)).toBeGreaterThan(1);
  });
});

describe("stateLabel", () => {
  it("names a State by its Position and Scene", () => {
    const w = world({
      positions: [{ id: "p1", name: "couch", x: 0, y: 0 }],
      scenes: [{ id: "cam", name: "couch cam", camera: { x: 0, y: 0, facing: 0, fov: 90, range: 10 } }],
      states: [{ id: "s1", sceneId: "cam", positionId: "p1", clip: null, pose: "standing" }],
    });
    expect(stateLabel(w, "s1")).toBe("couch (standing) · couch cam");
  });
});
