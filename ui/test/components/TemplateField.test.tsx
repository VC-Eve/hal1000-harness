import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import "./harness";
import { TemplateField } from "../../src/components/TemplateField";
import { DEFAULT_TEMPLATES } from "../../../shared/src/prompts";
import { SLOT_VOCABULARY } from "../../../shared/src/templates";

// Behaviour a reader cannot check by eye: which buttons are live in which
// state, what gets sent, and whether a broken template can reach the server.
// The look of the panel is verified by screenshot, per AGENTS.md.

const ROLE = "monitor-user" as const;
const SHIPPED = DEFAULT_TEMPLATES[ROLE];

function setup(over: Partial<Parameters<typeof TemplateField>[0]> = {}) {
  const props = {
    role: ROLE,
    label: "log monitors — the request",
    note: "one branch per reason",
    stored: undefined as string | null | undefined,
    shipped: SHIPPED,
    slots: SLOT_VOCABULARY[ROLE],
    baseline: undefined,
    onApply: vi.fn(),
    onReset: vi.fn(),
    onSaveBaseline: vi.fn(),
    onRevertToBaseline: vi.fn(),
    ...over,
  };
  render(<TemplateField {...props} />);
  return props;
}

const area = (): HTMLTextAreaElement => screen.getByRole("textbox") as HTMLTextAreaElement;
const type = (text: string): void => fireEvent.change(area(), { target: { value: text } });

describe("TemplateField — state", () => {
  it("reports the shipped default when nothing is stored", () => {
    setup();
    expect(screen.getByTestId(`template-state-${ROLE}`)).toHaveTextContent("shipped default");
  });

  it("reports edited when the stored text differs", () => {
    setup({ stored: "{monitor_lines}" });
    expect(screen.getByTestId(`template-state-${ROLE}`)).toHaveTextContent("edited");
  });

  it("reports the baseline when the stored text is the saved one", () => {
    setup({
      stored: "{monitor_lines}",
      baseline: { text: "{monitor_lines}", shippedDefault: SHIPPED },
    });
    expect(screen.getByTestId(`template-state-${ROLE}`)).toHaveTextContent("your baseline");
  });
});

describe("TemplateField — validation gates the send", () => {
  it("refuses to apply a template naming a slot the role does not have", () => {
    const props = setup();
    type("{data_vison}");
    const errors = screen.getByTestId(`template-errors-${ROLE}`);
    expect(errors).toHaveTextContent("'data_vison' is not a slot here.");
    // And it lists what is valid, so the vocabulary is learnable without
    // guessing a second time.
    expect(errors).toHaveTextContent("monitor_label");
    expect(screen.getByRole("button", { name: "apply" })).toBeDisabled();
    expect(props.onApply).not.toHaveBeenCalled();
  });

  it("refuses to apply an unclosed block", () => {
    setup();
    type("{#reason_cycle}Summarise it.");
    expect(screen.getByTestId(`template-errors-${ROLE}`)).toHaveTextContent("never closed");
    expect(screen.getByRole("button", { name: "apply" })).toBeDisabled();
  });

  it("refuses a condition slot used inline", () => {
    setup();
    type("{reason_cycle}");
    expect(screen.getByTestId(`template-errors-${ROLE}`)).toHaveTextContent("only works as a condition");
  });

  it("applies a valid edit and sends exactly what was typed", () => {
    const props = setup();
    type("{#reason_cycle}Summarise {monitor_label}.{/}\n\n{monitor_lines}");
    fireEvent.click(screen.getByRole("button", { name: "apply" }));
    expect(props.onApply).toHaveBeenCalledWith("{#reason_cycle}Summarise {monitor_label}.{/}\n\n{monitor_lines}");
  });

  it("leaves apply disabled while the draft matches what is stored", () => {
    setup();
    expect(screen.getByRole("button", { name: "apply" })).toBeDisabled();
  });
});

