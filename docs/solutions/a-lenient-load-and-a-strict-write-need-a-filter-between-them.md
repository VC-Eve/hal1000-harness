---
title: A lenient load and a strict write need a filter between them
date: 2026-09-05
last_updated: 2026-09-05
category: pattern
tags: [validation, editors, persisted-data, hand-edited, whole-list, races, blind-spots, review]
module: ui/src/components/OverlayEditor.tsx, shared/src/overlays.ts, server/src/storage/worlds.ts
problem_type: logic_error
component: frontend_stimulus
severity: high
symptoms:
  - every edit to a list is refused, and the control that made the edit shows nothing
  - the refusal names a value the operator never typed, in a row they did not touch
  - a second edit made before the first is answered silently undoes the first
  - the store, the wire and the editor each do the right thing alone, and the three together jam
  - clicking "add" makes the new row disappear instead of appearing
  - an unrelated hand-edited row makes an operation fail and blames the operation
---

## Context

The World manifest is hand-editable, so the overlay slot list is loaded *leniently*: a slot with
`size: 30` is kept whole rather than dropped, because dropping it at load would have the next node
drag write the World without its slots (the shape
`docs/solutions/rebuilding-a-cache-field-by-field-turns-a-read-into-a-delete.md` records). The
wire is *strict*: `set-world-overlays` sends the whole next list, and the server refuses a list
with one unusable slot rather than writing part of it — the client is describing what it thinks
the World holds, and a partial write would leave the two disagreeing.

Both rules are right. Together they jammed the editor: it built every edit from the list it had
been given, the list carried the bad slot, and every edit to a *good* slot was refused. The
refusal was answered on `world-result`, which the editor did not render, so the operator saw a
select box that changed and changed back.

The code review found it; the unit tests had not. The tests fed the editor lists the strict guard
accepted, because that is what the editor's own tests naturally construct.

## Guidance

When the same list is read leniently and written strictly, the editor sits between the two and
has to reconcile them itself:

1. **Filter on write, not on load.** The store keeps what the author wrote; the editor drops what
   the wire would refuse, at the moment it sends, and says so on the row:

   ```tsx
   const write = (next: readonly OverlaySlot[]) => {
     latest.current = next;
     const usable = next.filter((slot) => cleanSlot(slot) !== null);
     send({ type: "set-world-overlays", worldId: world.id, overlays: [...usable] });
   };
   ```

   The unusable entry was already skipped where it is drawn, so dropping it on the next authored
   edit loses nothing the output showed. The row carries a warning that says it will be dropped.

2. **Build each edit on the last list sent, not the last one received.** A blur that commits a
   text and the click that caused the blur both land before the broadcast. Computed from the
   received list, the second silently drops the first:

   ```tsx
   const latest = useRef<readonly OverlaySlot[] | null>(null);
   useEffect(() => { latest.current = null; }, [world.overlays]);   // the broadcast landed
   const current = () => latest.current ?? slots;
   ```

   Every edit maps over `current()`. The remembered list is the *unfiltered* one, so the indices
   the rows on screen still carry keep meaning the same slots until the broadcast arrives.

3. **Render the refusal.** A whole-list write can be refused for a reason the operator cannot see
   in the row they touched. The result channel already carries it; the editor has to show it.

4. **A row that is not filled in yet must be *valid and empty*, not refused.** This one arrived a
   day later, adding a second kind of slot. An "add image slot" button appends a row with no image
   chosen yet — and if the guard refuses that row, the filter in step 1 deletes it on the very write
   the click itself triggers. The operator clicks add, the row appears, and it is gone on the next
   broadcast:

   ```ts
   // Absent is allowed and stays absent: an unfilled row is a slot that draws
   // nothing, exactly as a text slot with no words does.
   const image = cleanText(raw.image, IMAGE_NAME_MAX);
   ```

   The rule was not new — a text slot with no words was already valid and drew nothing. It just had
   to be extended to the new kind rather than reinvented for it. The editor then has to tell the two
   states apart, because they are both "the guard says no" to a naive reader:

   ```tsx
   const cleaned = cleanSlot(slot);
   const broken = cleaned === null;                                   // damage: show the warning
   const unfilled = cleaned !== null && isImageSlot(cleaned) && cleaned.image === undefined;
   ```

   They are not `else` branches of each other. A row that is unfilled *and* broken for another
   reason is still broken and must still say so, or the next edit drops it with no explanation.

