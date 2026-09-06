---
title: Typed test fixtures cannot express what a lenient loader admits
date: 2026-09-05
category: bug
tags: [testing, type-safety, hand-edited, lenient-load, crash, error-boundary, blind-spots]
module: ui/src/components/OverlayEditor.tsx, ui/test/components/OverlayEditor.test.tsx, shared/src/overlays.ts
problem_type: runtime_error
component: frontend_stimulus
severity: high
symptoms:
  - a hand-edited field of the wrong type takes the whole page down to its error boundary
  - the crash is a .trim() or .map() on a value the type swore was a string
  - every fixture is built by the same typed helpers, so none of them can produce the bad shape
  - the loader accepted the file as valid; only the component drawing it later threw
  - coverage is complete by its own fixtures' lights and the input class that matters is untested
---

## Context

A World manifest is hand-editable, and the overlay guards in `shared/src/overlays.ts` are written to
be lenient about it — `overlayEntries` keeps a stored list whole even when one entry in it is
unusable, because refusing the list would lose the good slots along with the bad one. So the editor
renders from `slotsOf(world)`, which is the *raw* stored list. A manifest holding
`{ kind: "image", position: "top-right", image: 3, size: 6 }` is a legal file on disk and an illegal
`ImageSlot` by the TypeScript type, and it reaches the component exactly as saved.

The editor read that field directly:

```tsx
const unfilled = isImageSlot(slot) && (slot.image ?? "").trim().length === 0;
```

`3 ?? ""` is `3`, and `3.trim` is not a function. The throw was not caught locally, so one bad row in
one editor took `/live`'s whole main view down to its error boundary.

No test could have caught it. Every fixture in `ui/test/components/OverlayEditor.test.tsx` came from
the `text()` and `image()` helpers, whose parameter type is `Partial<TextSlot>` / `Partial<ImageSlot>`
— so the type system guarantees the fixture is well-formed, which is precisely the population the bug
does not live in. A code review found this, not the suite.

## Guidance

**Read through the cleaned value, not the raw one**, wherever a leniently-loaded store feeds a
component. The fix routes every field access in the row through the guard:

```tsx
// The *cleaned* slot, not the raw one. A manifest is hand-editable, so
// `slot.image` can be a number, and `(slot.image ?? "").trim()` on one
// throws — taking /live's whole main view down to the error boundary
// because one row of one editor read a field it had not checked.
const cleaned = cleanSlot(slot);
const broken = cleaned === null;
const unfilled = cleaned !== null && isImageSlot(cleaned) && cleaned.image === undefined;
```

`cleaned` is either `null` — rendered as the damage warning — or a value the guard has vouched for.
Nothing downstream has to defend against a wrong-typed field again.

**At least one test must bypass the type system to build its fixture**, because a fixture built the
normal way cannot represent the case that matters:

```ts
const hostile = [
  { kind: "image", position: "top-right", image: 3, size: 6 },
  { kind: "image", position: "top-left", image: null, size: 6 },
  { kind: "image", position: "bottom-left", image: { path: "x.png" }, size: 6 },
] as unknown as OverlaySlot[];

expect(() => editor(hostile)).not.toThrow();
```

The `as unknown as` is not a shortcut around the type. It is the only way to write down what a hand
edit can produce, which the type says cannot happen.

## Why This Matters

A lenient loader and a strict type describing its output are in tension by design. The type documents
the shape the rest of the codebase may rely on; the loader exists because reality does not always
arrive in that shape. Every fixture built through typed constructors inherits the type's promise, and
therefore can never generate the input the loader was written to survive.

That is a structural blind spot, not a coverage gap. No percentage would show it: the suite is green
and, by its own fixtures' lights, complete. The one input class the leniency exists for is the one
class no fixture can express.

The tell is a type assertion standing in for a check. Wherever a value's type is *asserted* at the
boundary rather than *verified*, the tests downstream of that boundary are all testing the assertion.

## When to Apply

- A component reads a value loaded leniently — a hand-editable file, an older schema version, an
  external response — and typed strictly downstream.
- Every existing test for it is built through typed constructors or fixture helpers.
- A `.trim()`, `.map()`, `.length` or similar sits on a field whose type was asserted, not checked.

## Examples

**Before.** The editor reads `slot.image`, typed `string | undefined`, straight from the stored list.
A manifest hand-edited to `"image": 3` reaches it unchanged and `(slot.image ?? "").trim()` throws,
uncaught. `/live`'s main view falls to its error boundary; the overlay editor is one panel on that
page, and all of it goes.

**After.** Every read in the row goes through `cleanSlot(slot)`. `cleanImageSlot` passes the field
through `cleanText(raw.image, IMAGE_NAME_MAX)`, which answers `undefined` for a non-string, so `3`
becomes "no image chosen" rather than a thrown error. Reverting that one line makes the new test go
red with `TypeError: (slot.image ?? "").trim is not a function` — the crash, reproduced on demand.

## Related

- `docs/solutions/a-lenient-load-and-a-strict-write-need-a-filter-between-them.md` — the same
  lenient-load boundary, one layer up, where the tension is between the load and the write rather
  than between the load and the type.
- `docs/solutions/tests-that-lock-in-the-bug.md` — the inverse shape. There, a fixture fabricates a
  state production can never produce; here, a fixture cannot express a state production does produce.
