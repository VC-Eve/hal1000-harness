// Single-lane scheduler for the shared model server (R16).
//
// Rules:
// - One job runs at a time — a local server serializes generations per model
//   anyway, and serializing here keeps VRAM behavior predictable.
// - Chat preempts narration **on the same backend**: an arriving chat job
//   aborts an in-flight narration job (its AbortSignal fires; the caller
//   re-queues its work) and always runs before queued narration.
// - In-flight chat jobs are never aborted by scheduling.
//
// The backend qualifier is the whole reason preemption is not unconditional.
// Chat Preemption exists because one machine runs one model at a time and a
// person waiting on a reply must not queue behind commentary. When chat is
// pointed at a different backend from narration, that premise is simply false:
// aborting narration buys the chat request nothing and destroys work that had
// to be re-queued and re-run.

import { sameHost } from "./provider.js";

export type JobClass = "chat" | "narration";

interface Job {
  clazz: JobClass;
  ctrl: AbortController;
  // Where this job is going, when the caller knows. Absent means unknown, and
  // unknown contends — see `contends`.
  endpoint?: string;
  start: () => void;
}

/**
 * Whether two jobs are competing for the same machine's model.
 *
 * An unknown endpoint contends with everything. That keeps the pre-existing
 * behaviour for any caller that has not been taught to say where it is going,
 * and it is the safe direction to be wrong in: preempting unnecessarily costs a
 * re-queued narration batch, while failing to preempt when they really do
 * contend puts a waiting person behind commentary — the exact thing this queue
 * was built to prevent.
 *
 * `sameHost` and not `sameDestination`, on purpose. Readiness and `list-models`
 * compare whole backends because they ask whether an *answer* transfers; this
 * asks which *machine* is busy, and two slots on one box with two keys are
 * still one GPU serving one model at a time. A test names this so the asymmetry
 * reads as a decision rather than as a place somebody forgot to update.
 */
function contends(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return true;
  return sameHost(a, b);
}

export class ProviderQueue {
  private readonly chatQ: Job[] = [];
  private readonly narrationQ: Job[] = [];
  private current: Job | null = null;

  enqueue<T>(clazz: JobClass, run: (signal: AbortSignal) => Promise<T>, endpoint?: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const ctrl = new AbortController();
      const job: Job = {
        clazz,
        ctrl,
        ...(endpoint === undefined ? {} : { endpoint }),
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
      if (
        clazz === "chat" &&
        this.current?.clazz === "narration" &&
        contends(job.endpoint, this.current.endpoint)
      ) {
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
