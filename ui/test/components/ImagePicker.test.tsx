import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { ImagePicker } from "../../src/components/ImagePicker";
import type { ClientMessage, LibraryListing } from "../../../shared/src/types";
import { mount, testState, testWorld } from "./harness";

const listing = (over: Partial<LibraryListing> = {}): LibraryListing => ({
  folder: "D:/art",
  parent: "D:/",
  folders: [{ name: "old", path: "D:/art/old" }],
  clips: [{ name: "couch.mp4", path: "D:/art/couch.mp4", sizeBytes: 10 }],
  images: [
    { name: "band.png", path: "D:/art/band.png", sizeBytes: 20 },
    { name: "logo.png", path: "D:/art/logo.png", sizeBytes: 30 },
  ],
  ...over,
});

/** Mount the picker for one slot and collect what it sends. */
function picker(over: { library?: LibraryListing | null; slot?: number; results?: Record<string, { ok: boolean; error?: string }> } = {}) {
  const sent: ClientMessage[] = [];
  let closed = 0;
  const world = testWorld({ id: "night-drive" });
  const state = testState({
    world,
    clipLibrary: over.library === undefined ? listing() : over.library,
    ...(over.results ? { worldResults: over.results } : {}),
  });
  mount(
    <ImagePicker
      state={state}
      send={(msg) => sent.push(msg)}
      worldId="night-drive"
      slot={over.slot ?? 0}
      onClose={() => {
        closed += 1;
      }}
    />,
  );
  return { sent, closed: () => closed };
}

describe("choosing an image", () => {
  it("sends the import naming this row's own index", () => {
    // A non-zero index deliberately: an off-by-one would attach the picture to
    // whatever slot happened to be first and no other test would notice.
    const { sent } = picker({ slot: 3 });

    fireEvent.click(screen.getByText("logo.png"));

    expect(sent).toEqual([
      { type: "import-overlay-image", worldId: "night-drive", sourcePath: "D:/art/logo.png", slot: 3 },
    ]);
  });

  it("offers the folder's images and not its clips", () => {
    picker();
    expect(screen.queryByText("logo.png")).not.toBeNull();
    expect(screen.queryByText("band.png")).not.toBeNull();
    // The listing carries both halves; this reads only its own.
    expect(screen.queryByText("couch.mp4")).toBeNull();
    expect(screen.queryByText("old/")).not.toBeNull();
  });

  it("filters by name without asking the server again", () => {
    const { sent } = picker();
    fireEvent.change(screen.getByLabelText("filter images"), { target: { value: "log" } });

    expect(screen.queryByText("logo.png")).not.toBeNull();
    expect(screen.queryByText("band.png")).toBeNull();
    expect(sent).toEqual([]);
  });

  it("does not re-browse when the store already holds a listing", () => {
    // `state.clipLibrary` is one slot shared with ClipBrowser. Browsing on
    // mount blanked an open clip browser back to "reading…" the moment this
    // opened.
    const { sent } = picker();
    expect(sent).toEqual([]);
  });

  it("browses once when the store holds nothing yet", () => {
    const { sent } = picker({ library: null });
    expect(sent).toEqual([{ type: "browse-clips" }]);
    expect(screen.queryByText("reading…")).not.toBeNull();
  });

  it("navigates into a folder and up to the parent", () => {
    const { sent } = picker();
    fireEvent.click(screen.getByText("old/"));
    fireEvent.click(screen.getByText("../"));
    expect(sent).toEqual([
      { type: "browse-clips", path: "D:/art/old" },
      { type: "browse-clips", path: "D:/" },
    ]);
  });

  it("shows no error before this picker has asked for anything", () => {
    // `worldResults` keeps the last answer for an action indefinitely, so a
    // refusal from some earlier import used to greet a picker that had not sent
    // anything yet.
    picker({ results: { "import-overlay-image": { ok: false, error: "That file is not an image HAL can draw." } } });
    expect(screen.queryByTestId("image-import-error")).toBeNull();
  });

  it("reports a refusal of the import it actually sent, and stays open", () => {
    const { closed } = picker({
      results: { "import-overlay-image": { ok: false, error: "That file is not an image HAL can draw." } },
    });

    fireEvent.click(screen.getByText("logo.png"));

    expect(screen.getByTestId("image-import-error").textContent).toBe(
      "That file is not an image HAL can draw.",
    );
    // Closing on the click meant a refusal was reported to a panel that had
    // already gone, so a rejected image looked like nothing happening.
    expect(closed()).toBe(0);
  });

  it("says when a folder holds no images, and when it holds more than it shows", () => {
    picker({ library: listing({ images: [], truncated: true }) });
    expect(screen.queryByText("No images in this folder.")).not.toBeNull();
    expect(screen.queryByText(/More here than is shown/)).not.toBeNull();
  });

  it("reports a folder that could not be read rather than looking empty", () => {
    picker({ library: listing({ images: [], error: "That folder could not be read: EACCES" }) });
    expect(screen.queryByText("That folder could not be read: EACCES")).not.toBeNull();
  });
});
