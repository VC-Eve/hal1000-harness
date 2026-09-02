import { describe, it, expect } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { ClipBrowser } from "../../src/components/ClipBrowser";
import { harness, mount, testListing, testReports, testState, testWorld } from "./harness";
import type { AppState } from "../../src/store";

const open = (over: Partial<AppState> = {}) => {
  const world = testWorld();
  return testState({ world, worldReports: testReports(world), clipLibrary: testListing(), ...over });
};

const noop = () => {};

describe("mount requests", () => {
  it("asks for one listing, not one per render", () => {
    const h = harness();
    const { rerender } = mount(<ClipBrowser state={open()} send={h.send} owner={{ kind: "state", id: "s-couch" }} onClose={noop} />);
    expect(h.countOf("browse-clips")).toBe(1);

    rerender(<ClipBrowser state={open()} send={h.send} owner={{ kind: "state", id: "s-couch" }} onClose={noop} />);
    rerender(
      <ClipBrowser
        state={open({ clipLibrary: testListing({ folder: "/other" }) })}
        send={h.send}
        owner={{ kind: "state", id: "s-couch" }}
        onClose={noop}
      />,
    );
    expect(h.countOf("browse-clips")).toBe(1);
  });

  it("asks once even when handed a fresh send on every render", () => {
    // The component must not depend on its caller memoising: an effect that
    // lists an unstable `send` in its deps re-runs forever.
    const h = harness();
    const unstable = () => (msg: Parameters<typeof h.send>[0]) => h.send(msg);
    const { rerender } = mount(<ClipBrowser state={open()} send={unstable()} owner={{ kind: "state", id: "s-couch" }} onClose={noop} />);
    for (let i = 0; i < 5; i += 1) {
      rerender(<ClipBrowser state={open()} send={unstable()} owner={{ kind: "state", id: "s-couch" }} onClose={noop} />);
    }
    expect(h.countOf("browse-clips")).toBe(1);
  });
});

describe("what it lists", () => {
  it("shows the folder, its subfolders and its clips, from the broadcast reply", () => {
    mount(<ClipBrowser state={open()} send={harness().send} owner={{ kind: "state", id: "s-couch" }} onClose={noop} />);

    expect(screen.getByTestId("browser-folder")).toHaveTextContent("/takes");
    expect(screen.getByTestId("folder-old")).toBeInTheDocument();
    expect(screen.getByTestId("clip-couch-idle.mp4")).toBeInTheDocument();
    expect(screen.getByTestId("clip-booth-idle.mp4")).toBeInTheDocument();
  });

  it("filters by filename, and restores when cleared", () => {
    mount(<ClipBrowser state={open()} send={harness().send} owner={{ kind: "state", id: "s-couch" }} onClose={noop} />);

    fireEvent.change(screen.getByLabelText("filter clips"), { target: { value: "booth" } });
    expect(screen.queryByTestId("clip-couch-idle.mp4")).not.toBeInTheDocument();
    expect(screen.getByTestId("clip-booth-idle.mp4")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("filter clips"), { target: { value: "" } });
    expect(screen.getByTestId("clip-couch-idle.mp4")).toBeInTheDocument();
  });

  it("browses into a folder and back up", () => {
    const h = harness();
    mount(<ClipBrowser state={open()} send={h.send} owner={{ kind: "state", id: "s-couch" }} onClose={noop} />);

    fireEvent.click(within(screen.getByTestId("folder-old")).getByRole("button"));
    expect(h.sent.at(-1)).toEqual({ type: "browse-clips", path: "/takes/old" });

    fireEvent.click(screen.getByRole("button", { name: "up" }));
    expect(h.sent.at(-1)).toEqual({ type: "browse-clips", path: "/" });
  });

  it("cannot go up from a filesystem root", () => {
    mount(
      <ClipBrowser
        state={open({ clipLibrary: testListing({ parent: null }) })}
        send={harness().send}
        owner={{ kind: "state", id: "s-couch" }}
        onClose={noop}
      />,
    );
    expect(screen.getByRole("button", { name: "up" })).toBeDisabled();
  });

  it("renders the reason a folder could not be read, rather than an empty folder", () => {
    mount(
      <ClipBrowser
        state={open({
          clipLibrary: testListing({ error: "That folder could not be read: EACCES", clips: [], folders: [] }),
        })}
        send={harness().send}
        owner={{ kind: "state", id: "s-couch" }}
        onClose={noop}
      />,
    );

    expect(screen.getByTestId("browser-error")).toHaveTextContent("EACCES");
    expect(screen.queryByTestId("browser-empty")).not.toBeInTheDocument();
  });

  it("says so when a readable folder holds nothing it can play", () => {
    mount(
      <ClipBrowser
        state={open({ clipLibrary: testListing({ clips: [], folders: [] }) })}
        send={harness().send}
        owner={{ kind: "state", id: "s-couch" }}
        onClose={noop}
      />,
    );
    expect(screen.getByTestId("browser-empty")).toBeInTheDocument();
  });

  it("shows the file's size, the only thing it can know about a clip here", () => {
    // Not its duration. A page served over http cannot load a `file://` URL, so
    // probing the file from the browser could never have worked; the real
    // duration is measured server-side the first time the clip plays.
    mount(<ClipBrowser state={open()} send={harness().send} owner={{ kind: "state", id: "s-couch" }} onClose={noop} />);
    expect(screen.getByTestId("duration-couch-idle.mp4")).toHaveTextContent("2 kB");
  });
});

