---
title: Rebuilding a cache field by field turns a read into a delete
date: 2026-08-11
category: bug
tags: [caching, persistence, data-loss, optional-fields, invariants, blind-spots, verification]
module: server/src/vision/candidates.ts, server/src/storage
problem_type: data_integrity
symptoms:
  - a counter or field resets to zero after a restart, or after one more ordinary write
  - a value is on disk, is read, and is absent from the object the reader hands back
  - the field was added recently and every other part of the feature works
  - the type is optional, so nothing fails to compile and no guard fires
  - a test that writes and reads back in one process passes
---

## Context

`CandidateStore` holds a JSON index on disk and caches it in memory. Every mutation is
load-modify-write, so the read path and the write path share one object:

```ts
private async load(): Promise<CandidateFile> {
  if (this.cache) return this.cache;
  const stored = await readJson<CandidateFile>(this.file).catch(() => null);
  ...
  this.cache = {
    candidates: stored?.candidates ?? [],
    overflow: stored?.overflow ?? { ...EMPTY_OVERFLOW },
  };
  return this.cache;
}

private async persist(state: CandidateFile): Promise<void> {
  this.cache = state;
  await writeJsonAtomic(this.file, state);
}
```

Read it twice. `load()` builds the cache by **naming** the fields it wants, and `persist()` writes
**the cache** back to the file. The persisted shape had since gained two keys — `setAsideOverflow` and
`shelfMatches`, two counters added by a later feature. Neither was named in that object literal.

So the sequence is:

1. The file on disk holds all four keys. Both new counters are non-zero.
2. Something calls `load()`. The cache now holds two keys. The counters are gone from memory.
3. Anything at all mutates the store — one arriving face is enough — and `persist()` writes the cache.
4. The file now holds two keys. The counters are gone from disk, permanently.

**A read became a delete on the next write.** Nothing threw. Nothing logged. The two counters simply
read as zero afterwards, which is indistinguishable from "nothing has happened yet" — and one of them
existed precisely to report faces the user was never shown, so the failure mode was a tally of
withheld information quietly reporting that nothing had been withheld.

The type system had nothing to say, and that is the crux: both new keys were declared optional
(`setAsideOverflow?: CandidateOverflow`) because they legitimately don't exist in files written before
the feature. An object literal omitting an optional field is a valid `CandidateFile`. Optional was the
right call for reading old files and exactly what made this legal.

## How it was found, which is the uncomfortable part

Not by a test. Not by the review that came later. It surfaced while seeding a screenshot scene: writing
a `vision-candidates.json` by hand, booting HAL against it, and looking at the pane. That is the only
path in the project that reads those numbers back the way the real store does — every test either wrote
and read within one process (so the cache never reloaded) or used the in-memory fake (which has no
`load()` at all).

The store's own suite had 44 passing cases at the time, including one named "carries the tally across a
restart". It covered `overflow`, the counter that predated the bug. Nobody wrote the same case for the
two new ones, and the shape of the defect is that the covered field is fine.

## What to do

**If a cache is what gets persisted, the read path is a write path — review it as one.**

Concretely, when rebuilding a persisted object:

- **Spread the validated value first, then re-add only the fields that need defaults or coercion.** The
  default becomes "keep what the file had"; the exception list is the fields you deliberately touch.
- **Do not fix it by adding the missing names.** See below — that was the first attempt, and it left the
  next key to be added carrying the same defect.
- **Assume every branch that assigns the cache has the bug.** A corruption fallback, an empty-file path,
  a migration branch: each one is a separate object literal, and each one drops whatever it forgot.

The test has to cross a process boundary *and* keep writing:

```ts
// Read it back in a NEW store — the cache is what hides this in a single process.
const reopened = new CandidateStore(dir);
await reopened.list();
expect(reopened.setAsideOverflow().dropped).toBe(1);

// Then write again and read AGAIN. The first half catches a lossy read; only the
// second half catches the delete, which is the part that is permanent.
await reopened.offer(vec(160), CROP, 10);
const again = new CandidateStore(dir);
await again.list();
expect(again.setAsideOverflow().dropped).toBe(1);
```

Reverting the fix reddens both assertions. Without the second write, a lossy read looks like a display
bug you could ship.

## Why This Matters

The cost here was a privacy-facing counter. HAL keeps a bounded pool of unnamed faces, and
`shelfMatches` records how often an arriving face was taken for one already on that shelf — the only
trace of a person the machine saw and never mentioned. `setAsideOverflow` records faces the user
deliberately kept and the bound then dropped. Both are the kind of number a user checks rarely and
trusts absolutely. Silently resetting them to zero is worse than never having had them: it converts
"we do not know" into a confident, false "nothing was lost".

