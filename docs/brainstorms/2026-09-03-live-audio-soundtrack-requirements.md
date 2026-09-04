---
date: 2026-09-03
topic: live-audio-soundtrack
---

# Live audio soundtrack

## Summary

Give `/live` a soundtrack: an audio player that plays FLAC and MP3 from named playlists, with each
World naming one. While a track plays, its length, remaining time, BPM and position in the playlist
are live Parameters that every World has, so transitions and Effects can condition on the music the
same way they condition on anything else.

---

## Problem Frame

A World is a state machine over video that runs silently. The DJ Booth World has dancers doing
breaks, drum & bass and dub routines, and nothing they move to. Music today happens in some other
application, on its own clock, next to a machine that cannot hear it.

That gap is not only aesthetic. The machine already changes on time — exit times, Effect intervals,
clip ends — but every one of those clocks is internal. A World has no way to be driven by something
the audience can also hear. Adding sound as decoration would fix the silence and leave that second
problem exactly where it is, which is why the readouts matter as much as the playback.

What the readouts reach is structure, not pulse. A World can change on a track ending, on a tempo
tier, on a countdown into the last seconds of a track — the scale at which a set has sections. It
cannot land a movement on a beat, and that limit is a property of the machine rather than a feature
left out.

---

## Key Decisions

**Audio is a source the graph reads, never a thing the graph commands.** Playback publishes values;
conditions and Effects consume them. The transport belongs to the person at the machine. One
direction keeps the feedback loop impossible — a World cannot skip a track that then moves the World
that skips the track.

**Playback is independent of a World's lifecycle.** Starting, stopping and switching Worlds does not
interrupt the music. A World starts its playlist only when the transport is empty, so a switch
mid-set is silent to the audience. Because that gives a World only one unprompted chance to be heard,
the transport carries two operator actions the graph does not: stop, and start this World's playlist
over whatever is playing.

**Reserved Parameters under a qualifier authors cannot use.** Every World gains a fixed set of audio
Parameters it never declares, named under a reserved prefix. The qualifier is what makes the reserved
set extensible: a sixth readout added later cannot collide with a name some existing World already
chose. A manifest that declares one anyway is loaded read-only and told why — never refused, because
the editor is the only place the author could fix it.

**Audio Parameters are read-only, and a change in one is an evaluation point.** No Effect may target a
readout and nothing outside the player writes one. But a readout that changed without waking the
machine would be scenery: the runtime evaluates transitions on a closed set of triggers, and an audio
change has to be one of them or a condition on the music is sampled only when a clip happens to end.

**The server owns the transport clock; the browser is an output device.** Track length is read at
import and persisted, and the runtime advances position from its own timer, exactly as it does for a
clip whose duration the browser measured once. A client's position report is a correction, not the
source. This keeps a World's transitions identical whether or not a page is open — the machine is
built to run with nothing watching, and readouts that existed only while a browser was attached
would make the same World take different paths depending on who was looking.

**Remaining time is exposed in whole seconds, and conditions on it are thresholds.** The machine is
level-based: a condition is true for as long as its comparison holds. Whole seconds keep a threshold
window short enough to write against — `remaining <= 5` opens five seconds before the end and is
still true on arrival if a bridge was crossing when it opened. An equality comparison is the one form
that does not survive that, and the reports say so rather than the requirements pretending otherwise.

**Audio lives in a shared store in the data dir, alongside `worlds/`.** Tracks are copied in on
import under the same rule clips follow — nothing is referenced by a path outside the store — but one
level up rather than inside a World. Named playlists can then be shared, and deleting a World touches
no audio. The cost is that a World folder is portable in itself and silent without the store, which
is a change to what "self-contained" has meant here.

**A World names one playlist; playlists are their own objects.** A set built once can be pointed at by
three Worlds. The manifest holds a reference, not the tracks — and an edit to a shared playlist is
reported where the edit is made, not only inside whichever World it broke.

**Detection is the primary BPM source, not a fallback.** Most of the target library carries no BPM
tag — measured, not assumed — so a tags-first design would mean hand-entering a tempo for nearly
every track before a single tempo condition worked. Detection therefore ships with the feature rather
than after it.

**Detection runs in-process, and ships only if it can be honest.** No second runtime and no install
steps: the detector lives in the existing server. That narrows the field, and the narrowing is not
allowed to be resolved by lowering the bar — a detector that cannot cover the range or cannot say
which octave it chose is worse than none, because a plausible wrong number silently halves every
tempo condition in the World. If nothing in-process clears that bar, BPM ships on tags and hand
entry, and the doc says so rather than pretending.

---

## Requirements

**Playback**

R1. The player plays FLAC and MP3. Additional formats the browser already decodes are acceptable but
not required.

