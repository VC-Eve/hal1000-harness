---
category: process
module: shared/src/phrases.ts, shared/src/templates.ts, AGENTS.md
tags: [completeness, catalogue, audit, prompts, guide-drift]
symptoms:
  - a guide claims every X is covered and one X is not
  - a catalogue grew by addition and nobody checked what was never in it
  - the gap is found by a user asking "why can I not do this here?"
---

# Extending a catalogue is not auditing it

Adding entries to a catalogue tells you nothing about what was never in it. The
work of extending pulls attention toward the entries that exist; the missing one
is invisible precisely because nothing points at it.

Measured here on 2026-08-10. The template feature added a universal slot tier,
decomposed a context slot into eleven readings, and converted six prompts — a
great deal of catalogue work. Throughout, the Vision cycle's caption line was
assembled in code:

```js
return `${unique.length ? `[${unique.join(" and ")}] ` : ""}${o.caption}`;
```

Three pieces of human-chosen wording — `[`, `] `, and ` and ` — reaching a model
with no editor, while every sibling line (`session.remark_line`,
`monitor.remark_line`, `sight.face_line`, `sight.last_look`) had a Phrase. The
asymmetry had been there since phrases shipped. Nobody looked, because everybody
was busy adding.

`AGENTS.md` meanwhile asserted "there is no human-chosen wording left reaching a
model without an editor". A sentence, not a test. It was false and had been for
some time, and it was found by a user asking why they could not use a slot in a
prompt — not by any of the reviews, the tests, or the two authors of the guide.

## The rules

**A completeness claim in a guide needs a test, not a sentence.** "Every X has a
Y" is an assertion the code can make about itself: enumerate the Xs, assert each
has a Y. Written as prose it degrades silently the first time someone adds an X.

**Audit by enumerating the domain, not the catalogue.** Ask "what are all the
things that reach a model?" and check each against the catalogue. Asking "is
every catalogue entry correct?" cannot find an absence.

**When you extend a catalogue, grep for the shape it covers.** One pass over the
message-building paths for string construction — template literals, `join`,
bracket wrappers — costs a minute and is the only thing that finds a sibling
that never got one.

**Distinguish wording from formatting, and write the line down.** A date
rendered `Sunday 9 August 2026` and a duration rendered `10 minutes` are value
formats; `[Creator 74%] …` is a sentence fragment somebody chose. If the
boundary is not recorded, every audit re-litigates it and each one draws it
somewhere new.
