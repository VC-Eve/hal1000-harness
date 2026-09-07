import { describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { OverlayEditor } from "../../src/components/OverlayEditor";
import type { ClientMessage, LiveState } from "../../../shared/src/types";
import {
  DEFAULT_OUTLINE,
  DEFAULT_SHADOW,
  MAX_OVERLAY_FADE_MS,
  OUTLINE_WIDTH_MAX,
  type ImageSlot,
  type OverlaySlot,
  type TextSlot,
} from "../../../shared/src/overlays";
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

describe("when a slot is drawn", () => {
  /** Mount with a live state, so the showing mark has something to answer from. */
  function editorLive(overlays: OverlaySlot[], live: Partial<LiveState> | null, editable = true) {
    const sent: ClientMessage[] = [];
    const world = testWorld({ id: "night-drive", overlays, states: [
      { id: "s1", name: "one", clips: [], x: 0, y: 0 },
      { id: "s2", name: "two", clips: [], x: 1, y: 0 },
    ] });
    mount(
      <OverlayEditor
        world={world}
        editable={editable}
        send={(msg) => sent.push(msg)}
        state={testState({
          world,
          worldLive: live === null ? null : { worldId: "night-drive", stateId: "s1", clip: null, parameters: {}, generation: 1, fault: null, ...live },
        })}
        refusal={() => null}
      />,
    );
    return {
      sent,
      lastList: () => {
        for (let i = sent.length - 1; i >= 0; i -= 1) {
          const msg = sent[i]!;
          if (msg.type === "set-world-overlays") return msg.overlays;
        }
        return null;
      },
    };
  }

  const open = (index = 0) => fireEvent.click(screen.getByTestId(`overlay-when-${index}`));

  it("keeps the when collapsed for a slot that says nothing about it", () => {
    editorLive([text()], {});
    expect(screen.getByTestId("overlay-when-0").getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByTestId("overlay-when-0").textContent).toContain("always");
    expect(screen.queryByLabelText(/^condition 0 parameter/)).toBeNull();
  });

  it("opens on a click and offers the World's States and no others", () => {
    editorLive([text()], {});
    open();
    expect(screen.getByLabelText("state one for slot 1")).toBeInTheDocument();
    expect(screen.getByLabelText("state two for slot 1")).toBeInTheDocument();
    expect(screen.queryByLabelText(/^state three/)).toBeNull();
  });

  it("sends the State it was given", () => {
    const e = editorLive([text()], {});
    open();
    fireEvent.click(screen.getByLabelText("state one for slot 1"));
    expect(e.lastList()![0]).toMatchObject({ states: ["s1"] });
  });

  it("removes the states key when the last State goes", () => {
    const e = editorLive([text({ states: ["s1"] })], {});
    open();
    fireEvent.click(screen.getByLabelText("state one for slot 1"));
    // Absent, not `[]`: `write` sends the list unfiltered, so an empty array
    // would go on the wire and the canonical form of "always" would differ from
    // every manifest already on disk.
    expect(e.lastList()![0]).not.toHaveProperty("states");
  });

  it("adds a complete clause, and the row does not vanish", () => {
    // The write-side filter deletes any slot the strict guard refuses, so a row
    // that could be added half-authored would delete itself on the click that
    // added it.
    const e = editorLive([text()], {});
    open();
    fireEvent.click(screen.getByLabelText("add condition — slot 1"));
    const slot = e.lastList()![0] as OverlaySlot;
    expect(slot.conditions).toHaveLength(1);
    expect(slot.conditions![0]).toMatchObject({ parameter: expect.any(String), op: expect.any(String) });
    expect(screen.getByTestId("overlay-slot-0")).toBeInTheDocument();
  });

  it("removes the conditions key when the last clause goes", () => {
    const e = editorLive([text({ conditions: [{ parameter: "audio.playing", op: "is", value: true }] })], {});
    open();
    fireEvent.click(screen.getByLabelText("remove condition 0 — slot 1"));
    expect(e.lastList()![0]).not.toHaveProperty("conditions");
  });

  it("re-points a clause across a type boundary with an operator the new type has", () => {
    // The defect `repoint` exists for, asserted on what is *sent* rather than on
    // what the dropdown offers.
    const world = testWorld({
      id: "night-drive",
      overlays: [text({ conditions: [{ parameter: "ready", op: "is", value: true }] })],
      parameters: [
        { name: "ready", type: "bool", defaultValue: false },
        { name: "energy", type: "float", defaultValue: 0.25 },
      ],
    });
    const sent: ClientMessage[] = [];
    mount(
      <OverlayEditor
        world={world}
        editable
        send={(msg) => sent.push(msg)}
        state={testState({ world })}
        refusal={() => null}
      />,
    );
    open();
    fireEvent.change(screen.getByLabelText(/^condition 0 parameter/), { target: { value: "energy" } });

    const last = sent.filter((m) => m.type === "set-world-overlays").pop() as { overlays: OverlaySlot[] };
    expect(last.overlays[0]!.conditions![0]).toEqual({ parameter: "energy", op: "gt", value: 0.25 });
  });

  it("says whether the slot is showing, and which half said no", () => {
    editorLive([text({ states: ["s1"] })], { stateId: "s1" });
    expect(screen.getByTestId("overlay-showing-0").textContent).toBe("showing");

    document.body.innerHTML = "";
    editorLive([text({ states: ["s1"] })], { stateId: "s2" });
    expect(screen.getByTestId("overlay-showing-0").textContent).toContain("another State");

    document.body.innerHTML = "";
    editorLive([text({ conditions: [{ parameter: "gone", op: "is", value: true }] })], { stateId: "s1" });
    expect(screen.getByTestId("overlay-showing-0").textContent).toContain("clause");
  });

  it("says nothing at all while the live state names another World", () => {
    // Not "no" but "not known": a mark claiming the slot is hidden would be a
    // statement about a projector this panel is not watching.
    editorLive([text({ states: ["s1"] })], { worldId: "other" });
    expect(screen.queryByTestId("overlay-showing-0")).toBeNull();
  });

  it("keeps a State the World no longer holds, checked and removable", () => {
    const e = editorLive([text({ states: ["s1", "gone"] })], {});
    open();
    const missing = screen.getByLabelText("missing state gone for slot 1") as HTMLInputElement;
    expect(missing.checked).toBe(true);

    fireEvent.click(missing);
    expect(e.lastList()![0]).toMatchObject({ states: ["s1"] });
  });

  it("offers to clear a broken row rather than losing the slot with it", () => {
    // Without this, the write filter drops the whole slot — words, font,
    // position, colour — on the next edit to any other slot.
    const broken = { ...text(), conditions: 3 } as unknown as OverlaySlot;
    const e = editorLive([broken, text({ text: "other" })], {});
    open();
    fireEvent.click(screen.getByText("clear conditions"));

    const list = e.lastList()!;
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ text: "caption", font: "Georgia", position: "bottom-left" });
    expect(list[0]).not.toHaveProperty("conditions");
  });

  it("sends a fade", () => {
    const e = editorLive([text()], {});
    open();
    const field = screen.getByLabelText("fade for slot 1");
    fireEvent.change(field, { target: { value: "300" } });
    fireEvent.blur(field);
    expect(e.lastList()![0]).toMatchObject({ fadeMs: 300 });
  });

  it("removes the fade key when it is set back to a cut", () => {
    // Zero is a cut and a cut is what absent means: one absent-shaped answer
    // downstream rather than two, which is `blendMs`' rule.
    const e = editorLive([text({ fadeMs: 300 })], {});
    open();
    const field = screen.getByLabelText("fade for slot 1");
    fireEvent.change(field, { target: { value: "0" } });
    fireEvent.blur(field);
    expect(e.lastList()![0]).not.toHaveProperty("fadeMs");
  });

  it("refuses a fade past the ceiling rather than clamping it", () => {
    const e = editorLive([text()], {});
    open();
    const field = screen.getByLabelText("fade for slot 1");
    fireEvent.change(field, { target: { value: String(MAX_OVERLAY_FADE_MS + 1) } });
    fireEvent.blur(field);
    expect(e.lastList()).toBeNull();
  });

  it("disables every control on a read-only World", () => {
    editorLive([text({ conditions: [{ parameter: "audio.playing", op: "is", value: true }] })], {}, false);
    open();
    expect((screen.getByLabelText(/^condition 0 parameter/) as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByLabelText(/^condition 0 operator/) as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByLabelText(/^condition 0 value/) as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByLabelText("state one for slot 1") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("fade for slot 1") as HTMLInputElement).disabled).toBe(true);
  });

  it("offers the when on a picture slot as well as a caption", () => {
    editorLive([image()], {});
    open();
    expect(screen.getByLabelText("state one for slot 1")).toBeInTheDocument();
    expect(screen.getByLabelText("fade for slot 1")).toBeInTheDocument();
  });
});