R2. Transport is manual: play, pause, next, previous, seek within the current track, volume, stop, and
start the current World's playlist over whatever is playing. Transport is driven through the WS
protocol, so an agent operates it exactly as the pane does. What the graph is denied is commanding
playback, not an agent's access to it.

R3. Playback is independent of World lifecycle. A World starts its playlist only when the transport
holds no track; switching Worlds, and stopping one, leave playback untouched. A paused track still
occupies the transport, so pausing does not open the gate.

R4. Playback is audible from the `/live` pane whether the graph editor is open or the World is simply
running.

R5. Audible playback requires a user gesture in the page. A World that starts before one has happened
arms its playlist without advancing it, the pane shows an explicit control to enable sound, and the
audio Parameters report that nothing is playing. The armed playlist begins on the gesture.

R6. Exactly one connected client at a time is the audio authority and produces sound. Other clients
show the transport read-only and play nothing.

R7. Volume persists across World switches within a session.

R8. A playback failure that is not a single track's fault — sound blocked, a store read error, a
decoder the browser refuses — is visible wherever the transport is, distinct from the per-track
unplayable state in R14.

**Playlists and storage**

R9. A playlist is a named, saved object holding an ordered list of tracks. It exists independently of
any World.

R10. A World records which playlist it uses. A World may have none, and starts nothing when it does.

R11. Adding a track copies the file into the shared audio store. Nothing in a playlist names a path
outside that store.

R12. The audio browser accumulates a selection across picks and commits it in one action, so a
playlist can be built from many tracks in a single visit. This differs from the clip browser, which
commits on the first pick and closes.

R13. Deleting a World removes no audio and no playlist.

R14. A track that cannot be played — its file is missing, or present and undecodable — is reported
unplayable and skipped, and its entry stays in the playlist untouched.

R15. A World naming a playlist the store does not hold loads and runs silently, with the audio
Parameters at their nothing-playing values and the missing reference named in the World's reports.
This is the ordinary case for a World folder copied from another machine.

R16. A World's reports name every condition comparing playlist position against an index the
referenced playlist no longer reaches.

R17. The playlist editor names, at the moment of a reorder or a removal, every World whose conditions
that edit invalidates. A report only inside the affected World arrives when it is next opened, which
during a set is too late to be a guardrail.

**Serving and browsing**

R18. Any HTTP route serving audio bytes carries the same host and origin checks `/api/live/clip`
carries. Those checks are applied per route in this codebase rather than inherited from a shared
gate, and this project has already shipped one local media surface that inherited none of them.

R19. Browsing the drive for tracks goes over the existing WS command surface that clip browsing uses,
inheriting the hub's origin refusal and per-boot token. It does not add a second HTTP entry point to
the filesystem, and it does not adopt the byte route's weaker guard.

**Reserved Parameters**

R20. Every World exposes a fixed set of audio Parameters without declaring them, offered wherever a
declared Parameter is offered: whether audio is playing, the current track's total length, its
remaining time, its BPM, its position in the playlist, and the number of tracks the playlist holds.

R21. Reserved Parameters sit under a reserved name qualifier. A manifest declaring a Parameter that
uses the qualifier loads read-only with the qualifier named as the reason, the declaration is left in
the manifest untouched, and the reserved readout is the one conditions read.

R22. Audio Parameters are read-only. An Effect may not target one, and the panel does not offer them
as write targets.

R23. When nothing is playing, the is-playing readout is false and the numeric readouts hold zero. A
transition conditioned on a numeric audio readout without also testing is-playing is named in the
World's reports, because zero satisfies every below-threshold comparison an author is likely to write.

R24. Remaining time is exposed in whole seconds and changes once a second.

R25. A change in an audio readout is an evaluation point for the current State's transitions, on the
same footing as a Parameter write, and subject to the same holds — a crossing and an atomic run
evaluate nothing. A condition on remaining time is evaluated within a quarter-second of the second it
names.

R26. A World's reports name every transition whose condition compares an audio readout for equality.
An equality on remaining time is true for one second, and a crossing may hold the machine for up to
`MAX_BRIDGE_MS`, so such a condition is not occasionally missed but reliably missed on any exit that
crosses a bridge.

R27. A change in the audio readouts alone does not broadcast machine state to clients. Transport
state is published on its own channel to every connected client, which is what a read-only client's
display and an agent's transport access both read.

R28. Audio Parameters are not written into the manifest. They are runtime state, like the machine's
current State.

**BPM**

R29. BPM is read from the file's tag on import when one is present. A tag outside the range R32
requires of a detector is ignored with its reason recorded — a tag is no more trustworthy than a
detector.

R30. Detection runs on import for every track with no usable tag, which is most of them. It runs
in-process, adding no second runtime and no install step.

