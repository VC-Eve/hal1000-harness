import { describe, it, expect, afterEach } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { LivePane } from "../../src/components/LivePane";
import { App } from "../../src/App";
import { currentRoute, navigate, parseRoute } from "../../src/route";
import { harness, mount, testReports, testState, testWorld } from "./harness";

afterEach(() => {
  window.history.pushState({}, "", "/");
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
