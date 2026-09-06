import { afterEach, describe, expect, it } from "vitest";
import {
  clampLiveLayout,
  defaultLiveLayout,
  deriveLiveTracks,
  loadLiveLayout,
  saveLiveLayout,
  type LiveLayoutState,
} from "../src/liveLayout";

// Same fake as `layout.test.ts` installs, and for the same reason: this suite
// runs under the node environment, and a hand-written storage lets a test
// choose what storage *does* — including refusing to answer — which is the
// behaviour worth asserting and the one a real browser will not reproduce on
// demand.
interface FakeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const installStorage = (storage: FakeStorage) => {
  (globalThis as { window?: unknown }).window = { localStorage: storage };
};

const memoryStorage = (seed: Record<string, string> = {}): FakeStorage => {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
};

const throwingStorage = (): FakeStorage => ({
  getItem() {
    throw new Error("access denied");
  },
  setItem() {
    throw new Error("access denied");
  },
});

const KEY = "hal1000.live-layout";
const stored = (state: Partial<LiveLayoutState>) => ({ [KEY]: JSON.stringify(state) });

const at = (stage: number, side: number): LiveLayoutState => ({ stage, side, video: true });

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("defaults", () => {
  it("opens on the geometry /live already renders", () => {
    expect(defaultLiveLayout()).toEqual({ stage: 26, side: 25, video: true });
  });

  /**
   * The stylesheet says 34, and 34 would be wrong.
   *
   * `.live-body` is `minmax(240px, 26%) 1fr` and `.state-graph` is
   * `1fr minmax(240px, 34%)` — so the sidebar's 34% is a share of the graph
   * area, which is itself the remainder after the stage. Flattening two grids
   * into one is what makes that visible, and carrying the number across
   * unchanged would widen the sidebar by about a third while claiming to
   * reproduce it.
   */
  it("derives the sidebar default from the nesting rather than from the stylesheet's number", () => {
    const graphArea = 100 - 26;
    expect(Math.round(graphArea * 0.34)).toBe(defaultLiveLayout().side);
  });

  it("starts with the video shown", () => {
    expect(defaultLiveLayout().video).toBe(true);
  });
});

describe("clamps", () => {
  it("holds the stage inside its own range", () => {
    expect(clampLiveLayout(at(90, 20), "stage").stage).toBe(50);
    expect(clampLiveLayout(at(2, 20), "stage").stage).toBe(15);
  });

  it("holds the sidebar inside its own range", () => {
    expect(clampLiveLayout(at(20, 90), "side").side).toBe(45);
    expect(clampLiveLayout(at(20, 2), "side").side).toBe(15);
  });

  it("leaves a geometry that already fits alone", () => {
    expect(clampLiveLayout(at(26, 25), "stage")).toEqual(at(26, 25));
  });

  it("carries the video flag through untouched", () => {
    expect(clampLiveLayout({ stage: 26, side: 25, video: false }, null).video).toBe(false);
  });
});