R31. A detector is used only if it covers roughly 60–200 BPM and reports which octave it chose. A
detector that returns half or double the real tempo without saying so is a silent failure, and the
library this is built for is drum & bass, dub and breaks — exactly the material a narrow detector gets
wrong while looking right. If no in-process detector clears that bar, the feature ships with no
detector rather than a wrong one, and BPM rests on tags and hand entry.

R32. Every track's BPM is hand-editable in the playlist, and the edited value wins over both tag and
detection. An edited value outside the R31 range is refused with its reason.

R33. Import does not block on detection. A track is added, playable and orderable as soon as it is
copied, with its BPM arriving after; the playlist shows which tracks are still being measured.

R34. A track whose BPM is not yet known is distinguishable from one whose BPM is zero, and a
condition on the BPM readout is not satisfied by a track that has not been measured.

---

## Key Flows

- F1. Building a playlist
  - **Trigger:** The user opens the playlist editor in `/live`.
  - **Steps:** Browse the drive for audio files; add tracks across as many picks as wanted and commit
    the selection; each is copied into the shared audio store; tags are read and BPM is filled where
    usable; the user orders the tracks and names the playlist.
  - **Outcome:** A saved playlist any World can point at.
  - **Covered by:** R9, R11, R12, R19, R29, R30, R32, R33

- F2. A World's soundtrack begins
  - **Trigger:** A World with a playlist starts while the transport holds no track.
  - **Steps:** The playlist is armed; if sound has not been enabled the pane offers the control and
    the operator supplies the gesture; the first track begins; the audio readouts take their values
    and each change wakes the machine; at track end the next track starts; the playlist loops.
  - **Outcome:** Audio and readouts run until the operator stops them.
  - **Covered by:** R3, R5, R20, R24, R25

- F3. Switching Worlds mid-set
  - **Trigger:** The operator opens a different World while a track is playing.
  - **Steps:** The outgoing World's machine stops; playback does not; the incoming World starts its
    machine and arms nothing, because the transport is occupied. If the operator wants the incoming
    World's own music, they start it from the transport.
  - **Outcome:** The music is continuous across the switch, and changing it is a deliberate act.
  - **Covered by:** R2, R3

- F4. Conditioning the graph on the music
  - **Trigger:** The author edits a transition's conditions.
  - **Steps:** The condition picker lists the audio readouts beside the World's own Parameters; the
    author writes a threshold against one, conjoined with is-playing; the World's reports name the
    condition if either the is-playing test or a threshold form is missing.
  - **Outcome:** The World responds to what is playing.
  - **Covered by:** R20, R23, R25, R26

---

## Acceptance Examples

- AE1. **Covers R23.** Given a World with a transition conditioned only on remaining time below five
  seconds, when the World loads, then its reports name that condition — regardless of what is playing,
  because the defect is in the graph rather than in the moment.

- AE2. **Covers R23.** Given a World whose audio conditions all test is-playing, when playback is
  paused, then no audio-conditioned transition is taken.

- AE3. **Covers R21.** Given a manifest declaring a Parameter whose name uses the reserved qualifier,
  when it loads, then the World opens read-only with the qualifier named as the reason and the
  declaration still present in the manifest.

- AE4. **Covers R5.** Given a freshly loaded page and a World with a playlist, when the World starts,
  then the machine runs, the pane offers a control to enable sound, the audio Parameters report
  nothing playing, and the first track begins on the gesture rather than before it.

- AE5. **Covers R3.** Given a track playing under World A, when the operator switches to World B which
  names a different playlist, then the track keeps playing uninterrupted and World B arms nothing.

- AE6. **Covers R2.** Given a track playing under World A and the operator now in World B, when the
  operator starts World B's playlist from the transport, then World A's track stops and World B's
  first track begins.

- AE7. **Covers R25.** Given a State whose only exit is conditioned on remaining time at or below five
  seconds, when that boundary passes mid-clip, then the transition is taken without waiting for the
  clip to end.

- AE8. **Covers R25.** Given the same transition, when the boundary passes while a bridge is crossing,
  then the transition is taken on arrival, because a threshold that opened during the crossing is
  still true when evaluation resumes.

- AE9. **Covers R26.** Given a transition conditioned on remaining time equalling five seconds, when
  the World loads, then its reports name that condition as one a crossing can miss.

- AE10. **Covers R31.** Given a 174 BPM drum & bass track with no BPM tag, when detection runs, then it
  reports either 174 or 87 labelled as the half-time reading — never 87 presented as the track's tempo.

- AE11. **Covers R14.** Given a playlist whose third track's file has been deleted, when the playlist
  reaches it, then the fourth track plays and the third stays in the playlist marked unplayable.

- AE12. **Covers R15.** Given a World folder copied from another machine whose playlist the store does
  not hold, when the World loads, then it runs silently and its reports name the missing playlist.

- AE13. **Covers R17.** Given playlist P referenced by Worlds B and C, when the operator removes two
  tracks from P in the playlist editor, then the editor names B and C and the conditions the removal
  invalidated, at the moment of the edit.

