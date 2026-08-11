# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with
project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and
ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Observation

### Adapter
A kind of coding-agent tool HAL knows how to observe — the thing that makes some tool's Sessions
visible to HAL at all.

Adapters are enabled and disabled individually. Disabling one ends its observation entirely: it
detaches, stops watching, and its Sessions leave the picker, though the observations it already
produced stay in the Narration Feed. Each Adapter carries its own colour, which marks the provenance
of the observations it produced rather than when they arrived.

### Session
A coding-agent session that HAL observes from the outside by reading the log the agent writes as
it works. HAL never participates in a Session — it only observes.
*Avoid:* "the session" when a Conversation is meant.

A Session is discovered rather than created: it exists because some other tool started working,
and it keeps existing after that tool exits. Every Session comes from one Adapter, and is grouped
with the others from the project it ran in.

### Followed Session
A Session HAL is currently reading and narrating. Every live Session is followed automatically, up
to a bounded number; following starts and stops on its own as Sessions come alive and go quiet, and
is not something the user asks for.

Following always begins at the present moment, never at the start of the log — narration is about
what is happening now, not a replay of history. This holds for a first follow and a re-follow alike.
Each Followed Session is narrated on its own, never pooled with another: a single remark drawn from
two Sessions' activity would describe neither.

### Watched Session
The one Followed Session the user has singled out. It is chosen by the user, remembered across
restarts, and there is at most one — but it is a matter of attention, not of scope: the Watched
Session is emphasised in the Narration Feed and narrated first when several Sessions are waiting,
while the rest continue to be observed regardless.

Clearing it stops nothing. Observation of every live Session continues; only the emphasis goes away.
Ending observation altogether is done by disabling the Adapter.

### Session State
How alive a Session looks, judged from how recently its log changed: live, idle, or ended.
`unreadable` is the fourth value and means something different — HAL can no longer make sense of
the log (it vanished, shrank, or turned to garbage), rather than the work having stopped.

A Session moves back out of `unreadable` on its own once sane content flows again; the other three
are pure functions of elapsed time since the last activity.

### Session Event
One narration-relevant observation extracted from a single log entry — a developer request, an
agent reply, private reasoning, a tool call with what it acted on, or the outcome of a tool call.

A single log entry can yield several Session Events, because one agent turn can reason, speak, and
call tools all at once. Events carry only what narration needs; log bookkeeping is discarded.

### Gap
A stretch of a Session that happened while HAL was not watching — across a restart, or because the
log was replaced underneath it.

HAL announces a Gap once and resumes at the present. It never replays what it missed, because
stale narration is worse than absent narration.

## Narration

### Narration Feed
The running commentary HAL produces about everything it observes — every Followed Session, every
Monitor, and Vision — gathered into one history rather than split per source.

The recent past is kept and outlives the program, so the feed a reader returns to spans earlier runs
instead of beginning empty at every start. Each entry names the source it came from, which is what
keeps one feed legible when several Sessions are narrating at once.

### Narration Entry
One item in the Narration Feed. Three kinds: HAL's commentary on observed activity, a Gap notice,
and a status report about HAL's own condition (such as losing contact with the model provider).

Status entries are part of the feed rather than a separate error channel — HAL reports on itself
in the same voice it reports on the agent. Commentary records the Adapter it came from when it is
created, so its provenance survives switching Adapters and reloading; the two self-referential kinds
have no Adapter, because HAL is their subject.

### Narration Status
What the narrator is doing right now: idle, narrating, catching up on a backlog, or paused. Paused
splits into two causes with different remedies — no model has been chosen, or the provider cannot
be reached.

### Persona Intensity
How strongly HAL's voice is applied to the app's own messages — empty states, banners, error
notices — from plain description through to full character.

It governs interface copy only. Narration's voice comes from its System Prompt instead, so changing
intensity never changes anything HAL says about a Session.

### Chat Preemption
The rule that a user's chat request outranks narration when both want the same machine's model.