5. **Every writer needs the filter, not just the editor.** The rule above is about the editor
   because that is where it was first found, and that framing is how it got broken again. A later
   feature added a server handler that attached an imported image to a slot: it read the list with
   `slotsOf(w)` — the *lenient* view, which keeps an unusable entry whole — and passed it to
   `setWorldOverlays`, the *strict* guard, which refuses a list holding one. One hand-edited slot
   anywhere in the World therefore made every image import fail, and roll its copied file back,
   reporting a cause that had nothing to do with the import. The fix is the same filter, in the new
   place:

   ```ts
   const next = list
     .map((slot, i) => (i === msg.slot ? { ...slot, image: copied.path } : slot))
     .filter((slot) => cleanSlot(slot) !== null);
   return setWorldOverlays(w, next);
   ```

   Worth saying plainly: the author of that handler had cited this document in the plan for that
   feature, applied the filter on the client, and then omitted it on the server path they wrote
   themselves. Knowing the rule is not the same as having a way to notice where it applies. The
   question to ask at every write is not "have I read the lenient/strict doc" but "which of these two
   views am I holding, and which does the thing I am about to call want".

## Why This Matters

Each half of the system was written to a good rule and tested against inputs that rule produced.
The failure lived only in the composition: a list that the load rule admits and the write rule
refuses, passing through an editor that assumed the two agreed. That is a class of defect the
unit suite is structurally blind to, because the fixtures are built by the same hand that wrote
the guards. It surfaced under an adversarial review that constructed a hand-edited manifest, which
is the input the lenient load exists for and the one nobody had fed the editor.

The in-flight race is the same shape one step later: the editor assumed the list it received was
the list it had sent, which holds until two edits are one broadcast apart.

## When to Apply

- A stored list is loaded leniently (kept whole when partly invalid) and written strictly
  (refused whole when partly invalid).
- A control replaces a whole list rather than patching one entry — clip sets, effects, slots.
- Two edits can be sent before the first is answered: a blur and the click that caused it, a
  keystroke and Enter, a fast double action.
- A refusal is answered on a result channel the control does not render.

## Examples

**Before.** A World hand-edited to `{"size": 30}` on its second slot. Changing the first slot's
position sends all three, the server answers `ok: false`, nothing on screen says so, and the
select snaps back. Every later edit does the same.

**After.** The second row is marked as one that cannot be drawn as stored and will be dropped.
Changing the first slot's position sends two slots; the server writes them; the marked row is
gone on the next broadcast. A refusal from any other cause appears under the list in the
operator's words.

**The empty row.** Click "add image slot". Before: the appended
`{ kind: "image", position: "top-right", size: 6 }` fails `cleanSlot`, the write filter drops it, and
the row vanishes on the next broadcast. After: the same object is a valid slot that draws nothing, the
row survives, and it reads "no image chosen" with a browse button rather than a damage warning.

**The unrelated neighbour.** A World holds one hand-edited slot with `size: 300`. Before: every image
import into that World fails and deletes its own copy, saying the World could not be written. After:
the import lands, and the unusable neighbour is dropped exactly as the next authored edit would have
dropped it.

**The race.** Slots `["one", "two"]`. Type into slot 1's text, then click "move slot 2 up" — the
click blurs the field first. Before: send `["one edited", "two"]`, then `["two", "one"]`, and the
edit is lost. After: `["one edited", "two"]`, then `["two", "one edited"]`.

## Related

- `docs/solutions/rebuilding-a-cache-field-by-field-turns-a-read-into-a-delete.md` — why the
  load is lenient in the first place.
- `docs/solutions/a-fix-to-what-a-picker-offers-is-not-a-fix-to-what-it-keeps.md` — the
  neighbouring blind spot: a control verified by what it offers, not by what the store holds.
- `docs/solutions/self-review-finds-mechanism-bugs-not-outcome-bugs.md` — this was found by a
  reviewer constructing the input the author's tests never did.
- `docs/residual-review-findings/feat-video-text-overlays.md` — the trades accepted around it,
  including two-tab last-write-wins.
- `docs/solutions/typed-test-fixtures-cannot-express-what-a-lenient-loader-admits.md` — the same
  lenient boundary seen from the tests: no typed fixture can express what the load admits.
- `docs/residual-review-findings/feat-overlay-images-and-fonts.md` — where items 4 and 5 came from.
