import { describe, it, expect } from "vitest";
import {
  angularDistance,
  cameraUsable,
  coverage,
  deadEnds,
  missingClips,
  reversedCuts,
  staleStrikes,
  uncoveredPositions,
  worldReports,
} from "../../../shared/src/world-geometry.js";
import type { Camera, Edge, Scene, World, WorldPosition, WorldState } from "../../../shared/src/types.js";

const at = (id: string, x: number, y: number): WorldPosition => ({ id, name: id, x, y });

const cam = (id: string, camera: Camera): Scene => ({ id, name: id, camera });

const state = (id: string, sceneId: string, positionId: string, hasClip = true): WorldState => ({
  id,
  sceneId,
  positionId,
  clip: hasClip ? { path: `clips/${id}.mp4`, durationMs: 3000 } : null,
});

const edge = (over: Partial<Edge> & Pick<Edge, "id" | "from" | "to">): Edge => ({
  kind: "pose",
  conditions: [],
  onClipEnd: true,
  clip: null,
  ...over,
});

function world(over: Partial<World> = {}): World {
  return { id: "lounge", name: "Lounge", positions: [], scenes: [], states: [], edges: [], parameters: [], struck: [], ...over };
}

describe("coverage", () => {
  // The couch camera stands south of the room looking north and sees the couch
  // and the floor; the DJ camera stands east looking west and sees the floor
  // and the booth.
  const couchCam = cam("couch-cam", { x: 0, y: -10, facing: 90, fov: 70, range: 30 });
  const djCam = cam("dj-cam", { x: 20, y: 0, facing: 180, fov: 90, range: 22 });
  const positions = [at("couch", -5, 5), at("floor", 0, 0), at("booth", 10, 2)];

  it("turns three Positions under two overlapping cones into four States", () => {
    // Covers AE1.
    const w = world({ positions, scenes: [couchCam, djCam] });
    const pairs = coverage(w).map((p) => `${p.sceneId}/${p.positionId}`).sort();

    expect(pairs).toEqual(["couch-cam/couch", "couch-cam/floor", "dj-cam/booth", "dj-cam/floor"].sort());
    expect(pairs).toHaveLength(4);

    // `floor` is the Position both cameras see, so it needs an idle clip from
    // each — the second one being the clip nobody has generated yet.
    const missing = missingClips(w).filter((p) => p.positionId === "floor");
    expect(missing.map((p) => p.sceneId).sort()).toEqual(["couch-cam", "dj-cam"]);
  });

  it("reports a Position no camera covers", () => {
    const w = world({ positions: [...positions, at("corridor", -40, -40)], scenes: [couchCam, djCam] });
    expect(uncoveredPositions(w)).toEqual(["corridor"]);
  });

  it("does not cover a Position beyond a camera's range", () => {
    const near = cam("near", { x: 0, y: 0, facing: 0, fov: 180, range: 5 });
    const w = world({ positions: [at("close", 3, 0), at("far", 40, 0)], scenes: [near] });
    expect(coverage(w).map((p) => p.positionId)).toEqual(["close"]);
  });

  it("covers a cone that spans 0°/360°", () => {
    // The variant that breaks a first implementation comparing raw bearings —
    // and the one that happens the moment a camera is aimed a little west of
    // due east.
    expect(angularDistance(350, 10)).toBe(20);
    const wrapping = cam("wrap", { x: 0, y: 0, facing: 0, fov: 90, range: 20 });
    const w = world({
      positions: [
        at("just-below", 10, -1), // bearing ≈ 354°
        at("just-above", 10, 1), // bearing ≈ 6°
        at("behind", -10, 0), // bearing 180°
      ],
      scenes: [wrapping],
    });
    expect(coverage(w).map((p) => p.positionId).sort()).toEqual(["just-above", "just-below"]);
  });

  it("covers nothing with a non-finite facing", () => {
    const broken = cam("broken", { x: 0, y: 0, facing: Number.NaN, fov: 90, range: 20 });
    expect(cameraUsable(broken.camera)).toBe(false);
    const w = world({ positions: [at("couch", 1, 0)], scenes: [broken] });

    expect(coverage(w)).toEqual([]);
    expect(worldReports(w).unusableCameras).toEqual(["broken"]);
    // The whole point of the acceptance-shaped guard: NaN must not read as
    // "covers everything".
    expect(uncoveredPositions(w)).toEqual(["couch"]);
  });
});