Narration in flight is aborted and its batch re-queued, so nothing observed is lost; chat is never
aborted by scheduling. This exists because one machine runs one model at a time, and a person
waiting on a reply must not queue behind commentary.

Both halves of that premise are scoped to a machine, not to HAL. Preemption applies only when the
two jobs are going to the same host, and so does the one-at-a-time rule that sits underneath it:
Backends on two machines are two pools of memory, and their jobs run at once rather than one behind
the other. Splitting the roles across machines so a second computer carries part of the work is a
supported setup, and a scheduler that serialized regardless would hand back the whole benefit of it.

### Sticky Model
The model the narrator resolves the first time it has something to narrate, and then holds onto, so
that switching chat conversations does not silently retarget narration to a different model.

Resolved on demand rather than when the user picks a Session: HAL narrates Followed Sessions nobody
has singled out, so tying resolution to that choice would leave it unresolved in the ordinary case.
The user changing the narration model still replaces it.

## Monitors

### Monitor
A standing observation source the user points at a log — a file path, or a command run on an
interval. HAL's second observation role, alongside Sessions.

Monitors are plural and configured rather than discovered: a Monitor exists because someone named a
path or a command, so it carries no project identity and never appears in the session picker. They
observe from the moment they start and never replay history, which for a command means its first
run only primes what has already been seen. They run whether or not a Session is attached, and
attaching or detaching one does not disturb them.

The logs that carry machine health are often not files at all — the Windows event logs and the
systemd journal are reachable only by command — which is why running a command is a first-class
source rather than a convenience.

### Monitor Verbosity
Whether a Monitor is quiet or narrated in full, set per Monitor.

Quiet is the default and the point: a machine log is watched for the exception, so HAL accumulates
and summarises once a cycle. A cycle that saw nothing produces nothing — an all-clear on a timer is
noise. Full narrates each batch as it arrives, the way a Session is narrated, which suits a log the
user is actively working against rather than one they are merely keeping an eye on.

### Severity Interrupt
A quiet Monitor speaking immediately instead of waiting for its cycle, because a line looked severe.

Severity is judged without the model, so a severe line is recognised even while chat holds it. It is
read from the source when the source states one — the Windows event logs and journald both do — and
worked out from the text only when the source states nothing. Interrupting changes nothing else: the
Monitor stays quiet, and what HAL narrates in full is unaffected.

Each Monitor decides for itself what counts, because severity is source-specific: it can use the
shipped keywords, its own pattern, or never interrupt at all. The shipped keywords are wrong more
often than they look — llama.cpp writes "checkpoint check failed" as routine slot output, which made
a quiet Monitor speak every thirty seconds. A stated level still wins over a pattern; *never* wins
over everything, being an instruction rather than a guess.

## Vision

### Vision
HAL's third observation role: watching through a camera on an interval and remarking on what it sees
in the same feed as Sessions and Monitors.

What the camera shows is whatever it was pointed at — someone working or at leisure, a room, a
doorway, a view outdoors, or nobody at all. Vision assesses the scene rather than assuming one, which
is why its prompt names no desk and no task.

Like a Monitor it is configured rather than discovered and runs whether or not a Session is attached.
Unlike either, it must manufacture its own silence — a log with no new lines produces nothing on its
own, but a camera describes something every time it is asked.

Off until switched on, and it touches no device before that. Switching it off deletes the frames it
kept.

Whether it *remarks* is a second switch, separate from whether it watches. Silenced, the camera still
runs and the Vision pane is unchanged — captures, captions, the Vision Timeline and recognition all
continue — but nothing reaches the Narration Feed, so a feed read for coding-session activity is not
interleaved with remarks about the room. The summariser is skipped rather than run and discarded: it
is a model call on the card that also holds chat and narration, and its only reader is the feed it is
not being sent to. The cycle still drains, because a buffer left to grow would summarise an hour of
the room the moment remarking came back.

### Captioner
The local vision model that turns one frame into words. A separate process outside Ollama, spoken to
over HTTP.

