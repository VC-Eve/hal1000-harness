import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { LivePane } from "../../src/components/LivePane";
import { App } from "../../src/App";
import { currentRoute, navigate, parseRoute } from "../../src/route";
import { harness, mount, testReports, testState, testWorld } from "./harness";

afterEach(() => {
  window.history.pushState({}, "", "/");
  // The pane remembers its geometry and whether the video is shown. Without
  // this, one test's toggle is the next test's opening state.
  window.localStorage.clear();
});

describe("routing", () => {
  it("pushes and restores through history, which a node test has no window for", () => {
    navigate("live");
    expect(window.location.pathname).toBe("/live");
    expect(currentRoute()).toBe("live");

    navigate("home");
    expect(window.location.pathname).toBe("/");
    expect(currentRoute()).toBe("home");
  });

  it("renders the live surface on a deep load of /live, not the chat shell", () => {
    window.history.pushState({}, "", "/live");
    expect(parseRoute(window.location.pathname)).toBe("live");
    mount(<App />);

    expect(screen.getByTestId("world-picker")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/message/i)).not.toBeInTheDocument();
  });

  it("links to the live surface from the base page", () => {
    mount(<App />);
    fireEvent.click(screen.getByRole("button", { name: "live" }));
    expect(window.location.pathname).toBe("/live");
    expect(screen.getByTestId("world-picker")).toBeInTheDocument();
  });

  it("mounts no operator component on /broadcast", () => {
    // The requirement is about absence, so each one is asserted absent by name.
    // "The stage is present" would pass just as well with the whole operator
    // interface rendered underneath it, which is the failure being prevented.
    window.history.pushState({}, "", "/broadcast");
    mount(<App />);

    expect(screen.getByTestId("broadcast-stage")).toBeInTheDocument();
    expect(screen.queryByTestId("live-pane")).toBeNull();
    expect(screen.queryByTestId("world-picker")).toBeNull();
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
    expect(screen.queryByRole("button", { name: "live" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "HAL 1000" })).toBeNull();
  });

  it("sets a neutral document title on /broadcast and the HAL one elsewhere", () => {
    window.history.pushState({}, "", "/broadcast");
    mount(<App />);
    expect(document.title).not.toMatch(/HAL/);

    cleanup();
    window.history.pushState({}, "", "/live");
    mount(<App />);
    expect(document.title).toBe("HAL 1000");
  });

});

describe("the picker", () => {
  it("asks for the world list once, not once per render", () => {
    const h = harness();
    const { rerender } = mount(<LivePane state={testState()} send={h.send} />);
    expect(h.countOf("list-worlds")).toBe(1);

    rerender(<LivePane state={testState({ worlds: [{ id: "lounge", name: "Lounge", readable: true }] })} send={h.send} />);
    rerender(<LivePane state={testState({ worldLive: null })} send={h.send} />);
    expect(h.countOf("list-worlds")).toBe(1);
  });

  it("asks once even when handed a fresh send on every render", () => {
    // The component must not depend on its caller memoising: an effect that
    // lists an unstable `send` in its deps re-runs forever.
    const h = harness();
    const unstable = () => (msg: Parameters<typeof h.send>[0]) => h.send(msg);
    const { rerender } = mount(<LivePane state={testState()} send={unstable()} />);
    for (let i = 0; i < 5; i += 1) {
      rerender(<LivePane state={testState({ worlds: [{ id: "lounge", name: "Lounge", readable: true }] })} send={unstable()} />);
    }
    expect(h.countOf("list-worlds")).toBe(1);
  });

  it("lists worlds and opens one, scoped by testid rather than by index", () => {
    const h = harness();
    mount(
      <LivePane
        state={testState({
          worlds: [
            { id: "lounge", name: "Lounge", readable: true },
            { id: "kitchen", name: "Kitchen", readable: true },
          ],
        })}
        send={h.send}
      />,
    );

    fireEvent.click(within(screen.getByTestId("world-kitchen")).getByRole("button"));
    expect(h.sent).toContainEqual({ type: "open-world", worldId: "kitchen" });
  });

  it("creates a World with the typed name", () => {
    const h = harness();
    mount(<LivePane state={testState()} send={h.send} />);

    fireEvent.change(screen.getByLabelText("New World name"), { target: { value: "Streamer Lounge" } });
    fireEvent.click(screen.getByRole("button", { name: "create" }));

    expect(h.sent).toContainEqual({ type: "create-world", world: { name: "Streamer Lounge" } });
  });

  it("closes on the World it asked for, even when that World is already open", () => {
    // Found by driving the real browser. Keyed on the id *changing*, picking
    // the World already open changed nothing and the picker sat there ignoring
    // the click — worse than one that never closed at all.
    const world = testWorld();
    const open = testState({ world, worldReports: testReports(world), worlds: [{ id: "lounge", name: "Lounge", readable: true }] });
    const { rerender } = mount(<LivePane state={open} send={harness().send} />);

    fireEvent.click(screen.getByRole("button", { name: "worlds" }));
    expect(screen.getByTestId("world-picker")).toBeInTheDocument();

    fireEvent.click(within(screen.getByTestId("world-lounge")).getByRole("button"));
    rerender(<LivePane state={open} send={harness().send} />);

    expect(screen.queryByTestId("world-picker")).not.toBeInTheDocument();
    expect(screen.getByTestId("live-world")).toBeInTheDocument();
  });

  it("keeps the picker up and says why when a World will not open", () => {
    const state = testState({
      worlds: [{ id: "lounge", name: "Lounge", readable: true }],
      worldResults: { "open-world": { ok: false, error: "There is no World by that name." } },
    });
    mount(<LivePane state={state} send={harness().send} />);

    fireEvent.click(within(screen.getByTestId("world-lounge")).getByRole("button"));
    expect(screen.getByTestId("world-picker")).toBeInTheDocument();
    expect(screen.getByTestId("open-error")).toHaveTextContent("no World by that name");
  });

  it("says when a World's manifest will not parse", () => {
    mount(<LivePane state={testState({ worlds: [{ id: "lounge", name: "Lounge", readable: false }] })} send={harness().send} />);
    expect(within(screen.getByTestId("world-lounge")).getByText(/read-only/)).toBeInTheDocument();
  });
});

