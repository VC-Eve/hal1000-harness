import { describe, it, expect } from "vitest";
import { ANY_STATE_KEY, NODE_W, graphLayout, outbound, placeFor, stateName, transitionLabel } from "../src/graph";
import { worldReports } from "../../shared/src/world-graph";
import { WORLD_VERSION } from "../../shared/src/worlds";
import type { Transition, World, WorldState } from "../../shared/src/types";

const state = (id: string, over: Partial<WorldState> = {}): WorldState => ({
  id,
  name: id,
  clip: { path: `clips/${id}.mp4`, durationMs: 2000 },
  x: 100,
  y: 100,
  ...over,
});

const transition = (over: Partial<Transition> & Pick<Transition, "id" | "to">): Transition => ({
  conditions: [],
  hasExitTime: true,
  exitTime: 1,
  order: 0,
  ...over,
});

function world(over: Partial<World> = {}): World {
  return {
    version: WORLD_VERSION,
    id: "lounge",
    name: "Lounge",
    defaultStateId: "a",
    states: [],
    transitions: [],
    parameters: [],
    ...over,
  };
}

const layout = (w: World) => graphLayout(w, worldReports(w));

describe("nodes", () => {
  it("draws one per State, at the position the manifest holds", () => {
    const g = layout(world({ states: [state("a", { x: 10, y: 20 })] }));
    expect(g.nodes).toHaveLength(1);
    expect(g.nodes[0]).toMatchObject({ id: "a", x: 10, y: 20, isDefault: true });
  });

  it("places a State whose position is not a number rather than dropping it", () => {
    // A NaN would take the whole canvas with it.
    const g = layout(world({ states: [state("a", { x: Number.NaN, y: 0 })] }));
    expect(Number.isFinite(g.nodes[0]!.x)).toBe(true);
    expect(Number.isFinite(g.width)).toBe(true);
  });

  it("staggers States created before anything is dragged", () => {
    // Stacked at one point, only the last would be clickable.
    const places = [0, 1, 2].map(placeFor);
    expect(new Set(places.map((p) => `${p.x},${p.y}`)).size).toBe(3);
  });

  it("carries the reports onto the node", () => {
    const g = layout(
      world({
        defaultStateId: "a",
        states: [state("a"), state("orphan", { clip: null })],
      }),
    );
    const orphan = g.nodes.find((n) => n.id === "orphan")!;
    expect(orphan.unreachable).toBe(true);
    expect(orphan.missingClip).toBe(true);
    expect(g.nodes.find((n) => n.id === "a")!.unreachable).toBe(false);
  });

  it("sizes the canvas to hold everything it drew", () => {
    const g = layout(world({ states: [state("a", { x: 400, y: 300 })] }));
    expect(g.width).toBeGreaterThanOrEqual(400 + NODE_W);
    expect(g.height).toBeGreaterThan(300);
  });

  it("is empty and finite for a World with nothing in it, and for no World", () => {
    const g = layout(world());
    expect(g.nodes).toEqual([]);
    expect(Number.isFinite(g.width)).toBe(true);
    expect(graphLayout(null, null).nodes).toEqual([]);
  });
});

describe("Any State", () => {
  it("appears only when a transition comes from it", () => {
    expect(layout(world({ states: [state("a")] })).anyState).toBeNull();

    const g = layout(
      world({
        states: [state("a"), state("wave")],
        transitions: [transition({ id: "t", fromAny: true, to: "wave" })],
      }),
    );
    expect(g.anyState).not.toBeNull();
    expect(g.lines[0]!.fromAny).toBe(true);
  });

  it("sits left of every State, which is what makes 'from anywhere' read", () => {
    const g = layout(
      world({
        states: [state("a", { x: 300, y: 100 })],
        transitions: [transition({ id: "t", fromAny: true, to: "a" })],
      }),
    );
    expect(g.anyState!.x).toBeLessThan(300);
  });
});

