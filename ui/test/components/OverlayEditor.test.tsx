import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { OverlayEditor } from "../../src/components/OverlayEditor";
import type { ClientMessage } from "../../../shared/src/types";
import type { ImageSlot, OverlaySlot, TextSlot } from "../../../shared/src/overlays";
import { mount, testState, testWorld } from "./harness";

const text = (over: Partial<TextSlot> = {}): TextSlot => ({
  position: "bottom-left",
  source: "text",
  text: "caption",
  font: "Georgia",
  size: 4,
  color: "#ffffff",
  ...over,
});

const image = (over: Partial<ImageSlot> = {}): ImageSlot => ({
  kind: "image",
  position: "top-right",
  image: "logo.png",
  size: 6,
  ...over,
});

/** Mount the editor and collect everything it sends. */
function editor(overlays: OverlaySlot[]) {
  const sent: ClientMessage[] = [];
  const world = testWorld({ id: "night-drive", overlays });
  mount(
    <OverlayEditor
      world={world}
      editable
      send={(msg) => sent.push(msg)}
      state={testState({ world })}
      refusal={() => null}
    />,
  );
  return {
    sent,
    /** The overlay list carried by the last `set-world-overlays` sent. */
    lastList: () => {
      for (let i = sent.length - 1; i >= 0; i -= 1) {
        const msg = sent[i]!;
        if (msg.type === "set-world-overlays") return msg.overlays;
      }
      return null;
    },
  };
}

