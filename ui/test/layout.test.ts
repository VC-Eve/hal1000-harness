import { afterEach, describe, expect, it } from "vitest";
import {
  canCollapse,
  clampSplit,
  defaultLayout,
  deriveTracks,
  loadLayout,
  railIsVertical,
  saveLayout,
  showHorizontalDivider,
  showVerticalDivider,
  toggleCollapse,
  type LayoutState,
} from "../src/layout";

// This suite runs under the node environment, so there is no `window` to read.
// Installing a minimal fake is deliberate: it lets each test choose what
// storage *does* — including refusing to answer — which is the behaviour worth
// asserting and the one a real browser will not reproduce on demand.
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

const collapse = (state: LayoutState, ...ids: Array<keyof LayoutState["collapsed"]>): LayoutState =>
  ids.reduce(toggleCollapse, state);

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("defaults", () => {
  it("shows all three sections", () => {
    const state = defaultLayout();
    expect(state.collapsed).toEqual({ conversation: false, webcam: false, observation: false });
  });
});

describe("collapse rules", () => {
  it("leaves the other two visible when one collapses", () => {
    const state = toggleCollapse(defaultLayout(), "conversation");
    expect(state.collapsed.conversation).toBe(true);
    expect(state.collapsed.webcam).toBe(false);
    expect(state.collapsed.observation).toBe(false);
    expect(canCollapse(state, "webcam")).toBe(true);
    expect(canCollapse(state, "observation")).toBe(true);
  });

  it("refuses to collapse the last visible section", () => {
    const state = collapse(defaultLayout(), "conversation", "webcam");
    expect(canCollapse(state, "observation")).toBe(false);
    expect(toggleCollapse(state, "observation")).toBe(state);
  });

  it("still allows a collapsed section to expand when it is the only one hidden left", () => {
    const state = collapse(defaultLayout(), "conversation", "webcam");
    expect(canCollapse(state, "conversation")).toBe(true);
    expect(toggleCollapse(state, "conversation").collapsed.conversation).toBe(false);
  });

  it("restores collapsibility for every section once one expands", () => {
    const state = collapse(defaultLayout(), "conversation", "webcam", "conversation");
    expect(canCollapse(state, "observation")).toBe(true);
    expect(canCollapse(state, "conversation")).toBe(true);
  });
});

describe("derived tracks", () => {
  // The tracks and the rendered children have to agree. A component test can
  // see which sections are present but not whether the grid reserved the right
  // number of slots for them, so the count is asserted here against the number
  // of children each layout actually renders.
  const trackCount = (list: string) => list.split(/\s+(?![^(]*\))/).length;
  const childCount = (state: LayoutState) => {
    const left = 1; // the left column, always rendered
    const right = 1; // observation, as a pane or a rail
    return left + right + (showVerticalDivider(state) ? 1 : 0);
  };

  it("gives the left column a percentage track and both dividers when nothing is collapsed", () => {
    const tracks = deriveTracks({ ...defaultLayout(), split: 55, leftSplit: 45 });
    expect(tracks.columns).toBe("minmax(0, 55%) 6px minmax(0, 1fr)");
    expect(tracks.rows).toBe("minmax(0, 45%) 6px minmax(0, 1fr)");
  });

  it("drops the divider track when one left section collapses", () => {
    const state = toggleCollapse(defaultLayout(), "webcam");
    expect(showHorizontalDivider(state)).toBe(false);
    expect(deriveTracks(state).rows).toBe("minmax(0, 1fr) auto");
  });

  it("splits the left column evenly between two rails and drops the vertical divider", () => {
    const state = collapse(defaultLayout(), "conversation", "webcam");
    expect(deriveTracks(state).rows).toBe("minmax(0, 1fr) minmax(0, 1fr)");
    expect(deriveTracks(state).columns).toBe("auto minmax(0, 1fr)");
  });

  it("lets the left column fill the width when observation collapses", () => {
    const state = toggleCollapse(defaultLayout(), "observation");
    expect(deriveTracks(state).columns).toBe("minmax(0, 1fr) auto");
  });

  it("declares exactly as many column tracks as children in every layout", () => {
    const every: LayoutState[] = [
      defaultLayout(),
      toggleCollapse(defaultLayout(), "conversation"),
      toggleCollapse(defaultLayout(), "webcam"),
      toggleCollapse(defaultLayout(), "observation"),
      collapse(defaultLayout(), "conversation", "webcam"),
      collapse(defaultLayout(), "conversation", "observation"),
      collapse(defaultLayout(), "webcam", "observation"),
    ];
    for (const state of every) {
      expect(trackCount(deriveTracks(state).columns)).toBe(childCount(state));
      // The dividers are display:none when stacked, so they are not grid items
      // and the stacked list is always two tracks.
      expect(trackCount(deriveTracks(state).stackRows)).toBe(2);
    }
  });

  it("keeps a lone collapsed left section horizontal and an edge rail vertical", () => {
    const lone = toggleCollapse(defaultLayout(), "conversation");
    expect(railIsVertical(lone, "conversation")).toBe(false);

    const both = collapse(defaultLayout(), "conversation", "webcam");
    expect(railIsVertical(both, "conversation")).toBe(true);
    expect(railIsVertical(lone, "observation")).toBe(true);
  });
});

describe("persistence", () => {
  it("round-trips collapse flags and both splits", () => {
    installStorage(memoryStorage());
    const state: LayoutState = { ...toggleCollapse(defaultLayout(), "webcam"), split: 35, leftSplit: 42 };
    saveLayout(state);
    expect(loadLayout()).toEqual(state);
  });

  it("returns the default when nothing is stored", () => {
    installStorage(memoryStorage());
    expect(loadLayout()).toEqual(defaultLayout());
  });

  it("returns the default when the stored value is not JSON", () => {
    installStorage(memoryStorage({ "hal1000.layout": "{not json" }));
    expect(loadLayout()).toEqual(defaultLayout());
  });

  it("returns the default when the stored JSON has the wrong shape", () => {
    installStorage(memoryStorage({ "hal1000.layout": JSON.stringify({ collapsed: { conversation: "yes" }, split: 60 }) }));
    expect(loadLayout()).toEqual(defaultLayout());
  });

  it("returns the default when storage itself throws", () => {
    installStorage(throwingStorage());
    expect(loadLayout()).toEqual(defaultLayout());
  });

  it("does not throw when storage refuses a write", () => {
    installStorage(throwingStorage());
    expect(() => saveLayout(defaultLayout())).not.toThrow();
  });

  it("returns the default when the stored state has every section collapsed", () => {
    // Reachable only by editing storage by hand or by loading a payload from a
    // future version, but it would render a body with nothing in it, so the
    // invariant is re-checked rather than trusted.
    const allGone = { ...defaultLayout(), collapsed: { conversation: true, webcam: true, observation: true } };
    installStorage(memoryStorage({ "hal1000.layout": JSON.stringify(allGone) }));
    expect(loadLayout()).toEqual(defaultLayout());
  });

  it("clamps a stored split that sits outside the draggable range", () => {
    installStorage(memoryStorage({ "hal1000.layout": JSON.stringify({ ...defaultLayout(), split: 99, leftSplit: 2 }) }));
    const loaded = loadLayout();
    expect(loaded.split).toBe(clampSplit(99));
    expect(loaded.leftSplit).toBe(clampSplit(2));
  });
});
