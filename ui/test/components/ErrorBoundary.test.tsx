import { describe, it, expect, vi, afterEach } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { ErrorBoundary } from "../../src/components/ErrorBoundary";
import { SettingsPanel } from "../../src/components/SettingsPanel";
import { harness, mount, testState } from "./harness";

// A render throw must not blank the app.
//
// React's default for an uncaught one is to unmount the whole tree, which is a
// black page with no message — worst exactly where it matters most, since the
// settings panel is where someone goes to fix whatever broke. This happened
// here for real: a server predating the backends wire change served a client
// expecting the new shape, `settings.backends` was undefined, and the page went
// black with nothing on it.

function Boom({ message }: { message: string }): never {
  throw new Error(message);
}

// React logs caught render errors to console.error. Silenced per test so a
// passing run is not full of red that means nothing.
function quiet() {
  return vi.spyOn(console, "error").mockImplementation(() => {});
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ErrorBoundary", () => {
  it("renders its children when nothing throws", () => {
    mount(
      <ErrorBoundary label="Settings">
        <p>all well</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText("all well")).toBeInTheDocument();
    expect(screen.queryByTestId("render-error")).not.toBeInTheDocument();
  });

  it("names the surface that failed", () => {
    quiet();
    mount(
      <ErrorBoundary label="Settings">
        <Boom message="anything" />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/Settings could not be displayed/)).toBeInTheDocument();
  });

  it("shows the actual message rather than a generic apology", () => {
    // A user who can read "Cannot read properties of undefined (reading
    // 'shared')" can tell this is a version skew and restart. One who reads
    // "an error occurred" can tell nothing.
    quiet();
    mount(
      <ErrorBoundary label="Settings">
        <Boom message="Cannot read properties of undefined (reading 'shared')" />
      </ErrorBoundary>,
    );
    expect(screen.getByText("Cannot read properties of undefined (reading 'shared')")).toBeInTheDocument();
  });

  it("logs the error rather than swallowing it", () => {
    const spy = quiet();
    mount(
      <ErrorBoundary label="Settings">
        <Boom message="kaboom" />
      </ErrorBoundary>,
    );
    expect(spy.mock.calls.some((c) => String(c[0]).includes("render error in Settings"))).toBe(true);
  });

  it("offers close only when dismissing is possible", () => {
    quiet();
    const { unmount } = mount(
      <ErrorBoundary label="The main view">
        <Boom message="x" />
      </ErrorBoundary>,
    );
    expect(screen.queryByRole("button", { name: "close" })).not.toBeInTheDocument();
    unmount();

    const onDismiss = vi.fn();
    mount(
      <ErrorBoundary label="Settings" onDismiss={onDismiss}>
        <Boom message="x" />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByRole("button", { name: "close" }));
    expect(onDismiss).toHaveBeenCalled();
  });

  it("retries on demand, so a transient fault is not a dead end", () => {
    quiet();
    let shouldThrow = true;
    function Flaky() {
      if (shouldThrow) throw new Error("not yet");
      return <p>recovered</p>;
    }

    mount(
      <ErrorBoundary label="Settings">
        <Flaky />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId("render-error")).toBeInTheDocument();

    shouldThrow = false;
    fireEvent.click(screen.getByRole("button", { name: "try again" }));
    expect(screen.getByText("recovered")).toBeInTheDocument();
  });
});

describe("the failure this was built for", () => {
  it("catches settings arriving without backends instead of blanking the app", () => {
    // Exactly the skew that produced the black page: an old server sending the
    // pre-backends settings shape to a client that reads `backends.shared`.
    quiet();
    const h = harness();
    const state = testState();
    const legacy = { ...state.settings!, backends: undefined as never };

    mount(
      <ErrorBoundary label="Settings" onDismiss={() => {}}>
        <SettingsPanel state={{ ...state, settings: legacy }} send={h.send} onClose={() => {}} />
      </ErrorBoundary>,
    );

    expect(screen.getByTestId("render-error")).toBeInTheDocument();
    expect(screen.getByText(/Settings could not be displayed/)).toBeInTheDocument();
  });
});