It is outside deliberately: Ollama already holds the chat and narration models on one card, and a
third tenant there would evict one of them on every capture. Because a cycle is minutes long the
Captioner does not need the GPU at all, so keeping it separate removes the contest rather than
winning it.

It is treated as fallible. It rewords the same scene differently each time and miscounts objects, and
HAL sees only its text — so an invented detail is indistinguishable from an observed one, and the
Vision prompt attributes rather than asserts.

### Camera Stream
The single ffmpeg process that holds the camera while Vision is on, feeding both the live preview and
the interval capture.

There is exactly one because a webcam is an exclusive device: a browser taking it for a preview would
stop every capture. Holding it once and fanning the frames out is what lets both exist, and it makes
a capture a buffer read rather than a process launch.

It lives and dies with Vision being on. Switching Vision off gives the camera back.

### Vision Sensitivity
How readily HAL speaks about a cycle, from remarking every time down to only when something is
clearly notable.

This is the dial that replaces a Monitor's structural silence. Where the line sits is taste, so it
belongs to the user rather than to the product. A cycle HAL says nothing about leaves no trace at
all — no placeholder, no all-clear.

### Recogniser
The local process that finds faces in a frame and turns each one into a comparable vector. A separate
process HAL points at by URL and never starts, exactly as it points at Ollama and at the Captioner.

Stateless by design: it answers about one frame and tracks nothing between calls. That is what leaves
Appearance continuity in HAL rather than in the Recogniser, and it is a deliberate constraint rather
than a simplification — a Recogniser that remembered would be quietly deciding who is who.

### Appearance
One person's continuous presence in front of the camera, however many detections it spans.

The unit is the Appearance, not the detection. Detection fires every few seconds and a person stays
for minutes, so consecutive detections of one face collapse into a single Appearance carrying one
identity decision. Two people in frame are two Appearances. The decision is made when the Appearance
opens and is never revisited while it stays open, because an identity flickering between matched and
unmatched reads to the summariser as someone arriving and leaving.

That frozen decision is what HAL acts on. It is not what any single check found: every detection also
produces its own reading of who the face resembles and how strongly, and those readings vary
continuously across one Appearance as the person moves. The Vision Timeline records the per-check
reading; narration and banding use the Appearance's decision. Confusing the two makes a record that
repeats one measurement at accurate timestamps.

### Gallery
The people the user deliberately named, and the faces held for each.

A person accumulates faces rather than being defined by one, so naming someone HAL already knows adds
to them instead of creating a second record. The Gallery is the only lasting biometric data HAL
holds, and it outlives the Vision toggle: switching Vision off releases the camera and drops the
retained frames, and leaves the Gallery alone.

It is editable without the camera: a name can be corrected, a badly framed face pruned, and a face
added from a picture on disk. Renaming onto a name already held merges the two records — the same
rule enrolment follows, since typing a name you have used before means "this is that person". A
change of capitalisation of a record's own name is a rename and not a merge.

### Candidate
A face HAL kept so it can be resolved later — either unrecognised, or recognised only in the hedged
band.

An unrecognised Candidate asks "who is this?" and is answered by naming. An uncertain one asks "is
this Steve?" and is answered by confirming, which adds the face to that person rather than creating
one; keeping those is opt-in, because confirming correctly improves matching and confirming
carelessly teaches the wrong face. A confident match is never kept — HAL is already sure.

This is what makes enrolment possible when the live view will not cooperate — two people in frame, or
someone who has already walked away. Naming moves the face into the Gallery; dismissing deletes it and
records nothing.

There is a third answer, and it is the one that changes what HAL keeps: **set aside**. A Candidate can
be shelved, which takes it out of the active queue and holds it — crop, embedding and all — until the
user names or dismisses it. Nothing expires. HAL therefore does keep a gallery of unrecognised people,
bounded and visible, and keeps it on purpose: the alternative on offer was a clock that emptied the
shelf on its own, and indefinite retention was chosen over it.

