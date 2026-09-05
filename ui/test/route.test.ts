import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

describe("the title the document actually ships", () => {
  it("is neutral in index.html, so a page that never runs its bundle is still neutral", () => {
    // The mapping above is pure and says nothing about what is served. The
    // static title is the whole of KTD8: a broadcast window whose JS fails to
    // parse keeps whatever index.html shipped, so the identifying name must not
    // be the default. Reverting this file to "HAL 1000" would leave every unit
    // test green while putting the name back on the projector — a reviewer
    // proposed exactly that during code review.
    const html = readFileSync(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");
    const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? "";

    expect(title).not.toMatch(/HAL/i);
    expect(title).toBe("Broadcast");
  });
});
