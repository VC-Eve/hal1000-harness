// Single-lane scheduler for the shared Ollama instance (R16).
//
// Rules:
// - One job runs at a time — Ollama serializes generations per model anyway,
//   and serializing here keeps VRAM behavior predictable.
// - Chat preempts narration: an arriving chat job aborts an in-flight
//   narration job (its AbortSignal fires; the caller re-queues its work) and
//   always runs before queued narration.
// - In-flight chat jobs are never aborted by scheduling.

export type JobClass = "chat" | "narration";

interface Job {
  clazz: JobClass;
  ctrl: AbortController;
  start: () => void;
}

export class ProviderQueue {
  private readonly chatQ: Job[] = [];
  private readonly narrationQ: Job[] = [];
  private current: Job | null = null;

  enqueue<T>(clazz: JobClass, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const ctrl = new AbortController();
      const job: Job = {
        clazz,
        ctrl,
        start: () => {
          run(ctrl.signal)
            .then(resolve, reject)
            .finally(() => {
              this.current = null;
              this.pump();
            });
        },
      };
      (clazz === "chat" ? this.chatQ : this.narrationQ).push(job);
      if (clazz === "chat" && this.current?.clazz === "narration") {
        this.current.ctrl.abort();
      }
      this.pump();
    });
  }

  private pump(): void {
    if (this.current) return;
    const job = this.chatQ.shift() ?? this.narrationQ.shift();
    if (!job) return;
    this.current = job;
    job.start();
  }
}