What survives of the original refusal is accounting rather than absence. Each pool has its own bound
and its own tally, so "faces you set aside were dropped" is never reported in the words meant for
"faces you never looked at". A shelved face stays in the duplicate check, which is what stops its owner
re-queueing on every visit — and because a permanent comparison pool can absorb a stranger who merely
resembles someone on the shelf, every such match is counted too. The queue is the only way HAL ever
surfaces a stranger, so a match nobody counted would be a person it saw and never mentioned.

### Identity Band
Which of three things HAL may say about a face, decided by the best confidence the current visit has
produced — not by the frame it opened on.

The running maximum is what makes the thresholds mean what their settings say. "At or above this I
say the name outright" carries no clause about when the reading was taken, so banding on the opening
frame left a visit that arrived on a marginal frame hedged for its whole length while every later
reading cleared the bar — the pane read "someone who looks like Creator 68%" against a threshold of
0.6. It rises and never falls within a visit, which keeps the anti-flicker guarantee the frozen
decision was protecting: a value that cannot fall cannot oscillate. It resets with the next visit,
because a new arrival is a new decision, and only readings of the person the visit already resolves
to can raise it.

Below the recognition threshold a face is unrecognised and reaches the Candidate queue. Between that
and the statement threshold it is *attributed* — "someone who looks like Alice 55%". At or above the
statement threshold it is *stated* — "Alice 71%". Both thresholds are user settings and cannot be set
equal: a band that can be configured to nothing is not a band.

The form is applied to the summariser's input rather than asked of it in a prompt, and then checked
again on what the model produced. Naming the wrong human is worse than miscounting a cup, and a
prompt rule requesting care is the lever this project has measured failing three times. The check
runs against the whole Gallery rather than the cycle's matches, because a Character Profile can put a
name in HAL's standing context without anyone being seen; a name with no live reading is attributed
and carries no percentage, since there is no confidence to report about someone HAL did not see.

The statement threshold rests on field observation rather than measurement. Different-person
similarity has never been measured, so 0.6 records "two enrolled people in daily use, no cross-person
false positive" and not a ceiling.

### Character Profile
Free text describing who someone is and why they matter, in the user's own words.

It reaches a model through a System Prompt and never through a caption line. That placement is the
whole point: the caption line is built bare because labels attached to observations have been
measured becoming the subject of the narration. Only a *stated* band unlocks a profile — handing HAL
someone's history on the strength of a maybe is how a marginal match becomes a confident story about
the wrong person. Profiles are withheld from the inference log, which is never pruned, so deleting a
person genuinely deletes what HAL was told about them.

### Operator
The one person HAL is talking to, marked on their Gallery record.

Distinct from a Gallery entry that merely has a profile, because who HAL is talking to is true with
the camera off, with the Recogniser down, and before anything has been detected. Their profile is
standing context; everyone else's is situational and surfaces only while they are in view. At most
one record carries the mark, and marking a second moves it rather than producing two.

### Vision Timeline
What HAL saw: every recognition check and every caption, each stamped when it happened.

Distinct from the Narration Feed, which is what HAL *said*. A check is written on every detection
pass, including the ones that found nobody — an absence that is only the gap between two entries is
not evidence of anything, and a record that goes quiet when the room empties cannot tell "nobody
here" from "not looking". Checks and captions are separate kinds because they answer at very
different rates: a face is recognised in milliseconds, a frame is described in tens of seconds, and
a record that fused them would misdate one of the two.

Append-only, one file per day, read as a bounded tail. Nothing expires: everyone in the Gallery
consented to being held, and the constraint on this record is that it does not leave the machine.
The Vision pane's window is a rendering bound, not a retention one — it collapses runs of
nobody-found checks and says when it is full.

### Recognition Weight
How much a person's presence is supported by a run of checks rather than by one frame.

