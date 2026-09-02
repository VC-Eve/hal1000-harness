import { describe, it, expect, afterEach } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
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
    expect(screen.getByTestId("floorplan")).toBeInTheDocument();
    expect(screen.getByTestId("clip-player")).toBeInTheDocument();
  });

  it("offers a way back to the picker", () => {
    const world = testWorld();
    mount(<LivePane state={testState({ world, worldReports: testReports(world) })} send={harness().send} />);

    fireEvent.click(screen.getByRole("button", { name: "worlds" }));
    expect(screen.getByTestId("world-picker")).toBeInTheDocument();
  });

  it("says so when the manifest is read-only", () => {
    const world = testWorld();
    mount(
      <LivePane state={testState({ world, worldReports: testReports(world), worldReadable: false })} send={harness().send} />,
    );
    expect(screen.getByText(/read-only/)).toBeInTheDocument();
  });
});
