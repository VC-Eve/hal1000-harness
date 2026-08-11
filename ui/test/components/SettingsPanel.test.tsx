import { describe, it, expect } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { SettingsPanel } from "../../src/components/SettingsPanel";
import { MAX_PROFILE_CHARS } from "../../../shared/src/types";
import { harness, mount, testState } from "./harness";

function open(over: Parameters<typeof testState>[0] = {}) {
  const h = harness();
  const utils = mount(<SettingsPanel state={testState(over)} send={h.send} onClose={() => {}} />);
  return { h, ...utils };
}

// Scoped to the rail, for the same reason `scripts/screenshot.mjs` scopes its
// own: every category is mounted at once, and the sections now carry blocks and
// buttons of their own. An unscoped role query goes ambiguous the first time a
// control anywhere in the panel shares a word with a category.
const category = (name: string) => within(screen.getByTestId("settings-nav")).getByRole("button", { name });

// Sections other than the active one are `hidden`, so role queries skip them.
// Reaching into one by testid is how a test asserts against a category it has
// not navigated to.
const group = (id: string) => within(screen.getByTestId(`group-${id}`));

describe("SettingsPanel — one category at a time", () => {
  it("lists every category in the rail", () => {
    open();
    for (const name of ["connections", "sessions", "log monitors", "vision", "chat", "interface", "readiness"]) {
      expect(category(name)).toBeInTheDocument();
    }
  });

  // A new install cannot do anything until a backend is reachable, so that is
  // where the panel opens rather than on whatever happens to be first.
  it("opens on the connections category", () => {
    open();
    expect(category("connections")).toHaveAttribute("aria-current", "page");
    expect(screen.getByTestId("group-vision")).not.toBeVisible();
  });

  it("shows only the category you pick", () => {
    open();
    fireEvent.click(category("vision"));

    expect(screen.getByTestId("group-vision")).toBeVisible();
    expect(screen.getByTestId("group-sessions")).not.toBeVisible();
    expect(screen.getByTestId("group-monitors")).not.toBeVisible();
    expect(screen.getByTestId("group-readiness")).not.toBeVisible();
  });

  it("marks the selected category in the rail", () => {
    open();
    fireEvent.click(category("chat"));

    expect(category("chat")).toHaveAttribute("aria-current", "page");
    expect(category("connections")).not.toHaveAttribute("aria-current");
  });

  /**
   * The reason the sections are hidden rather than conditionally rendered.
   *
   * `MonitorsPanel` asks the server for monitors and suggestions from a mount
   * effect. Rendering only the active category would unmount it on every switch
   * away and re-run that effect on every switch back, turning navigation into a
   * request generator — the shape `MonitorsPanel.test.tsx` exists to prevent.
   * Hiding keeps it mounted, so the count stays at one however much the user
   * moves around.
   */
  it("does not re-request monitors when moving between categories", () => {
    const { h } = open();
    expect(h.countOf("list-monitors")).toBe(1);
    expect(h.countOf("list-monitor-suggestions")).toBe(1);

    for (const name of ["log monitors", "vision", "chat", "log monitors", "connections", "log monitors"]) {
      fireEvent.click(category(name));
    }

    expect(h.countOf("list-monitors")).toBe(1);
    expect(h.countOf("list-monitor-suggestions")).toBe(1);
  });

  // Readiness reports what HAL can reach; it changes nothing. It was under
  // `interface` only because that was the last section in the old column.
  it("gives readiness its own category rather than burying it in interface", () => {
    open();
    fireEvent.click(category("interface"));
    expect(screen.getByTestId("group-readiness")).not.toBeVisible();

    fireEvent.click(category("readiness"));
    expect(screen.getByTestId("group-readiness")).toBeVisible();
    expect(screen.getByText("no probe yet")).toBeInTheDocument();
  });

  // Drafts are component state, so navigating away and back must not silently
  // discard something the user typed but has not applied yet.
  it("keeps an unapplied prompt draft across a category switch", () => {
    open();
    fireEvent.click(category("chat"));
    // Scoped to the chat group: several prompt fields are legitimately empty,
    // so a document-wide value query is ambiguous.
    const draft = document.querySelector('[data-testid="group-chat"] textarea')!;
    fireEvent.change(draft, { target: { value: "a prompt I have not applied yet" } });

    fireEvent.click(category("vision"));
    fireEvent.click(category("chat"));

    expect(draft).toHaveValue("a prompt I have not applied yet");
  });
});