describe("the canvas minimum", () => {
  /**
   * The rule CSS cannot express. `minmax(240px, 50%)` caps a track at a share
   * of the container, and a `minmax(30%, 1fr)` canvas does not rescue it —
   * grid resolves the minimums and then overflows, giving a 125% grid rather
   * than a clamped one.
   */
  it("gives way on the seam nobody is holding when the stage is dragged wide", () => {
    const result = clampLiveLayout(at(50, 45), "stage");
    expect(result.stage).toBe(50);
    expect(result.side).toBe(20);
    expect(100 - result.stage - result.side).toBe(30);
  });

  it("gives way on the stage when the sidebar is the seam being dragged", () => {
    const result = clampLiveLayout(at(50, 45), "side");
    expect(result.side).toBe(45);
    expect(result.stage).toBe(25);
    expect(100 - result.stage - result.side).toBe(30);
  });

  /**
   * The load path has no hand on either seam, and the tiebreak still has to be
   * stated — storage is editable by hand and survives across versions.
   */
  it("resolves a hand-edited overlap the way a stage drag would", () => {
    const result = clampLiveLayout(at(50, 45), null);
    expect(result).toEqual(at(50, 20));
  });

  /**
   * The two ranges are chosen so the joint rule always has a solution: the
   * widest stage beside the narrowest sidebar is 65, and the widest sidebar
   * beside the narrowest stage is 60 — both inside the 70 the canvas leaves.
   * If either bound moved, this is the assertion that would say so.
   */
  it("never has to break one of its own bounds to satisfy the canvas", () => {
    for (const dragged of ["stage", "side", null] as const) {
      for (let stage = 0; stage <= 100; stage += 5) {
        for (let side = 0; side <= 100; side += 5) {
          const result = clampLiveLayout(at(stage, side), dragged);
          expect(result.stage).toBeGreaterThanOrEqual(15);
          expect(result.stage).toBeLessThanOrEqual(50);
          expect(result.side).toBeGreaterThanOrEqual(15);
          expect(result.side).toBeLessThanOrEqual(45);
          expect(result.stage + result.side).toBeLessThanOrEqual(70);
        }
      }
    }
  });
});

describe("derived tracks", () => {
  /**
   * One assertion rather than the variant sweep `layout.test.ts` runs, because
   * this derivation has no branch to sweep — there is no collapse here, and
   * hiding the video removes no column. What it can still get wrong is the
   * count: the dividers are grid items, so three tracks would put the sidebar
   * in a 6px divider track and the trailing divider in the sidebar's, drawing
   * a plausible layout that breaks no test.
   */
  it("declares one track per grid child, with both percentages in place", () => {
    const tracks = deriveLiveTracks(at(30, 20));
    expect(tracks).toBe("minmax(240px, 30%) 6px minmax(0, 1fr) 6px minmax(240px, 20%)");
  });

  it("keeps the pixel floor on both side columns at every width", () => {
    expect(deriveLiveTracks(at(15, 15))).toContain("minmax(240px, 15%)");
  });
});

describe("persistence", () => {
  it("round-trips all three fields", () => {
    installStorage(memoryStorage());
    saveLiveLayout({ stage: 40, side: 20, video: false });
    expect(loadLiveLayout()).toEqual({ stage: 40, side: 20, video: false });
  });

  it("returns the default when nothing is stored", () => {
    installStorage(memoryStorage());
    expect(loadLiveLayout()).toEqual(defaultLiveLayout());
  });

  it("returns the default when the stored value is not JSON", () => {
    installStorage(memoryStorage({ [KEY]: "{not json" }));
    expect(loadLiveLayout()).toEqual(defaultLiveLayout());
  });

  it("returns the default when the stored JSON has the wrong shape", () => {
    installStorage(memoryStorage(stored({ stage: 40 })));
    expect(loadLiveLayout()).toEqual(defaultLiveLayout());
  });

  it("returns the default when the stored numbers are not finite", () => {
    installStorage(memoryStorage({ [KEY]: JSON.stringify({ stage: null, side: 20, video: true }) }));
    expect(loadLiveLayout()).toEqual(defaultLiveLayout());
  });

  /** Shape-valid is not the same as reachable. */
  it("clamps a stored geometry no drag could have produced", () => {
    installStorage(memoryStorage(stored({ stage: 95, side: 95, video: true })));
    expect(loadLiveLayout()).toEqual({ stage: 50, side: 20, video: true });
  });

  it("survives storage that refuses to answer", () => {
    installStorage(throwingStorage());
    expect(loadLiveLayout()).toEqual(defaultLiveLayout());
    expect(() => saveLiveLayout(defaultLiveLayout())).not.toThrow();
  });

  /** Its own key, so a schema change on either surface cannot hand the other a
   *  shape it will reject. */
  it("does not read the body layout's key", () => {
    installStorage(memoryStorage({ "hal1000.layout": JSON.stringify({ split: 60, leftSplit: 60 }) }));
    expect(loadLiveLayout()).toEqual(defaultLiveLayout());
  });
});