describe("TemplateField — the preview is the point", () => {
  it("shows what the template renders, with the branch that fired", () => {
    setup();
    const preview = screen.getByTestId(`template-preview-${ROLE}`);
    expect(preview).toHaveTextContent("Activity in windows event log over the last period. Summarise it.");
  });

  it("names the blocks that dropped rather than leaving them invisible", () => {
    setup();
    const preview = screen.getByTestId(`template-preview-${ROLE}`);
    expect(preview).toHaveTextContent("reason_interrupt");
    expect(preview).toHaveTextContent("reason_full");
  });

  it("says so when everything dropped", () => {
    setup();
    type("{#reason_interrupt}never fires in the sample{/}");
    expect(screen.getByTestId(`template-preview-${ROLE}`)).toHaveTextContent("nothing — every block dropped");
  });

  it("emits no marker word for the branch that fired", () => {
    setup();
    expect(screen.getByTestId(`template-preview-${ROLE}`)).not.toHaveTextContent("set");
  });
});

describe("TemplateField — baselines", () => {
  it("saves the draft and the shipped default it was taken against", () => {
    const props = setup();
    type("{monitor_lines}");
    fireEvent.click(screen.getByRole("button", { name: "save as baseline" }));
    expect(props.onSaveBaseline).toHaveBeenCalledWith("{monitor_lines}");
  });

  it("offers no revert when no baseline was ever saved", () => {
    setup();
    expect(screen.queryByRole("button", { name: "revert to baseline" })).toBeNull();
  });

  it("offers revert once a baseline exists, and disables it while already there", () => {
    setup({ stored: "{monitor_lines}", baseline: { text: "{monitor_lines}", shippedDefault: SHIPPED } });
    expect(screen.getByRole("button", { name: "revert to baseline" })).toBeDisabled();
  });

  it("enables revert once the draft moves off the baseline", () => {
    setup({ stored: "{monitor_lines}", baseline: { text: "{monitor_lines}", shippedDefault: SHIPPED } });
    type("{monitor_lines} and more");
    expect(screen.getByRole("button", { name: "revert to baseline" })).toBeEnabled();
  });

  it("refuses to save a baseline that does not validate", () => {
    setup();
    type("{#reason_cycle}unclosed");
    expect(screen.getByRole("button", { name: "save as baseline" })).toBeDisabled();
  });
});

describe("TemplateField — a release that moves the default", () => {
  const OLD = "{#reason_cycle}Old wording for {monitor_label}.{/}\n\n{monitor_lines}";

  it("says nothing while the baseline was taken against the current default", () => {
    setup({ stored: "{monitor_lines}", baseline: { text: "{monitor_lines}", shippedDefault: SHIPPED } });
    expect(screen.queryByTestId(`template-behind-${ROLE}`)).toBeNull();
  });

  it("flags the template as behind when the shipped default has moved", () => {
    setup({ stored: "{monitor_lines}", baseline: { text: "{monitor_lines}", shippedDefault: OLD } });
    expect(screen.getByTestId(`template-behind-${ROLE}`)).toHaveTextContent("shipped default for this template changed");
  });

  it("takes the new default wholesale when asked", () => {
    const props = setup({
      stored: "{monitor_lines}",
      baseline: { text: "{monitor_lines}", shippedDefault: OLD },
    });
    fireEvent.click(screen.getByRole("button", { name: "take the new default" }));
    expect(props.onApply).toHaveBeenCalledWith(SHIPPED);
  });
});