describe("struck pairings", () => {
  const scene = cam("cam", { x: 0, y: 0, facing: 0, fov: 180, range: 50 });

  it("excludes a struck pairing from coverage", () => {
    const w = world({
      positions: [at("couch", 5, 0), at("behind-wall", 5, 5)],
      scenes: [scene],
      struck: [{ sceneId: "cam", positionId: "behind-wall" }],
    });
    expect(coverage(w).map((p) => p.positionId)).toEqual(["couch"]);
    expect(uncoveredPositions(w)).toEqual(["behind-wall"]);
  });

  it("reports a strike whose camera has since moved away", () => {
    // An exemption nobody re-checks is how a completeness guard goes quietly
    // dishonest: aim the camera back and the State would stay missing.
    const moved = cam("cam", { x: 100, y: 100, facing: 0, fov: 30, range: 5 });
    const w = world({
      positions: [at("couch", 5, 0)],
      scenes: [moved],
      struck: [{ sceneId: "cam", positionId: "couch" }],
    });
    expect(staleStrikes(w)).toEqual([{ sceneId: "cam", positionId: "couch" }]);
  });

  it("reports a strike whose Position has been deleted", () => {
    const w = world({ positions: [], scenes: [scene], struck: [{ sceneId: "cam", positionId: "gone" }] });
    expect(staleStrikes(w)).toEqual([{ sceneId: "cam", positionId: "gone" }]);
  });

  it("says nothing about a strike that is still doing its job", () => {
    const w = world({
      positions: [at("behind-wall", 5, 5)],
      scenes: [scene],
      struck: [{ sceneId: "cam", positionId: "behind-wall" }],
    });
    expect(staleStrikes(w)).toEqual([]);
  });
});

describe("screen direction", () => {
  const cut = (id: string, from: string, to: string, exitEdge: "left" | "right", entryEdge: "left" | "right"): Edge =>
    edge({ id, from, to, kind: "cut", exitEdge, entryEdge });

  it("passes a mirrored pair and flags a reversed one", () => {
    // Covers AE2.
    const mirrored = world({
      states: [state("floor-a", "cam-a", "floor"), state("floor-b", "cam-b", "floor")],
      edges: [cut("out", "floor-a", "floor-b", "right", "left"), cut("back", "floor-b", "floor-a", "left", "right")],
    });
    expect(reversedCuts(mirrored)).toEqual([]);

    const reversed = world({
      states: mirrored.states,
      edges: [cut("out", "floor-a", "floor-b", "right", "left"), cut("back", "floor-b", "floor-a", "right", "left")],
    });
    expect(reversedCuts(reversed)).toEqual([
      { edgeId: "out", returnEdgeId: "back", exitEdge: "right", returnExitEdge: "right" },
    ]);
  });

  it("claims nothing about a Cut with no return authored yet", () => {
    const w = world({
      states: [state("floor-a", "cam-a", "floor"), state("floor-b", "cam-b", "floor")],
      edges: [cut("out", "floor-a", "floor-b", "right", "left")],
    });
    expect(reversedCuts(w)).toEqual([]);
  });
});