describe("a panel that addresses a row by its place in the list", () => {
  function open(overlays: OverlaySlot[]) {
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
      lastList: () => {
        for (let i = sent.length - 1; i >= 0; i -= 1) {
          const msg = sent[i]!;
          if (msg.type === "set-world-overlays") return msg.overlays;
        }
        return null;
      },
    };
  }

  it("closes the when panel when a move re-points what an index means", () => {
    // `move` already closes the picker, with a comment saying why: the index it
    // holds means a different slot afterwards. The when panel is three more
    // index-addressed writes and was not closed, so the next checkbox rewrote a
    // slot the operator was no longer looking at.
    open([text({ text: "first" }), text({ text: "second" })]);
    fireEvent.click(screen.getByTestId("overlay-when-1"));
    expect(screen.getByTestId("overlay-when-1").getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(screen.getByLabelText("move slot 2 up"));
    expect(screen.getByTestId("overlay-when-1").getAttribute("aria-expanded")).toBe("false");
  });

  it("closes the when panel when a row is removed", () => {
    open([text({ text: "first" }), text({ text: "second" })]);
    fireEvent.click(screen.getByTestId("overlay-when-1"));

    fireEvent.click(screen.getByLabelText("remove slot 1"));
    expect(screen.getByTestId("overlay-when-1").getAttribute("aria-expanded")).toBe("false");
  });

  it("offers to clear only the key that would bring a refused row back", () => {
    // The write filter drops any slot the guard still refuses, so a clear that
    // does not fix the refusal deletes the slot's words, font, position and
    // picture — the opposite of what the panel's own line promises.
    const badClause = { ...text(), conditions: 3 } as unknown as OverlaySlot;
    open([badClause]);
    fireEvent.click(screen.getByTestId("overlay-when-0"));
    expect(screen.getByText("clear conditions")).toBeInTheDocument();
    expect(screen.queryByText("clear states")).toBeNull();

    document.body.innerHTML = "";
    // Refused for a reason neither control can fix: clearing either would drop
    // the slot, so neither is offered.
    const badSize = { ...text(), size: 300 } as unknown as OverlaySlot;
    open([badSize]);
    fireEvent.click(screen.getByTestId("overlay-when-0"));
    expect(screen.queryByText("clear conditions")).toBeNull();
    expect(screen.queryByText("clear states")).toBeNull();
    expect(screen.getByText(/would not bring it back/)).toBeInTheDocument();
  });

  it("writes nothing for a value being retyped, and the number once it is one", () => {
    // A cleared field is not a zero. Writing one sends a whole
    // `set-world-overlays` — a manifest write and a broadcast to every client —
    // for a number the operator is in the middle of changing.
    //
    // The field also refuses a value that is not finite. That half cannot be
    // driven from here: jsdom sanitises `1e999` out of a number input, where a
    // real browser hands it through as `Infinity`. What it would cost is
    // covered where the shape is judged — `cleanSlot` refuses a clause whose
    // value is not finite, and the editor's write filter then drops the slot —
    // so the guard exists to stop a keystroke deleting a slot's words, font,
    // colour and picture with nothing refused and nothing said.
    const e = open([text({ conditions: [{ parameter: "audio.remaining", op: "lt", value: 5 }] })]);
    fireEvent.click(screen.getByTestId("overlay-when-0"));
    const value = screen.getByLabelText(/^condition 0 value/);

    fireEvent.change(value, { target: { value: "" } });
    expect(e.lastList()).toBeNull();

    fireEvent.change(value, { target: { value: "6" } });
    expect(e.lastList()).toHaveLength(1);
    expect((e.lastList()![0] as OverlaySlot).conditions![0]!.value).toBe(6);
  });
});

