import { describe, it, expect } from "vitest";
import { WorldRuntime } from "../../src/live/runtime.js";
import { waitFor } from "../wait.js";
import type { ClipRef, Edge, LiveState, Parameter, World, WorldState } from "../../../shared/src/types.js";

const clip = (name: string, durationMs = 4000): ClipRef => ({ path: `clips/${name}.mp4`, durationMs });

const state = (id: string, sceneId: string, positionId: string, clipName: string | null): WorldState => ({
  id,
  sceneId,
  positionId,
  clip: clipName ? clip(clipName) : null,
});

const edge = (over: Partial<Edge> & Pick<Edge, "id" | "from" | "to">): Edge => ({
  kind: "pose",
  conditions: [],
  onClipEnd: true,
  clip: null,
  ...over,
});

const location: Parameter = { name: "location", values: ["couch", "floor", "booth"], defaultValue: "couch" };

function world(over: Partial<World> = {}): World {
  return {
    id: "lounge",
    name: "Lounge",
    positions: [],
    scenes: [],
    states: [],
    edges: [],
    parameters: [],
    struck: [],
    ...over,
  };
}

interface Rig {
  runtime: WorldRuntime;
  seen: LiveState[];
  last(): LiveState;
}

function rig(w: World, opts: { clipUsable?(c: ClipRef): Promise<boolean> } = {}): Rig {
  const seen: LiveState[] = [];
  const runtime = new WorldRuntime(w, { onChange: (live) => seen.push(live), ...opts });
  runtime.start();
  return { runtime, seen, last: () => seen[seen.length - 1]! };
}

/** Drive one clip to its end through the seam and let the transition settle. */
async function stepThrough(r: Rig, times = 1): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await waitFor(() => !r.runtime.idle, "a clip to be playing");
    r.runtime.step();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("triggers", () => {
  it("takes an edge whose conditions a Parameter change satisfies", async () => {
    const r = rig(
      world({
        parameters: [location],
        states: [state("couch", "cam", "p-couch", "couch-idle"), state("floor", "cam", "p-floor", "floor-idle")],
        edges: [
          edge({
            id: "e1",
            from: "couch",
            to: "floor",
            kind: "travel",
            onClipEnd: false,
            conditions: [{ parameter: "location", op: "eq", value: "floor" }],
            clip: clip("walk"),
          }),
        ],
      }),
    );

    expect(r.last().stateId).toBe("couch");
    r.runtime.setParameter("location", "floor");
    await waitFor(() => r.last().clip?.path === "clips/walk.mp4", "the walk clip to start");
    await stepThrough(r);

    expect(r.last().stateId).toBe("floor");
    expect(r.last().clip?.path).toBe("clips/floor-idle.mp4");
  });

  it("leaves the State alone when a Parameter change satisfies nothing", async () => {
    const r = rig(
      world({
        parameters: [location],
        states: [state("couch", "cam", "p-couch", "couch-idle"), state("booth", "cam2", "p-booth", "booth-idle")],
        edges: [
          edge({
            id: "e1",
            from: "couch",
            to: "booth",
            onClipEnd: false,
            conditions: [{ parameter: "location", op: "eq", value: "floor" }],
          }),
        ],
      }),
    );

    r.runtime.setParameter("location", "booth");
    // A negative assertion has no condition to poll, so the wait is the point.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(r.last().stateId).toBe("couch");
  });

  it("takes an exit-time edge when the clip ends, with no Parameter change", async () => {
    const r = rig(
      world({
        states: [state("a", "cam", "p", "a-idle"), state("b", "cam", "p", "b-idle")],
        edges: [edge({ id: "e1", from: "a", to: "b", onClipEnd: true })],
      }),
    );

    await stepThrough(r);
    expect(r.last().stateId).toBe("b");
  });

  it("loops the same clip again when a clip ends and nothing is satisfied", async () => {
    const r = rig(world({ states: [state("a", "cam", "p", "a-idle")] }));

    const before = r.last().generation;
    await stepThrough(r);
    expect(r.last().stateId).toBe("a");
    expect(r.last().clip?.path).toBe("clips/a-idle.mp4");
    expect(r.last().generation).toBeGreaterThan(before);
  });

  it("fires clip end from its own timer, with no seam involved", async () => {
    // The seam must not be the only path tested: a seam every test uses leaves
    // the production trigger — the timer — entirely uncovered.
    const r = rig(
      world({
        states: [
          { id: "a", sceneId: "cam", positionId: "p", clip: { path: "clips/a.mp4", durationMs: 20 } },
          state("b", "cam", "p", "b-idle"),
        ],
        edges: [edge({ id: "e1", from: "a", to: "b", onClipEnd: true })],
      }),
    );

    await waitFor(() => r.last().stateId === "b", "the timer to end the clip and take the edge");
  });
});

