# Residual findings — video text overlays

Accepted knowingly, at the moment each trade was made. The plan is
`docs/plans/2026-09-05-001-feat-video-text-overlays-plan.md`; the brief it derives from is
`docs/brainstorms/2026-09-05-video-text-overlays-requirements.md`. The code review ran on
2026-09-05 with nine reviewers (run `20260905-084739-708a9962`); eight of its findings were
verified against the code and applied in `fix(review)`, and what follows is what was not.

---

## `server/src/live/audio-service.ts` crossed 1000 lines

**What.** The two new playlist cases took the file over the maintainability reviewer's line
threshold. The suggested extraction — the playlist CRUD branches into a sibling module the service
delegates to — is a refactor of code this feature did not write.

**Why it was not done here.** It is outside the brief's scope and would put a structural change
in the same diff as a feature, which is the shape the repo's own review process is worst at
catching. The two cases added are twelve lines and follow `rename-playlist` exactly.

**What is still open.** The extraction, on its own branch, with `service.test.ts` passing
unmodified across it.

## Two tabs editing the slot list

**What.** The list is replaced whole, so a slot removed in one tab is resurrected by the other
tab's next colour change if its render predates the first tab's broadcast. `set-world-effects`
makes the same trade and the brief chose the whole-list shape deliberately.

**What is still open.** Nothing unless two operators author one World at once, which the product
does not contemplate.

## A hand-edited `overlays: null` becomes an explicit empty list on the next write

**What.** The lenient guard reads a non-array as "no slots", and the next ordinary write — a node
drag — persists `[]`, which means "draw nothing" rather than "the defaults". Tested and documented
in `worlds.test.ts`; it is the one hand edit that silently removes the three defaults.

**Why it was accepted.** The alternative — treating a non-array as absent — would silently give a
World whose author had written `overlays: false` the three defaults, which is the other surprise.
Neither is right for every author; this one is at least visible on the panel, which shows no rows.

## `cleanText` can split a surrogate pair at `TEXT_MAX`

**What.** The bound slices at 200 UTF-16 code units. A title whose 200th unit is the first half of
an astral character stores a lone surrogate and draws U+FFFD.

**Why it was accepted.** Reaching it needs an emoji or a rare script at exactly the cap. Slicing
by code point is a two-line change if it ever matters.

## The fade check in `scripts/overlays-check.mjs` is best-effort

**What.** With two clips alternating across two elements, each element keeps its source and a
reassignment never refetches, so a deleted file may never raise an error and the fade may never
arm. The first run on 2026-09-05 did fade and the screenshot shows the words standing over black;
the second run did not fade within thirty seconds. This is the clip engine's existing behaviour,
recorded in the broadcast plan's U6, not something the overlay changed.

**What is still open.** A World with three or more clips would make the check deterministic.

## `TransportState.header` and `description` are required fields

**What.** The one place this feature adds required rather than optional fields to a wire type. Safe
because server and UI ship from one build; a future out-of-repo consumer should read them
defensively against an older server.

## Observers may still send authoring messages

**What.** Neither `set-world-title` nor the other three new messages check `isObserver`, because
no World or playlist edit does — the observer gate covers the audio grant and the two clip
reports only. The broadcast client sends none of these. Raised by the learnings researcher as a
convention to confirm rather than a gap; it is the same open question the broadcast plan already
records.
