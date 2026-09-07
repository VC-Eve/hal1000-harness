# Residual findings — a slot that says when it is drawn

What this feature knowingly leaves open. Written at build time rather than
discovered later, and each entry says why it was left rather than only that it
was.

## Deliberate

**A slot that stops being drawn leaves the flow, and its neighbours move.** Two
slots at one position stack in a column, so hiding one moves the caption beneath
it. A reserved empty box would push other captions aside for a caption that is
not there, which is worse. The movement is measured rather than assumed —
`scripts/conditions-check.mjs` reports 10px on `/live` and 52px on `/broadcast`
for the seed World — and reserving the box is one CSS rule if the number ever
reads badly on a stage.

**Visibility is not frozen by the machine's evaluation invariant.** While a
crossing, an atomic run or a blend is live the runtime evaluates nothing, and a
slot's visibility keeps updating anyway. It is a rendering of the values as they
stand, and a caption that lies for the length of a bridge is worse than one that
does not. The visible consequence: an arrival Effect writing a Parameter as a
blend window opens changes a caption while the picture is still dissolving.

**A slot scoped to a crossing's destination appears when the crossing ends.**
`stateId` names the *source* State for the whole of a move, so a lower third for
the State being entered arrives at the landing rather than at the cut. That is
the same answer the machine gives about where it is, and making the picture
disagree with the machine would be the worse half.

**A clause cannot name a State.** The clause value stays boolean-or-number, and
the structural half answers what a State-naming clause would have. Widening
`ParameterValue` to carry strings would reach `clauseHolds`, `opsFor`, every
report and the store's clamp — a change to the machine's own comparison
vocabulary for something the `states` list expresses better.

**Slot position is an address, not an identity.** A report names `slot 3`, and a
reorder makes that a different slot. Every report is re-derived from the World on
every broadcast, so the panel corrects itself; the one surface that holds a
server-computed note across an unrelated edit is the playlist-edit warning, where
a reorder of the *overlays* while that warning is on screen would leave it naming
the wrong position. Low-frequency, self-correcting on the next message, and the
alternative is an identity for slots that nothing else needs.

## Left undone

**The `?? "bool"` fallback in `typeOf` still types an undeclared name as bool.**
A clause naming a Parameter the World no longer declares is offered `is` and
`is not` even when it was written as a comparison. The store now repairs the
case it can see and `danglingConditions` reports the rest, so the situation is
rare and visible; changing what the picker offers for a name it cannot type is a
decision about pre-existing behaviour and was left alone.

**No never-appears mark in the graph.** The editor row says whether a slot is
showing *now*. Whether it could ever show — given the World's reachable States
and the ranges its Parameters can hold — is the question the graph already
answers for transitions with its never-fires marks, and a slot has no equivalent.

**The broadcast allowlist tests became weaker evidence.** They now count nodes
the viewer never sees, because a not-drawn slot keeps its element. The browser
check asserts the property that matters — one visible text node with two hidden
captions in the DOM — but the component-level assertions no longer prove it on
their own.

**A fade has one shape.** Linear opacity, both directions, one number. No easing,
no separate in and out, and no per-source default.

## New surface, recorded

**The transport broadcasts more often than it did.** `publish()` now sends
`audio-transport-state` when the readout signature changes as well as when the
second does, so a track whose length is not a whole number of seconds produces
one extra message per second-ish rather than one per second exactly. It is
bounded by the same granularity the readouts already have, and `world-live` is
untouched — origin R27 is unaffected — but a running show does emit slightly
more than it used to.

**`Transport.readouts()` now goes through `TransportState`.** It reads its own
`state()` and hands it to the shared derivation, rather than reading its private
fields. One definition, and the browser can reach it; the cost is that a future
field the readouts need must be on `TransportState` rather than private, and the
oracle test in `server/test/live/audio-readouts.test.ts` is what says the move
changed no value.

## Raised by the code review, and not fixed

Seven reviewers read the branch. What was worth fixing was fixed — seventeen
findings, including a caption that could stick on the projector for good — and
these are the ones judged not worth building now.

**The whole-list write has no staleness check.** `set-world-overlays` replaces
the list wholesale and the store's `mutate` holds a lock but compares no
generation, so two writers — a second tab, or an agent, which the protocol
invites — silently overwrite each other with a successful result on both sides.
The `when` panel adds three more index-addressed writes and a multi-step edit
that spans several round trips, which widens a window that was already open.
Closing it means a generation on the message or per-slot writes addressed by an
id; both are protocol changes and neither is a patch.

**An older build that edits overlays strips the three new fields.** `cleanSlot`
builds its result as a literal of the fields it knows, so a build without this
feature drops `states`, `conditions` and `fadeMs` on the write path. It takes an
*overlay* edit specifically — an unrelated mutation spreads the World and leaves
the slot list alone — and it is the property every optional field this codebase
has added shares, `backing` and `opacity` included. Recorded rather than fixed
because fixing it means the older build, not this one.

**The wire contract carries no version.** Replacing `transitionId` with `owner`
on the two note shapes is a flag-day break for anything parsing them. Client and
server ship together here and always have, so the exposure is an agent holding
an older idea of the shape; a protocol version is the fix and it is a decision
about the whole contract, not about this branch.

**A conditioned slot keeps drawing from the last thing it heard.** The store
clears neither `worldLive` nor `audioTransport` when the socket closes, so during
a restart a slot goes on asserting a State and readouts that are no longer true.
Before this feature the layer drew the same words either way; now it draws a
claim about the machine. The honest fix is a staleness mark on the live state,
which is a change to what every surface reads.

**A clause naming a Parameter the World declares can still be evaluated against
a mix of two messages.** `world-live` and `audio-transport-state` arrive
separately, so a slot conjoining a declared Parameter and a readout can briefly
hold a combination that never existed on the server. With a fade at the ceiling
that is seconds rather than a frame. Inherent to evaluating in the browser, which
KTD2 chose deliberately.

## Found while building

**The first draft of the plan reached for one half of the vocabulary.** It gave a
slot `conditions` and stopped, because `Condition` is a greppable type and
`from`/`fromAny` is a field on the thing that owns it — so the filter half looks
like the whole vocabulary and the structural half does not look like part of it
at all. Two of six reviewers noticed; the framing survived the review because it
had already been written up as an out-of-scope question rather than a missing
half. It was dissolved by the operator asking why it did not just work the way
transitions do.

**"The derivation is exact" was wrong.** The plan claimed a browser could read
the audio readouts off `TransportState` by naming its fields. `readouts()`
computes length and remaining from a private `totalMs()` that floors at
`MIN_TRACK_MS` and rejects non-finite values, while `durationMs` on the wire is
the raw stored number — so a 300ms track was one second long to the machine and
zero to the browser. Two reviewers found it independently; the pairing matrix had
no sub-second row, so the delegation would have shipped green.

**The store already had a repair that would not have reached the new owner.**
`removeParameter` and the re-type path in `declareParameter` strip stranded
clauses from `world.transitions` and nothing else. A slot's clause would have
survived a Parameter deletion as a caption that could never appear. Both tests
were seen red with the repair removed.

**The plan's own revert instruction was backwards.** It said that if the pairing
test still passed after reverting the delegation, the test was asserting nothing
— when reverting is precisely what *restores* a comparison between two
implementations. The test is now a frozen copy of the pre-move arithmetic, which
stays discriminating after the delegation lands.
