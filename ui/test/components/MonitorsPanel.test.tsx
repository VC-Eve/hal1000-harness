import { describe, it, expect } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { MonitorsPanel } from "../../src/components/MonitorsPanel";
import { harness, mount, testMonitor, testState, testSuggestion } from "./harness";

describe("MonitorsPanel — mount requests", () => {
  it("asks for monitors and suggestions once, not once per render", () => {
    // The regression this harness exists for. The mount effect listed `send` in
    // its dependencies while App re-created `send` every render, so each run
    // issued two requests whose broadcasts re-rendered the tree and ran the
    // effect again — roughly 250 round-trips a second, indefinitely.
    const h = harness();
    const { rerender } = mount(<MonitorsPanel state={testState()} send={h.send} />);

    expect(h.countOf("list-monitor-suggestions")).toBe(1);
    expect(h.countOf("list-monitors")).toBe(1);

    // Re-render as the store would after each broadcast. The effect must not
    // fire again.
    rerender(<MonitorsPanel state={testState({ monitors: [testMonitor()] })} send={h.send} />);
    rerender(<MonitorsPanel state={testState({ monitorSuggestions: [testSuggestion()] })} send={h.send} />);
    rerender(<MonitorsPanel state={testState({ monitors: [testMonitor()], monitorSuggestions: [testSuggestion()] })} send={h.send} />);

    expect(h.countOf("list-monitor-suggestions")).toBe(1);
    expect(h.countOf("list-monitors")).toBe(1);
  });

  it("asks once even when handed a fresh send function on every render", () => {
    // The shape the real bug had: App re-created `send` each render, so an
    // effect depending on it re-ran forever. A stable `send` hides that, so
    // this test deliberately supplies an unstable one — the component must not
    // depend on its caller getting memoisation right.
    const h = harness();
    const unstable = () => (msg: Parameters<typeof h.send>[0]) => h.send(msg);

    const { rerender } = mount(<MonitorsPanel state={testState()} send={unstable()} />);
    for (let i = 0; i < 5; i += 1) {
      rerender(<MonitorsPanel state={testState({ monitors: [testMonitor()] })} send={unstable()} />);
    }

    expect(h.countOf("list-monitor-suggestions")).toBe(1);
    expect(h.countOf("list-monitors")).toBe(1);
  });

  it("sends nothing beyond those two requests without user interaction", () => {
    const h = harness();
    mount(<MonitorsPanel state={testState({ monitors: [testMonitor()] })} send={h.send} />);
    expect(h.sent.map((m) => m.type).sort()).toEqual(["list-monitor-suggestions", "list-monitors"]);
  });
});

describe("MonitorsPanel — suggestions", () => {
  it("offers an available suggestion that is not yet added", () => {
    const h = harness();
    mount(<MonitorsPanel state={testState({ monitorSuggestions: [testSuggestion()] })} send={h.send} />);

    const button = screen.getByRole("button", { name: /^add systemd journal$/i });
    expect(button).toBeEnabled();
  });

  it("marks a suggestion already being watched and refuses to add it twice", () => {
    const suggestion = testSuggestion();
    const h = harness();
    mount(
      <MonitorsPanel
        state={testState({ monitorSuggestions: [suggestion], monitors: [testMonitor({ source: suggestion.source })] })}
        send={h.send}
      />,
    );

    const button = screen.getByRole("button", { name: /already added$/i });
    expect(button).toBeDisabled();
    expect(screen.getByText(/already watching this/i)).toBeInTheDocument();
    // No "add" button at all — the disabled one reads as done, not broken.
    expect(screen.queryByRole("button", { name: /^add systemd journal$/i })).toBeNull();
  });

  it("still marks it added when the monitor was renamed", () => {
    // Matching is on the source: an id is server-generated and a label is the
    // user's, so neither identifies what is actually being watched.
    const suggestion = testSuggestion();
    const h = harness();
    mount(
      <MonitorsPanel
        state={testState({
          monitorSuggestions: [suggestion],
          monitors: [testMonitor({ label: "renamed by hand", source: suggestion.source })],
        })}
        send={h.send}
      />,
    );
    expect(screen.getByRole("button", { name: /already added$/i })).toBeDisabled();
  });

  it("disables an unavailable suggestion and says why", () => {
    const h = harness();
    mount(<MonitorsPanel state={testState({ monitorSuggestions: [testSuggestion({ available: false })] })} send={h.send} />);

    expect(screen.getByRole("button", { name: /^add systemd journal$/i })).toBeDisabled();
    expect(screen.getByText(/not present on this machine/i)).toBeInTheDocument();
  });
});

