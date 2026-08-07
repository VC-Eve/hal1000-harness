---
title: A flag nothing reads looks shipped from every angle except the user's
date: 2026-08-07
category: pattern
tags: [attribution, ui, requirements, testing, blind-spots, wire-contract]
module: shared/src/types.ts, ui/src/colors.ts, ui/src/components/NarrationPane.tsx
symptoms:
  - a requirement traces to a field that exists, a server that sets it, and a test that passes
  - the user reports the feature missing anyway
  - the missing half is presentation, and nothing asserts presentation
---

# A flag nothing reads looks shipped from every angle except the user's

Vision shipped with this requirement:

> R11. Narration Entries from Vision are attributed to it, distinctly from Session commentary and
> Monitor output.

The wire contract gained `fromVision`. The server set it on every entry. A test asserted it:

```ts
expect(entries[0]!.fromVision).toBe(true);
expect(entries[0]!.adapterId).toBeNull();
expect(entries[0]!.monitorId).toBeNull();
```

Green. Requirement traced. Code review — eleven reviewers, including one whose entire brief was
agent-native parity — did not flag it.

The client never read the field. `entryColor()` branched on `monitorId`, then `adapterId`, then fell
through to HAL's red, which is the colour reserved for HAL speaking about *himself*. So a remark
about the room rendered identically to a status report about HAL's own condition, with no label.
The user asked why it wasn't labelled.

## Why every check passed

Each one was looking at a true thing:

- **The requirement** said "attributed", which sounds satisfied by an attribution field existing.
- **The test** asserted the producer's behaviour — the field is set correctly, which it was.
- **Parity review** asked whether an agent could reach everything a user could. It could; the data
  was on the wire. Parity was genuinely fine. Presentation was not, and that is not parity's job.
- **Typecheck** was silent because the field is optional, and an unread optional field is legal.

The failure sits in the gap between "the data exists" and "something renders it", and nothing in the
pipeline owned that gap.

## The tell

A field on the wire is not a feature. It is half of one, and the half that is easy to test.

Whenever a requirement is about what the user *sees* — attributed, labelled, highlighted,
distinguishable, ordered — the producing side cannot satisfy it. Ask which line of rendering code
consumes the value, and open that file. If the answer is a shrug, the requirement is not done no
matter how green the suite is.

The mirror-image smell: a `?` on a new field is a quiet invitation to never read it. Optional is
right for wire compatibility and wrong as a reason to skip the consumer.

## What actually catches it

A test on the consumer, asserting the observable outcome rather than the input:

```ts
it("never paints a Vision remark as HAL's own voice", () => {
  expect(entryColor(entry({ fromVision: true }), settings())).not.toBe(HAL_RED);
});
```

Note the negative assertion. The positive one — "renders in Vision's colour" — is worth having, but
the bug was specifically *falling through to a colour that means something else*, and only the
negative form states that. A fallback that silently means the wrong thing is the shape worth pinning.

## Related

- `tests-that-lock-in-the-bug.md` — the adjacent failure, where a test exists and certifies the
  wrong behaviour. Here the test was correct and simply covered the wrong side of the boundary.
