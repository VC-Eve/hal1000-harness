# Residual findings — the broadcast surface

Accepted knowingly, at the moment each trade was made rather than after the fact. The plan is
`docs/plans/2026-09-04-002-feat-broadcast-surface-plan.md`; the brief it derives from is
`docs/brainstorms/2026-09-04-broadcast-surface-requirements.md`.

The first entry is unlike the others and is the reason this file leads with it: everything else here
is a bounded trade with a known shape, and that one is an absence of evidence about the only thing
the feature is for.

---

## The surface has never been looked at

**What.** U6 — seven checks in a real browser — was never run. The feature shipped on 2872 passing
tests, a clean typecheck across three tsconfigs, and a ten-reviewer code review. None of those can
see what a projector shows.

**Why it shipped anyway.** The operator asked for it after being told twice, which is their call to
make. The unit coverage is genuinely thorough — every server-side guard was proved by removing it and
watching a test fail — and nothing in the review suggested the surface was broken. It is unverified,
not suspected.

**What is still open, precisely.** Three of the seven cannot be answered any other way:

- `FADE_AFTER_MS` is 3000, and that number was chosen in a text editor. Whether three seconds reads
  as a deliberate cut or as a dead feed is a judgement about what an audience infers, and there is no
  test that can hold an opinion about it.
- `object-fit: contain` was chosen so nothing authored is ever cropped, on the reasoning that bars
  against true black are invisible. Whether they are invisible on a real projector, at a real
  brightness, against a real room, is not established.
- The observer role surviving a server restart with both windows open. `npm run start` never
  auto-reloads, so restarts are routine here, and this is the case the role is most likely to be
  silently lost in. `BroadcastObserve.test.tsx` covers the reconnect against a mocked `WsClient`,
  which proves the client re-declares — not that the server's election lands the way it should when
  two real sockets race to reconnect.

The remaining four (nothing but video painted, the background truly `#000`, the grant landing on
`/live`, the title in an OBS source list) have unit-level proxies that are good evidence but not the
thing itself. `docs/solutions/a-rule-that-is-right-for-the-whole-is-wrong-for-the-part.md` is the
recorded reason to distrust the proxy for the first of them.

---

## An observer never measures a clip, so a broadcast-only show runs on stale durations

**What.** `report-clip-duration` is the only path by which a clip's real length reaches the manifest —
the clip route serves only clips the manifest already references, so nothing can probe a duration at
assignment time. The observer role refuses that report. A show driven with only `/broadcast` open
therefore measures nothing, and the runtime's timer runs on whatever the manifest holds, which for a
freshly imported clip is `0`.

**Why it shipped anyway.** The refusal is doing real work: nothing downstream deduplicates a
duration, and it is a manifest write, so two windows showing one World would otherwise both write it.
And the intended way to operate is two windows — the brief's own framing is that a broadcast needs
`/live` for the audio anyway, and `/live` measures.

**What is still open, precisely.** The code review proposed a strictly better shape: accept the
report from an observer and drop the write server-side when the recorded duration already matches
within tolerance. That removes the duplicate write without removing the only measurement path.
**It contradicts KTD5 of the plan**, which calls the duration refusal load-bearing — so it is a
design decision the operator has not made rather than a fix waiting to be applied. The failure it
guards against is narrow but silent: a World whose clips were imported and only ever shown on
`/broadcast` will loop at the wrong length with nothing reporting why.

---

## A declaration with no answer

**What.** A socket that sends `observe` while not holding the audio grant is told nothing at all.
`observed()` only speaks when the declaring socket was the authority, and then only to say it no
longer is. There is no acknowledgement that the declaration was received.

**Why it shipped anyway.** It is symmetric — a browser learns no more than an agent does — so it
breaks no parity rule, and the observer's own behaviour does not depend on the answer.

**What is still open, precisely.** An agent holding the boot token can declare itself an observer and
has no way to confirm the declaration landed except by provoking a refusal it does not otherwise
want: sending `take-audio-authority` and reading `OBSERVER_REFUSED` back. Two reviewers found this
independently, from the contract side and the parity side.

---

## The mutation switch is ungated

**What.** `WorldService.handle()`'s switch — `open-world`, `add-state`, `set-parameter`,
`set-world-playlist`, `import-clip` and the rest — carries no authority or observer check at all. An
admitted broadcast socket could open a different World or repoint the playlist mid-show.

**Why it shipped anyway.** The broadcast client sends none of those messages. It renders video and
declares itself an observer; that is the whole of its wire traffic. The gate would be defence against
a future bug rather than a live hole, and it was out of the brief's scope.

**What is still open, precisely.** The feature's own KTD3 argues that capability gates belong at the
door rather than resting on what a client happens to send — which is an argument for gating this
switch too. That the observer role stops short of it is a scope decision, not a principled boundary.
Recorded here because the next person to extend the role will want to know it was noticed.

---

## The black is less protected than the title

**What.** KTD8 inverts the document title so the neutral one is the static default and the operator
routes set "HAL 1000" from JS. That makes the title survive a bundle that never parses. The
background does not: `html.broadcast` is added in `main.tsx`, so a page that never executes falls
back to the document's `--bg` of `#050505`.

**Why it shipped anyway.** It degrades to a slightly lifted near-black rather than to a leak. There
is no text either way, which is the requirement that matters.

**What is still open, precisely.** The two halves of KTD8 do not have equal reach, and the decision as
originally written implied they did. Closing it would mean the static document carrying the class, or
a CSS rule that can see the path — neither of which the current shape supports. The plan now records
the asymmetry.