describe("a list of two kinds", () => {
  it("lets a caption be edited while a broken picture sits beside it", () => {
    // The defect this guards is three days old on this exact code path: the
    // editor drops slots the strict guard refuses before sending, because the
    // server refuses a list whole. Add a second kind without teaching that
    // filter about it and one bad picture jams every edit to every caption in
    // the list. See
    // docs/solutions/a-lenient-load-and-a-strict-write-need-a-filter-between-them.md.
    const broken = { kind: "image", position: "top-left", image: "gone.png", size: 300 } as ImageSlot;
    const { lastList } = editor([broken, text({ source: "title" })]);

    fireEvent.change(screen.getByLabelText("size for slot 2"), { target: { value: "9" } });
    fireEvent.blur(screen.getByLabelText("size for slot 2"));

    const list = lastList();
    expect(list).not.toBeNull();
    // The caption's edit went, and only the refused neighbour was dropped.
    expect(list).toHaveLength(1);
    expect(list![0]).toMatchObject({ source: "title", size: 9 });
  });

  it("keeps a hand-edited font when a different field on that slot changes", () => {
    // The offering half and the keeping half are two sites, and fixing only the
    // first is the failure recorded one feature earlier in
    // docs/solutions/a-fix-to-what-a-picker-offers-is-not-a-fix-to-what-it-keeps.md.
    // The gesture is what proves it: coerce the select's value to a list member
    // and *this* edit — to the colour — silently rewrites the font. Asserting
    // the dropdown's render instead would pass while the bug shipped.
    const { lastList } = editor([text({ font: "Wingdings Deluxe" })]);

    const control = screen.getByLabelText("font for slot 1") as HTMLSelectElement;
    expect(control.value).toBe("Wingdings Deluxe");

    // Any other field will do; the point is that this edit does not touch the
    // font, and a coerced select value would rewrite it anyway.
    fireEvent.change(screen.getByLabelText("size for slot 1"), { target: { value: "9" } });
    fireEvent.blur(screen.getByLabelText("size for slot 1"));

    const list = lastList();
    expect(list![0]).toMatchObject({ font: "Wingdings Deluxe", size: 9 });
  });

  it("offers an off-list family on its own row only", () => {
    const { sent } = editor([text({ font: "Wingdings Deluxe" }), text({ font: "Georgia" })]);
    const first = screen.getByLabelText("font for slot 1") as HTMLSelectElement;
    const second = screen.getByLabelText("font for slot 2") as HTMLSelectElement;

    const families = (s: HTMLSelectElement) => Array.from(s.options).map((o) => o.value);
    expect(families(first)).toContain("Wingdings Deluxe");
    expect(families(second)).not.toContain("Wingdings Deluxe");
    // Reading the list sends nothing.
    expect(sent).toHaveLength(0);
  });

  it("shows a picture row no font, colour or source, and a caption row no opacity", () => {
    editor([image(), text()]);

    expect(screen.queryByLabelText("font for slot 1")).toBeNull();
    expect(screen.queryByLabelText("colour for slot 1")).toBeNull();
    expect(screen.queryByLabelText("source for slot 1")).toBeNull();
    expect(screen.queryByLabelText("opacity for slot 1")).not.toBeNull();

    expect(screen.queryByLabelText("font for slot 2")).not.toBeNull();
    expect(screen.queryByLabelText("opacity for slot 2")).toBeNull();
  });

  it("tells a freshly added picture row apart from a broken one", () => {
    // An unfilled row is valid and draws nothing; it is not damage, and must
    // not wear the damage warning. This test is why the model says so: written
    // the other way, the editor's own write filter dropped the row it had just
    // added, and the row vanished on the next broadcast.
    editor([image({ image: "" })]);

    expect(screen.queryByTestId("overlay-slot-0-unusable")).toBeNull();
    expect(screen.getByTestId("overlay-slot-0-image").textContent).toBe("no image chosen");
  });

  it("warns on a picture row the guard refuses", () => {
    editor([image({ size: 300 })]);
    expect(screen.queryByTestId("overlay-slot-0-unusable")).not.toBeNull();
  });

  it("adds a picture slot that carries no caption fields", () => {
    const { lastList } = editor([text()]);
    fireEvent.click(screen.getByTestId("add-overlay-image-slot"));

    const added = lastList()![1]!;
    expect(added).toMatchObject({ kind: "image" });
    expect(added).not.toHaveProperty("font");
    expect(added).not.toHaveProperty("color");
    expect(added).not.toHaveProperty("source");
  });

  it("sends an import naming the row's own index", () => {
    const { sent } = editor([text(), image({ image: "" })]);
    fireEvent.click(screen.getByLabelText("choose image for slot 2"));
    expect(screen.queryByTestId("image-picker")).not.toBeNull();
    // The picker asks for a folder on open; the import itself carries the index.
    expect(sent.some((m) => m.type === "browse-clips")).toBe(true);
  });

  it("survives a hand-edited manifest whose image is not a string", () => {
    // Every other fixture here comes from the typed helpers, which is exactly
    // why the type lied about `slot.image` unnoticed: a manifest is
    // hand-editable and the loader is lenient, so the editor is handed shapes
    // TypeScript promised could not exist. Reading `.trim()` off a number threw
    // and took /live's whole main view down to the error boundary.
    const hostile = [
      { kind: "image", position: "top-right", image: 3, size: 6 },
      { kind: "image", position: "top-left", image: null, size: 6 },
      { kind: "image", position: "bottom-left", image: { path: "x.png" }, size: 6 },
    ] as unknown as OverlaySlot[];

    expect(() => editor(hostile)).not.toThrow();
    expect(screen.getAllByTestId(/^overlay-slot-\d+-image$/)).toHaveLength(3);
  });

  it("keeps the damage warning on a row that is unfilled AND broken", () => {
    // Suppressing it for every unfilled row hid a genuinely broken one, which
    // the next edit then dropped with no explanation.
    editor([image({ image: undefined, size: 300 })]);
    expect(screen.queryByTestId("overlay-slot-0-unusable")).not.toBeNull();
  });

  it("commits an edit against the list it is about to write, not a stale one", () => {
    // After a reorder the broadcast has not returned, so the rendered `slots`
    // is stale while `write` uses the fresh list. Deciding on one and writing to
    // the other lands the edit on a different slot or drops it at the kind
    // check.
    const { lastList } = editor([text({ text: "first" }), image()]);

    fireEvent.click(screen.getByLabelText("move slot 2 up"));
    // The picture is now index 0 and the caption index 1, in the sent list.
    fireEvent.change(screen.getByLabelText("size for slot 1"), { target: { value: "9" } });
    fireEvent.blur(screen.getByLabelText("size for slot 1"));

    const list = lastList()!;
    expect(list[0]).toMatchObject({ kind: "image", size: 9 });
    expect(list[1]).toMatchObject({ text: "first", size: 4 });
  });

  it("closes an open picker when its row moves or goes", () => {
    // `picking` is a bare index; a move changes what that index means, and an
    // image chosen afterwards would attach to a row nobody is looking at.
    const { lastList } = editor([text(), image({ image: undefined })]);

    fireEvent.click(screen.getByLabelText("choose image for slot 2"));
    expect(screen.queryByTestId("image-picker")).not.toBeNull();
    fireEvent.click(screen.getByLabelText("move slot 2 up"));
    expect(screen.queryByTestId("image-picker")).toBeNull();
    void lastList;
  });

  it("moves and removes a picture row exactly as a caption row", () => {
    const { lastList } = editor([text(), image()]);

    fireEvent.click(screen.getByLabelText("move slot 2 up"));
    expect(lastList()![0]).toMatchObject({ kind: "image" });

    fireEvent.click(screen.getByLabelText("remove slot 2"));
    expect(lastList()).toHaveLength(1);
  });
});