Rises with each consecutive recognition, scaled by that check's own reading — not by the
Appearance's standing decision, which cannot fall and so could only ever push the weight up — and
decays against
wall-clock — so a gap reads as absence, and Vision switched off overnight does not leave last
evening's confidence looking current in the morning. A restart is just another gap: the last check
holds the value and its time, and decaying that is the ordinary read.

It decides nothing. Every Identity Band, every narration line, every profile delivery and the
Candidate queue all still read the current frame's confidence. Each check records the weight *and*
the band weight would have chosen, so promoting it later is a measurement rather than a hunch.

A Conversation is told about it, in words rather than as a number, and that is not a promotion:
nothing branches on it. It is delivered because withholding it left HAL unable to conclude anything.
Watching one person continuously for two minutes in the stated band, it still answered "I do not know
who is in front of me" — the evidence for continuity existed, was recorded, and never reached the
one place a conclusion had to be drawn.


## Providers

### Backend
One model server HAL sends inference to: an endpoint, the protocol it speaks, and an optional key.

There are exactly two, named for what sends there rather than for how they relate. The **chat**
backend answers a person who is waiting. The **observation** backend serves narration, Monitors and
Vision — the three roles that run whether or not anybody is watching, kept together so there is one
endpoint to check the bill for rather than three nobody is looking at.

They are independent and both always configured. Neither follows the other when it changes, and both
start on the same server, which is the ordinary setup arrived at without turning anything on.
Copying one to the other is a deliberate act rather than an inheritance nobody can see — and the copy
moves the key too, which is why it happens on HAL's side: a client is never told a credential and
could not copy one itself.

Comparing two Backends is two different questions, and conflating them was a defect rather than a
simplification. **Same host** asks which machine is busy, and endpoint alone answers it: Chat
Preemption contends over one GPU serving one model at a time, so two slots on one box with two keys
still contend. **Same destination** asks whether an answer about one Backend holds for the other, and
endpoint alone gets it wrong: a probe that succeeded on one slot's credential says nothing about a
slot that has none. Readiness and the model list ask the second question; everything else asks the
first.

A window belongs to a backend and a model together, not to a model name: two servers can hold the
same model at different sizes. It is also not a property of the role that asked. Where a server
allocates its window when the model loads, two roles naming two sizes for one model on one machine
make it reload between them — so roles sharing a destination ask for one window, sized to the largest
of them and clamped to what that model can hold. How much of it each role then fills stays its own
business.

A key is never part of the Backend as a client sees it. Settings are broadcast whole on every
connection, so a credential among them would have to be stripped at each of those points; it is kept
in its own store instead, and what a client is told is only whether one is held.

### Protocol
Which wire language a Backend speaks: Ollama's native API, or the OpenAI-compatible
`/v1/chat/completions` shape that llama.cpp, LM Studio, vLLM and the hosted APIs all answer.

Worked out rather than declared — the endpoint is asked what it is, and the answer is remembered per
endpoint. A failure is not remembered, so a server that starts later is still found. Naming a
protocol by hand overrides the question permanently and is the escape hatch for when the answer is
wrong, not the expected route.

Ollama keeps its native API even though it also answers the OpenAI shape, and a server that answers
both is read as Ollama. That is not a preference: the OpenAI schema has no field for the per-request
context window, which every request HAL makes sets and which Context Level sizes itself against.
Under any other Backend the window is whatever the server was started with, and HAL says which of the
two it is rather than letting the control quietly mean something weaker.

## Prompts

### System Prompt
The standing instruction HAL is given ahead of the messages in a request — its voice, and for
narration also the tag glossary and the rule against inventing activity. It is the user's text, not
the product's: it can be edited freely, including the parts that keep narration honest, and reset
back to what shipped.

There are four: one for narration, one seeding each Conversation, one for Monitors, and one for
Vision. The narration prompt's tag glossary describes coding-agent log entries, so a Monitor needs
its own — pointing it at a machine log would have HAL interpreting tags that will never appear, and
Vision's describes frames it never sees.