describe("picking a clip", () => {
  it("imports it against the State it was opened for, and closes", () => {
    const h = harness();
    let closed = false;
    mount(
      <ClipBrowser
        state={open()}
        send={h.send}
        owner={{ kind: "state", id: "s-booth" }}
        onClose={() => {
          closed = true;
        }}
      />,
    );

    fireEvent.click(within(screen.getByTestId("clip-couch-idle.mp4")).getByRole("button"));

    expect(h.sent.at(-1)).toEqual({
      type: "import-clip",
      worldId: "lounge",
      sourcePath: "/takes/couch-idle.mp4",
      owner: { kind: "state", id: "s-booth" },
    });
    expect(closed).toBe(true);
  });

  it("cannot import while no World is open", () => {
    mount(
      <ClipBrowser
        state={testState({ clipLibrary: testListing() })}
        send={harness().send}
        owner={{ kind: "state", id: "s-couch" }}
        onClose={noop}
      />,
    );
    expect(within(screen.getByTestId("clip-couch-idle.mp4")).getByRole("button")).toBeDisabled();
  });

  it("renders the reason an import was refused", () => {
    mount(
      <ClipBrowser
        state={open({ worldResults: { "import-clip": { ok: false, error: "That file is not a video HAL can play." } } })}
        send={harness().send}
        owner={{ kind: "state", id: "s-couch" }}
        onClose={noop}
      />,
    );
    expect(screen.getByTestId("import-error")).toHaveTextContent("not a video");
  });
});

describe("what the review of 2026-09-02 found", () => {
  it("ignores a listing that arrives for a folder no longer being asked for", () => {
    // The server does not await one handler before starting the next, and
    // listing cost varies with folder size — so the reply for a big folder can
    // land after the reply for the small one navigated to next.
    const h = harness();
    const { rerender } = mount(
      <ClipBrowser state={open()} send={h.send} owner={{ kind: "state", id: "s-couch" }} onClose={noop} />,
    );

    fireEvent.click(within(screen.getByTestId("folder-old")).getByRole("button"));
    expect(h.sent.at(-1)).toEqual({ type: "browse-clips", path: "/takes/old" });

    // The slower reply for the folder we left arrives second.
    rerender(
      <ClipBrowser
        state={open({ clipLibrary: testListing({ folder: "/takes" }) })}
        send={h.send}
        owner={{ kind: "state", id: "s-couch" }}
        onClose={noop}
      />,
    );

    expect(screen.queryByTestId("browser-folder")).not.toHaveTextContent("/takes");
  });

  it("shows the listing once the folder actually asked for replies", () => {
    const h = harness();
    const { rerender } = mount(
      <ClipBrowser state={open()} send={h.send} owner={{ kind: "state", id: "s-couch" }} onClose={noop} />,
    );

    fireEvent.click(within(screen.getByTestId("folder-old")).getByRole("button"));
    rerender(
      <ClipBrowser
        state={open({ clipLibrary: testListing({ folder: "/takes/old" }) })}
        send={h.send}
        owner={{ kind: "state", id: "s-couch" }}
        onClose={noop}
      />,
    );

    expect(screen.getByTestId("browser-folder")).toHaveTextContent("/takes/old");
  });
});

describe("a folder with more in it than one listing shows", () => {
  it("says so, rather than looking like the end of the folder", () => {
    // The server sets the flag; without this it set it into nothing and the
    // author saw a short list with no sign anything was missing.
    mount(
      <ClipBrowser
        state={open({ clipLibrary: testListing({ truncated: true }) })}
        send={harness().send}
        owner={{ kind: "state", id: "s-couch" }}
        onClose={noop}
      />,
    );

    expect(screen.getByTestId("browser-truncated")).toBeInTheDocument();
  });

  it("says nothing when the folder fits", () => {
    mount(<ClipBrowser state={open()} send={harness().send} owner={{ kind: "state", id: "s-couch" }} onClose={noop} />);
    expect(screen.queryByTestId("browser-truncated")).not.toBeInTheDocument();
  });
});
