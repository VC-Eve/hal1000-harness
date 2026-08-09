---
title: A lane is a property of the machine, not of the app
date: 2026-08-09
category: bug
tags: [scheduling, concurrency, backends, singleton-split, queue, verification]
module: server/src/providers/queue.ts
problem_type: logic_error
symptoms:
  - two backends are configured on two machines and only one is ever busy
  - a job waits for an unrelated job that cannot possibly be competing with it
  - the helper that decides whether two things compete exists, and is correct, and is called from one place
  - a comment justifies a global rule with an argument about a single machine
---

## Context

`ProviderQueue` is HAL's scheduler for the four inference roles. It has two rules: one job at a
time, and chat preempts narration.

When the single provider endpoint became two named backends, the preemption rule was correctly
narrowed. A `contends(a, b)` helper was added, `sameHost`-based, with a comment explaining exactly
why aborting narration for a chat job on a *different* backend buys nothing and destroys work. A
test pins it. That work was done well.

The serialization rule was not touched.

```ts
private pump(): void {
  if (this.current) return;                                   // <-- "the" current job
  const job = this.chatQ.shift() ?? this.narrationQ.shift();
  if (!job) return;
  this.current = job;
  job.start();
}
```

`contends` is not called here. So with chat offloaded to a desktop and observation left on the
laptop, the laptop sat idle through every chat reply — two machines, two VRAM pools, one job.

That is the whole benefit of having two backend slots, handed straight back.

## The shape

This is [splitting-a-singleton-leaves-every-lookup-keyed-to-the-old-one](splitting-a-singleton-leaves-every-lookup-keyed-to-the-old-one.md)
again, but with a twist that makes it harder to see: **the distinction had already been drawn. It
was wired to one of the two decisions it governs.**

A missing distinction is findable — you grep for the concept and find nothing. A half-wired one is
not, because the helper's existence reads as coverage. `contends` was right there in the file,
documented, tested. Anyone auditing "does this queue understand multiple backends?" would find it
and stop.

The tell is in the prose. The header comment justified the single lane like this:

> One job runs at a time — a local server serializes generations per model anyway, and serializing
> here keeps VRAM behavior predictable.

Every clause of that is an argument about **one machine**. It was written when there was one, it
stayed true-sounding after there were two, and nothing in it is false — it simply stopped being an
argument for the rule it was attached to.

## The fix

`current` becomes `running: Job[]`, and the eligibility question moves into the scan:

```ts
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
```

`blocked` is the part that is easy to omit and expensive to get wrong. Scanning for "anything that
can start" without remembering what was passed over lets narration overtake the chat job queued
ahead of it on the *same* machine, the moment a *different* machine happens to be busy. Priority is
per-machine too.

An unstated endpoint blocks everything behind it, which keeps `contends`'s existing safe direction:
unknown competes with everything.

## Verification that actually bites

Four tests were added; two of them fail against the old scheduler, and that was checked by stashing
the fix and watching them go red — the step that separates a plausible test from evidence.

Live, on one box with two real servers (Ollama on 11434 for chat, `llama-server` on 8099 for
observation), the inference log shows what unit tests cannot:

```
21:19:30.214 + 16780ms  chat     http://localhost:11434
21:19:32.082 + 11628ms  session  http://127.0.0.1:8099
=> overlapping by 14912ms
```

Before the fix the second call would have waited out the first. Two endpoints on one machine is
enough to prove it; a second machine is not needed.

## What to do

Add a fourth item to the singleton-split inventory:

4. **Every mutual-exclusion rule.** A lane, a lock, a semaphore, an "only one at a time" — is it
   guarding *the* resource, or *a* resource? Anything phrased "one at a time" is a claim about
   something countable, and after a split there is more than one of it.

And a general rule about half-wired distinctions: when you introduce a helper that answers *which
instance*, grep for every decision that should have been asking. The helper is not the fix; calling
it everywhere is. Leaving one caller behind is worse than never writing it, because the next reader
finds the helper and concludes the question was already settled.

## Related

- [splitting-a-singleton-leaves-every-lookup-keyed-to-the-old-one](splitting-a-singleton-leaves-every-lookup-keyed-to-the-old-one.md)
  — the parent shape, and the inventory this adds an item to.
- [the-window-is-a-property-of-the-destination-not-of-the-role](the-window-is-a-property-of-the-destination-not-of-the-role.md)
  — found in the same sweep, same repo, same week: another value keyed by who was asking instead of
  by where it was going.
- [a-flag-nothing-reads-looks-shipped](a-flag-nothing-reads-looks-shipped.md) — the adjacent failure:
  there a value was carried and never read; here a helper was written and half-called.