The general form is worse than the instance. This shape is invisible to every signal a project
normally relies on:

- **The compiler** is satisfied, because the dropped fields are optional.
- **The corruption guard** is satisfied — it validated that `candidates` is an array, which was true.
- **The type** is accurate. `CandidateFile` correctly describes what the file may contain; the literal
  just builds less than that.
- **Same-process tests** pass, because the cache they read is the cache they wrote.
- **The feature works.** Setting a face aside, evicting, counting, broadcasting, rendering — all
  correct. Only the round trip through disk loses anything.

## When to Apply

Suspect this whenever a persisted shape grows a field, and especially when:

- the class holds a `private cache` and writes that same object back
- the new field is **optional**, which it usually is, because that is how you stay compatible with
  files written before the feature
- the rebuild is an object literal naming fields rather than a spread, `structuredClone`, or a parse
  through a schema that owns every key
- there is more than one assignment to the cache — the fallback branches are where the second instance
  lives

The diagnostic on behaviour alone: **a value that resets to zero rather than to a wrong number.** A
corrupted count is arithmetic gone wrong somewhere; a count that is exactly the empty value, for one
field while its neighbours are intact, is a field that was never read.

## It happened again, in the same function

The first fix added the two missing names:

```ts
this.cache = {
  candidates: stored?.candidates ?? [],
  overflow: stored?.overflow ?? { ...EMPTY_OVERFLOW },
  ...(stored?.setAsideOverflow ? { setAsideOverflow: stored.setAsideOverflow } : {}),
  ...(stored?.shelfMatches ? { shelfMatches: stored.shelfMatches } : {}),
};
```

That is green, it has a regression test, and it is still the defect. It fixed two instances of a shape
and left the shape in place: the fifth key anyone adds to this file will be dropped the same way, by
the same line, for the same reason. A code review five commits later found the *other* branch of the
same function untouched —

```ts
this.cache = { candidates: [], overflow: { ...EMPTY_OVERFLOW } };   // the corruption fallback
```

— harmless only by luck, because the accessors happen to fall back to empty tallies when the key is
missing. The real fix stops naming fields at all:

```ts
this.cache = {
  ...(stored ?? {}),
  candidates: stored?.candidates ?? [],
  overflow: tally(stored?.overflow, EMPTY_OVERFLOW, "dropped", this.file),
  setAsideOverflow: tally(stored?.setAsideOverflow, EMPTY_OVERFLOW, "dropped", this.file),
  shelfMatches: tally(stored?.shelfMatches, EMPTY_MATCHES, "matched", this.file),
};
```

Spread first; the named lines are now only the fields that need a default or a shape check, and a new
key survives without anybody remembering it. The corruption branch spreads a shared `EMPTY_TALLIES`
constant, so the two paths cannot disagree about what an empty store looks like.

The second finding also exposed a related claim that had gone stale. The plan for this feature argued
*for* keeping both pools in one collection partly because "the corruption guard covers one key" — and
then added two more keys to that same file without extending the guard. A damaged tally would have
sailed past it and thrown later, deeper, in a caller that has no idea the file exists. The guard now
checks the shape of all three counters, not just the presence of the array.

## Related

- `editing-state-a-running-process-caches-loses-the-edit.md` — the operational cousin, and it named
  this exact class as a risk: "any store with `private cache` has this property, and none of them will
  tell you." That doc's mechanism is a second writer racing the cache; this one needs no second writer
  at all. The shared fact is the one worth remembering — the cache is what `persist` writes back, so
  anything wrong with the cache becomes wrong with the file.
- `a-value-frozen-for-one-caller-is-stale-for-the-next.md` — same family, a held value diverging from
  the truth, by a third route. Also the same lesson about hand-built shapes: it ends with a
  hand-copied type letting drift hide, and this is a hand-built literal doing it.
- `a-fix-teaches-a-pattern-go-looking-for-it.md` — the "it happened again" section above is a textbook
  instance. The first fix treated the bug as two missing names instead of a pattern, and the pattern
  was sitting eight lines up in the same function.
- `a-completeness-guard-is-only-as-honest-as-its-exemptions.md` — the corruption guard here is exactly
  that: a check that validated one key, was cited as coverage for the design, and had two unguarded
  keys grow beside it.
- `a-flag-nothing-reads-looks-shipped.md` — the mirror image. There, a field was written and never
  read; here, a field was read and thrown away. Both look shipped from every angle except the disk's.
