# feat: Conversation context injection — accepted residuals

Origin: `docs/brainstorms/2026-08-08-conversation-context-injection-requirements.md`
Plan: `docs/plans/2026-08-08-003-feat-conversation-context-injection-plan.md`

What shipped knowingly incomplete, and what would discharge each.

## Chat replies carry no band-aware check

**What.** Narration entries pass through `enforceIdentityBands` on the way out, so a model that
states a name the confidence does not support is corrected. Chat replies do not.

**Why it shipped anyway.** Chat streams token by token — `chat-token` is broadcast as each arrives —
so a check applied to the finished text cannot unsay what already rendered. Buffering the reply to
check it would remove streaming from the one surface where a person is watching it arrive. The input
gating still holds and is the lever this project has actually measured working: only a *stated* band
reaches the model as a bare name, a hedged one arrives attributed, and only a stated band unlocks a
Character Profile. What is missing is the second belt, not the first.

**What would discharge it.** Either a streaming-aware check that can correct a name mid-stream, or a
decision that the input gating is sufficient and the narration check is the belt-and-braces case.
Worth measuring before building: whether a model handed only attributed forms ever produces a bare
name anyway.

## The characters-per-token ratio is an approximation

**What.** Budgets convert tokens to characters at four to one. A token-dense prompt — code, JSON,
unusual names — spends the window faster than the label implies.

**Why it shipped anyway.** It is the same approximation the narration budget has run on since
`EVENT_BUDGET_CHARS` was written, and the level shares leave half the window free, which is the
margin that absorbs the error. A real tokeniser in the UI would be a dependency for a label.

**What would discharge it.** Measuring actual token counts for a few real sends against the models in
use, and adjusting the ratio or the shares if the margin turns out to be thinner than assumed.

## The allocation cap is a guess about this machine

**What.** `chatContextCap` defaults to 8192 tokens. Nothing measured that; it is a conservative
number chosen because raising it grows the KV cache on the card already holding the chat and
narration models.

**Why it shipped anyway.** It is a setting, so it can be corrected without a release, and the
consequence of it being too low is that HAL is told less rather than that anything breaks.

**What would discharge it.** Watching VRAM while raising it, on the machine that actually runs this.

## The recogniser endpoint still has no gate

**What.** The off-machine acknowledgement is built, persisted, and checked before chat context leaves.
The recogniser endpoint — which sends whole camera frames — does not consult it yet.

**Why it shipped anyway.** The flag was deliberately scoped to identity data leaving the machine
rather than to chat, so it already covers the recogniser conceptually. Only the check at the
recogniser's own call site is unbuilt, and pointing the recogniser off-machine is not something the
product encourages.

**What would discharge it.** One check in the vision settings path, reading the same flag.

## Two enrolled people have still not been in frame together

**What.** The multi-*appearance* path is now observed: a live send carried
`Creator 61%` alongside `someone who looks like Creator 55%`, one stated and one hedged, rendered in
their different forms in one presence block. What has still not happened is two *different* enrolled
people at once — so the profile half (one delivered, another withheld by band) remains untested
outside the suite.

**Why it shipped anyway.** It needs a second enrolled person, not more code.

**What would discharge it.** One session with two enrolled people in front of the camera, and a look
at the assembled system message in the inference log.

## A gloss became a prohibition, and the fix was to delete it

**What.** The presence header briefly carried "a percentage is how strongly that face matched, nothing
more", added to give a bare number its unit. The model read it as a caution, escalated it into a rule
it invented — "do not read it as a record of who is sitting here now, because it is not" — and then
obeyed that rule against its own data, refusing to identify someone it had recognised without a break
for two minutes, in the *stated* band, at a confidence well above the statement threshold. Told
directly "that's me at my desk", it answered "I am not assuming anything about the person in front of
me".

**Why it is recorded rather than just fixed.** It is the third time this project has watched a
qualifier become the subject of the output, and the first time it happened to text this codebase
added while explicitly citing the lesson against it. The clause is gone; the number goes bare, as it
had for weeks. What replaced it is evidence rather than instruction: the duration now says it means
one unbroken recognition of the same person, and Recognition Weight is rendered in words. The band
already licenses what may be said, and nothing needed to tell the model how to weigh a number.

**What would discharge it.** Nothing to build. It is here so the next person who wants to explain a
field in a prompt reads what explaining one cost.

## The caption is attributed in time, but not in reliability

**What.** The caption reaches a Conversation as `My last look at the scene, 12 seconds ago at
17:02:16: "…"` — quoted, dated, and framed as HAL's own sight. Nothing tells the model that the text
came from a separate small vision model that invents detail. In live use it read one chair's brand as
both "GTRACING" and "GTRADING"/"GAI" within a few frames, and once decided the operator was holding
scissors. HAL presents that as something it saw.

**Why it shipped anyway.** The obvious remedy — telling the model its own eyes are unreliable — is
the shape `docs/solutions/an-instruction-that-fights-its-own-input-loses.md` records losing: a rule
arguing with its own input generally loses, and the likely outcome is HAL hedging everything
including the parts that are correct. The narration path solved the same problem by position rather
than by instruction, and the same bet is taken here. Quoting and dating already stop the caption
being read as a bare assertion; what is missing is a claim about the *source*, not about the framing.

**What would discharge it.** Evidence either way from use. If HAL starts repeating invented details
as fact, the cheap next move is attributing the caption to the captioner by name rather than adding
a rule about trust — naming a source is what the narration prompt does, and it does not argue with
anything.

## The session block can talk about vision, and used to win

**What.** When the Watched Session is the session working on HAL, its narration discusses vision
itself. With sight placed before that commentary, a model asked what it could see answered from the
commentary — "the observation window only opens on a scheduled segment that has not arrived" — while
a caption describing the room sat above it, unread.

**Why it shipped anyway.** It did not: sight now goes last, after the session block, and the fix was
confirmed live on the same configuration that produced the failure. What remains is that the
underlying pressure is unbounded — a session block can be several times the size of the sight block,
and position is the only thing keeping sight salient.

**What would discharge it.** Either a cap on the session block relative to the sight block, or
evidence over time that ordering alone is enough. Ordering is the cheaper bet and it is the one taken.

## Verified live, for the record

The following were confirmed against the running instance rather than assumed:

- All twenty installed models resolved a window, including the two that publish it only via
  `/api/show` under an architecture-prefixed key.
- A send with both switches on produced a system message carrying the presence line, a quoted and
  dated caption, the Operator's profile, and the watched session's recent narration with a
  `(214 earlier remarks not recalled here.)` notice.
- The Operator's Character Profile appeared in the request and as
  `[withheld: 72 characters of character profile]` in the inference log.
- The conversation record on disk held the levels and nothing else — no assembled text, no names.
- The presence line's original wording made HAL report an empty room while its own caption described
  someone sitting in it. Fixed, and the fix confirmed live.
- With both sources at their largest, HAL reported who was in view, in both bands, and gave the
  wall-clock time the reading was taken — on the same configuration that previously produced
  "I cannot see anything". The sight block was the last 890 characters of an 8,957-character system
  message.