describe("conditions over more than one Parameter", () => {
  it("reads both when two are non-default", async () => {
    const energy: Parameter = { name: "energy", values: ["low", "high"], defaultValue: "low" };
    const r = rig(
      world({
        parameters: [location, energy],
        states: [state("couch", "cam", "p", "couch-idle"), state("dance", "cam", "p", "dance")],
        edges: [
          edge({
            id: "e1",
            from: "couch",
            to: "dance",
            onClipEnd: false,
            conditions: [
              { parameter: "location", op: "eq", value: "floor" },
              { parameter: "energy", op: "eq", value: "high" },
            ],
          }),
        ],
      }),
    );

    r.runtime.setParameter("location", "floor");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(r.last().stateId).toBe("couch");

    r.runtime.setParameter("energy", "high");
    await waitFor(() => r.last().stateId === "dance", "both conditions to be read together");
  });
});

describe("a Cut", () => {
  const cutWorld = (samePosition = false) =>
    world({
      parameters: [location],
      states: [
        state("floor-a", "cam-a", "p-floor", "floor-a-idle"),
        state("floor-b", "cam-b", samePosition ? "p-floor" : "p-floor-b", "floor-b-idle"),
      ],
      edges: [
        edge({
          id: "cut",
          kind: "cut",
          from: "floor-a",
          to: "floor-b",
          onClipEnd: false,
          conditions: [{ parameter: "location", op: "eq", value: "booth" }],
          clip: clip("exit-right"),
          entryClip: clip("enter-left"),
          exitEdge: "right",
          entryEdge: "left",
        }),
      ],
    });

  it("plays exit then entry, changes Scene on the join, and arrives only at the end", async () => {
    // Covers F2.
    const r = rig(cutWorld());
    r.runtime.setParameter("location", "booth");

    await waitFor(() => r.last().clip?.path === "clips/exit-right.mp4", "the exit clip");
    expect(r.last().phase).toBe("playing");
    expect(r.last().sceneId).toBe("cam-a");
    expect(r.last().stateId).toBe("floor-a");

    await stepThrough(r);
    expect(r.last().clip?.path).toBe("clips/enter-left.mp4");
    expect(r.last().phase).toBe("cutting");
    // The camera changed on the join, before the destination State is reached.
    expect(r.last().sceneId).toBe("cam-b");
    expect(r.last().stateId).toBe("floor-a");

    await stepThrough(r);
    expect(r.last().stateId).toBe("floor-b");
    expect(r.last().phase).toBe("holding");
  });

  it("plays a re-frame with no travel clip between the two halves", async () => {
    // Covers R16: two States at the same Position, exit and entry, nothing else.
    const r = rig(cutWorld(true));
    r.runtime.setParameter("location", "booth");

    const paths: string[] = [];
    await waitFor(() => r.last().phase === "playing", "the Cut to start");
    paths.push(r.last().clip!.path);
    await stepThrough(r);
    paths.push(r.last().clip!.path);
    await stepThrough(r);

    expect(paths).toEqual(["clips/exit-right.mp4", "clips/enter-left.mp4"]);
    expect(r.last().stateId).toBe("floor-b");
  });
});

