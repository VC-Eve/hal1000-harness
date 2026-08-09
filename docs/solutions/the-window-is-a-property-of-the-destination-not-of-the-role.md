---
title: The window is a property of the destination, not of the role
date: 2026-08-09
category: bug
tags: [ollama, num-ctx, caching, singleton-split, performance, constants, verification]
module: server/src/providers/resolve.ts, server/src/providers/windows.ts, server/src/narration/coalescer.ts
problem_type: performance_issue
symptoms:
  - a local model reloads between requests even though the model never changed
  - "`load_duration` is milliseconds on one request and seconds on the next, alternating"
  - two roles send to one endpoint with two different values for the same request field
  - a constant named like a budget is only ever passed to the server, never spent against
---

## Context

Ollama takes a context window per request as `options.num_ctx`. It looks like a per-request field.
It is not: Ollama sizes the KV cache when the *runner* starts, so a request naming a different
window cannot be served by the runner already holding the weights. It tears that runner down and
builds a new one, re-reading identical weights off disk.

Measured on a 4B Q4 model, same model throughout:

```
num_ctx=8192   load_ms   192   <-- warm
num_ctx=4096   load_ms  3159   <-- reload
num_ctx=8192   load_ms  3154   <-- reload
num_ctx=8192   load_ms   194   <-- warm
```

It does not reuse a larger runner for a smaller request either. The value has to match **exactly**,
not merely fit.

HAL sent `chatContextCap` (8192) from chat and `NARRATION_NUM_CTX` (4096) from narration, monitors
and Vision. The default install points both backends at one Ollama with one model — so every
alternation between a chat turn and a narration paid 3.2 seconds. With Vision on a 30s detection
cadence, that landed in front of most chat turns the user typed.

## The constant that was not a budget

`NARRATION_NUM_CTX = 4096` sits in `narration/coalescer.ts` beside `EVENT_BUDGET_CHARS = 6000`, and
reads as its companion. It is not. Grep every use:

```
narration/narrator.ts:493   options: { num_ctx: NARRATION_NUM_CTX }
monitors/narrator.ts:220    options: { num_ctx: NARRATION_NUM_CTX }
vision/service.ts:1174      options: { num_ctx: NARRATION_NUM_CTX }
```

Three sites, all the same: passed straight to the server. Nothing budgets against it. The prompt is
built against `EVENT_BUDGET_CHARS`. So narration asking for 4096 rather than 8192 changed **not one
byte** of what narration sent — it was a declared ceiling and nothing else, and its entire observable
effect was the reload.

A constant that is only ever handed to an external system is a wire value, not a policy. Naming and
placing it as though it were policy is what kept it looking deliberate.

## The fix

The window is derived from `(endpoint, model)`, not from the role:

```ts
export function contextCapFor(endpoint: string, model: string, settings: Settings, ownCap: number): number {
  const observationModel = settings.narrationModel ?? settings.chatModel;
  const targets = [
    { endpoint: endpointForRole("chat", settings), model: settings.chatModel, cap: settings.chatContextCap },
    { endpoint: endpointForRole("narration", settings), model: observationModel, cap: NARRATION_NUM_CTX },
    // …monitor, vision
  ];
  let cap = ownCap;
  for (const target of targets) {
    if (target.model === model && sameHost(target.endpoint, endpoint)) cap = Math.max(cap, target.cap);
  }
  return cap;
}
```

Three things in that are load-bearing:

**`sameHost`, not `sameDestination`.** Two slots on one box with two credentials are still one
process holding one runner — the same asymmetry `queue.ts` draws for contention.

**`ownCap`, always included.** A conversation may run a model that is not `chatModel`; its request
still has to carry chat's cap.

**Not one global value.** Roles split across two machines have two runners and nothing to share.
Collapsing them would make the laptop allocate a KV cache sized for the desktop's model — which is
the offload scenario the two backend slots exist for.

Then `numCtxFor` clamps the shared cap to what the model can actually hold. That clamp is what makes
the sharing hold for *every* model rather than for large ones only: without it chat sends
`min(window, 8192)` and narration sends `8192`, which are equal right up until someone loads a 4k
model, and then it thrashes again with no code change to blame. Local models here span 2k to 262k, so
"works if your model is big enough" is not a fix.

Model windows moved out of `ChatService` into `providers/windows.ts`, module-level like
`detect.ts`. Four roles now need the same number, and two caches would be two answers. Applying
settings drops them, exactly as it already drops protocols and for the same swap: `llama-server`
replacing Ollama on a port fixes `n_ctx` at launch, so a window cached from the previous occupant
would size the next request against a number nobody is serving.

## Verification that actually bites

Unit tests cover shared, split-by-machine, split-by-model, and the reversed case where the user's
chat cap is the *smaller* one — the max runs both ways or the reload comes back with the roles
swapped.

The claim itself is about bytes on the wire, so it was verified there: a logging proxy in front of
Ollama, with both backends pointed at it, capturing what each role actually sends.

```
POST-FIX   21:31:01  num_ctx=8192    (chat)
           21:31:08  num_ctx=8192    (narration)
           …six requests, all 8192

PRE-FIX    21:33:02  num_ctx=4096    (narration)
           21:33:09  num_ctx=8192    (chat)       <-- reload
           21:33:25  num_ctx=4096                 <-- reload
           21:33:39  num_ctx=8192                 <-- reload
```

Same scenario, same models, the fix stashed in between. A green test suite would have shown none of
this — the values were always internally consistent.

## What to do

- **Check whether a "per-request" field is actually load-time.** `num_ctx` is the example here;
  anything that sizes an allocation on the server side is a candidate. The test is cheap: send the
  same request twice with the field changed and watch `load_duration`.
- **When two roles share a destination, they share its wire values.** Fill budgets stay per-role —
  those are HAL's own policy. Only the allocation the server makes has to agree.
- **Grep a constant's uses before trusting its name.** One that is only ever passed outward is a wire
  value; if it never appears in an arithmetic or a comparison, it is not a budget however it is
  placed.

## Related

- [splitting-a-singleton-leaves-every-lookup-keyed-to-the-old-one](splitting-a-singleton-leaves-every-lookup-keyed-to-the-old-one.md)
  — the parent shape. Its first instance was this very window cache keyed by model name; this is the
  same value keyed by *role* instead of by destination.
- [a-lane-is-a-property-of-the-machine-not-of-the-app](a-lane-is-a-property-of-the-machine-not-of-the-app.md)
  — found in the same sweep: the scheduler making the same role-versus-destination mistake.
- [editing-state-a-running-process-caches-loses-the-edit](editing-state-a-running-process-caches-loses-the-edit.md)
  — why applying settings drops the window cache rather than trusting the endpoint to have changed.
- [a-value-frozen-for-one-caller-is-stale-for-the-next](a-value-frozen-for-one-caller-is-stale-for-the-next.md)
  — the caching half of the same family.
