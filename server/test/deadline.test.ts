import { describe, it, expect } from "vitest";
import { withDeadline } from "../src/deadline.js";

describe("answering within a deadline", () => {
  it("returns what the work returned when it is quick enough", async () => {
    expect(await withDeadline(Promise.resolve("done"), 1000, "gave up")).toBe("done");
  });

  it("returns the fallback when the work outlasts the deadline", async () => {
    const never = new Promise<string>(() => {});
    expect(await withDeadline(never, 20, "gave up")).toBe("gave up");
  });

  it("takes the fallback rather than a rejection", async () => {
    // The callers are asking a question about a file, not performing an
    // operation: "I could not find out" is an answer, not an error to handle.
    await expect(withDeadline(Promise.reject(new Error("EIO")), 1000, "gave up")).resolves.toBe("gave up");
  });

  it("does not hold the process open once it has answered", async () => {
    // The timer has to be cleared on the fast path, or a short check leaves a
    // pending timer behind for every clip it looked at.
    const before = process.getActiveResourcesInfo?.().filter((r) => r === "Timeout").length ?? 0;
    await withDeadline(Promise.resolve(1), 60_000, 0);
    const after = process.getActiveResourcesInfo?.().filter((r) => r === "Timeout").length ?? 0;
    expect(after).toBeLessThanOrEqual(before);
  });

  it("lets late work settle without an unhandled rejection", async () => {
    let reject: (e: Error) => void = () => {};
    const late = new Promise<string>((_, r) => {
      reject = r;
    });
    expect(await withDeadline(late, 10, "gave up")).toBe("gave up");
    reject(new Error("arrived after nobody was listening"));
    await new Promise((r) => setTimeout(r, 20));
  });
});