// ---------------------------------------------------------------------------
// Wording, grouped with the thing it configures
// ---------------------------------------------------------------------------
//
// Every template and phrase used to live in one catch-all category. They now
// sit in the section that owns them, with the templates a prompt is rendered
// into collapsed beneath that prompt. These cases pin the parts a reader cannot
// check by eye: that a moved editor still writes the setting it always wrote,
// that the block stays shut until asked, and that nothing was left pointing at
// the category being retired.

describe("chat — the envelope around the preamble", () => {
  it("keeps the default conversation prompt first, above the envelope", () => {
    open();
    fireEvent.click(category("chat"));
    // The draft-preservation case above reaches for the chat section's first
    // textarea. Inserting an editor above this one would silently retarget it.
    const first = document.querySelector('[data-testid="group-chat"] textarea')!;
    expect(group("chat").getByTestId("template-chatDefaultPrompt")).toContainElement(first as HTMLElement);
  });

  it("says why the default conversation prompt has no envelope", () => {
    open();
    fireEvent.click(category("chat"));
    // R2 teaches containment by position, so the one prompt that has none needs
    // to say so — otherwise the gap reads as a control that failed to render.
    expect(group("chat").getByTestId("chat-default-aside")).toBeVisible();
    expect(group("chat").getAllByTestId(/^disclosure-/)).toHaveLength(1);
  });

  it("holds chat-context shut until it is asked for", () => {
    open();
    fireEvent.click(category("chat"));
    expect(screen.queryByTestId("template-chat-context")).toBeNull();

    fireEvent.click(screen.getByTestId("disclosure-chat-context"));

    expect(screen.getByTestId("template-chat-context")).toBeVisible();
  });

  it("still writes the template setting from its new home", () => {
    const { h } = open();
    fireEvent.click(category("chat"));
    fireEvent.click(screen.getByTestId("disclosure-chat-context"));

    const editor = within(screen.getByTestId("template-chat-context"));
    // Slotless on purpose: this case is about where the editor now lives, not
    // about the vocabulary. A rejected slot name disables apply and the failure
    // reads as a broken move.
    fireEvent.change(editor.getByRole("textbox"), { target: { value: "here is what I have seen." } });
    fireEvent.click(editor.getByRole("button", { name: "apply" }));

    expect(h.sent).toContainEqual({
      type: "update-settings",
      patch: { templates: { "chat-context": "here is what I have seen." } },
    });
  });

  // The baseline buttons are passed only by the old category. Redistributing
  // without them would drop the machinery silently — the editor looks the same.
  it("carries the saved-baseline machinery with the editor", () => {
    const { h } = open();
    fireEvent.click(category("chat"));
    fireEvent.click(screen.getByTestId("disclosure-chat-context"));

    const editor = within(screen.getByTestId("template-chat-context"));
    fireEvent.change(editor.getByRole("textbox"), { target: { value: "mine, and I intend to keep it." } });
    fireEvent.click(editor.getByRole("button", { name: "save as baseline" }));

    const saved = h.sent.find((m) => "patch" in m && m.patch && "templateBaselines" in m.patch);
    expect(saved, "the save-baseline button sent no templateBaselines patch").toBeDefined();
  });

  it("offers the cheat sheet from the section that has an envelope", () => {
    open();
    fireEvent.click(category("chat"));
    fireEvent.click(screen.getByTestId("open-template-help-chat"));

    expect(screen.getByTestId("template-help")).toBeVisible();
  });

  it("no longer sends the reader to a category that is going away", () => {
    open();
    expect(group("chat").queryByText(/what I send/)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Recognition settings and the roster
// ---------------------------------------------------------------------------

const person = (over: Partial<{ id: string; name: string; createdAt: string; faceCount: number; thumbnail: string }> = {}) => ({
  id: "p1",
  name: "Dave",
  createdAt: "2026-08-07T12:00:00.000Z",
  faceCount: 1,
  thumbnail: "data:image/jpeg;base64,AAAA",
  ...over,
});

describe("SettingsPanel — recognition", () => {
  it("toggles recognition independently of Vision", () => {
    // The preference is stored on its own, so switching Vision off and on again
    // does not silently lose it.
    const { h } = open();
    fireEvent.click(category("vision"));
    fireEvent.click(screen.getAllByRole("button", { name: "on" })[1]!);

    expect(h.sent).toContainEqual({
      type: "update-settings",
      patch: { vision: { recognitionEnabled: true } },
    });
  });

  it("applies the recogniser endpoint and rechecks readiness", () => {
    const { h } = open();
    fireEvent.click(category("vision"));

    const inputs = screen.getAllByRole("textbox");
    const endpoint = inputs.find((i) => (i as HTMLInputElement).value === "http://127.0.0.1:8100")!;
    fireEvent.change(endpoint, { target: { value: "http://gpu-box:8100" } });
    fireEvent.click(screen.getAllByRole("button", { name: "apply" })[1]!);

    expect(h.sent).toContainEqual({
      type: "update-settings",
      patch: { vision: { recogniserEndpoint: "http://gpu-box:8100" } },
    });
    expect(h.sent).toContainEqual({ type: "check-readiness" });
  });

  it("does not send the endpoint on every keystroke", () => {
    // The unstable-send loop AGENTS.md warns about, in its slower form: one
    // settings write per character typed.
    const { h } = open();
    fireEvent.click(category("vision"));

    const inputs = screen.getAllByRole("textbox");
    const endpoint = inputs.find((i) => (i as HTMLInputElement).value === "http://127.0.0.1:8100")!;
    fireEvent.change(endpoint, { target: { value: "http://a" } });
    fireEvent.change(endpoint, { target: { value: "http://ab" } });

    // The panel already sends on mount, so the assertion is on writes.
    expect(h.sent.filter((m) => m.type === "update-settings")).toEqual([]);
  });

  it("commits the detection interval on blur rather than per keystroke", () => {
    const { h } = open();
    fireEvent.click(category("vision"));

    const spin = screen.getAllByRole("spinbutton");
    const detection = spin.find((i) => (i as HTMLInputElement).value === "3")!;
    fireEvent.change(detection, { target: { value: "10" } });
    expect(h.sent.filter((m) => m.type === "update-settings")).toEqual([]);

    fireEvent.blur(detection);
    expect(h.sent).toContainEqual({
      type: "update-settings",
      patch: { vision: { detectionIntervalSeconds: 10 } },
    });
  });

  it("says nobody is enrolled when the roster is empty", () => {
    open();
    fireEvent.click(category("vision"));
    expect(screen.getByTestId("people-roster").textContent).toContain("Nobody enrolled");
  });

  it("lists an enrolled person with their face count", () => {
    open({ visionPeople: [person({ faceCount: 2 })] });
    fireEvent.click(category("vision"));

    const row = screen.getByTestId("person-row");
    expect(row.textContent).toContain("Dave");
    expect(row.textContent).toContain("2 faces");
  });

  it("requires a confirmation before deleting a person", () => {
    // R27 destroys biometric data, so it is never one click.
    const { h } = open({ visionPeople: [person()] });
    fireEvent.click(category("vision"));

    fireEvent.click(screen.getByTestId("delete-person"));
    expect(h.sent.filter((m) => m.type === "delete-person")).toEqual([]);

    fireEvent.click(screen.getByTestId("confirm-delete-person"));
    expect(h.sent).toContainEqual({ type: "delete-person", id: "p1" });
  });

  it("names who is being forgotten in the confirmation", () => {
    // "Are you sure" tells the user nothing. Whose data, and how much, does.
    open({ visionPeople: [person()] });
    fireEvent.click(category("vision"));
    fireEvent.click(screen.getByTestId("delete-person"));

    expect(screen.getByTestId("confirm-delete-person").textContent).toContain("Dave");
  });

  it("lets a confirmation be cancelled without deleting", () => {
    const { h } = open({ visionPeople: [person()] });
    fireEvent.click(category("vision"));

    fireEvent.click(screen.getByTestId("delete-person"));
    fireEvent.click(screen.getByRole("button", { name: "cancel" }));

    expect(h.sent.filter((m) => m.type === "delete-person")).toEqual([]);
    expect(screen.getByTestId("delete-person")).toBeInTheDocument();
  });

  it("shows the recogniser as its own readiness leg", () => {
    open({
      readiness: {
        ollama: "ok",
        models: "ok",
        claudeLogs: "ok",
        captioner: "ok",
        recogniser: "degraded",
      },
    });
    fireEvent.click(category("readiness"));

    const list = screen.getByRole("list");
    expect(list.textContent).toContain("vision recogniser");
    // Degraded, not failed: it can detect but not match, and that is a
    // different thing to tell the user.
    expect(list.textContent).toContain("degraded");
  });

  describe("the biometric purge", () => {
    // Producer-side tests would pass while the user saw nothing, so every
    // assertion here is on what the panel renders and what it sends.
    const openVision = (over: Parameters<typeof testState>[0] = {}) => {
      const r = open(over);
      fireEvent.click(category("vision"));
      return r;
    };

    it("asks the server for a count before showing the confirmation", () => {
      const { h } = openVision();
      fireEvent.click(screen.getByTestId("purge-biometrics"));
      expect(h.sent.filter((m) => m.type === "count-biometrics")).toHaveLength(1);
      // Nothing destructive has been sent yet.
      expect(h.sent.filter((m) => m.type === "purge-biometrics")).toEqual([]);
    });

    it("will not let the purge fire before the count arrives", () => {
      // A destructive confirmation the user cannot read is not a confirmation.
      const { h } = openVision();
      fireEvent.click(screen.getByTestId("purge-biometrics"));
      const confirm = screen.getByTestId("confirm-purge-biometrics");
      expect(confirm).toBeDisabled();
      fireEvent.click(confirm);
      expect(h.sent.filter((m) => m.type === "purge-biometrics")).toEqual([]);
    });

    it("states the counts the server gave, not the roster it is holding", () => {
      // The client's roster says nothing about the queue, and can be stale.
      openVision({
        visionPeople: [{ id: "p1", name: "Dave", createdAt: "2026-08-08T00:00:00.000Z", faceCount: 1 }],
        biometricTally: { people: 3, faces: 9, candidates: 2 },
      });
      fireEvent.click(screen.getByTestId("purge-biometrics"));
      const warning = screen.getByTestId("purge-warning").textContent ?? "";
      expect(warning).toContain("3 people");
      expect(warning).toContain("9 faces");
      expect(warning).toContain("2 waiting faces");
      expect(warning).toContain("cannot be undone");
    });

    it("says 'person' and 'face' when there is one of each", () => {
      openVision({ biometricTally: { people: 1, faces: 1, candidates: 1 } });
      fireEvent.click(screen.getByTestId("purge-biometrics"));
      const warning = screen.getByTestId("purge-warning").textContent ?? "";
      expect(warning).toContain("1 person");
      expect(warning).toContain("1 face");
      expect(warning).not.toContain("1 people");
    });

    it("purges once confirmed", () => {
      const { h } = openVision({ biometricTally: { people: 2, faces: 4, candidates: 0 } });
      fireEvent.click(screen.getByTestId("purge-biometrics"));
      fireEvent.click(screen.getByTestId("confirm-purge-biometrics"));
      expect(h.sent.filter((m) => m.type === "purge-biometrics")).toHaveLength(1);
    });

    it("sends nothing when cancelled", () => {
      const { h } = openVision({ biometricTally: { people: 2, faces: 4, candidates: 0 } });
      fireEvent.click(screen.getByTestId("purge-biometrics"));
      fireEvent.click(screen.getAllByRole("button", { name: "cancel" })[0]!);
      expect(h.sent.filter((m) => m.type === "purge-biometrics")).toEqual([]);
      expect(screen.getByTestId("purge-biometrics")).toBeInTheDocument();
    });
  });

  describe("editing the roster", () => {
    const openVision = (over: Parameters<typeof testState>[0] = {}) => {
      const r = open(over);
      fireEvent.click(category("vision"));
      return r;
    };

    const person = (id: string, name: string, faceIds: string[]) => ({
      id,
      name,
      createdAt: "2026-08-08T00:00:00.000Z",
      faceCount: faceIds.length,
      faces: faceIds.map((fid) => ({ id: fid, addedAt: "2026-08-08T00:00:00.000Z" })),
    });

    it("edits the roster with Vision switched off", () => {
      // R16. Every control in the vision PANE is gated on Vision being on; the
      // roster deliberately is not, because a name typed wrong should not need
      // a camera to fix. Asserted rather than assumed — a property nothing
      // reads looks shipped from every angle except the user's.
      openVision({ visionPeople: [person("p1", "Dave", ["f1", "f2"])] });
      expect(screen.getByTestId("rename-person")).toBeInTheDocument();
      expect(screen.getByTestId("show-faces")).toBeInTheDocument();
    });

    it("sends a rename", () => {
      const { h } = openVision({ visionPeople: [person("p1", "Dave", ["f1"])] });
      fireEvent.click(screen.getByTestId("rename-person"));
      fireEvent.change(screen.getByTestId("rename-input"), { target: { value: "David" } });
      fireEvent.click(screen.getByTestId("rename-submit"));
      expect(h.sent).toContainEqual({ type: "rename-person", id: "p1", name: "David" });
    });

    it("states the merge before it happens, and calls the button merge", () => {
      // Retyping a name and hoping is how one person became five records last
      // time. The hint mirrors the server's own case-insensitive trimmed match.
      openVision({
        visionPeople: [person("p1", "Steven", ["f1"]), person("p2", "Steve", ["f2", "f3", "f4"])],
      });
      fireEvent.click(screen.getAllByTestId("rename-person")[0]!);
      fireEvent.change(screen.getByTestId("rename-input"), { target: { value: "steve" } });

      const hint = screen.getByTestId("merge-hint").textContent ?? "";
      expect(hint).toContain("merges into Steve");
      expect(hint).toContain("3 faces");
      expect(hint).toContain("cannot be undone");
      expect(screen.getByTestId("rename-submit").textContent).toBe("merge");
    });

    it("says rename, not merge, when the name is free", () => {
      openVision({ visionPeople: [person("p1", "Steven", ["f1"]), person("p2", "Steve", ["f2"])] });
      fireEvent.click(screen.getAllByTestId("rename-person")[0]!);
      fireEvent.change(screen.getByTestId("rename-input"), { target: { value: "Stephen" } });
      expect(screen.queryByTestId("merge-hint")).toBeNull();
      expect(screen.getByTestId("rename-submit").textContent).toBe("rename");
    });

    it("does not offer a merge for a change of capitalisation of the same name", () => {
      // Fixing your own typo is not a merge, and calling it one would be a hint
      // that disagrees with what the server actually does.
      openVision({ visionPeople: [person("p1", "steve", ["f1"])] });
      fireEvent.click(screen.getByTestId("rename-person"));
      fireEvent.change(screen.getByTestId("rename-input"), { target: { value: "Steve" } });
      expect(screen.queryByTestId("merge-hint")).toBeNull();
    });

    it("refuses to submit a blank name", () => {
      const { h } = openVision({ visionPeople: [person("p1", "Dave", ["f1"])] });
      fireEvent.click(screen.getByTestId("rename-person"));
      fireEvent.change(screen.getByTestId("rename-input"), { target: { value: "   " } });
      expect(screen.getByTestId("rename-submit")).toBeDisabled();
      fireEvent.click(screen.getByTestId("rename-submit"));
      expect(h.sent.filter((m) => m.type === "rename-person")).toEqual([]);
    });

    it("shows the faces and sends a removal", () => {
      const { h } = openVision({ visionPeople: [person("p1", "Dave", ["f1", "f2"])] });
      fireEvent.click(screen.getByTestId("show-faces"));
      expect(screen.getAllByTestId("remove-face")).toHaveLength(2);
      fireEvent.click(screen.getAllByTestId("remove-face")[0]!);
      expect(h.sent).toContainEqual({ type: "remove-face", personId: "p1", faceId: "f1" });
    });

    it("will not remove the only face, and says why", () => {
      // The refusal has to be visible before the click, not only after the
      // server answers — otherwise the user learns it by being told no.
      const { h } = openVision({ visionPeople: [person("p1", "Dave", ["f1"])] });
      fireEvent.click(screen.getByTestId("show-faces"));
      const button = screen.getByTestId("remove-face");
      expect(button).toBeDisabled();
      expect(button.getAttribute("title")).toContain("Forget them instead");
      fireEvent.click(button);
      expect(h.sent.filter((m) => m.type === "remove-face")).toEqual([]);
    });


    it("offers a photo picker per person", () => {
      openVision({ visionPeople: [person("p1", "Dave", ["f1"])] });
      expect(screen.getByTestId("add-face")).toBeInTheDocument();
      expect(screen.getByTestId("add-face-input")).toHaveAttribute("accept", "image/*");
    });

    it("sends nothing when the picker is dismissed without a file", () => {
      const { h } = openVision({ visionPeople: [person("p1", "Dave", ["f1"])] });
      fireEvent.change(screen.getByTestId("add-face-input"), { target: { files: [] } });
      expect(h.sent.filter((m) => m.type === "add-face-from-image")).toEqual([]);
    });

    it("surfaces a refusal about the picture the server could not use", () => {
      openVision({
        visionPeople: [person("p1", "Dave", ["f1"])],
        visionRosterResult: { "add-face": { ok: false, error: "I could not find a face in that picture." } },
      });
      expect(screen.getByTestId("roster-error").textContent).toContain("could not find a face");
    });


    it("describes a person and saves it", () => {
      const { h } = openVision({ visionPeople: [person("p1", "Dave", ["f1"])] });
      fireEvent.click(screen.getByTestId("edit-profile"));
      fireEvent.change(screen.getByTestId("profile-input"), { target: { value: "my brother, works nights" } });
      fireEvent.click(screen.getByTestId("save-profile"));
      expect(h.sent).toContainEqual({ type: "set-profile", id: "p1", profile: "my brother, works nights" });
    });

    it("will not save a profile over the bound, and shows the count", () => {
      // Refused here rather than only after the server answers, and the count
      // appears as the limit approaches rather than sitting on an empty field.
      const { h } = openVision({ visionPeople: [person("p1", "Dave", ["f1"])] });
      fireEvent.click(screen.getByTestId("edit-profile"));
      fireEvent.change(screen.getByTestId("profile-input"), { target: { value: "x".repeat(MAX_PROFILE_CHARS + 1) } });
      expect(screen.getByTestId("profile-count").textContent).toContain(String(MAX_PROFILE_CHARS));
      expect(screen.getByTestId("save-profile")).toBeDisabled();
      fireEvent.click(screen.getByTestId("save-profile"));
      expect(h.sent.filter((m) => m.type === "set-profile")).toEqual([]);
    });

    it("shows no counter while the profile is short", () => {
      openVision({ visionPeople: [person("p1", "Dave", ["f1"])] });
      fireEvent.click(screen.getByTestId("edit-profile"));
      fireEvent.change(screen.getByTestId("profile-input"), { target: { value: "brief" } });
      expect(screen.queryByTestId("profile-count")).toBeNull();
    });

    it("says whether a person is already described", () => {
      openVision({
        visionPeople: [
          { ...person("p1", "Dave", ["f1"]), profile: "my brother" },
          person("p2", "Liam", ["f2"]),
        ],
      });
      const labels = screen.getAllByTestId("edit-profile").map((b) => b.textContent);
      expect(labels).toEqual(["described", "describe"]);
    });

    it("marks and clears the operator", () => {
      const { h } = openVision({ visionPeople: [person("p1", "Dave", ["f1"])] });
      fireEvent.click(screen.getByTestId("set-operator"));
      expect(h.sent).toContainEqual({ type: "set-operator", id: "p1" });
    });

    it("clears the mark by clicking the person who already has it", () => {
      const { h } = openVision({ visionPeople: [{ ...person("p1", "Dave", ["f1"]), isOperator: true }] });
      expect(screen.getByTestId("set-operator").textContent).toBe("you");
      fireEvent.click(screen.getByTestId("set-operator"));
      expect(h.sent).toContainEqual({ type: "set-operator", id: null });
    });

    it("surfaces a refusal about a profile", () => {
      openVision({
        visionPeople: [person("p1", "Dave", ["f1"])],
        visionRosterResult: { profile: { ok: false, error: "That is 700 characters and I can hold 600." } },
      });
      expect(screen.getByTestId("roster-error").textContent).toContain("I can hold 600");
    });

    it("surfaces a refusal the server sent", () => {
      openVision({
        visionPeople: [person("p1", "Dave", ["f1"])],
        visionRosterResult: { rename: { ok: false, error: "A name cannot be blank." } },
      });
      expect(screen.getByTestId("roster-error").textContent).toContain("cannot be blank");
    });

    it("says so when a rename turned into a merge", () => {
      openVision({
        visionPeople: [person("p1", "Steve", ["f1"])],
        visionRosterResult: { rename: { ok: true, note: "Merged Steven into Steve — 5 faces now." } },
      });
      expect(screen.getByTestId("roster-note").textContent).toContain("Merged Steven into Steve");
    });
  });
});