Vision also configures a prompt that is not a System Prompt at all: the caption prompt is addressed
to the Captioner rather than to HAL, and asks a small vision model what to report about a frame.

The narration and Monitor prompts default the same way: each is one setting — the narration one
shared by every Adapter, the Monitor one by every Monitor — and while unedited it tracks whatever
the current release ships, so an improved default arrives on its own.

### Template
The text a message is rendered from, one per role and per message. Literal words the user
wrote, Slots that pull a live reading in, and Conditional Blocks that decide what survives.

There is one for every message HAL sends: the conversation context, and both halves of
narration, Monitors and Vision, plus the Captioner's question — and the six settings-level
prompts, which are Templates with their own field lists rather than roles. A stored `null` means never
edited and resolves to what the release ships, the same convention the System Prompts
follow. Editing one changes wording *and* placement, because a reading renders where its
Slot is typed — order stopped being a decision in code.

What a Template cannot do is compose. Joining the surviving sections, omitting the preamble
when nothing sits beneath it, and giving back lines to make room for a truncation notice all
stay inside the Slot renderers. Reaching them would mean a language with expressions in it,
and the whole argument for this shape is that there are none.

### Slot
One live reading, named in braces, rendering where it is typed. Some take a count —
`{session_remarks[5]}`.

The vocabulary is per role, plus a universal tier every role gets without listing it —
`{clock}`, `{date}`, `{model}` (the model *this* message is going to) and `{backend}`. Naming
a Slot a role does not have is refused when the Template is applied rather than rendered as
nothing. A universal Slot carries no budget source of its own, which is not the same as being
free: placed inside a budgeted section it charges that section. Each Slot carries what it means and what its wording is protecting, because a frame
exposed for editing with its reasoning stripped makes reintroducing a measured failure the
easy path.

A Slot that spends from a budget is charged what it renders, and literal text around it is
charged too — a long heading costs the same as a long remark. Chat charges per source, so
exhausting sight leaves the session share untouched.

### Phrase
One line inside a message, as text you can edit. A Template says where a reading goes; a Phrase
says how one line of that reading reads — one face, one remark, one person, one log line.

Phrases are Templates too, with their own small field lists and the same engine: same braces, same
`{{` escape, same Conditional Blocks, same refusal of a field that does not exist. A second
substitution syntax would be a second thing to learn and a second place for the two to disagree.
They are not simply more Slots because a Slot is placed *once* in a message while a Phrase is used
once *per item*, so their fields have nothing to bind to in a role's vocabulary.

Each carries what it protects and which measured failure produced it, for the same reason a Slot
does: a line exposed for editing with its reasoning stripped makes reintroducing a measured failure
the easy path.

### Wording and Format
The line between what gets a Phrase and what does not, because the audit that found five uncovered
strings would otherwise be redrawn somewhere else by the next one.

**A Phrase covers a string that makes a claim. A format renders a value the reader reads back.**
Change a Phrase and a model is told something different; change a format and a model is told the
same thing in a different notation.

By that test `[severe] `, `[assistant] `, `[Dave 71%] `, ` and `, ` (tools: …)` and every truncation
notice are claims — about a line's importance, about who spoke, about who is in frame, about what
is missing — and all are Phrases. Durations (`3 minutes`), clock times (`14:22:07`) and entry stamps
(`Aug 9 14:22:07`) are notation: they have one correct shape and a reader would have to be *wrong*,
not merely differently-minded, to change it. `relativeAge`'s singular/plural is named here
explicitly because it sits on the line and looks like wording — it is not; it is grammatical
agreement with a number, and it is a format.

The Session's own name — `Claude Code [a408c0a1]` — is a format, and it is the case worth stating.
It is not message wording: it is what an entry is *called*, stamped on the entry, rendered in the
Narration Feed and only *also* quoted into a message through `{session_label}`. An editor in the
prompt drawer would make the feed and the message disagree about what a session is called. What is
a Phrase is the sentence used when nothing has named it yet, which a model reads and the feed never
shows.