---

## Scope Boundaries

- The graph never commands playback. No State starts a track, no Effect skips one, no transition ducks
  the volume. A World arming its playlist into an empty transport is the one exception, and it is why
  R2 gives the operator a stop.
- No beat, downbeat or track-end Triggers, and no beat-level synchrony. Conditions read values, and a
  crossing evaluates nothing while it is live, so a movement cannot be landed on a beat. This is a
  property of the machine, not a deferral.
- No crossfading, gapless playback, cue points or multi-deck mixing. One track plays at a time.
- No waveform display or audio visualiser.
- No audio in the clip files themselves. Video clips stay silent; this is a separate track.

---

## Dependencies / Assumptions

- A **bridge** is a transition playing its own clips — the machine crossing between States rather than
  holding in one.
- The load-bearing invariant that a crossing evaluates nothing applies unchanged. Audio readouts keep
  changing during a bridge and during an atomic run, and nothing reads them until the hold ends. A
  threshold survives this; an equality does not, which is what R26 reports.
- Sound requires an attached client even though the clock does not. A World running unattended
  advances its readouts and takes the same transitions it would with a page open; it is simply
  inaudible.
- A World's manifest gains a playlist reference — a field added, not a field whose meaning changed.
- FLAC playback relies on the browser's decoder rather than a bundled one.
- The shared audio store needs its own backup story. The manifest-only convention adopted for Worlds
  in `docs/worlds/README.md` reconstructs clips from a byte-identical copy in the repo; a playlist
  reference in a restored manifest names an object that convention does not carry.
- No Python surface exists in this project — `recogniser/` is a Node/TypeScript sidecar — so detection
  has no existing home and is a new capability wherever it lands.

---

## Outstanding Questions

**Resolve before planning**

- Whether an in-process detector exists that clears R31 — roughly 60–200 BPM with the chosen octave
  disclosed. This is the feature's one hard dependency: most of the library is untagged, so without a
  detector the tempo conditions that motivated the reserved Parameters are reachable only by hand
  entry. Answer it before planning commits to a BPM story, and if the answer is no, say so in the plan
  rather than lowering R31.
- The exact reserved names under the qualifier. They are the author-facing vocabulary and appear in
  every condition picker.
- Whether the server-side transport survives a client reload. R7 scopes volume to a session while R3
  makes playback outlive every World in one; if the page is the session boundary, a reload silences
  the room and loses the gesture.

**Deferred to planning**

- How the audio authority is elected, what happens when it disconnects mid-track, and whether a second
  tab may take sound from the first.
- How long in-process detection takes on a FLAC of typical length, and how many run at once when a
  playlist of twenty is imported.
- How a client's position correction reaches the server, and how far it may disagree before the server
  takes it.
- Where the shared audio store sits within the data dir.
- Whether a track no playlist names is ever removed from the store, and by whom.
- Whether a playlist of entirely unplayable tracks is bounded against spinning as the player skips
  each in turn.

---

## Sources

- `shared/src/worlds.ts` — the World manifest, Parameters, Effects, `MAX_BRIDGE_MS`, the reports set
  R16, R23 and R26 extend, and the clip confinement rule the audio store's copy-on-import mirrors.
- `server/src/storage/worlds.ts` — how a manifest that cannot be used is handled today: loaded
  read-only with a reason, with the author's work left in place. R21 follows that rather than adding a
  refusal the store has no shape for.
- `server/src/live/library.ts` — how clip browsing and copy-on-import work today. The audio browser
  differs in one respect that R12 names: the clip browser commits on first pick and closes.
- `server/src/live/service.ts` — clip browsing is a WS command, not an HTTP route. R19 rests on this.
- `server/src/live/runtime.ts` — the server-side machine, its evaluation triggers, the clip-end report
  a position correction would parallel, and the no-change-no-broadcast rule R27 protects.
- `server/src/http.ts` — where `/api/live/clip` applies its host and origin checks, per route.
- `docs/solutions/loopback-binding-is-not-an-origin-check.md` — the recorded case of a new local media
  surface inheriting none of those checks. It is the evidence behind R18.
- `docs/residual-review-findings/feat-live-scene-worlds.md` — accepted residuals for the World
  subsystem, including what clip confinement does and does not cover.
- `docs/worlds/README.md` — the manifest-only backup convention the shared audio store falls outside.
- A prior project's `scripts/measure-tempo.py` measures BPM but only across roughly 100–145 BPM,
  documented in that project's `docs/solutions/design-patterns/ace-step-15-remix-recipe.md`. It is not
  usable here: the material this feature exists for sits outside that window, and its failure mode is
  a wrong number rather than an error. It is the direct evidence behind R31 — doubly so, since it is Python and R30 rules a second runtime out.
