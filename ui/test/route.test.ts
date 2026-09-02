import { describe, it, expect } from "vitest";
import { parseRoute } from "../src/route";

// Pure, and therefore node: everything about `navigate`, `popstate` and
// `history` needs a window and lives in the component suite instead.
describe("parseRoute", () => {
  it("maps the two routes the app has", () => {
    expect(parseRoute("/")).toBe("home");
    expect(parseRoute("/live")).toBe("live");
  });

  it("treats a trailing slash as the same place", () => {
    expect(parseRoute("/live/")).toBe("live");
  });

  it("sends anything unrecognised home", () => {
    // The server's SPA fallback already answers every unmatched path with the
    // document, so a second not-found surface would only disagree with it.
    expect(parseRoute("/nowhere")).toBe("home");
    expect(parseRoute("/live/extra")).toBe("home");
    expect(parseRoute("")).toBe("home");
  });
});