Nothing asserts this in prose any more. `server/test/templates/surface.test.ts` scans the
message-building files for strings a person wrote — interpolated literals, literal joins, and
prose — and fails on any that is neither a Slot, a Phrase, nor named on its recorded list as a
format, structure, not-model-facing, or an oracle. There is deliberately no `wording` category:
a string that tells a model something gets a Phrase or the test stays red.

What it does NOT claim: that every file is scanned. It nominates candidates by four signals —
renders, requests, reports, feeds — and each must be either scanned or excluded with a written
reason. The exclusions are the honest part of the guarantee, and an exclusion for a file nothing
nominates fails too. Shipped Template and Phrase defaults are exempted by asking the catalogues
what they actually ship, rather than by a claim about syntax.

### Conversation Prompt
A Conversation's own standing instruction, and a Template like everything else — but one a
thread opts into rather than one it is given.

A prompt written before Templates existed is read literally, because its braces were typed when
braces meant braces and reading them as Slots would silently drop them. Saving it through the editor
escapes them and turns that thread into a Template; nothing is migrated behind anyone's back.

Its vocabulary is the whole conversation-context one, so a thread can place a reading itself rather
than only deciding where the block sits. That was two names once — the individual Slots were kept out
so a reading could reach a request only through the path that budgets it, gates it and registers
Character Profile text for redaction. The hazard was two renders with two ledgers, not repetition, so
the two renders became one: a reading named in the prompt and again inside `{context}` is drawn once,
charged once against the same Context Level, and redacted once.

What that buys is per-thread arrangement, which no editor change could give. The conversation-context
Template is a single global setting; a Conversation Prompt is per thread. A thread that wants the
caption above and the rest beneath could not have it without changing every other thread.

`{context}` still means the whole block in the conversation-context Template's own order. Leave it
out and the block is appended beneath, as it always was — unless the prompt placed a reading of its
own, in which case it gets exactly what it placed rather than everything twice.

### Observation Source
One kind of thing a Conversation can be told about, each with its own Context Level. Three: what HAL
can see, what it has been saying about the Watched Session, and what it has been saying about the
Monitors.

The third was invisible for a reason worth stating: the Narration Feed has always carried Monitor
entries, and the session block filters on a session id a Monitor does not have — so they were
excluded by construction rather than by choice. Off by default, because a machine log is watched for
the exception and most cycles produce nothing worth carrying into a chat.

Sight is two readings, not one. Who is in view empties the moment somebody leaves; who was
recognised lately is read from the record of checks and states an age on every line, because without
one it would read as a claim about the present and contradict a room HAL can see is empty.

### Context Group
`{context}` in a Conversation Prompt, expanded in place and droppable whole.

Not a Conditional Block, though it looks like one from outside. A Block holds when the Slot of its
own name produced text, and a Group has no such Slot — it *is* the expansion. A Block drops only when
its body is empty, and a Group must drop while its body still holds a preamble and headings, because
those are not observations. What decides a Group is whether an observation reading reached the output
inside it, judged from every emission in order rather than from the deduplicated list: a reading named
in the prompt and again inside the Group appears in that list once, at the earlier mention, outside.

Wrapping it — `{#context}…{context}…{/}` — makes the wording part of the Group rather than a Block
around it, which is what keeps the wording and the block from disappearing together.

### Conditional Block
`{#slot}…{/}` — wording that goes when the Slot it names has nothing to say.

This is what keeps a heading from appearing above nothing. The alternative was a renderer
that silently dropped lines whose Slots came back empty, which is a hidden rule inside a
feature whose purpose is removing hidden rules. A Block that drops takes one following line
break with it, which is what lets sections sit a blank line apart while the lines inside one
sit single-spaced.

A Block is also how one branch is chosen from several. The language cannot compare a value,
so each branch has its own Slot that resolves set or empty — a Monitor's three reasons, a
Vision cycle's four sensitivities. Such a Slot renders nothing on its own, so typing the bare
name cannot leak a marker word into a prompt.