describe("TemplateField — discovering the vocabulary", () => {
  it("lists the role's slots with what each one means", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: /^slots \(/ }));
    const list = screen.getByTestId(`template-slots-${ROLE}`);
    expect(list).toHaveTextContent("{monitor_label}");
    expect(list).toHaveTextContent("the name of the Monitor this batch came from");
    // A condition slot advertises the shape it actually works in.
    expect(list).toHaveTextContent("{#reason_cycle}…{/}");
  });

  it("inserts a slot at the cursor", () => {
    setup();
    type("");
    fireEvent.click(screen.getByRole("button", { name: /^slots \(/ }));
    fireEvent.click(screen.getByRole("button", { name: "{monitor_label}" }));
    expect(area().value).toBe("{monitor_label}");
  });

  it("carries the reasoning behind each slot's wording", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: /^slots \(/ }));
    expect(screen.getByTestId(`template-slots-${ROLE}`)).toHaveTextContent("An all-clear on a timer is noise.");
  });
});

describe("TemplateField — identity", () => {
  it("says nothing for a role that places no identity", () => {
    setup();
    expect(screen.queryByTestId(`template-identity-${ROLE}`)).toBeNull();
  });

  it("cautions when a template places a reading that may be uncertain", () => {
    render(
      <TemplateField
        role="chat-context"
        label="conversation context"
        note=""
        stored={"{#vision_faces}Confirmed present: {vision_faces}{/}"}
        shipped={DEFAULT_TEMPLATES["chat-context"]}
        slots={SLOT_VOCABULARY["chat-context"]}
        baseline={undefined}
        onApply={vi.fn()}
        onReset={vi.fn()}
        onSaveBaseline={vi.fn()}
        onRevertToBaseline={vi.fn()}
      />,
    );
    expect(screen.getByTestId("template-identity-chat-context")).toHaveTextContent("may be uncertain");
  });
});

describe("TemplateField — the draft follows the stored value", () => {
  // Reset, revert and take-the-new-default all change `stored` from outside the
  // component. Seeded once and never re-synced, the textarea kept the old text
  // and pressing apply re-stored what had just been discarded.
  function rerenderWith(stored: string | null) {
    const props = {
      role: ROLE,
      label: "l",
      note: "n",
      stored,
      shipped: SHIPPED,
      slots: SLOT_VOCABULARY[ROLE],
      baseline: undefined,
      onApply: vi.fn(),
      onReset: vi.fn(),
      onSaveBaseline: vi.fn(),
      onRevertToBaseline: vi.fn(),
    };
    return { props, ...render(<TemplateField {...props} />) };
  }

  it("shows the shipped default after a reset", () => {
    const { rerender, props } = rerenderWith("{monitor_lines}");
    expect(area().value).toBe("{monitor_lines}");
    rerender(<TemplateField {...props} stored={null} />);
    expect(area().value).toBe(SHIPPED);
  });

  it("shows the baseline after a revert", () => {
    const { rerender, props } = rerenderWith("edited beyond");
    rerender(<TemplateField {...props} stored="{monitor_lines}" />);
    expect(area().value).toBe("{monitor_lines}");
  });

  it("does not discard an in-progress edit while the stored value is unchanged", () => {
    const { rerender, props } = rerenderWith("{monitor_lines}");
    type("{monitor_lines} plus mine");
    rerender(<TemplateField {...props} />);
    expect(area().value).toBe("{monitor_lines} plus mine");
  });
});

describe("TemplateField — reset", () => {
  it("fires onReset", () => {
    const props = setup({ stored: "{monitor_lines}" });
    fireEvent.click(screen.getByRole("button", { name: "reset" }));
    expect(props.onReset).toHaveBeenCalled();
  });

  it("is disabled when the stored template is already the shipped default", () => {
    setup();
    expect(screen.getByRole("button", { name: "reset" })).toBeDisabled();
  });

  it("is enabled when an edited template is stored", () => {
    setup({ stored: "{monitor_lines}" });
    expect(screen.getByRole("button", { name: "reset" })).toBeEnabled();
  });
});

describe("TemplateField — a slot the vocabulary lost", () => {
  it("marks the template degraded and names the dead slot", () => {
    setup({ stored: "{monitor_lines} {gone_away}" });
    expect(screen.getByTestId(`template-degraded-${ROLE}`)).toHaveTextContent("gone_away");
  });
});
