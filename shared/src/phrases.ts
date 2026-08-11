// The lines a slot renderer builds, as text you can edit.
//
// A template says where a reading goes. A phrase says how one line of that
// reading is worded — "someone who looks like Ada 55%", "(214 earlier remarks
// not recalled here.)", "You know Ada, whose machine this is: …". They were the
// last human-chosen words in this product reaching a model with no editor.
//
// They are templates too, with their own small field sets, rendered by the same
// engine: same braces, same `{{` escape, same conditional blocks, same refusal
// of a field that does not exist. A second substitution syntax would be a
// second thing to learn and a second place for the two to disagree.
//
// Why phrases are not simply more slots: a slot is placed once in a message,
// while a phrase is used once PER ITEM — per face, per remark, per person. They
// are a different unit, and mixing them would put per-item fields in a
// vocabulary where they have nothing to bind to.

import { renderTemplateText, type SlotSpec } from "./templates.js";

export const PHRASE_GROUPS = ["sight", "session", "monitor", "narration", "people"] as const;
export type PhraseGroup = (typeof PHRASE_GROUPS)[number];

export interface PhraseSpec {
  id: string;
  group: PhraseGroup;
  label: string;
  /** What this line is for, in one sentence. */
  meaning: string;
  /** What its wording protects, and which measured failure produced it. */
  note: string;
  fields: readonly SlotSpec[];
  shipped: string;
}

const f = (name: string, meaning: string, condition = false): SlotSpec => ({
  name,
  meaning,
  note: "",
  ...(condition ? { condition: true } : {}),
});