describe("authoring how a slot's words are treated", () => {
  const firstSlot = (list: OverlaySlot[] | null): TextSlot | undefined => {
    const first = list?.[0];
    return first !== undefined && !("kind" in first && first.kind === "image") ? (first as TextSlot) : undefined;
  };

  it("keeps the panel closed on first render, even for a slot that already carries one", () => {
    // A row already carries two control lines, a colour, a font and a size,
    // times up to MAX_OVERLAYS. Opening for a treated slot would grow every row
    // in a World that uses this once.
    editor([text(), text({ outline: { color: "#000000", width: 4 } })]);
    expect(screen.getByTestId("overlay-treatment-0").getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByTestId("overlay-treatment-1").getAttribute("aria-expanded")).toBe("false");
  });

  it("says at a glance whether a slot asks for any treatment at all", () => {
    editor([text(), text({ band: true })]);
    expect(screen.getByTestId("overlay-treatment-0").textContent).toContain("none");
    expect(screen.getByTestId("overlay-treatment-1").textContent).not.toContain("none");
  });

  it("writes something visible when a treatment is switched on", () => {
    // A control that writes nothing visible reads as broken, so "on" has to
    // mean something on screen before anything is adjusted.
    const one = editor([text()]);
    fireEvent.click(screen.getByTestId("overlay-treatment-0"));
    fireEvent.click(screen.getByLabelText("outline for slot 1"));

    expect(firstSlot(one.lastList())?.outline).toEqual(DEFAULT_OUTLINE);

    fireEvent.click(screen.getByLabelText("shadow for slot 1"));
    expect(firstSlot(one.lastList())?.shadow).toEqual(DEFAULT_SHADOW);
  });

  it("removes the key when a treatment is switched off, rather than storing a disabled one", () => {
    // The canonical form of an untreated slot is the one every existing
    // manifest already has — `withWhen`'s rule.
    const one = editor([text({ outline: { color: "#000000", width: 4 }, band: true })]);
    fireEvent.click(screen.getByTestId("overlay-treatment-0"));

    fireEvent.click(screen.getByLabelText("outline for slot 1"));
    expect(firstSlot(one.lastList())).not.toHaveProperty("outline");

    fireEvent.click(screen.getByLabelText("band for slot 1"));
    expect(firstSlot(one.lastList())).not.toHaveProperty("band");
  });

  it("commits a number on blur, and not before", () => {
    // `LiveNumberField` commits as it is typed, which is right for a Parameter
    // and wrong here: typing "12" would send 1 and then 12.
    const one = editor([text({ shadow: { color: "#000000", angle: 135, distance: 4, blur: 6 } })]);
    fireEvent.click(screen.getByTestId("overlay-treatment-0"));
    const field = screen.getByLabelText("shadow angle for slot 1");

    fireEvent.change(field, { target: { value: "20" } });
    expect(one.lastList()).toBeNull();

    fireEvent.blur(field);
    expect(firstSlot(one.lastList())?.shadow?.angle).toBe(20);
  });

  it("commits a number on Enter", () => {
    const one = editor([text({ outline: { color: "#000000", width: 4 } })]);
    fireEvent.click(screen.getByTestId("overlay-treatment-0"));
    const field = screen.getByLabelText("outline width for slot 1");

    fireEvent.change(field, { target: { value: "9" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(firstSlot(one.lastList())?.outline?.width).toBe(9);
  });

  it("refuses a number outside its band here, with its reason, and sends nothing", () => {
    // `commitSize`'s rule: the server refuses it as well, and this is the half
    // that explains, because the person is looking at the field.
    const one = editor([text({ outline: { color: "#000000", width: 4 } })]);
    fireEvent.click(screen.getByTestId("overlay-treatment-0"));
    const field = screen.getByLabelText("outline width for slot 1");

    fireEvent.change(field, { target: { value: String(OUTLINE_WIDTH_MAX + 5) } });
    fireEvent.blur(field);

    expect(one.lastList()).toBeNull();
    expect(screen.getByTestId("overlay-size-error").textContent).toContain(String(OUTLINE_WIDTH_MAX));
  });

  it("edits each of the shadow's four numbers", () => {
    const one = editor([text({ shadow: { color: "#000000", angle: 135, distance: 4, blur: 6 } })]);
    fireEvent.click(screen.getByTestId("overlay-treatment-0"));

    for (const [label, value] of [
      ["shadow angle for slot 1", 200],
      ["shadow distance for slot 1", 12],
      ["shadow blur for slot 1", 30],
      ["shadow opacity for slot 1", 40],
    ] as const) {
      const field = screen.getByLabelText(label);
      fireEvent.change(field, { target: { value: String(value) } });
      fireEvent.blur(field);
    }

    expect(firstSlot(one.lastList())?.shadow).toMatchObject({
      angle: 200,
      distance: 12,
      blur: 30,
      opacity: 40,
    });
  });

  it("offers no treatment at all on a picture", () => {
    // Neither means anything for an image — `ImageSlot`'s own reason for
    // carrying no font and no colour.
    editor([image()]);
    expect(screen.queryByTestId("overlay-treatment-0")).toBeNull();
  });

  it("shows what a stored backing was translated into, because it renders the cleaned slot", () => {
    editor([{ ...text(), backing: "shadow" } as unknown as OverlaySlot]);
    fireEvent.click(screen.getByTestId("overlay-treatment-0"));
    expect((screen.getByLabelText("outline width for slot 1") as HTMLInputElement).value).toBe("3");
  });

  it("closes the panel when a move re-points what an index means", () => {
    // `move` closes the picker and the when panel for this reason; a third
    // index-addressed panel has to let go too, or the next checkbox rewrites a
    // slot the operator is no longer looking at.
    editor([text({ text: "first" }), text({ text: "second" })]);
    fireEvent.click(screen.getByTestId("overlay-treatment-1"));
    expect(screen.getByTestId("overlay-treatment-1").getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(screen.getByLabelText("move slot 2 up"));
    expect(screen.getByTestId("overlay-treatment-1").getAttribute("aria-expanded")).toBe("false");
  });

  it("closes the panel when a row is removed", () => {
    editor([text({ text: "first" }), text({ text: "second" })]);
    fireEvent.click(screen.getByTestId("overlay-treatment-1"));

    fireEvent.click(screen.getByLabelText("remove slot 1"));
    expect(screen.getByTestId("overlay-treatment-1").getAttribute("aria-expanded")).toBe("false");
  });

  it("draws its panel on a row the guard refuses, without throwing", () => {
    // The row is still shown with its warning; the panel reads the stored slot
    // and must not assume it was cleanable.
    editor([text({ size: 300 })]);
    expect(screen.getByTestId("overlay-slot-0-unusable")).toBeTruthy();
    fireEvent.click(screen.getByTestId("overlay-treatment-0"));
    expect(screen.getByLabelText("band for slot 1")).toBeTruthy();
  });
});

describe("a slot that still stores the vocabulary this replaced", () => {
  const firstSlot = (list: OverlaySlot[] | null): TextSlot | undefined => {
    const first = list?.[0];
    return first !== undefined && !("kind" in first && first.kind === "image") ? (first as TextSlot) : undefined;
  };
  const legacy = (backing: string) => ({ ...text(), backing }) as unknown as OverlaySlot;

  it("keeps the band when the outline is ticked on a slot storing a backing", () => {
    // The translated band lives only in the cleaned slot, and the write deletes
    // the key that produced it. Carrying the untouched half across is what
    // stops ticking one treatment from silently switching the other off.
    const one = editor([legacy("band")]);
    fireEvent.click(screen.getByTestId("overlay-treatment-0"));
    fireEvent.click(screen.getByLabelText("outline for slot 1"));

    const sent = firstSlot(one.lastList());
    expect(sent?.outline).toEqual(DEFAULT_OUTLINE);
    expect(sent?.band).toBe(true);
    expect(sent).not.toHaveProperty("backing");
  });

  it("keeps the translated outline when the band is ticked on a slot storing a backing", () => {
    const one = editor([legacy("shadow")]);
    fireEvent.click(screen.getByTestId("overlay-treatment-0"));
    fireEvent.click(screen.getByLabelText("band for slot 1"));

    const sent = firstSlot(one.lastList());
    expect(sent?.band).toBe(true);
    expect(sent?.outline).toEqual({ color: "#000000", width: 3 });
    expect(sent).not.toHaveProperty("backing");
  });

  it("actually clears the band, rather than writing back a key the guard restores", () => {
    // Without the delete, the wire carries `backing: "band"` again and the
    // guard puts the band straight back: the checkbox does nothing at all.
    const one = editor([legacy("band")]);
    fireEvent.click(screen.getByTestId("overlay-treatment-0"));
    fireEvent.click(screen.getByLabelText("band for slot 1"));

    const sent = firstSlot(one.lastList());
    expect(sent).not.toHaveProperty("band");
    expect(sent).not.toHaveProperty("backing");
  });
});

describe("a treatment stored in a shape the guard refuses", () => {
  it("draws the panel without throwing, and offers the treatment as off", () => {
    // The row is handed the *stored* slot when the guard refuses it, so this
    // panel sees whatever a hand edit put there. `shadow: null` read as
    // "present" and threw on `shadow.angle`, taking the editor down with it.
    for (const broken of [{ shadow: null }, { outline: null }, { shadow: "heavy" }, { outline: [] }]) {
      editor([{ ...text(), ...broken } as unknown as OverlaySlot]);
      fireEvent.click(screen.getByTestId("overlay-treatment-0"));
      expect((screen.getByLabelText("outline for slot 1") as HTMLInputElement).checked).toBe(false);
      expect((screen.getByLabelText("shadow for slot 1") as HTMLInputElement).checked).toBe(false);
      cleanup();
    }
  });

  it("replaces the refused value when the treatment is ticked on", () => {
    const one = editor([{ ...text(), shadow: null } as unknown as OverlaySlot]);
    fireEvent.click(screen.getByTestId("overlay-treatment-0"));
    fireEvent.click(screen.getByLabelText("shadow for slot 1"));

    const first = one.lastList()?.[0] as TextSlot | undefined;
    expect(first?.shadow).toEqual(DEFAULT_SHADOW);
  });
});
