import { describe, it, expect } from "vitest";
import { parseRoute, titleFor } from "../src/route";

// Pure, and therefore node: everything about `navigate`, `popstate` and
// `history` needs a window and lives in the component suite instead.
describe("parseRoute", () => {
  it("maps the three routes the app has", () => {
    expect(parseRoute("/")).toBe("home");
    expect(parseRoute("/live")).toBe("live");
    expect(parseRoute("/broadcast")).toBe("broadcast");
  });

  it("treats a trailing slash as the same place", () => {
    expect(parseRoute("/live/")).toBe("live");
    expect(parseRoute("/broadcast/")).toBe("broadcast");
  });

  it("sends anything unrecognised home", () => {
    // The server's SPA fallback already answers every unmatched path with the
    // document, so a second not-found surface would only disagree with it.
    expect(parseRoute("/nowhere")).toBe("home");
    expect(parseRoute("/live/extra")).toBe("home");
    expect(parseRoute("/broadcast/extra")).toBe("home");
    expect(parseRoute("")).toBe("home");
  });
});

describe("titleFor", () => {
  it("names the operator routes and leaves the output surface neutral", () => {
    expect(titleFor("home")).toBe("HAL 1000");
    expect(titleFor("live")).toBe("HAL 1000");
    expect(titleFor("broadcast")).not.toMatch(/HAL/);
  });
});
