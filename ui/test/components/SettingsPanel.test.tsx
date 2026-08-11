import { describe, it, expect } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { NOT_A_SETTING, SettingsPanel, TEMPLATE_FIELDS } from "../../src/components/SettingsPanel";
import { MAX_PROFILE_CHARS } from "../../../shared/src/types";
import { DEFAULT_TEMPLATES, NARRATION_PRESETS } from "../../../shared/src/prompts";
import { TEMPLATE_ROLES } from "../../../shared/src/templates";
import { PHRASES, type PhraseGroup } from "../../../shared/src/phrases";
import { harness, mount, testSettings, testState } from "./harness";

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
  it("lists every category in the rail, and nothing else", () => {
    open();
    const names = ["connections", "sessions", "log monitors", "vision", "chat", "interface", "readiness"];
    for (const name of names) {
      expect(category(name)).toBeInTheDocument();
    }
    // Counted, not just checked one by one: `what I send` used to sit in this
    // rail and its editors are now spread across four of the seven above.
    expect(within(screen.getByTestId("settings-nav")).getAllByRole("button")).toHaveLength(names.length);
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

    // The whole payload, not merely that one was sent: the baseline records the
    // shipped default it was taken against, and a patch that stored the text
    // without it would look identical to a caller checking only for the key.
    expect(h.sent).toContainEqual({
      type: "update-settings",
      patch: {
        templates: { "chat-context": "mine, and I intend to keep it." },
        templateBaselines: {
          "chat-context": {
            text: "mine, and I intend to keep it.",
            shippedDefault: DEFAULT_TEMPLATES["chat-context"],
          },
        },
      },
    });
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

describe("sessions — narration wording lands with narration", () => {
  it("leaves the preset strip with the prompt, above the envelope", () => {
    open();
    fireEvent.click(category("sessions"));
    // The presets seed `narrationPrompt`, not the templates around it. If they
    // ended up inside the envelope they would be seeding the wrong editor.
    const prompt = within(screen.getByTestId("template-narrationPrompt"));
    expect(prompt.getByRole("button", { name: NARRATION_PRESETS[0]!.label })).toBeVisible();
  });

  it("holds both halves of the narration envelope shut until asked", () => {
    open();
    fireEvent.click(category("sessions"));
    expect(screen.queryByTestId("template-narration-system")).toBeNull();
    expect(screen.queryByTestId("template-narration-user")).toBeNull();

    fireEvent.click(screen.getByTestId("disclosure-narration"));

    expect(screen.getByTestId("template-narration-system")).toBeVisible();
    expect(screen.getByTestId("template-narration-user")).toBeVisible();
  });

  it("gathers the narration and session lines, and no others", () => {
    open();
    fireEvent.click(category("sessions"));
    fireEvent.click(screen.getByTestId("disclosure-session-lines"));

    expect(screen.getByTestId("phrase-group-narration")).toBeVisible();
    expect(screen.getByTestId("phrase-group-session")).toBeVisible();
    // sight, people and monitor belong to other sections. A group appearing in
    // two places is two editors writing one setting.
    expect(group("sessions").queryByTestId("phrase-group-monitor")).toBeNull();
    expect(group("sessions").queryByTestId("phrase-group-sight")).toBeNull();
  });

  it("still writes a phrase from its new home", () => {
    const { h } = open();
    fireEvent.click(category("sessions"));
    fireEvent.click(screen.getByTestId("disclosure-session-lines"));

    // Named rather than taken by index, so the assertion below can state the
    // exact id it expects to be written.
    const spec = PHRASES.find((p) => p.group === "session")!;
    const editor = within(screen.getByTestId(`phrase-${spec.id}`));
    fireEvent.change(editor.getByRole("textbox"), { target: { value: "reworded by hand" } });
    fireEvent.click(editor.getByRole("button", { name: "apply" }));

    expect(h.sent).toContainEqual({
      type: "update-settings",
      patch: { phrases: { [spec.id]: "reworded by hand" } },
    });
  });
});

describe("log monitors — monitor wording lands with monitors", () => {
  // The all-mounted architecture exists for MonitorsPanel's mount effect. This
  // is the case that catches a section reshuffle turning navigation back into a
  // request generator.
  it("does not re-request monitors now that the section carries more", () => {
    const { h } = open();
    for (const name of ["sessions", "log monitors", "vision", "chat", "log monitors", "readiness"]) {
      fireEvent.click(category(name));
    }
    expect(h.countOf("list-monitors")).toBe(1);
    expect(h.countOf("list-monitor-suggestions")).toBe(1);
  });

  it("holds the monitor envelope and its fifteen lines shut until asked", () => {
    open();
    fireEvent.click(category("log monitors"));
    expect(screen.queryByTestId("template-monitor-user")).toBeNull();

    fireEvent.click(screen.getByTestId("disclosure-monitor"));
    expect(screen.getByTestId("template-monitor-system")).toBeVisible();
    expect(screen.getByTestId("template-monitor-user")).toBeVisible();

    fireEvent.click(screen.getByTestId("disclosure-monitor-lines"));
    expect(within(screen.getByTestId("phrase-group-monitor")).getAllByTestId(/^phrase-monitor\./)).toHaveLength(15);
  });

  it("still writes the monitor template from its new home", () => {
    const { h } = open();
    fireEvent.click(category("log monitors"));
    fireEvent.click(screen.getByTestId("disclosure-monitor"));

    const editor = within(screen.getByTestId("template-monitor-user"));
    fireEvent.change(editor.getByRole("textbox"), { target: { value: "say what changed." } });
    fireEvent.click(editor.getByRole("button", { name: "apply" }));

    expect(h.sent).toContainEqual({
      type: "update-settings",
      patch: { templates: { "monitor-user": "say what changed." } },
    });
  });
});

describe("vision — the heaviest section keeps its shape", () => {
  // Two assertions elsewhere in this file pick buttons out of the vision
  // section by index. Role queries skip the seven hidden sections but see this
  // one in full, so twenty-three collapsed editors must contribute nothing.
  // Defaulting any block to open breaks tests that have no visible connection
  // to the wording being edited.
  it("adds nothing to the accessible tree while its blocks are shut", () => {
    open();
    fireEvent.click(category("vision"));

    // On arrival, before any click. Counting after would pass just as happily
    // with a block defaulting to open, which is the thing being forbidden.
    for (const role of ["vision-system", "vision-user", "captioner-user"]) {
      expect(screen.queryByTestId(`template-${role}`), `${role} renders before it is asked for`).toBeNull();
    }
    expect(screen.queryByTestId(/^phrase-sight\./)).toBeNull();
    const shut = screen.getAllByRole("button").length;

    // And still nothing once a block has been opened and closed again: the
    // body stays mounted to hold its drafts, so it must stay `hidden`.
    fireEvent.click(screen.getByTestId("disclosure-vision"));
    fireEvent.click(screen.getByTestId("disclosure-vision"));

    expect(screen.getAllByRole("button")).toHaveLength(shut);
  });

  it("hangs each envelope under the prompt it wraps", () => {
    open();
    fireEvent.click(category("vision"));

    fireEvent.click(screen.getByTestId("disclosure-vision"));
    expect(screen.getByTestId("template-vision-system")).toBeVisible();
    expect(screen.getByTestId("template-vision-user")).toBeVisible();
    // The captioner's block holds its one template and not vision's two.
    expect(screen.queryByTestId("template-captioner-user")).toBeNull();

    fireEvent.click(screen.getByTestId("disclosure-captioner"));
    expect(screen.getByTestId("template-captioner-user")).toBeVisible();
  });

  it("gathers the sight and people lines", () => {
    open();
    fireEvent.click(category("vision"));
    fireEvent.click(screen.getByTestId("disclosure-vision-lines"));

    expect(within(screen.getByTestId("phrase-group-sight")).getAllByTestId(/^phrase-sight\./)).toHaveLength(16);
    expect(within(screen.getByTestId("phrase-group-people")).getAllByTestId(/^phrase-people\./)).toHaveLength(4);
  });

  // The captioner prompt is vision-scoped storage merged by mergeVision; the
  // captioner template is not. They now sit adjacent, which is exactly where
  // one patch shape could be written for the other.
  it("writes the captioner template to templates, not to vision", () => {
    const { h } = open();
    fireEvent.click(category("vision"));
    fireEvent.click(screen.getByTestId("disclosure-captioner"));

    const editor = within(screen.getByTestId("template-captioner-user"));
    fireEvent.change(editor.getByRole("textbox"), { target: { value: "describe this frame plainly." } });
    fireEvent.click(editor.getByRole("button", { name: "apply" }));

    expect(h.sent).toContainEqual({
      type: "update-settings",
      patch: { templates: { "captioner-user": "describe this frame plainly." } },
    });
  });

  it("saves a vision baseline as one patch carrying both keys", () => {
    const { h } = open();
    fireEvent.click(category("vision"));
    fireEvent.click(screen.getByTestId("disclosure-vision"));

    const editor = within(screen.getByTestId("template-vision-system"));
    fireEvent.change(editor.getByRole("textbox"), { target: { value: "my own voice over a cycle." } });
    fireEvent.click(editor.getByRole("button", { name: "save as baseline" }));

    expect(h.sent).toContainEqual({
      type: "update-settings",
      patch: {
        templates: { "vision-system": "my own voice over a cycle." },
        templateBaselines: {
          "vision-system": {
            text: "my own voice over a cycle.",
            shippedDefault: DEFAULT_TEMPLATES["vision-system"],
          },
        },
      },
    });
  });

  it("reaches the cheat sheet from every section that has an envelope", () => {
    open();
    for (const [name, section] of [
      ["sessions", "sessions"],
      ["log monitors", "monitors"],
      ["vision", "vision"],
    ]) {
      fireEvent.click(category(name!));
      fireEvent.click(screen.getByTestId(`open-template-help-${section}`));
      const sheet = screen.getByTestId("template-help");
      expect(sheet, `${section} did not open the cheat sheet`).toBeVisible();
      // Scoped to the sheet: the settings panel has a close control too.
      fireEvent.click(within(sheet).getByRole("button", { name: "close" }));
    }
  });
});

describe("vision groups hold what they say they hold", () => {
  // Both groupings were made by moving a closing tag by hand. A control that
  // slips back outside its fieldset is not a type error and not a visual one
  // either at a glance — it is a heading that has stopped describing what is
  // under it, which is the whole defect the grouping exists to fix.
  const legendNamed = (name: string): HTMLElement => {
    const legend = group("vision").getByText(name, { selector: "legend" });
    return legend.closest("fieldset")!;
  };

  it("keeps the camera and the captioner inside watching", () => {
    open();
    fireEvent.click(category("vision"));
    const watching = legendNamed("watching");

    expect(watching).toContainElement(group("vision").getByRole("combobox"));
    expect(watching).toContainElement(
      group("vision").getAllByRole("textbox").find((i) => (i as HTMLInputElement).value.includes("8099"))!,
    );
    // The recogniser belongs to the group below and must not have come along.
    expect(watching).not.toContainElement(
      group("vision").getAllByRole("textbox").find((i) => (i as HTMLInputElement).value.includes("8100"))!,
    );
  });

  it("keeps pace and retention together", () => {
    open();
    fireEvent.click(category("vision"));
    const pace = legendNamed("pace, and what is kept");

    // Scoped to the group and asserted as a set. Searching the whole section
    // for a value finds `faces kept for naming`, which also defaults to 20 and
    // belongs to recognition — a lookup loose enough to pass on the wrong
    // element is a lookup that would pass on a broken grouping too.
    const spin = within(pace).getAllByRole("spinbutton");
    expect(spin.map((i) => (i as HTMLInputElement).value).sort()).toEqual(["20", "300", "60"]);
    expect(within(pace).getByText("seconds between looks")).toBeInTheDocument();
    expect(within(pace).getByText("seconds per cycle")).toBeInTheDocument();
    expect(within(pace).getByText("frames kept")).toBeInTheDocument();
  });
});

describe("the collapsed header is the only thing a shut block can say", () => {
  // Nothing renders inside a block until it is opened, so the header carries
  // the whole signal. If it reads "shipped" over an editor asking to be looked
  // at, the notice may as well not exist.
  const headerOf = (testId: string): string => screen.getByTestId(`disclosure-${testId}`).textContent ?? "";

  it("counts nothing when every template is shipped", () => {
    open();
    fireEvent.click(category("vision"));
    expect(headerOf("vision")).toContain("2, shipped");
  });

  it("counts the edited ones", () => {
    open({ settings: testSettings({ templates: { "vision-system": "a voice of my own." } }) });
    fireEvent.click(category("vision"));
    expect(headerOf("vision")).toContain("2, 1 edited");
  });

  it("raises a template storing a slot the release withdrew", () => {
    open({ settings: testSettings({ templates: { "vision-user": "{a_slot_that_went_away}" } }) });
    fireEvent.click(category("vision"));
    expect(headerOf("vision")).toContain("needs attention");
  });

  it("raises a baseline whose shipped default has since moved", () => {
    open({
      settings: testSettings({
        templates: { "monitor-system": "mine." },
        templateBaselines: {
          "monitor-system": { text: "mine.", shippedDefault: "what shipped when I saved this" },
        },
      }),
    });
    fireEvent.click(category("log monitors"));
    expect(headerOf("monitor")).toContain("needs attention");
  });

  it("raises a phrase storing a field that no longer exists", () => {
    const spec = PHRASES.find((p) => p.group === "sight")!;
    open({ settings: testSettings({ phrases: { [spec.id]: "{a_field_that_went_away}" } }) });
    fireEvent.click(category("vision"));
    expect(headerOf("vision-lines")).toContain("needs attention");
  });

  it("lets attention beat a plain edit in the same block", () => {
    open({
      settings: testSettings({
        templates: { "vision-system": "edited but fine.", "vision-user": "{a_slot_that_went_away}" },
      }),
    });
    fireEvent.click(category("vision"));
    expect(headerOf("vision")).toContain("1 needs attention");
  });
});

// ---------------------------------------------------------------------------
// The sweep: everything the drawer sends a model reaches exactly one section
// ---------------------------------------------------------------------------
//
// Fifty-two editors moved out of one category into four. That is fifty-two
// chances to land one nowhere, or in two places at once — and neither is
// visible in a diff, or to a test asserting that every phrase has a label.
// A phrase with an editor and no binding shipped in this repo once already.
//
// The expected homes below are written here on purpose rather than imported
// from the panel. A sweep that reads the same table the renderer reads proves
// only that the component agrees with itself.

const TEMPLATE_HOME: Record<string, string> = {
  "chat-context": "chat",
  "narration-system": "sessions",
  "narration-user": "sessions",
  "monitor-system": "monitors",
  "monitor-user": "monitors",
  "vision-system": "vision",
  "vision-user": "vision",
  "captioner-user": "vision",
};

const PHRASE_HOME: Record<PhraseGroup, string> = {
  narration: "sessions",
  session: "sessions",
  monitor: "monitors",
  sight: "vision",
  people: "vision",
};

// Reached the way a user reaches them: navigate to the category, then expand
// what is visible there. Clicking a toggle by testid inside a hidden section
// would assert reachability of a control nobody could have clicked.
const expandEverything = (): void => {
  for (const name of ["chat", "sessions", "log monitors", "vision"]) {
    fireEvent.click(category(name));
    const id = name === "log monitors" ? "monitors" : name;
    for (const toggle of group(id).queryAllByTestId(/^disclosure-/)) {
      if (toggle.getAttribute("aria-expanded") === "false") fireEvent.click(toggle);
    }
  }
};

describe("every editable wording has exactly one home", () => {
  it("accounts for all nine template roles", () => {
    const owned = TEMPLATE_FIELDS.map((f) => f.role);
    expect([...owned, ...NOT_A_SETTING].sort()).toEqual([...TEMPLATE_ROLES].sort());
    expect(owned.filter((r) => NOT_A_SETTING.includes(r))).toEqual([]);
    // Pinned so the partition cannot be made vacuous by emptying it.
    expect(NOT_A_SETTING).toEqual(["conversation-system"]);
  });

  it("assigns a home to every role the drawer owns", () => {
    // Pinned against TEMPLATE_FIELDS rather than assumed. Without this, a
    // ninth owned role added to the panel but forgotten here would be skipped
    // by the loop below and the sweep would pass while it rendered nowhere.
    expect(Object.keys(TEMPLATE_HOME).sort()).toEqual(TEMPLATE_FIELDS.map((f) => f.role).sort());
    expect(Object.keys(PHRASE_HOME).sort()).toEqual([...new Set(PHRASES.map((p) => p.group))].sort());
  });

  it("renders each settings-owned role once, in the section that owns it", () => {
    open();
    expandEverything();

    for (const role of TEMPLATE_FIELDS.map((f) => f.role)) {
      const found = screen.queryAllByTestId(`template-${role}`);
      expect(found, `${role} renders ${found.length} times, expected once`).toHaveLength(1);
      expect(
        screen.getByTestId(`group-${TEMPLATE_HOME[role]}`),
        `${role} is not under ${TEMPLATE_HOME[role]}`,
      ).toContainElement(found[0]!);
    }
  });

  it("never renders the role that belongs to a conversation", () => {
    open();
    expandEverything();
    expect(screen.queryByTestId("template-conversation-system")).toBeNull();
  });

  it("renders each of the forty-four phrases once, in the section that owns it", () => {
    open();
    expandEverything();

    for (const spec of PHRASES) {
      const found = screen.queryAllByTestId(`phrase-${spec.id}`);
      expect(found, `${spec.id} renders ${found.length} times, expected once`).toHaveLength(1);
      expect(
        screen.getByTestId(`group-${PHRASE_HOME[spec.group]}`),
        `${spec.id} is not under ${PHRASE_HOME[spec.group]}`,
      ).toContainElement(found[0]!);
    }
    expect(PHRASES).toHaveLength(44);
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

    it("stops the queue bound from claiming to govern the shelf as well", () => {
      // It governs one pool. The shelf has its own bound, stated in the vision
      // pane, and copy that implied otherwise would describe a limit that does
      // not bite where the user thinks it does.
      openVision();
      const copy = screen.getByText(/unrecognised faces waiting for a decision/).textContent ?? "";
      expect(copy).toContain("held separately");
      expect(copy).toContain("does not govern them");
    });

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
        biometricTally: { people: 3, faces: 9, candidates: 2, setAside: 0 },
      });
      fireEvent.click(screen.getByTestId("purge-biometrics"));
      const warning = screen.getByTestId("purge-warning").textContent ?? "";
      expect(warning).toContain("3 people");
      expect(warning).toContain("9 faces");
      expect(warning).toContain("2 waiting faces");
      expect(warning).toContain("cannot be undone");
    });

    it("names the faces the user set aside apart from the rest", () => {
      // The one irreversible action in the feature. A merged figure would
      // destroy a shelf the user deliberately kept while reporting it as queue
      // clutter, and the whole reason the two pools have separate tallies is
      // that they are separate sentences.
      openVision({ biometricTally: { people: 1, faces: 4, candidates: 5, setAside: 3 } });
      fireEvent.click(screen.getByTestId("purge-biometrics"));
      const warning = screen.getByTestId("purge-warning").textContent ?? "";
      expect(warning).toContain("5 waiting faces");
      expect(warning).toContain("3 of them set aside");
      expect(warning).toContain("cannot be undone");
    });

    it("says nothing about a shelf with nothing on it", () => {
      openVision({ biometricTally: { people: 1, faces: 4, candidates: 5, setAside: 0 } });
      fireEvent.click(screen.getByTestId("purge-biometrics"));
      expect(screen.getByTestId("purge-warning").textContent ?? "").not.toContain("set aside");
    });

    it("says 'person' and 'face' when there is one of each", () => {
      openVision({ biometricTally: { people: 1, faces: 1, candidates: 1, setAside: 0 } });
      fireEvent.click(screen.getByTestId("purge-biometrics"));
      const warning = screen.getByTestId("purge-warning").textContent ?? "";
      expect(warning).toContain("1 person");
      expect(warning).toContain("1 face");
      expect(warning).not.toContain("1 people");
    });

    it("purges once confirmed", () => {
      const { h } = openVision({ biometricTally: { people: 2, faces: 4, candidates: 0, setAside: 0 } });
      fireEvent.click(screen.getByTestId("purge-biometrics"));
      fireEvent.click(screen.getByTestId("confirm-purge-biometrics"));
      expect(h.sent.filter((m) => m.type === "purge-biometrics")).toHaveLength(1);
    });

    it("sends nothing when cancelled", () => {
      const { h } = openVision({ biometricTally: { people: 2, faces: 4, candidates: 0, setAside: 0 } });
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