export const PHRASES: readonly PhraseSpec[] = [
  // -- sight ---------------------------------------------------------------
  {
    id: "sight.camera_off",
    group: "sight",
    label: "the camera is off",
    meaning: "stands in for the whole sight section when Vision is not watching",
    note:
      "Whether HAL is looking is not the same claim as whether anyone is there. A line saying 'nobody is in view' with the camera off would be inventing an observation.",
    fields: [],
    shipped: "I am not looking at anything right now; my camera is off.",
  },
  {
    id: "sight.nobody_placed",
    group: "sight",
    label: "watching, nobody recognised",
    meaning: "used when the camera is on and face detection placed no one",
    note:
      "Claims what recognition knows and nothing more. This comes from face detection, so it means 'no face I can place', not 'the room is empty'. Worded as the latter it outranked a caption describing someone sitting in frame, and HAL called an occupied room empty.",
    fields: [],
    shipped:
      "I am watching, and no face I can place is in view; that is not the same as nobody being there.",
  },
  {
    id: "sight.face_line",
    group: "sight",
    label: "one person in view",
    meaning: "one line per face the camera can currently place",
    note:
      "The percentage is supplied bare. An earlier version explained it — 'a percentage is how strongly that face matched, nothing more' — and the model escalated the gloss into a prohibition it invented and then obeyed against its own data, refusing to name someone it had recognised for two minutes.",
    fields: [
      f("who", "the person, in whatever form their identity band allows"),
      f("held", "how long they have been continuously recognised, when known", true),
      f("age", "that duration in words, e.g. '6 minutes'"),
      f("run", "how well a run of checks supports them, when known", true),
      f("strength", "that support in words, e.g. 'steadily across that whole run'"),
    ],
    shipped: "- {who}{#held}, recognised without a break as the same person for {age}{/}{#run}, {strength}{/}.",
  },
  {
    id: "sight.run_strong",
    group: "sight",
    label: "a well-supported run",
    meaning: "how a person recognised repeatedly over a stretch is described",
    note:
      "Rendered as words rather than a second percentage: two numbers side by side invite the model to compare them, and they measure different things.",
    fields: [],
    shipped: "steadily across that whole run",
  },
  {
    id: "sight.run_building",
    group: "sight",
    label: "a run still building",
    meaning: "the middle band of run support",
    note: "See the note on the well-supported run.",
    fields: [],
    shipped: "though the run is still building",
  },
  {
    id: "sight.run_thin",
    group: "sight",
    label: "a run of a check or two",
    meaning: "the weakest band of run support",
    note: "See the note on the well-supported run.",
    fields: [],
    shipped: "on only a check or two so far",
  },
  {
    id: "sight.unrecognised",
    group: "sight",
    label: "a face that matched nobody",
    meaning: "stands in for a name when recognition placed the face below the recognition threshold",
    note:
      "Never a guess at the nearest person. Below the recognition threshold a face is unrecognised, and saying so plainly is what stops a marginal match becoming a name.",
    fields: [],
    shipped: "someone I do not recognise",
  },
  {
    id: "sight.hedged_identity",
    group: "sight",
    label: "an uncertain match",
    meaning: "how a name reads when the match sits between the two identity thresholds",
    note:
      "Naming the wrong human is worse than miscounting a cup. The hedge is applied to the model's INPUT rather than asked of it in a prompt, because a rule requesting care is the lever this project has measured failing three times. Note that this is the input half only: the check on what the model WRITES still looks for the shipped wording, so rewording here does not reword that, and the two can disagree on an uncertain match.",
    fields: [f("name", "the enrolled name"), f("percent", "the match confidence, e.g. ' 55%'")],
    shipped: "someone who looks like {name}{percent}",
  },
  {
    id: "sight.stated_identity",
    group: "sight",
    label: "a confident match",
    meaning: "how a name reads at or above the statement threshold",
    note: "The bare name, with the number that earned it.",
    fields: [f("name", "the enrolled name"), f("percent", "the match confidence, e.g. ' 74%'")],
    shipped: "{name}{percent}",
  },
  {
    id: "sight.faces_truncated",
    group: "sight",
    label: "more people than fitted",
    meaning: "the notice when the budget could not hold every face",
    note:
      "A bound that silently drops its own 'I dropped things' notice is worse than no bound: the result reads as a complete list.",
    fields: [f("count", "how many were left out"), f("plural", "'s' when that is more than one")],
    shipped: "- ({count} other{plural} in view, not listed here.)",
  },
  {
    id: "sight.last_look",
    group: "sight",
    label: "the most recent description of the room",
    meaning: "the one part of the sight section that is not current",
    note:
      "Quoted and dated rather than asserted, because it comes from a small vision model that invents object counts. Its own age is stated separately from the live readings: with only the caption carrying a time, HAL applied that age to everything and said it could not know what had happened, about a reading taken that same second.",
    fields: [f("when", "how long ago, and the clock time"), f("caption", "what the captioner said")],
    shipped:
      'Separately, and this is the one thing above that is not current — my last description of the room, {when}: "{caption}"',
  },

  {
    id: "sight.look_age",
    group: "sight",
    label: "how old a description of the room is",
    meaning: "fills the 'when' of the most-recent-description line — the relative age and the clock together",
    note:
      "Both, not either. The age is what the model should reason with; the clock is what a person checks against their own, and without it '14 seconds ago' cannot be audited at all — which is the state that sent someone looking for a bug in the file read. Supplying a clock is a known risk taken deliberately: timestamps have become the subject of narration before.",
    // Not `{clock}`: that is a universal reading every Template gets, and a
    // phrase field of the same name would shadow it on the one path that is
    // deliberately explicit-vocabulary only.
    fields: [f("age", "how long ago, in words, e.g. '4 minutes'"), f("time", "the wall-clock time, e.g. '18:22:04'")],
    shipped: "{age} ago at {time}",
  },
  {
    id: "sight.look_age_unknown",
    group: "sight",
    label: "a description with no usable time",
    meaning: "stands in for the age when the stored timestamp cannot be read",
    note:
      "Says the time is unknown rather than omitting it. A caption that simply arrives with no age reads as current, and the whole point of quoting and dating this line is that it is the one thing in the section that is not.",
    fields: [],
    shipped: "at an unknown time",
  },
  {
    id: "sight.caption_line",
    group: "sight",
    label: "who was in a captioned frame",
    meaning: "prefixes one caption with the people recognised in that frame, on the way into the Vision summariser",
    note:
      "This is how identity reaches the summariser at all, and it is why {vision_faces} is not offered in the Vision prompt: what the summariser is given is per-FRAME, interleaved with the captions, not one roster for the cycle. A cycle-level list would say who was seen without saying which description they were in, and the summariser's whole job is to say what happened when. Bare names with no bracket were tried and the summariser read them as part of the scene, describing 'a person called Dave 71%' as though the number were painted on the wall. Dropped entirely when consent to name people off this machine is withheld — the scene is still described, only who was in it is withheld.",
    fields: [f("names", "who was recognised in this frame, already banded and already joined"), f("caption", "what the captioner said about the frame")],
    shipped: "[{names}] {caption}",
  },
  {
    id: "sight.identity_join",
    group: "sight",
    label: "between two people in one reading",
    meaning: "what separates two names in a caption prefix, and in an observation's own identity record",
    note:
      "One phrase for both, because two copies of a separator is how they drift. Worded rather than punctuated — a comma-separated list of names read as one compound name to a small vision model, which then described a single person by both.",
    fields: [],
    shipped: " and ",
  },

  {
    id: "sight.recent_person",
    group: "sight",
    label: "someone seen recently",
    meaning: "one line per person recognised lately, whether or not they are still here",
    note:
      "Says when, because that is the whole difference from the live list: without an age this reads as a claim about the present and would contradict a room HAL can see is empty. Banded by what the check actually found, so a marginal reading is attributed here exactly as it would be live.",
    fields: [f("who", "the person, in whatever form their reading allows"), f("ago", "how long since that reading, in words")],
    shipped: "- {who}, last seen {ago} ago",
  },

  // -- session -------------------------------------------------------------
  //
  // No heading here. The heading above the remarks is literal text in the
  // conversation-context template, where it is already editable — a phrase for
  // it would be a second control for one string, and the one in settings would
  // have changed nothing.
  {
    id: "session.remark_line",
    group: "session",
    label: "one remark",
    meaning: "one line per thing HAL said about the watched session",
    note:
      "The stamp is the clock alone for anything from today, with a date added only for another day — a bare clock on an older entry reads as this morning and is wrong by however long HAL was off.",
    fields: [f("stamp", "when it was said"), f("text", "what HAL said")],
    shipped: "- [{stamp}] {text}",
  },
  {
    id: "session.gap",
    group: "session",
    label: "time HAL was not watching",
    meaning: "what HAL says about a stretch of a session that ran while it was away",
    note:
      "Reaches a model as well as the feed: a gap entry carries the session id, and the remarks slot filters on that id alone, so this arrives in chat context as one of HAL's own remarks. Says the attention lapsed rather than summarising what was missed, because HAL has no record of it — a sentence that implied otherwise would be an invented observation. Carries the session's name but no adapter colour: colour marks whose voice is speaking, and this is HAL speaking about itself.",
    fields: [],
    shipped: "My attention lapsed while I was away, and the session continued without me. I resume observation now.",
  },
  {
    id: "session.label_unknown",
    group: "session",
    label: "the watched session, unnamed",
    meaning: "stands in for the session's name when HAL is watching one but nothing has stamped a name on it yet",
    note:
      "Says what is true — something is being watched — rather than leaving the sentence around it holding an empty name. The session's name itself is not a phrase: it is stamped onto each entry and rendered in the feed as well as quoted into a message, so the two would disagree. This is the one part of that sentence a model reads and nothing else does.",
    fields: [],
    shipped: "the session I am watching",
  },
  {
    id: "session.remarks_truncated",
    group: "session",
    label: "more remarks than fitted",
    meaning: "the notice when the budget could not hold every remark",
    note: "Room is made for this by giving back the remarks it reports on, for the same reason the sight notice is.",
    fields: [f("count", "how many were left out"), f("plural", "'s' when that is more than one")],
    shipped: "({count} earlier remark{plural} not recalled here.)",
  },

  // -- monitor -------------------------------------------------------------
  {
    id: "monitor.remark_line",
    group: "monitor",
    label: "one remark about a log",
    meaning: "one line per thing HAL said about a Monitor",
    note:
      "A Monitor carries no project identity, so its label is the only thing naming what is being reported on — which is why the line names it and the session line does not.",
    fields: [f("stamp", "when it was said"), f("label", "which Monitor"), f("text", "what HAL said")],
    shipped: "- [{stamp}] {label}: {text}",
  },
  {
    id: "monitor.remarks_truncated",
    group: "monitor",
    label: "more log remarks than fitted",
    meaning: "the notice when the budget could not hold every remark",
    note: "Room is made for it by giving back the remarks it reports on, the rule every bound here follows.",
    fields: [f("count", "how many were left out"), f("plural", "'s' when that is more than one")],
    shipped: "({count} earlier log remark{plural} not recalled here.)",
  },

  {
    id: "monitor.status_readable",
    group: "monitor",
    label: "a log HAL can read again",
    meaning: "what HAL says when a Monitor's source comes back after being unreadable",
    note:
      "Reaches a model as well as the feed, which is why it is a Phrase and not a UI string. A Monitor's status entries carry its id, and the remarks slot that feeds a Conversation filters on that id alone — so this sentence turns up in chat context as one of HAL's own remarks. Said on the transition only: a file missing for an hour polls 120 times, and 120 identical entries would bury real narration in a bounded ring.",
    fields: [f("label", "which Monitor")],
    shipped: "{label} is readable again.",
  },
  {
    id: "monitor.status_failed",
    group: "monitor",
    label: "a cycle HAL could not narrate",
    meaning: "what HAL says when the model could not be reached for one Monitor's batch",
    note:
      "Reaches a model as well as the feed, for the same reason the readable line does. Says the attempt failed rather than replaying the lines later: narrating stale log lines once a provider recovers would report the past as the present.",
    fields: [f("label", "which Monitor"), f("reason", "what went wrong, in the provider's own words")],
    shipped: "I could not narrate {label} just now: {reason}",
  },
  {
    id: "monitor.event_line",
    group: "monitor",
    label: "one line from a watched log",
    meaning: "how a single line a Monitor picked up is presented to the narrator",
    note:
      "The severity marker is a REPORT, not an instruction. Severity is judged before any model sees the line — by the Monitor's own rule, on the text — so this marks what was already decided rather than asking for a reaction to it. Written as a prefix rather than a sentence for that reason: 'this line is important' invites the model to argue with it, and a tag does not. The source is named only when the line carried one, because an empty label reads as a source called nothing.",
    fields: [
      f("severity_marker", "the marker for a severe line, already spaced — empty for a routine one"),
      // `source_label` and not `source`, for the reason the narration line uses
      // `tool_list`: this holds the rendered clause, and `source` is the bare
      // name one phrase down.
      f("source_label", "which source within the Monitor emitted this, already punctuated — empty when it named none"),
      f("text", "the line itself"),
    ],
    shipped: "{severity_marker}{source_label}{text}",
  },
  {
    id: "monitor.severe_marker",
    group: "monitor",
    label: "the marker on a severe line",
    meaning: "what precedes a line the Monitor's own rule judged severe",
    note: "Carries its own trailing space, because the line it precedes has none to give.",
    fields: [],
    shipped: "[severe] ",
  },
  {
    id: "monitor.line_source",
    group: "monitor",
    label: "which source a line came from",
    meaning: "how a line names its source inside a Monitor that watches several",
    note: "Carries its own separator and trailing space. Dropped whole when the line named no source.",
    fields: [f("source", "the source's name")],
    shipped: "{source}: ",
  },
  {
    id: "monitor.lines_omitted",
    group: "monitor",
    label: "more lines than fitted",
    meaning: "the notice when the char budget could not hold every line the Monitor picked up",
    note:
      "Stands above the lines that survived. A bound that silently drops its own 'I dropped things' notice is worse than no bound: the batch would read as everything the log said. Counts lines dropped by the budget together with those already dropped upstream, because the reader cares how much is missing and not which stage lost it.",
    fields: [f("count", "how many lines were left out")],
    shipped: "({count} further lines omitted)",
  },

  // -- narration -----------------------------------------------------------
  //
  // The log lines the narrator reads, rather than anything it says. The
  // narration system prompt contains a glossary of exactly this format — it
  // names the tags and it names `(tools: Name(target))` — and that glossary is
  // editable. Until these phrases existed only half the contract was: an editor
  // could rewrite the explanation while the lines it described stayed put, or
  // the lines could be changed in code and leave the explanation quietly wrong.
  // Change either and read the other.
  {
    id: "narration.event_line",
    group: "narration",
    label: "one line from the watched log",
    meaning: "how a single event from the coding session is presented to the narrator",
    note:
      "The tag is what the narration prompt's glossary explains — [user], [assistant], [thinking], [tool-result], [system] — so retagging here means rewording that prompt, and the two live in the same drawer for that reason. A bare line with no tag was tried first and the narrator attributed the developer's own requests to the agent.",
    fields: [
      f("kind", "which sort of event this is, e.g. 'assistant'"),
      f("text", "the event's text, whitespace already collapsed to single spaces"),
      // Not a condition field. A condition renders nothing inline, and this one
      // carries the annotation's own text — declaring it one silently dropped
      // every tool list from the narrator's input while the line still looked
      // well-formed.
      // Named for what it holds — the whole rendered annotation — rather than
      // `tools`, which is the bare joined list one phrase down. Two fields of
      // one name meaning two different things is a trap for the editor and for
      // the preview, which samples by field name.
      f("tool_list", "the tool annotation, already worded and already spaced — empty when the event called nothing"),
    ],
    shipped: "[{kind}] {text}{tool_list}",
  },
  {
    id: "narration.tool_list",
    group: "narration",
    label: "what a line's tools were",
    meaning: "the annotation appended to an event that invoked tools",
    note:
      "Carries its own leading space, because the line it joins has none to give — the event text ends where the author's text ended. The narration prompt's glossary quotes this shape verbatim as '(tools: Name(target))'.",
    fields: [f("tools", "the tools invoked, already joined")],
    shipped: " (tools: {tools})",
  },
  {
    id: "narration.list_join",
    group: "narration",
    label: "between items in a line",
    meaning: "what separates two tools in one annotation, and two counts in the omitted-events notice",
    note:
      "One phrase for both, because two copies of a separator is how they drift apart — and a reader seeing 'Read, Edit' in one line and 'Read; Edit' in the next would reasonably assume the difference meant something.",
    fields: [],
    shipped: ", ",
  },
  {
    id: "narration.events_omitted",
    group: "narration",
    label: "more events than fitted",
    meaning: "the notice when the char budget could not hold every event verbatim",
    note:
      "Stands where the dropped events were — first, because they were the oldest. A bound that silently drops its own 'I dropped things' notice is worse than no bound: the batch would read as the session's complete activity. Says what KIND was dropped as well as how many, so the narrator can tell a lost tool-result from a lost thought.",
    fields: [f("count", "how many events were left out"), f("kinds", "a tally per kind, already joined")],
    shipped: "…plus {count} earlier events not shown ({kinds}).",
  },
  {
    id: "narration.omitted_kind",
    group: "narration",
    label: "one entry in that tally",
    meaning: "how a single kind's dropped count reads inside the omitted-events notice",
    fields: [f("count", "how many of this kind"), f("kind", "which kind, e.g. 'thinking'")],
    note: "Bare count and kind. The notice around it already says these were omitted, and repeating that per entry made the line longer than the events it stood for.",
    shipped: "{count} {kind}",
  },

  // -- people --------------------------------------------------------------
  {
    id: "people.operator",
    group: "people",
    label: "who HAL is talking to",
    meaning: "how the operator's character profile is introduced",
    note:
      "Phrased as something HAL knows rather than a document it was given: calling the captions 'what your eye reported' made the model discuss the report instead of the room, and a heading like 'context about people' is that same mistake waiting to happen.",
    fields: [f("name", "their name"), f("profile", "what you wrote about them")],
    shipped: "You know {name}, whose machine this is: {profile}",
  },
  {
    id: "people.other",
    group: "people",
    label: "someone else HAL knows",
    meaning: "how anyone else's character profile is introduced",
    note: "See the note on the operator's line.",
    fields: [f("name", "their name"), f("profile", "what you wrote about them")],
    shipped: "You know {name}: {profile}",
  },
  {
    id: "people.truncated",
    group: "people",
    label: "more people than fitted",
    meaning: "the notice when the budget could not hold every profile",
    note: "The operator is listed first, so if anything is cut it is not the person HAL is actually talking to.",
    fields: [f("count", "how many were left out"), f("plural", "'people' or 'person'")],
    shipped: "(I know {count} other {plural}, not recalled here.)",
  },
  {
    id: "people.closing",
    group: "people",
    label: "the closing instruction, narration only",
    meaning: "appended after the profiles when HAL is narrating a Vision cycle",
    note:
      "Narration keeps it: that prompt exists to produce commentary ABOUT people from what a camera saw, and this is what stops profile detail being narrated as observation. A Conversation drops it — there the person is in the conversation, and a standing rule to speak of them only as far as sight supports turns ordinary talk stilted.",
    fields: [],
    shipped: "Speak about them only as far as what you saw supports.",
  },
];

export type PhraseId = (typeof PHRASES)[number]["id"];

export type PhraseSettings = Partial<Record<string, string | null>>;

const BY_ID = new Map(PHRASES.map((p) => [p.id, p]));

export function phraseSpec(id: string): PhraseSpec | undefined {
  return BY_ID.get(id);
}

/**
 * Render one phrase.
 *
 * A stored `null` or an unknown id falls back to what shipped, the same
 * convention every other prompt here follows. Rendering goes through the
 * template engine so a phrase gets conditional blocks and brace escapes for
 * free — `{#held}…{/}` is what lets the face line drop its duration clause when
 * there is no duration.
 */
export function renderPhrase(
  id: string,
  stored: PhraseSettings | undefined,
  values: Readonly<Record<string, string>>,
): string {
  const spec = BY_ID.get(id);
  if (!spec) return "";
  const text = stored?.[id] ?? spec.shipped;
  return renderTemplateText(text, {
    vocabulary: spec.fields,
    // A phrase is one line. Collapsing blank runs here would reach inside a
    // substituted value and reflow it — which is how a multi-line Character
    // Profile stopped matching the string withheld from the inference log.
    normalize: false,
    resolve: (req) => ({ text: values[req.name] ?? "" }),
  }).text;
}
