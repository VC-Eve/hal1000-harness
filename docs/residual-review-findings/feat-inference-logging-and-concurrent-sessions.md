# Inference logging and concurrent sessions — accepted residuals

Two changes shipped together, because the second is what makes the first worth having: HAL now
records every model call with its input and output, and follows every live Claude Code session
rather than one. These are known and accepted, not oversights.

## The inference log grows without bound, and it contains everything

`inference/<kind>/<id>/<YYYY-MM-DD>.jsonl` is never pruned. That was an explicit decision, taken
against the alternative of a 30-day window: these records are the long-horizon analysis material,
and a log that quietly deletes the period you wanted to study is worse than a large directory.

The cost is real and worth stating plainly. Every record holds the full prompt, which for session
narration means clipped source code, file paths, tool commands and their output; for chat it means
the entire conversation history, re-recorded on every turn, so an *n*-turn thread writes O(n²)
characters over its life. Nothing redacts, and nothing warns when the directory gets large.

Anyone who wants a bound has the tools: the files are day-stamped, so deleting by date needs no
parser. There is deliberately no setting for it — a retention dial implies a considered default,
and the considered default here is "keep it".

## Following is capped at eight sessions, and the cap is silent

`MAX_FOLLOWED` in `watchers/claude-code.ts` bounds concurrent following. Beyond it, the most
recently active live sessions win and the rest are simply not followed — the user is not told. A
machine with more than eight genuinely live Claude Code sessions will therefore be under-observed
without any indication in the feed.

Accepted because the failure is quiet in the right direction: the sessions that lose are the least
recently active, and the alternative — narrating twelve sessions through one provider lane — makes
every feed useless rather than eight of them good. The count in the pane header is the only hint,
and it reports what is followed, not what was skipped.

## Priority is bounded, but background sessions still wait

The selected session takes up to `SELECTED_STREAK` (3) consecutive turns before yielding one to the
round-robin. Under sustained load on the selected session a background session therefore waits
roughly three narration calls — at four to five seconds each on the measured local model, ten to
fifteen seconds — before it is heard. Its events are still coalesced meanwhile, so nothing is lost;
it is late, not missing.

Tuning this trades the watched feed's responsiveness against background latency, and there is no
setting for it because the right answer depends on how many sessions are live, which changes minute
to minute.

## Unwatch no longer stops observation, and the word still says it does

`unwatch` used to stop the pipeline, because the selected session was the only one observed. It now
only clears the selection. The protocol message, the `watch-stopped` broadcast, and the pane's
`detach` button all kept their names, so a client reading the wire contract could reasonably expect
observation to stop.

The copy in `persona.ts` and the pane were corrected to match the behaviour, but the protocol names
were not: renaming them is a breaking wire change for a distinction that only became meaningful
here. Stopping observation outright is disabling the adapter, which is a different message and does
what it says.

## A followed session's gap notice is dimmed

A `gap` is HAL speaking about himself, so it keeps `adapterId: null` and HAL's red (R15). It now
also carries `sessionId`, so the pane's selection treatment applies to it — meaning a gap about an
unselected session renders at the same reduced opacity as that session's narration. That is
arguably wrong: the gap is HAL's voice, not the session's, and HAL's voice should not dim.

Accepted because the alternative is worse in the common case. Without the session stamp, "my
attention lapsed" gives no clue which of eight logs lapsed.

## Records are written fire-and-forget

Both logs append without blocking the caller, so a feed entry always reaches connected clients even
if the disk is wedged. `flushJsonl()` settles the debt on shutdown, but a hard kill — not the
`close()` path — loses whatever was queued, typically the last record or two. Write failures are
reported to the console and swallowed; nothing surfaces in the UI.

This is the correct trade for an observer of the app, but it does mean the log is very slightly
lossy at exactly the moment a crash makes it most interesting.