describe("one edge at a time", () => {
  const circuit = () =>
    world({
      parameters: [location],
      states: [
        state("couch", "cam-a", "p-couch", "couch-idle"),
        state("floor-a", "cam-a", "p-floor", "floor-a-idle"),
        state("floor-b", "cam-b", "p-floor", "floor-b-idle"),
        state("booth", "cam-b", "p-booth", "booth-idle"),
      ],
      edges: [
        edge({ id: "out1", kind: "travel", from: "couch", to: "floor-a", conditions: [{ parameter: "location", op: "eq", value: "booth" }], clip: clip("walk-out") }),
        edge({ id: "out2", kind: "cut", from: "floor-a", to: "floor-b", conditions: [{ parameter: "location", op: "eq", value: "booth" }], clip: clip("exit-r"), entryClip: clip("enter-l"), exitEdge: "right", entryEdge: "left" }),
        edge({ id: "out3", kind: "travel", from: "floor-b", to: "booth", conditions: [{ parameter: "location", op: "eq", value: "booth" }], clip: clip("walk-booth") }),
        edge({ id: "back1", kind: "travel", from: "booth", to: "floor-b", conditions: [{ parameter: "location", op: "eq", value: "couch" }], clip: clip("leave-booth") }),
        edge({ id: "back2", kind: "cut", from: "floor-b", to: "floor-a", conditions: [{ parameter: "location", op: "eq", value: "couch" }], clip: clip("exit-l"), entryClip: clip("enter-r"), exitEdge: "left", entryEdge: "right" }),
        edge({ id: "back3", kind: "travel", from: "floor-a", to: "couch", conditions: [{ parameter: "location", op: "eq", value: "couch" }], clip: clip("walk-back") }),
      ],
    });

  it("takes one edge and holds rather than chaining to the destination", async () => {
    // Covers R21. The destination is two hops away; one evaluation must not
    // walk the whole route.
    const r = rig(circuit());
    r.runtime.setParameter("location", "booth");

    // The couch idle ends, the walk plays, and the character arrives at
    // floor-a — one edge. The Cut waiting there is not also taken.
    await stepThrough(r, 2);
    expect(r.last().stateId).toBe("floor-a");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(r.last().stateId).toBe("floor-a");
  });

  it("drives the whole couch to booth to couch circuit and returns", async () => {
    const r = rig(circuit());

    r.runtime.setParameter("location", "booth");
    // couch idle, walk-out, floor-a idle, exit, entry, floor-b idle,
    // walk-booth: seven clips for three edges, which is what a claim about the
    // tenth transition rather than the first has to survive.
    await stepThrough(r, 7);
    expect(r.last().stateId).toBe("booth");

    r.runtime.setParameter("location", "couch");
    await stepThrough(r, 7);
    expect(r.last().stateId).toBe("couch");
    expect(r.last().clip?.path).toBe("clips/couch-idle.mp4");
  });
});