A Conversation's is the exception. It is a copy taken when that Conversation is created, so editing
the default that seeds new Conversations never rewrites a thread already under way. A blank
Conversation prompt is not an empty instruction: HAL sends no system message at all.

## Chat

### Conversation
A persistent chat thread between the user and HAL, owning its own message history, model, System
Prompt, and Conversation Context.
Distinct from a Session in every way: the user is a participant, HAL generates the replies, and it
is created deliberately rather than discovered.

### Conversation Context
What a Conversation is told about the world at the moment it sends: what HAL can see, and what HAL
has been saying about the Watched Session. Two switches, set per Conversation and off unless asked
for, so a thread started before the feature is unchanged.

Assembled per request and never written to the Conversation. Persisting it would put Character
Profile text beyond the reach of deletion and freeze the Gallery at the moment the thread was
created, so a rename would never reach a thread already under way.

It is named as HAL's own faculty before any of it arrives — sight, and a memory of what it has lately
been remarking on — rather than delivered as a report. Unheaded, it read as material handed over for
comment, and HAL answered it: asked anything at all, it summarised the room back instead of simply
knowing which room it was in. A faculty is not a question, and the framing is descriptive rather than
instructional because a rule about the input becomes the subject of the output.

The sight half is the newest caption plus the live Appearance set, not a fresh capture: a capture at
send time would be current at the cost of seconds of latency and a new way for a reply to fail. It
is also the one place a caption reaches a Conversation, which the cycle summary was meant to
prevent — but a summary says nothing at all on a quiet cycle, which is exactly when someone asks
what HAL can see. The caption therefore arrives quoted and dated as a look, never asserted as fact.

### Context Level
How much of one source a Conversation takes, as a share of the model's window rather than a fixed
size.

Rendered to the user as the characters it permits, which is the useful unit, but stored as the share
because the window belongs to the model and the model is chosen per Conversation. Installed models
span two thousand tokens to a quarter of a million: one fixed character count would be a rounding
error on one and most of the window on another. Both sources at their largest take half the window,
leaving the rest for the System Prompt and the history.

The window a request may actually use is the smaller of what the model was trained for and what the
machine is willing to allocate — a model advertising a quarter-million tokens is not offering that
much KV cache on a card already holding the narration model. A model that will not say falls back to
a small conservative window, because unknown reading as unlimited is how a System Prompt gets
evicted.

Where that window came from is stated, because it means three different things. HAL *requests* it per
request on Ollama, so the number is a promise it keeps. Any other Backend *reports* one it was
started with, which HAL cannot change — a request needing more simply overflows. When nothing can
say, the cautious default applies. A control whose meaning changes silently with a setting elsewhere
is the failure the per-request window exists to prevent.

### Off-Machine Acknowledgement
The user's recorded acceptance that identity data may leave this machine — enrolled names, Character
Profiles, a record of who was in the room, and HAL's commentary on observed Sessions.

Checked against the Backend *this* send resolves to, at the moment of sending, not when a switch is
turned on. Gating the switch would guard the switch and give every later send away, so configuring a
remote provider afterwards would carry the data out on the strength of an older decision. It is per
role for the same reason it is per send: chat sending locally is not gated because narration is
remote, and chat sending remotely is gated even while the others stay local.

There are three senders — a Conversation's context, the Recogniser, and Vision's cycle summary — and
they all pass through one check, because the bug this replaced was a sender that simply never got
one. A named gate makes an omission legible: a sender that does not call it is a sender that does not
mention consent at all.

An endpoint that cannot be parsed is treated as remote: it is not a local endpoint with a typo, it is
one nobody has established anything about. Withholding never fails the send — HAL says less rather
than refusing to answer, so a withheld Vision cycle still remarks on the scene without saying who was
in it.

## Flagged ambiguities

- "Session" had been used for both an observed coding-agent Session and a HAL chat Conversation —
  these are distinct, and only the former is watched.
