// One-lane-per-machine scheduler for the model servers (R16).
//
// Rules:
// - One job runs at a time **per machine** — a local server serializes
//   generations per model anyway, and serializing here keeps VRAM behavior
//   predictable. Two backends on two machines are two VRAM pools, so they run
//   at once.
// - Chat preempts narration **on the same backend**: an arriving chat job
//   aborts an in-flight narration job (its AbortSignal fires; the caller
//   re-queues its work) and always runs before queued narration.
// - In-flight chat jobs are never aborted by scheduling.
//
// The backend qualifier is the whole reason neither preemption nor
// serialization is unconditional. Both exist because one machine runs one model
// at a time and a person waiting on a reply must not queue behind commentary.
// When chat is pointed at a different backend from narration, that premise is
// simply false: aborting narration buys the chat request nothing and destroys
// work that had to be re-queued and re-run, and holding the chat job until
// narration finishes idles the very machine the user offloaded it to. Splitting
// roles across machines so a laptop can carry part of the work is the point of
// the two backend slots; a scheduler that serializes globally hands back the
// whole benefit.

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
  // Every job currently in flight. A list rather than a single slot because
  // "busy" is a property of a machine, not of the app: with chat offloaded and
  // observation local, two jobs are running and neither is waiting.
  private readonly running: Job[] = [];

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
              const at = this.running.indexOf(job);
              if (at >= 0) this.running.splice(at, 1);
              this.pump();
            });
        },
      };
      (clazz === "chat" ? this.chatQ : this.narrationQ).push(job);
      // Every contending narration, not just the one that happened to be in
      // `current`. With several machines in flight there is no single "the"
      // in-flight job, and the one this chat job is queued behind may not be
      // the first in the list.
      if (clazz === "chat") {
        for (const inFlight of this.running) {
          if (inFlight.clazz === "narration" && contends(job.endpoint, inFlight.endpoint)) {
            inFlight.ctrl.abort();
          }
        }
      }
      this.pump();
    });
  }

  private pump(): void {
    // Start every job that can start. One pass would leave the second idle
    // machine's job queued until something else happened to call back in.
    for (;;) {
      const job = this.claimEligible();
      if (!job) return;
      this.running.push(job);
      // May run to completion synchronously, which removes it from `running`
      // and re-enters `pump`. Safe: `claimEligible` removed it from its queue
      // before handing it over, so no job is ever started twice.
      job.start();
    }
  }

  /**
   * The next job whose machine is free, removed from its queue.
   *
   * Chat is scanned before narration so the priority rule survives: a waiting
   * person still goes first on the machine they are waiting on. `blocked`
   * carries the endpoints of jobs passed over, so a job cannot jump the one
   * ahead of it on its own machine — without it, narration queued behind chat
   * for one backend would overtake it the moment a *different* backend was
   * busy. An unstated endpoint blocks everything behind it, which is the same
   * safe direction `contends` already chooses.
   */
  private claimEligible(): Job | null {
    const blocked: (string | undefined)[] = [];
    for (const queue of [this.chatQ, this.narrationQ]) {
      for (let i = 0; i < queue.length; i += 1) {
        const job = queue[i]!;
        const busy = this.running.some((inFlight) => contends(job.endpoint, inFlight.endpoint));
        if (busy || blocked.some((endpoint) => contends(job.endpoint, endpoint))) {
          blocked.push(job.endpoint);
          continue;
        }
        queue.splice(i, 1);
        return job;
      }
    }
    return null;
  }
}
