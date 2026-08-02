import { describe, it, expect } from "vitest";
import { ProviderQueue } from "../../src/providers/queue.js";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("ProviderQueue", () => {
  it("runs a queued chat job before a queued narration job", async () => {
    const q = new ProviderQueue();
    const order: string[] = [];
    const gate = deferred();
    // Occupy the lane so both jobs below start queued.
    const busy = q.enqueue("chat", async () => {
      await gate.promise;
    });
    const narration = q.enqueue("narration", async () => {
      order.push("narration");
    });
    const chat = q.enqueue("chat", async () => {
      order.push("chat");
    });
    gate.resolve();
    await Promise.all([busy, narration, chat]);
    expect(order).toEqual(["chat", "narration"]);
  });

  it("aborts an in-flight narration job when a chat job arrives", async () => {
    const q = new ProviderQueue();
    const order: string[] = [];
    const narration = q.enqueue("narration", (signal) => {
      return new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          order.push("narration-aborted");
          reject(new Error("aborted"));
        });
      });
    });
    await tick();
    const chat = q.enqueue("chat", async () => {
      order.push("chat-ran");
    });
    await expect(narration).rejects.toThrow("aborted");
    await chat;
    expect(order).toEqual(["narration-aborted", "chat-ran"]);
  });

  it("never aborts an in-flight chat job when narration piles up", async () => {
    const q = new ProviderQueue();
    const gate = deferred();
    let chatAborted = false;
    const chat = q.enqueue("chat", async (signal) => {
      signal.addEventListener("abort", () => (chatAborted = true));
      await gate.promise;
      return "chat-done";
    });
    await tick();
    const narrations = [
      q.enqueue("narration", async () => "n1"),
      q.enqueue("narration", async () => "n2"),
    ];
    await tick();
    expect(chatAborted).toBe(false);
    gate.resolve();
    await expect(chat).resolves.toBe("chat-done");
    await expect(Promise.all(narrations)).resolves.toEqual(["n1", "n2"]);
  });

  it("runs jobs strictly one at a time", async () => {
    const q = new ProviderQueue();
    let running = 0;
    let maxRunning = 0;
    const jobs = Array.from({ length: 5 }, (_, i) =>
      q.enqueue(i % 2 === 0 ? "chat" : "narration", async () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await tick();
        running -= 1;
      }),
    );
    await Promise.all(jobs);
    expect(maxRunning).toBe(1);
  });
});