describe("supersede and faults", () => {
  it("supersedes an in-flight transition so the stale clip does not land", async () => {
    const r = rig(
      world({
        parameters: [location],
        states: [
          state("couch", "cam", "p1", "couch-idle"),
          state("floor", "cam", "p2", "floor-idle"),
          state("door", "cam", "p3", "door-idle"),
        ],
        edges: [
          edge({ id: "e1", kind: "travel", onClipEnd: false, from: "couch", to: "floor", conditions: [{ parameter: "location", op: "eq", value: "floor" }], clip: clip("walk-floor") }),
          edge({ id: "e2", kind: "travel", onClipEnd: false, from: "couch", to: "door", conditions: [{ parameter: "location", op: "eq", value: "booth" }], clip: clip("walk-door") }),
        ],
      }),
    );

    r.runtime.setParameter("location", "floor");
    await waitFor(() => r.last().clip?.path === "clips/walk-floor.mp4", "the first walk");
    r.runtime.setParameter("location", "booth");
    await waitFor(() => r.last().clip?.path === "clips/walk-door.mp4", "the superseding walk");
    await stepThrough(r);

    expect(r.last().stateId).toBe("door");
    // The superseded transition never arrived at its own destination.
    expect(r.seen.every((live) => live.stateId !== "floor")).toBe(true);
  });

  it("faults a transition whose clip will not resolve, rather than looping on", async () => {
    const r = rig(
      world({
        parameters: [location],
        states: [state("couch", "cam", "p1", "couch-idle"), state("floor", "cam", "p2", "gone")],
        edges: [
          edge({ id: "e1", kind: "travel", onClipEnd: false, from: "couch", to: "floor", conditions: [{ parameter: "location", op: "eq", value: "floor" }], clip: clip("walk") }),
        ],
      }),
      { clipUsable: async (c) => c.path !== "clips/gone.mp4" },
    );

    r.runtime.setParameter("location", "floor");
    await waitFor(() => r.last().fault !== null, "the fault to be reported");
    expect(r.last().stateId).toBe("couch");
    expect(r.last().clip).toBeNull();
  });
});

describe("clip-end reports from a browser", () => {
  const looping = () =>
    world({
      states: [state("a", "cam", "p", "a-idle"), state("b", "cam", "p", "b-idle")],
      edges: [edge({ id: "e1", from: "a", to: "b", onClipEnd: true })],
    });

  it("advances once for two identical reports", async () => {
    const r = rig(looping());
    const live = r.last();

    expect(r.runtime.reportClipEnd(live.worldId, live.stateId!, live.generation)).toBe(true);
    expect(r.runtime.reportClipEnd(live.worldId, live.stateId!, live.generation)).toBe(false);
    await new Promise((resolve) => setImmediate(resolve));

    expect(r.last().stateId).toBe("b");
  });

  it("discards a report naming a superseded generation", async () => {
    const r = rig(looping());
    const stale = r.last().generation;
    await stepThrough(r);

    expect(r.runtime.reportClipEnd("lounge", "b", stale)).toBe(false);
    expect(r.last().stateId).toBe("b");
  });

  it("discards a report naming another World", async () => {
    const r = rig(looping());
    const live = r.last();
    expect(r.runtime.reportClipEnd("somewhere-else", live.stateId!, live.generation)).toBe(false);
  });
});

describe("with nothing watching", () => {
  it("drives a full Cut to its destination with no client attached", async () => {
    // The headless case KTD1 exists for. Real durations, no seam, no socket:
    // a browser-sourced clip-end signal would take one edge here and freeze,
    // possibly mid-Cut with the camera already changed.
    const short = (name: string): ClipRef => ({ path: `clips/${name}.mp4`, durationMs: 15 });
    const runtime = new WorldRuntime(
      world({
        parameters: [location],
        states: [
          { id: "floor-a", sceneId: "cam-a", positionId: "p", clip: short("floor-a-idle") },
          { id: "floor-b", sceneId: "cam-b", positionId: "p", clip: short("floor-b-idle") },
        ],
        edges: [
          edge({
            id: "cut",
            kind: "cut",
            from: "floor-a",
            to: "floor-b",
            onClipEnd: false,
            conditions: [{ parameter: "location", op: "eq", value: "booth" }],
            clip: short("exit"),
            entryClip: short("entry"),
            exitEdge: "right",
            entryEdge: "left",
          }),
        ],
      }),
      { onChange: () => {} },
    );
    runtime.start();
    runtime.setParameter("location", "booth");

    await waitFor(() => runtime.live().stateId === "floor-b" && runtime.live().phase === "holding", "the Cut to complete unattended");
    runtime.stop();
  });
});