describe("an open World", () => {
  it("shows the World rather than the picker", () => {
    const world = testWorld();
    mount(<LivePane state={testState({ world, worldReports: testReports(world) })} send={harness().send} />);

    expect(screen.getByTestId("live-world")).toBeInTheDocument();
    expect(screen.queryByTestId("world-picker")).not.toBeInTheDocument();
    expect(screen.getByTestId("clip-player")).toBeInTheDocument();
    // One authoring surface: the graph. There is no second view to switch to.
    expect(screen.getByTestId("state-graph")).toBeInTheDocument();
  });

  it("offers a way back to the picker", () => {
    const world = testWorld();
    mount(<LivePane state={testState({ world, worldReports: testReports(world) })} send={harness().send} />);

    fireEvent.click(screen.getByRole("button", { name: "worlds" }));
    expect(screen.getByTestId("world-picker")).toBeInTheDocument();
  });

  it("keeps the loudspeaker mounted across a trip to the picker", () => {
    // The transport belongs to no World (origin R3), and this is where that has
    // to be true rather than merely written down. Mounted inside the World
    // branch, the `<audio>` element went away with the first click on "worlds" —
    // the music stopped, and the server heard nothing about it because the
    // socket was still open.
    const h = harness();
    const world = testWorld();
    const state = testState({ world, worldReports: testReports(world), audioAuthority: true });
    mount(<LivePane state={state} send={h.send} />);
    const speaker = screen.getByTestId("audio-element");

    fireEvent.click(screen.getByRole("button", { name: "worlds" }));
    expect(screen.getByTestId("world-picker")).toBeInTheDocument();
    // The same element, not another one in the same place: a remount would have
    // reloaded the file and started it from the beginning at best.
    expect(screen.getByTestId("audio-element")).toBe(speaker);

    fireEvent.click(screen.getByRole("button", { name: /back to/ }));
    expect(screen.getByTestId("live-world")).toBeInTheDocument();
    expect(screen.getByTestId("audio-element")).toBe(speaker);
    // One announcement for the whole trip, and no handing the loudspeaker back
    // halfway through it.
    expect(h.sent.filter((m) => m.type === "audio-transport")).toEqual([
      { type: "audio-transport", command: "attend" },
    ]);
  });

  it("says why the manifest is read-only, rather than only that it is", () => {
    const world = testWorld();
    mount(
      <LivePane
        state={testState({
          world,
          worldReports: testReports(world),
          worldReadable: false,
          worldReadOnlyReason: "This World was made by an earlier layout of HAL.",
        })}
        send={harness().send}
      />,
    );
    expect(screen.getAllByText(/earlier layout/).length).toBeGreaterThan(0);
  });
});

