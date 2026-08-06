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
it works. HAL never participates in a Session — it only watches one.
*Avoid:* "the session" when a Conversation is meant.

A Session is discovered rather than created: it exists because some other tool started working,
and it keeps existing after that tool exits. Every Session comes from one Adapter, and is grouped
with the others from the project it ran in.

### Watched Session
The single Session HAL is currently observing. At most one at a time, chosen by the user and
remembered across restarts.

Attaching always begins at the present moment, never at the start of the log — narration is about
what is happening now, not a replay of history. This holds for a first attach and a re-attach alike.

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
The running commentary HAL produces about the Watched Session, held as a bounded history so a
client that reconnects sees recent entries rather than an empty panel.

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
The rule that a user's chat request outranks narration when both want the single local model.

Narration in flight is aborted and its batch re-queued, so nothing observed is lost; chat is never
aborted by scheduling. This exists because one machine runs one model at a time, and a person
waiting on a reply must not queue behind commentary.

### Sticky Model
The model the narrator resolved when watching began and then holds onto, so that switching chat
conversations does not silently retarget narration to a different model.

## Prompts

### System Prompt
The standing instruction HAL is given ahead of the messages in a request — its voice, and for
narration also the tag glossary and the rule against inventing activity. It is the user's text, not
the product's: it can be edited freely, including the parts that keep narration honest, and reset
back to what shipped.

There are two, and they default differently. The narration System Prompt is one setting shared by
every Adapter, and while it is unedited it tracks whatever the current release ships — so an
improved default arrives on its own. A Conversation's is a copy taken when that Conversation is
created, so editing the default that seeds new Conversations never rewrites a thread already under
way. A blank Conversation prompt is not an empty instruction: HAL sends no system message at all.

## Chat

### Conversation
A persistent chat thread between the user and HAL, owning its own message history, model, and
System Prompt.
Distinct from a Session in every way: the user is a participant, HAL generates the replies, and it
is created deliberately rather than discovered.

## Flagged ambiguities

- "Session" had been used for both an observed coding-agent Session and a HAL chat Conversation —
  these are distinct, and only the former is watched.