describe("MonitorsPanel — configured monitors", () => {
  it("shows a command monitor's full command, never elided (R6)", () => {
    // What HAL runs on a schedule must be visible wherever monitors are managed.
    const command = 'powershell -NoProfile -NonInteractive -Command "Get-WinEvent -LogName System -MaxEvents 40"';
    const h = harness();
    mount(
      <MonitorsPanel
        state={testState({ monitors: [testMonitor({ source: { kind: "command", command, intervalMs: 120_000 } })] })}
        send={h.send}
      />,
    );
    expect(screen.getByText(command)).toBeInTheDocument();
  });

  it("says so plainly when nothing is configured", () => {
    const h = harness();
    mount(<MonitorsPanel state={testState()} send={h.send} />);
    expect(screen.getByText(/no monitors/i)).toBeInTheDocument();
  });
});

describe("MonitorsPanel — severity rule", () => {
  it("shows default selected when a monitor has no rule", () => {
    const h = harness();
    mount(<MonitorsPanel state={testState({ monitors: [testMonitor()] })} send={h.send} />);
    expect(screen.getByRole("button", { name: /interrupt on default/i })).toHaveClass("selected");
  });

  it("switches a noisy source to never without touching anything else", () => {
    const h = harness();
    mount(<MonitorsPanel state={testState({ monitors: [testMonitor()] })} send={h.send} />);

    fireEvent.click(screen.getByRole("button", { name: /interrupt on never/i }));
    expect(h.sent).toEqual([
      { type: "list-monitor-suggestions" },
      { type: "list-monitors" },
      { type: "update-monitor", monitorId: "m1", patch: { severity: { kind: "never" } } },
    ]);
  });

  it("reveals a pattern input only in pattern mode, seeded with the stored pattern", () => {
    const h = harness();
    const withPattern = testMonitor({ severity: { kind: "pattern", pattern: "out of memory" } });
    mount(<MonitorsPanel state={testState({ monitors: [withPattern] })} send={h.send} />);

    const input = screen.getByLabelText(/severity pattern/i) as HTMLInputElement;
    expect(input.value).toBe("out of memory");
  });

  it("hides the pattern input when the rule is never", () => {
    const h = harness();
    mount(<MonitorsPanel state={testState({ monitors: [testMonitor({ severity: { kind: "never" } })] })} send={h.send} />);
    expect(screen.queryByLabelText(/severity pattern/i)).toBeNull();
  });

  it("sends the pattern on blur, not on every keystroke", () => {
    // A half-typed regex would be rejected by the store and bounce the control.
    const h = harness();
    mount(
      <MonitorsPanel
        state={testState({ monitors: [testMonitor({ severity: { kind: "pattern", pattern: "old" } })] })}
        send={h.send}
      />,
    );

    const input = screen.getByLabelText(/severity pattern/i);
    fireEvent.change(input, { target: { value: "out of mem" } });
    expect(h.countOf("update-monitor")).toBe(0);

    fireEvent.blur(input);
    expect(h.sent.at(-1)).toEqual({
      type: "update-monitor",
      monitorId: "m1",
      patch: { severity: { kind: "pattern", pattern: "out of mem" } },
    });
  });

  it("keeps a typed pattern when flipping to never and back", () => {
    const h = harness();
    const withPattern = testMonitor({ severity: { kind: "pattern", pattern: "cuda error" } });
    mount(<MonitorsPanel state={testState({ monitors: [withPattern] })} send={h.send} />);

    fireEvent.click(screen.getByRole("button", { name: /interrupt on pattern/i }));
    expect(h.sent.at(-1)).toEqual({
      type: "update-monitor",
      monitorId: "m1",
      patch: { severity: { kind: "pattern", pattern: "cuda error" } },
    });
  });
});
