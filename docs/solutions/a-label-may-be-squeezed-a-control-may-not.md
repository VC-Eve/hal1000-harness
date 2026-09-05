---
title: A label may be squeezed; a control may not
date: 2026-09-04
category: bug
tags: [css, flexbox, ui, click-targets, measurement, verification, blind-spots]
module: ui/src/styles.css, ui/src/components/PlaylistEditor.tsx, scripts/screenshot.mjs
problem_type: logic_error
symptoms:
  - a new click target renders and cannot be clicked
  - an element measures 0px wide while its text is plainly on screen
  - a row's text has been rendering one character per line for weeks and reads as deliberate wrapping
  - the component test passes because jsdom has no layout
  - the screenshot looks odd rather than broken, so nobody calls it a defect
---

## Context

A track row in the playlist editor is a flex row carrying seven things: the track's name, its tempo,
a tempo field, and four buttons (`set`, `↑`, `↓`, `remove`). Six of those have a fixed or
content-sized width. The name was the only item with `flex: 1 1 auto`, so the name was the item that
absorbed the whole deficit whenever the row was narrower than its contents — and in the live pane the
row is 262px, which it always is.

Adding click-to-play made the name a `<button>` instead of a `<span>`. Everything else about it
stayed: same class, same flex rule, same text.

Measured in the running app, before and after:

| | element | box |
|---|---|---|
| before | `<span class="track-name">` | 22 × 95 px |
| after | `<button class="track-name">` | 0 × 255 px |

The span had been rendering `165-roller.flac` as a vertical column, one character per line, since
long before this change. As a button it collapsed to no width at all: a click target that occupies
zero pixels, on a row whose text is still visibly on screen.

## Guidance

**The flexible item in a row pays for every fixed sibling.** One item with `flex: 1 1 auto` and
`min-width: 0` among six sized ones is not "the item that grows" — it is the item that shrinks, by the
full amount the row is over-subscribed, every time. Each control added to such a row is taken out of
that item's width, and nothing in the stylesheet says so at the point where the seventh control gets
added.

**Promoting a label to a control changes what "too small" means.** A squeezed label is ugly and
still legible if you tilt your head. A squeezed control cannot be operated. The same 22px that had
been tolerated for weeks became, the moment the element gained an `onClick`, a defect — and the box
got smaller rather than staying put, because a different element type resolves a shortfall
differently. The rule is not "buttons shrink more than spans"; it is **re-measure the box when the
element type changes**, because the layout floor is a property of the element, not of the class you
kept.

**jsdom cannot catch this and never will.** The component tests for the new control all passed: they
assert what is sent, what is disabled, and which row carries the playing class, and every one of
those is true of a zero-width button. There is no layout in that environment, so no assertion written
there can fail on a geometry defect. The tests are not wrong — they are simply about a different
question.

**A screenshot shows the symptom and reads as intentional.** A column of single characters looks like
a wrapping rule doing its job in a narrow pane. It is exactly the kind of thing an eye files under
"cramped" rather than "broken", which is how it survived from the feature that introduced the row
until the feature that made the row clickable. What named it was a number:

```js
const box = name.getBoundingClientRect();
const style = getComputedStyle(name);
// widthPx: 0, heightPx: 255, color: "rgb(240, 162, 2)"
```

The same probe answered the other question worth asking of that change — whether the playing row's
colour is the one intended — and `rgb(240, 162, 2)` is evidence in a way a picture of an orange-ish
line is not. Both facts came from one `page.evaluate` against the real app; neither was reachable by
looking.

**The repair is to stop the row competing.** The controls wrap under the name rather than beside it,
so the name has a whole line and there is nothing to shrink it:

```css
.playlist-tracks li {
  flex-wrap: wrap;
}

.playlist-tracks .track-name {
  /* Basis wider than the row, so the controls always wrap beneath. */
  flex: 1 1 100%;
  min-width: 0;
}
```

After it, every name measures 262 × 17 — one full-width line each.

**Where else this shape lives:** any row where a name, a title or a path sits beside a growing set of
per-item controls. The failure arrives when the *n*th control is added, in a change that has nothing
to do with the name, and it is invisible to every test that does not have layout. Before turning a
label into a control, measure the label's box; if it is already smaller than the text it holds, the
row was over-subscribed before you got there and the control will be the thing that shows it.

## Related

- `css-tracks-with-two-sources-of-truth.md` — the other CSS defect this project verified by eye and
  got wrong. Both say the same thing: a stylesheet claim is checked by computing it, not by looking
  at it.
- `a-flag-nothing-reads-looks-shipped.md` — the wire half of this. There the value was produced and
  nothing rendered it; here the element rendered and could not be used. Both pass every test that
  stops short of the user's side of the screen.
- `assert-the-effect-not-the-existence.md` — the control existed, was enabled, and sent the right
  message. Existence was never the question.