describe("lines", () => {
  const pair = (over: Partial<Transition>[] = [{}]) =>
    world({
      states: [state("a", { x: 100, y: 100 }), state("b", { x: 400, y: 100 })],
      transitions: over.map((o, i) => transition({ id: `t${i}`, from: "a", to: "b", ...o })),
    });

  it("draws an arrow between the two nodes a transition connects", () => {
    const g = layout(pair());
    expect(g.lines).toHaveLength(1);
    expect(g.lines[0]!.d).toMatch(/^M /);
    expect(g.lines[0]!.selfLoop).toBe(false);
  });

  it("fans a transition and its return apart rather than drawing them on top of each other", () => {
    const w = world({
      ...pair(),
      transitions: [
        transition({ id: "there", from: "a", to: "b" }),
        transition({ id: "back", from: "b", to: "a" }),
      ],
    });
    const [x, y] = layout(w).lines;
    expect(x!.midY).not.toBeCloseTo(y!.midY);
  });

  it("loops a transition back into its own State above the node", () => {
    const w = world({
      states: [state("a", { x: 100, y: 100 })],
      transitions: [transition({ id: "self", from: "a", to: "a" })],
    });
    const [loop] = layout(w).lines;
    expect(loop!.selfLoop).toBe(true);
    expect(loop!.midY).toBeLessThan(100);
  });

  it("anchors two nodes in one column vertically, so a mirrored pair is not drawn as an X", () => {
    const w = world({
      states: [state("a", { x: 100, y: 100 }), state("b", { x: 100, y: 300 })],
      transitions: [
        transition({ id: "down", from: "a", to: "b" }),
        transition({ id: "up", from: "b", to: "a" }),
      ],
    });
    for (const line of layout(w).lines) {
      expect(line.midX).toBeGreaterThan(100);
      expect(line.midX).toBeLessThan(100 + NODE_W);
    }
  });

  it("carries mute and solo onto the line, so the arrow can show them", () => {
    const g = layout(pair([{ muted: true }]));
    expect(g.lines[0]!.muted).toBe(true);
    expect(layout(pair([{ solo: true }])).lines[0]!.solo).toBe(true);
  });

  it("skips a transition whose destination is not on screen, without throwing", () => {
    const w = world({ states: [state("a")], transitions: [transition({ id: "t", from: "a", to: "gone" })] });
    expect(layout(w).lines).toEqual([]);
  });
});

describe("parallel transitions between one pair", () => {
  /**
   * Where a curve actually bows: the control point alone.
   *
   * The control point *only*. Slicing a fixed span from the `Q` sweeps up the
   * trailing endpoints too, and those differ between a leg and its return
   * whatever the offset does — so the comparison passed with the fix reverted
   * and proved nothing. All four transitions here share one pair of endpoints,
   * so two curves coincide exactly when their control points do.
   */
  const control = (d: string): string => {
    const m = /Q (\S+) (\S+)/.exec(d);
    if (!m) throw new Error(`no control point in ${d}`);
    return `${m[1]},${m[2]}`;
  };

  it("gives every transition of a lane its own curve, whichever way it points", () => {
    // Reported from a real World: four transitions between two States drew
    // three lines, and the one underneath could not be clicked. The fan-out
    // offset is applied along the perpendicular of each leg, and a return leg's
    // perpendicular points the other way — so step `+g` outbound landed exactly
    // where `-g` inbound did. Interleaved on purpose: the collision needs the
    // directions to alternate, so a test that ran A,A,B,B would not see it.
    const w = world({
      states: [state("a", { x: 100, y: 100 }), state("b", { x: 500, y: 100 })],
      transitions: [
        transition({ id: "t1", from: "a", to: "b" }),
        transition({ id: "t2", from: "b", to: "a" }),
        transition({ id: "t3", from: "a", to: "b" }),
        transition({ id: "t4", from: "b", to: "a" }),
      ],
    });

    const curves = layout(w).lines.map((l) => control(l.d));
    expect(new Set(curves).size).toBe(4);
  });

  it("still draws a lone transition straight", () => {
    const w = world({
      states: [state("a", { x: 100, y: 100 }), state("b", { x: 500, y: 100 })],
      transitions: [transition({ id: "t1", from: "a", to: "b" })],
    });
    const [, x1, y1, cx, cy, x2, y2] = /M (\S+) (\S+) Q (\S+) (\S+) (\S+) (\S+)/.exec(
      layout(w).lines[0]!.d,
    )!.map(Number) as unknown as number[];
    // The control point sitting exactly on the midpoint of the ends is what
    // "no bow" means: a lane of one must not curve for the sake of it. Asserted
    // as the property rather than against a copied path string, which would
    // pass for any pair of numbers that happened to match.
    expect(cx).toBe((x1 + x2) / 2);
    expect(cy).toBe((y1 + y2) / 2);
  });
});

describe("reading the machine", () => {
  const w = () =>
    world({
      states: [state("a"), state("b")],
      transitions: [
        transition({ id: "second", from: "a", to: "b", order: 1 }),
        transition({ id: "first", from: "a", to: "b", order: 0 }),
        transition({ id: "any", fromAny: true, to: "b" }),
      ],
    });

  it("lists a source's transitions in the order the machine will try them", () => {
    expect(outbound(w(), "a").map((t) => t.id)).toEqual(["first", "second"]);
    expect(outbound(w(), ANY_STATE_KEY).map((t) => t.id)).toEqual(["any"]);
    expect(outbound(w(), null)).toEqual([]);
  });

  it("names a State, and says so when it has gone", () => {
    expect(stateName(w(), "a")).toBe("a");
    expect(stateName(w(), "gone")).toMatch(/gone/);
  });

  it("labels a transition by both ends, naming Any State as such", () => {
    expect(transitionLabel(w(), w().transitions[0]!)).toBe("a → b");
    expect(transitionLabel(w(), w().transitions[2]!)).toBe("Any State → b");
  });
});