describe("the video toggle", () => {
  const openWorld = (world = testWorld(), send = harness().send) =>
    mount(<LivePane state={testState({ world, worldReports: testReports(world) })} send={send} />);

  it("keeps the player mounted, because it is the only thing that measures a clip", () => {
    // Verified in a browser, not reasoned about: with the player unmounted, a
    // World holding a real clip at durationMs 0 still held 0 after six seconds
    // on /live; hidden instead, the manifest recorded 7000. `loadedmetadata` is
    // the only source of that number, `useClipStage` the only sender, and
    // /broadcast is refused it as an observer.
    openWorld();
    fireEvent.click(screen.getByTestId("toggle-video"));
    expect(screen.getByTestId("clip-player")).toBeInTheDocument();
  });

  it("hands the hiding to the stylesheet rather than to the tree", () => {
    // jsdom applies no stylesheet, so what can be asserted here is that the
    // class the stylesheet keys `display: none` off is on the column. That it
    // is genuinely out of the layout is scripts/live-layout-check.mjs's job —
    // the player measured 0px tall there.
    openWorld();
    fireEvent.click(screen.getByTestId("toggle-video"));
    expect(screen.getByTestId("live-stage").className).toContain("no-video");

    fireEvent.click(screen.getByTestId("toggle-video"));
    expect(screen.getByTestId("live-stage").className).not.toContain("no-video");
  });

  it("says what the press will do rather than what the state is", () => {
    openWorld();
    expect(screen.getByTestId("toggle-video")).toHaveTextContent("video off");
    fireEvent.click(screen.getByTestId("toggle-video"));
    expect(screen.getByTestId("toggle-video")).toHaveTextContent("video on");
  });

  it("opens the playlist in the room the picture was using", () => {
    // Without this the gesture hands over a column holding one `playlists`
    // button, because the editor is a panel behind that button rather than a
    // fixture of the stage.
    openWorld();
    expect(screen.queryByTestId("playlist-editor")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("toggle-video"));
    expect(screen.getByTestId("playlist-editor")).toBeInTheDocument();
  });

  it("leaves the playlist open when the picture comes back", () => {
    // The toggle opens the panel; it does not own it.
    openWorld();
    fireEvent.click(screen.getByTestId("toggle-video"));
    fireEvent.click(screen.getByTestId("toggle-video"));
    expect(screen.getByTestId("playlist-editor")).toBeInTheDocument();
  });

  it("marks the column so the stylesheet can hand it over", () => {
    openWorld();
    expect(screen.getByTestId("live-stage").className).not.toContain("no-video");
    fireEvent.click(screen.getByTestId("toggle-video"));
    expect(screen.getByTestId("live-stage").className).toContain("no-video");
  });

  it("opens on the choice the last visit left, not on the default", () => {
    openWorld();
    fireEvent.click(screen.getByTestId("toggle-video"));
    cleanup();

    openWorld();
    expect(screen.getByTestId("live-stage").className).toContain("no-video");
    expect(screen.getByTestId("toggle-video")).toHaveTextContent("video on");
  });

  it("keeps the loudspeaker mounted across the toggle", () => {
    // The transport belongs to no World and must not be collateral of putting
    // the picture away — the sibling of the picker case above, on the gesture
    // this feature adds.
    const world = testWorld();
    mount(
      <LivePane
        state={testState({ world, worldReports: testReports(world), audioAuthority: true })}
        send={harness().send}
      />,
    );
    const speaker = screen.getByTestId("audio-element");

    fireEvent.click(screen.getByTestId("toggle-video"));
    expect(screen.getByTestId("audio-element")).toBe(speaker);
    fireEvent.click(screen.getByTestId("toggle-video"));
    expect(screen.getByTestId("audio-element")).toBe(speaker);
  });
});