describe("dead ends", () => {
  const location = { name: "location", values: ["couch", "booth"], defaultValue: "couch" };

  it("reports a State with no way out for an allowed value", () => {
    // Covers AE3.
    const w = world({
      parameters: [location],
      states: [state("couch", "cam", "p-couch"), state("floor", "cam", "p-floor")],
      edges: [
        edge({ id: "e1", from: "couch", to: "floor", conditions: [{ parameter: "location", op: "eq", value: "couch" }] }),
        edge({ id: "e2", from: "floor", to: "couch", conditions: [{ parameter: "location", op: "eq", value: "couch" }] }),
      ],
    });

    expect(deadEnds(w)).toEqual([
      { stateId: "couch", parameter: "location", value: "booth" },
      { stateId: "floor", parameter: "location", value: "booth" },
    ]);
  });

  it("says nothing about a State with an unconditional way out", () => {
    const w = world({
      parameters: [location],
      states: [state("couch", "cam", "p-couch"), state("floor", "cam", "p-floor")],
      edges: [edge({ id: "e1", from: "couch", to: "floor" }), edge({ id: "e2", from: "floor", to: "couch" })],
    });
    expect(deadEnds(w)).toEqual([]);
  });

  it("walks the cross-product of two Parameters", () => {
    // Testing one Parameter at a time with the others pinned cannot see this:
    // each edge is satisfiable on its own, and the pair (booth, high) is the
    // combination nothing covers.
    const w = world({
      parameters: [location, { name: "energy", values: ["low", "high"], defaultValue: "low" }],
      states: [state("couch", "cam", "p-couch"), state("floor", "cam", "p-floor")],
      edges: [
        edge({
          id: "e1",
          from: "couch",
          to: "floor",
          conditions: [
            { parameter: "location", op: "eq", value: "booth" },
            { parameter: "energy", op: "eq", value: "low" },
          ],
        }),
        edge({ id: "e2", from: "couch", to: "floor", conditions: [{ parameter: "location", op: "eq", value: "couch" }] }),
        edge({ id: "e3", from: "floor", to: "couch" }),
      ],
    });

    const couchGaps = deadEnds(w).filter((d) => d.stateId === "couch");
    expect(couchGaps).toContainEqual({ stateId: "couch", parameter: "location", value: "booth" });
    expect(couchGaps).toContainEqual({ stateId: "couch", parameter: "energy", value: "high" });
    expect(deadEnds(w).some((d) => d.stateId === "floor")).toBe(false);
  });

  it("reports every State in a World with no edges, rather than throwing", () => {
    const w = world({
      parameters: [location],
      states: [state("couch", "cam", "p-couch"), state("floor", "cam", "p-floor")],
    });
    const reported = new Set(deadEnds(w).map((d) => d.stateId));
    expect([...reported].sort()).toEqual(["couch", "floor"]);
  });
});

describe("the whole report", () => {
  it("stays quiet on a complete World and names the gaps in a broken one", () => {
    // Covers F3.
    const complete = world({
      parameters: [{ name: "location", values: ["couch", "booth"], defaultValue: "couch" }],
      positions: [at("couch", 0, 5), at("booth", 0, -5)],
      scenes: [cam("cam", { x: 0, y: 0, facing: 90, fov: 360, range: 50 })],
      states: [state("s-couch", "cam", "couch"), state("s-booth", "cam", "booth")],
      edges: [edge({ id: "e1", from: "s-couch", to: "s-booth" }), edge({ id: "e2", from: "s-booth", to: "s-couch" })],
    });
    const clean = worldReports(complete);
    expect(clean.uncoveredPositions).toEqual([]);
    expect(clean.deadEnds).toEqual([]);
    expect(clean.reversedCuts).toEqual([]);
    expect(clean.staleStrikes).toEqual([]);
    expect(clean.unusableCameras).toEqual([]);

    // Add a fourth Position with an edge in and none out, out of every cone.
    const broken = world({
      ...complete,
      positions: [...complete.positions, at("corridor", 500, 500)],
      states: [...complete.states, state("s-corridor", "cam", "corridor")],
      edges: [...complete.edges, edge({ id: "e3", from: "s-booth", to: "s-corridor" })],
    });
    const reports = worldReports(broken);
    expect(reports.worldId).toBe("lounge");
    expect(reports.uncoveredPositions).toEqual(["corridor"]);
    expect(reports.deadEnds.map((d) => d.stateId)).toContain("s-corridor");
  });
});
