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

  it("does not abort narration for a chat job on a different backend", async () => {
    // Chat Preemption exists because one machine runs one model at a time. Once
    // chat is pointed somewhere else that premise is false, and aborting buys
    // the chat request nothing while destroying a batch that has to be re-run.
    const q = new ProviderQueue();
    const gate = deferred();
    let narrationAborted = false;

    const narration = q.enqueue(
      "narration",
      async (signal) => {
        signal.addEventListener("abort", () => (narrationAborted = true));
        await gate.promise;
        return "narration-done";
      },
      "http://localhost:11434",
    );
    await tick();

    const chat = q.enqueue("chat", async () => "chat-done", "https://api.example.com");
    await tick();

    expect(narrationAborted).toBe(false);
    gate.resolve();
    await expect(narration).resolves.toBe("narration-done");
    await expect(chat).resolves.toBe("chat-done");
  });

  it("still aborts narration for a chat job on the same backend", async () => {
    const q = new ProviderQueue();
    const narration = q.enqueue(
      "narration",
      (signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      "http://localhost:11434",
    );
    await tick();
    const chat = q.enqueue("chat", async () => "chat-done", "http://localhost:11434");

    await expect(narration).rejects.toThrow("aborted");
    await expect(chat).resolves.toBe("chat-done");
  });

  it("counts a trailing slash as the same backend", async () => {
    const q = new ProviderQueue();
    const narration = q.enqueue(
      "narration",
      (signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      "http://localhost:11434/",
    );
    await tick();
    const chat = q.enqueue("chat", async () => "chat-done", "http://localhost:11434");

    await expect(narration).rejects.toThrow("aborted");
    await chat;
  });

  it("still aborts narration when the slots share a host but differ by credential, because contention is about the machine", async () => {
    // Named for the reason, because the reason is the whole content. This
    // comparison is `sameHost` while its neighbours in readiness and
    // `list-models` are `sameDestination`, and that asymmetry looks like an
    // oversight to anyone who has just read the other two.
    //
    // It is not. Two slots on one box with two keys are still one GPU running
    // one model at a time, so a waiting person is still queued behind
    // commentary. Teaching this to tell the keys apart would restore precisely
    // the stall that narrowing preemption to the same backend removed.
    const q = new ProviderQueue();
    const narration = q.enqueue(
      "narration",
      (signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      "https://api.example.com",
    );
    await tick();
    // A different slot, a different credential, the same server.
    const chat = q.enqueue("chat", async () => "chat-done", "https://api.example.com");

    await expect(narration).rejects.toThrow("aborted");
    await expect(chat).resolves.toBe("chat-done");
  });

  it("treats an unstated endpoint as contending, preserving the old behaviour", async () => {
    // The safe direction to be wrong in: preempting unnecessarily costs a
    // re-queued batch, while failing to preempt when they do contend puts a
    // waiting person behind commentary.
    const q = new ProviderQueue();
    const narration = q.enqueue("narration", (signal) => {
      return new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });
    await tick();
    const chat = q.enqueue("chat", async () => "chat-done", "https://api.example.com");

    await expect(narration).rejects.toThrow("aborted");
    await chat;
  });

  it("runs jobs on two machines at once, because two backends are two VRAM pools", async () => {
    // The reason the two backend slots exist: offload chat to a desktop and
    // keep observation on the laptop, and both carry work. A global lane hands
    // that back — the laptop idles through every chat reply.
    const q = new ProviderQueue();
    let running = 0;
    let maxRunning = 0;
    const gate = deferred();
    const track = async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await gate.promise;
      running -= 1;
    };

    const narration = q.enqueue("narration", track, "http://laptop.lan:11434");
    await tick();
    const chat = q.enqueue("chat", track, "http://desktop.lan:11434");
    await tick();

    expect(maxRunning).toBe(2);
    gate.resolve();
    await Promise.all([narration, chat]);
  });

  it("still runs one at a time when both jobs are on one machine", async () => {
    const q = new ProviderQueue();
    let running = 0;
    let maxRunning = 0;
    const jobs = Array.from({ length: 4 }, (_, i) =>
      q.enqueue(
        i % 2 === 0 ? "chat" : "narration",
        async () => {
          running += 1;
          maxRunning = Math.max(maxRunning, running);
          await tick();
          running -= 1;
        },
        "http://localhost:11434",
      ),
    );
    await Promise.all(jobs);
    expect(maxRunning).toBe(1);
  });

  it("does not let narration overtake chat queued for the same machine while another machine is busy", async () => {
    // Running the free machine's job must not cost the priority rule on the
    // busy one. Scanning for "anything that can start" without remembering what
    // was passed over would let narration jump the chat job ahead of it.
    const q = new ProviderQueue();
    const order: string[] = [];
    const gate = deferred();

    const occupying = q.enqueue(
      "chat",
      async () => {
        await gate.promise;
        order.push("a-occupying");
      },
      "http://a.lan:11434",
    );
    await tick();

    const narrationA = q.enqueue("narration", async () => void order.push("a-narration"), "http://a.lan:11434");
    const chatA = q.enqueue("chat", async () => void order.push("a-chat"), "http://a.lan:11434");
    const narrationB = q.enqueue("narration", async () => void order.push("b-narration"), "http://b.lan:11434");
    await tick();

    // B was free, so its job ran; both A jobs are still queued behind the
    // occupying one.
    expect(order).toEqual(["b-narration"]);

    gate.resolve();
    await Promise.all([occupying, narrationA, chatA, narrationB]);
    expect(order).toEqual(["b-narration", "a-occupying", "a-chat", "a-narration"]);
  });

  it("aborts only the narration on the machine the chat job is going to", async () => {
    const q = new ProviderQueue();
    const gate = deferred();
    let localAborted = false;
    let remoteAborted = false;

    const local = q.enqueue(
      "narration",
      (signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            localAborted = true;
            reject(new Error("aborted"));
          });
        }),
      "http://a.lan:11434",
    );
    const remote = q.enqueue(
      "narration",
      async (signal) => {
        signal.addEventListener("abort", () => (remoteAborted = true));
        await gate.promise;
        return "remote-done";
      },
      "http://b.lan:11434",
    );
    await tick();

    const chat = q.enqueue("chat", async () => "chat-done", "http://a.lan:11434");

    await expect(local).rejects.toThrow("aborted");
    await expect(chat).resolves.toBe("chat-done");
    expect(localAborted).toBe(true);
    expect(remoteAborted).toBe(false);

    gate.resolve();
    await expect(remote).resolves.toBe("remote-done");
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