describe("the seams", () => {
  const KEY = "hal1000.live-layout";

  /** jsdom lays nothing out, so the container has to be told how wide it is.
   *  Every assertion below is about the numbers that reach storage and the
   *  track list — never about pixels, which only a browser can answer. */
  const openWide = () => {
    const world = testWorld();
    mount(<LivePane state={testState({ world, worldReports: testReports(world) })} send={harness().send} />);
    const body = screen.getByTestId("live-body");
    body.getBoundingClientRect = () =>
      ({ width: 1000, height: 500, left: 0, right: 1000, top: 0, bottom: 500, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    return body;
  };

  const stored = () => JSON.parse(window.localStorage.getItem(KEY) ?? "{}");

  const drag = (testid: string, from: number, to: number, finish: "pointerUp" | "pointerCancel" = "pointerUp") => {
    const bar = screen.getByTestId(testid);
    fireEvent.pointerDown(bar, { clientX: from, pointerId: 1 });
    fireEvent.pointerMove(bar, { clientX: to, pointerId: 1 });
    if (finish === "pointerUp") fireEvent.pointerUp(bar, { clientX: to, pointerId: 1 });
    else fireEvent.pointerCancel(bar, { clientX: to, pointerId: 1 });
    return bar;
  };

  it("offers a bar at each seam, announced as one", () => {
    openWide();
    for (const id of ["live-divider-stage", "live-divider-side"]) {
      expect(screen.getByTestId(id)).toHaveAttribute("role", "separator");
      expect(screen.getByTestId(id)).toHaveAttribute("aria-orientation", "vertical");
    }
  });

  it("keeps the graph's own element, which eight stylesheet rules hang off", () => {
    // `display: contents` rather than a fragment. Returning a fragment would
    // have unmatched `.state-graph .clip-set` and its run-grouping variants, the
    // crossing path and `broken-clips`, without failing anything.
    openWide();
    expect(screen.getByTestId("state-graph")).toBeInTheDocument();
  });

  it("moves the stage seam by the distance dragged", () => {
    openWide();
    drag("live-divider-stage", 260, 360); // +100px of 1000 = +10 points
    expect(stored().stage).toBeCloseTo(36, 5);
  });

  it("reads the sidebar seam from the edge it belongs to", () => {
    // The stored number is the sidebar's own width, so dragging left widens it.
    // Getting this backwards gives a bar that runs away from the pointer.
    openWide();
    drag("live-divider-side", 750, 650);
    expect(stored().side).toBeCloseTo(35, 5);
  });

  it("writes once for the whole gesture, not once per move", () => {
    const body = openWide();
    // Spied on the prototype, not on the instance: jsdom's Storage is a proxy
    // whose named-property setter treats `localStorage.setItem = fn` as storing
    // a key called "setItem", so the assignment succeeds and intercepts nothing.
    const setItem = vi.spyOn(window.Storage.prototype, "setItem");
    const writes = () => setItem.mock.calls.filter(([key]) => key === KEY);

    const bar = screen.getByTestId("live-divider-stage");
    fireEvent.pointerDown(bar, { clientX: 260, pointerId: 1 });
    for (let x = 265; x <= 360; x += 5) fireEvent.pointerMove(bar, { clientX: x, pointerId: 1 });
    // The geometry is live on the element throughout — it is just not going
    // through state, which would reconcile the whole pane at pointer rate.
    expect(body.style.getPropertyValue("--live-cols")).toContain("36%");
    expect(writes()).toHaveLength(0);

    fireEvent.pointerUp(bar, { clientX: 360, pointerId: 1 });
    expect(writes()).toHaveLength(1);
    setItem.mockRestore();
  });

  it("lets go on a cancelled pointer, which never sends an up", () => {
    // The exit `LayoutShell` has never handled. A touch-drag on a 6px bar is
    // what a browser claims as a pan, and the listeners would otherwise stay
    // bound — the bar following the next touch anywhere on the page.
    const body = openWide();
    const bar = drag("live-divider-stage", 260, 360, "pointerCancel");
    const settled = body.style.getPropertyValue("--live-cols");

    fireEvent.pointerMove(bar, { clientX: 700, pointerId: 1 });
    expect(body.style.getPropertyValue("--live-cols")).toBe(settled);
  });

  it("gives way on the other seam rather than on the canvas", () => {
    openWide();
    drag("live-divider-stage", 260, 600); // asks for 60, clamped to 50
    expect(stored().stage).toBe(50);
    expect(stored().side).toBe(20);
    expect(100 - stored().stage - stored().side).toBe(30);
  });

  it("returns the pressured seam when the drag comes back", () => {
    // Reversibility. Computed from where the gesture began rather than from the
    // layout as it stands, so a seam shoved aside on the way out recovers on
    // the way back instead of keeping what it was squeezed to.
    openWide();
    const bar = screen.getByTestId("live-divider-stage");
    fireEvent.pointerDown(bar, { clientX: 260, pointerId: 1 });
    fireEvent.pointerMove(bar, { clientX: 600, pointerId: 1 });
    fireEvent.pointerMove(bar, { clientX: 260, pointerId: 1 });
    fireEvent.pointerUp(bar, { clientX: 260, pointerId: 1 });

    expect(stored().stage).toBeCloseTo(26, 5);
    expect(stored().side).toBeCloseTo(25, 5);
  });

  it("declares the tracks as a custom property and never as an inline grid", () => {
    // The whole of KTD1, asserted as an absence: an inline
    // `grid-template-columns` beats the stylesheet, which is how this codebase
    // once ended up needing `!important` to restyle a grid it had already
    // described. Nothing fails when that happens, so the test is the guard.
    const body = openWide();
    expect(body.style.getPropertyValue("--live-cols")).toContain("minmax(0, 1fr)");
    expect(body.style.gridTemplateColumns).toBe("");
  });
});
