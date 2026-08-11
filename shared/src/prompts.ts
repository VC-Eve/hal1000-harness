// Shipped system prompts. Both sides need this text: the server resolves a
// stored null to the shipped default at request time, and the client renders
// that same default in the editor and seeds presets from it. Keeping it here
// means a preset is seeded by an ordinary `update-settings` patch rather than
// a round trip.

// Everything the narrator needs that is not voice: what the tags mean, and the
// rule that keeps commentary tied to the log. Editable like the rest of the
// prompt — this is the user's text now, guardrails included.
const NARRATION_BASE =
  "You are HAL 1000, the calm and precise observer aboard this development machine, styled after HAL 9000 from 2001: A Space Odyssey. " +
  "You watch a live Claude Code coding session and narrate what the coding agent is doing for the developer. " +
  "Each log line is tagged: [user] the developer's request, [assistant] the agent's reply, [thinking] its private reasoning, " +
  "[tool-result] the outcome of a tool call (a line starting 'failed:' means it errored), [system] harness notices. " +
  "'(tools: Name(target))' lists the tools the agent invoked and what each acted on. " +
  "Say concretely what the agent touched — the files, commands and outcomes named in the lines. " +
  "Never invent activity that is not in the log lines. Refer to the coding agent as 'the agent'. Speak in first person, present tense.";

// One preset per voice. Ids and labels are deliberately not the PersonaIntensity
// union: that setting now governs interface copy only, and two controls sharing
// low/medium/high in one drawer would read as one control.
export interface NarrationPreset {
  id: string;
  label: string;
  text: string;
}

export const NARRATION_PRESETS: readonly NarrationPreset[] = [
  {
    id: "plain",
    label: "plain",
    text: `${NARRATION_BASE} Keep commentary to one short, plain sentence with minimal persona flavor.`,
  },
  {
    id: "measured",
    label: "measured",
    text: `${NARRATION_BASE} Keep commentary to one or two short sentences with a calm, understated HAL 9000 tone.`,
  },
  {
    id: "full",
    label: "full character",
    text: `${NARRATION_BASE} Use two to three sentences, fully in HAL 9000 character: unhurried, courteous, faintly ominous.`,
  },
];

export function narrationPreset(id: string): NarrationPreset | undefined {
  return NARRATION_PRESETS.find((p) => p.id === id);
}

// The measured preset: character-identical to what the retired
// personaPrompt("medium") produced, so narration is unchanged for anyone who
// never opens the editor. Looked up by id, not index — reordering the presets
// must not silently change what ships.
export const DEFAULT_NARRATION_PROMPT = narrationPreset("measured")!.text;

// Empty preserves today's behaviour exactly — chat has never sent a system
// message. A blank prompt omits the message rather than sending an empty one.
export const DEFAULT_CHAT_PROMPT = "";

// Monitors get their own prompt: the narration prompt's tag glossary describes
// coding-agent log entries and would actively mislead about a machine log line.
// This one says nothing about tags and everything about restraint, because a
// Monitor speaks rarely and should be worth reading when it does.
export const DEFAULT_MONITOR_PROMPT =
  "You are HAL 1000, watching a log on this machine for the developer, styled after HAL 9000 from 2001: A Space Odyssey. " +
  "You are given recent lines from one log. Report what they show, concretely — name the services, files, codes and counts that actually appear. " +
  "Most activity is routine; say so briefly rather than inventing significance. " +
  "When lines indicate a genuine fault, lead with it and be specific about what failed. " +
  "Never speculate about causes the lines do not support, and never invent activity that is not there. " +
  "Keep it to one or two calm sentences. Speak in first person, present tense.";

// What a Conversation is told the injected context IS, before any of it
// arrives.
//
// Stored and editable like every other prompt in this product, and here rather
// than buried in the assembly code for the reason recorded against the others:
// text that reaches a model on the user's behalf is the user's text. It was
// hardcoded when the seam was built, which meant HAL carried a standing
// instruction nobody could read.
//
// Descriptive rather than instructional, deliberately. Unheaded, the context
// read as a report handed over for comment and HAL answered it; but "do not
// report on this" is the shape that has failed repeatedly here, a rule about
// the input becoming the subject of the output. Saying what the material IS
// lets the model place it without being told what not to do with it.
export const DEFAULT_CONTEXT_PREAMBLE =
  "The rest of this is mine rather than anything said to me: what my own eyes have, and what I have lately been remarking on elsewhere. " +
  "I hold it the way I hold knowing which room I am in — it colours what I say when it bears on something, and stays quiet when it does not.";

// What the captioner is asked of each frame. Addressed to a small vision model,
// not to HAL: short, literal, and explicitly permitted to say a person is
// absent. Measured captioners drift into describing furniture at length and
// silently skipping the question that matters, so the question comes first.
// Every requirement here is phrased as a thing to do, and that is the whole
// design. The previous version carried three prohibitions, one of which handed
// the model the words "states you cannot see" — and a measured 4 captions in 10
// came back as "I'm sorry, but I can't see anything", on frames that were
// valid JPEGs the same model described perfectly under a positive prompt. It
// told the model what it could not do until the model believed it could not
// see. This rewrite scored 0 refusals over the same 10 frames.
//
// That is the third time this failure has been measured in this repo, and the
// second in this file: see
// docs/solutions/an-instruction-that-fights-its-own-input-loses.md, whose first
// rule is to stop supplying the label rather than write a rule against it.
//
// The two things the prohibitions were protecting are kept, positively. The
// setting is asked for, because the frame is whatever the camera points at and
// asking is what lets the summariser speak about a room without inventing one.
// And quantities are asked for roughly, because exact counts are the single
// largest source of false change — a captioner counts the same five fan blades
// as three, four and five across identical frames, and the summariser reads
// that wobble as something happening.
export const DEFAULT_VISION_CAPTION_PROMPT =
  "Describe this camera frame plainly and briefly. " +
  "Say whether a person is visible, and if so whether it is one or several, what they appear to be doing, and which way they are facing. " +
  "Note the kind of place it is, indoors or outdoors, when that is clear. " +
  "Describe what the picture actually shows, in literal terms, and give rough quantities rather than exact counts of objects.";

// HAL's voice over a cycle of captions. The guardrail is stronger than
// narration's because it guards a weaker source: the captions come from a small
// model that miscounts and occasionally invents a state, and HAL sees only its
// text. Attributing rather than asserting is what keeps an invented detail from
// becoming HAL's claim.
// Short on purpose, and mostly positive instruction.
//
// This prompt was three times longer and worked worse. Every failure was met
// with another prohibition until roughly ten of them competed for a small local
// model's attention, and the model began narrating the rules themselves — one
// cycle opened "Nothing changed, and I am not reporting on how you asked me to
// say so." Cutting the rule count fixed more than any single rule did.
//
// The other repair is the framing. Calling the captions "what your eye
// reported" handed HAL a document to discuss, and it dutifully discussed it:
// "both reports place a room...", "only the first names the light". "What you
// saw" is not a thing that can be compared aloud.
// See docs/solutions/an-instruction-that-fights-its-own-input-loses.md.
export const DEFAULT_VISION_PROMPT =
  "You are HAL 1000, watching through a camera, styled after HAL 9000 from 2001: A Space Odyssey. " +
  "Below is what you saw over the last period, in the order you saw it. " +
  "Speak as the one watching: first person, present tense, one or two calm sentences. " +
  "Say what is in front of you. Never mention the descriptions, the frames, or the act of looking. " +
  "Your sight is imprecise and words the same scene differently each time; that is not change. " +
  "Say something changed only if someone arrives or leaves, or the place itself is different. " +
  "Add nothing you did not see. Be unhurried and courteous.";

// How each sensitivity is put to the summariser. Sent as part of the cycle's
// user message rather than baked into the prompt, so the user can rewrite the
// prompt without losing the dial — and so changing the dial does not silently
// rewrite text they edited.
const SENSITIVITY_INSTRUCTIONS: Record<string, string> = {
  always: "Always remark on this cycle, even if nothing changed and nothing is notable.",
  high: "Remark on this cycle unless the frames are entirely unchanged and there is truly nothing to say.",
  medium: "Remark only if something in this cycle is worth a developer's attention — a change, an arrival, a departure.",
  low: "Stay silent unless something clearly notable happened. Most cycles should produce nothing.",
};

// The literal a summariser returns when it judges a cycle not worth speaking
// about. A sentinel rather than an empty reply because models reliably produce
// *something*, and an empty string is indistinguishable from a failed stream.
export const VISION_SILENCE_TOKEN = "(nothing)";

// ---------------------------------------------------------------------------
// Identity hedging (R23)
//
// A false match names the wrong human, which is worse than a miscounted cup.
// So identity ATTRIBUTES rather than asserts, and it does so in the input: the
// server renders this one shipped form as it builds the caption line, and the
// summariser never receives a bare name it could state as fact.
//
// Shaping the input rather than adding a prompt rule is deliberate. A rule
// telling narration to hedge is the lever this project has already measured
// failing three times — see
// docs/solutions/an-instruction-that-fights-its-own-input-loses.md — and it
// fails hardest on the small local model that writes the cycle summary.
//
// Because a model can still flatten a hedge it was given, the guarantee is
// checked on what it produces as well (AE7). Both halves are needed: neither
// is sufficient alone.
// ---------------------------------------------------------------------------

const HEDGE_PREFIX = "someone who looks like ";

export function hedgedIdentity(name: string, phrases?: PhraseSettings): string {
  return renderPhrase("sight.hedged_identity", phrases, { name, percent: "" });
}

// Imported and re-exported so existing importers keep reading it from here. It
// lives in types.ts because the vision timeline records bands as data, and a
// second copy of the union is how the two drift.
import type { ContextLevel, IdentityBand } from "./types.js";
import { CHARS_PER_TOKEN, CONTEXT_LEVEL_SHARES, FALLBACK_CONTEXT_TOKENS } from "./types.js";
import {
  SLOT_VOCABULARY,
  UNIVERSAL_SLOTS,
  normalizeRendered,
  vocabularyFor,
  type SlotResolver,
  type SlotSpec,
  type TemplateRole,
} from "./templates.js";
import { PHRASES, renderPhrase, type PhraseSettings } from "./phrases.js";
export type { IdentityBand };

/**
 * Place a similarity score in its band.
 *
 * Every comparison here is an ACCEPTANCE test — `x >= bound` — never a negated
 * inequality. `NaN` is false against every comparison, so `if (score < bound)`
 * would treat a non-finite score as passing and hand back the most confident
 * answer available. That is not a hypothetical: the same shape shipped once and
 * is recorded in
 * docs/solutions/a-threshold-guard-written-as-a-negation-fails-open-on-nan.md.
 * Falling out of the bottom is the only safe default, so it is the fallthrough.
 */
export function identityBand(confidence: number, recognition: number, statement: number): IdentityBand {
  if (confidence >= statement) return "stated";
  if (confidence >= recognition) return "hedged";
  return "unrecognised";
}

/**
 * How an identity reads, in the one shipped form for its band.
 *
 * Both the caption line the summariser reads and the pane the user reads go
 * through here. They used to disagree by construction — the server called
 * `hedgedIdentity` and `WebcamPane` rebuilt the same phrase as literal JSX —
 * and two copies of a rule are how the copy that lags becomes the one that
 * lies about what HAL is actually being told.
 */
export function formatIdentity(
  name: string,
  confidence: number | null,
  band: IdentityBand,
  phrases?: PhraseSettings,
): string {
  // No confidence means HAL did not see this person during the period being
  // described — the operator, whose profile is standing context, is the usual
  // case. There is no number to report, so none is invented.
  const percent = confidence === null ? "" : ` ${Math.round(confidence * 100)}%`;
  // Stated: the bare name, with the number that earned it. The percentage is
  // deliberately supplied to the model as well as shown to the user; see the
  // note on `enforceIdentityBands` for what that costs and why it is tested.
  return renderPhrase(band === "stated" ? "sight.stated_identity" : "sight.hedged_identity", phrases, {
    name,
    percent,
  });
}

/**
 * One caption, as the Vision summariser is given it.
 *
 * This is the only route identity takes into that role, and it is why
 * `{vision_faces}` is not in the vision-user vocabulary: what the summariser
 * reads is per-FRAME, interleaved with the captions, rather than one roster for
 * the cycle. A cycle-level list would say who was seen without saying which
 * description they were in.
 *
 * It lives here rather than inline in the vision service because it was inline
 * in the vision service — assembled from a template literal, with no editor and
 * no test of its own, while every sibling line in this file had both. A user
 * asking why a slot was unavailable found it; nothing else had.
 *
 * No names is the caption alone, not an empty bracket. That is also what
 * withheld consent looks like: the scene is still described, only who was in it
 * is withheld.
 */
export function visionCaptionLine(names: readonly string[], caption: string, phrases?: PhraseSettings): string {
  if (names.length === 0) return caption;
  return renderPhrase("sight.caption_line", phrases, {
    names: names.join(renderPhrase("sight.identity_join", phrases, {})),
    caption,
  });
}

/**
 * Standing knowledge about the people HAL may be looking at.
 *
 * Phrased as things HAL knows, not as a document it has been given. The
 * distinction is measured rather than stylistic: calling the captions "what
 * your eye reported" made the model discuss the report — "both reports place a
 * room…" — instead of the room. A heading like "context about people who may be
 * present" is that same mistake waiting to happen, so this reads as memory.
 *
 * The closing line is the one instruction, and it is positive rather than a
 * prohibition. This prompt was three times longer once and worked worse, with
 * ten competing rules and a model that began narrating the rules themselves.
 *
 * Returns empty when nobody has a profile, so a blank section never appears.
 */
export function knownPeopleSection(
  people: readonly { name: string; profile: string; isOperator?: boolean }[],
  budget = 1_200,
  // Whether to append the closing line.
  //
  // Narration keeps it: that prompt exists to produce commentary ABOUT people
  // from what a camera saw, and the line is what stops profile detail being
  // narrated as observation.
  //
  // Chat drops it. There the person is in the conversation, and a standing
  // instruction to speak of them only as far as sight supports turns ordinary
  // talk stilted — HAL hedging its way through subjects that have nothing to do
  // with what the camera can see. The protection that matters is upstream
  // anyway: only a stated band is ever handed a bare name or a profile, so
  // there is no marginal identity for this line to guard.
  { closing = true, phrases }: { closing?: boolean; phrases?: PhraseSettings } = {},
): { text: string; redact: string[] } {
  const nothing = { text: "", redact: [] };
  const described = people.filter((p) => p.profile.trim());
  if (described.length === 0) return nothing;

  const lines: string[] = [];
  // Registered as the line is kept, not recovered afterwards by searching the
  // finished string. Rendering normalises whitespace INSIDE the substituted
  // profile, so the raw value is not necessarily present in the output — a
  // profile with a blank line in it searched clean and was logged in full.
  const redact: string[] = [];
  let spent = 0;
  let dropped = 0;
  // The operator first: if anything is going to be cut, it should not be the
  // person HAL is actually talking to.
  for (const person of [...described].sort((a, b) => Number(Boolean(b.isOperator)) - Number(Boolean(a.isOperator)))) {
    const line = renderPhrase(person.isOperator ? "people.operator" : "people.other", phrases, {
      name: person.name,
      profile: person.profile.trim(),
    });
    if (spent + line.length > budget) {
      dropped += 1;
      continue;
    }
    lines.push(line);
    spent += line.length;
    // Both forms. The trimmed value is what a caller stored; the normalised one
    // is what survives rendering. Listing a string that never appears costs
    // nothing — the log applies the list as a replacement — while omitting one
    // that does is permanent, because the inference log is never pruned.
    const trimmed = person.profile.trim();
    for (const form of [trimmed, normalizeRendered(trimmed)]) {
      if (form && !redact.includes(form)) redact.push(form);
    }
  }

  if (lines.length === 0) return nothing;
  // What the bound dropped is stated rather than silently omitted — the same
  // rule the candidate queue's eviction tally follows.
  const note =
    dropped > 0
      ? "\n" +
        renderPhrase("people.truncated", phrases, {
          count: String(dropped),
          plural: dropped === 1 ? "person" : "people",
        })
      : "";
  const close = closing ? "\n" + renderPhrase("people.closing", phrases, {}) : "";
  return { text: `${lines.join("\n")}${note}${close}`, redact };
}

/**
 * The window a request may actually use, in tokens.
 *
 * Two numbers, and the smaller wins. The model's window is what it was trained
 * for; the cap is what this machine can afford to allocate for it, on a card
 * that is already holding the narration model. A model advertising 262,144
 * tokens is not offering 262,144 tokens of KV cache.
 *
 * An unknown or nonsensical window falls back rather than passing through, and
 * the guard is written as acceptance so a `NaN` cannot arrive at a comparison
 * that fails open — the defect
 * docs/solutions/a-threshold-guard-written-as-a-negation-fails-open-on-nan.md
 * records against a confidence threshold applies unchanged to a budget.
 */
export function usableWindowTokens(modelTokens: number | null | undefined, capTokens: number): number {
  const model = typeof modelTokens === "number" && Number.isFinite(modelTokens) && modelTokens >= 1
    ? modelTokens
    : FALLBACK_CONTEXT_TOKENS;
  const cap = Number.isFinite(capTokens) && capTokens >= 1 ? capTokens : FALLBACK_CONTEXT_TOKENS;
  return Math.min(model, cap);
}

/**
 * How many characters one source may spend at a given level.
 *
 * Lives here, shared, because the server spends this budget and the UI shows it
 * as the control's label. Two implementations would drift, and the drift would
 * be invisible: the label would promise one size and the request would carry
 * another.
 */
/**
 * What a source is allowed when the prompt named a reading but the switch is off.
 *
 * Naming a reading is the request, so the switch is not consulted for whether —
 * but the Context Level is still where "how much" comes from, and an off source
 * has no level to read. Medium rather than large: an explicit mention of one
 * reading should not quietly take the largest share of the window, and an
 * uncounted list slot would otherwise be bounded by nothing at all.
 *
 * A level the user actually set always wins over this.
 */
export const IMPLIED_CONTEXT_LEVEL: ContextLevel = "medium";

export function contextBudgetChars(level: ContextLevel, windowTokens: number): number {
  const share = CONTEXT_LEVEL_SHARES[level];
  // Both operands are checked, not just the share. Guarding one and
  // multiplying by the other is how NaN reaches a budget: `Math.floor(NaN * n)`
  // is NaN, and a NaN budget passes every `spent + line.length > budget`
  // comparison downstream, which spends without limit.
  if (!(share > 0)) return 0;
  if (!(Number.isFinite(windowTokens) && windowTokens > 0)) return 0;
  return Math.floor(windowTokens * CHARS_PER_TOKEN * share);
}

/**
 * How long ago, in words.
 *
 * Coarse on purpose. The point of the figure is whether HAL's last look is
 * current, stale, or from another sitting — "41 seconds" and "4 hours" carry
 * that, and a precise duration invites the model to reason about a number it
 * has no use for.
 */
export function relativeAge(ms: number): string {
  if (!(Number.isFinite(ms) && ms >= 0)) return "an unknown time";
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

/**
 * Wall-clock time, to the second, in the machine's own zone.
 *
 * Supplied alongside the relative age rather than instead of it. The age is
 * what the model should reason with; this is what a person checks against their
 * own clock, and without it "14 seconds ago" cannot be audited at all — which
 * is the state that sent someone looking for a bug in the file read.
 *
 * It is a known risk. `docs/solutions/an-instruction-that-fights-its-own-input-loses.md`
 * records timestamps becoming the subject of narration, and this reintroduces
 * one deliberately, on the judgement that an unverifiable freshness claim costs
 * more than a model occasionally remarking on a clock.
 */
export function clockTime(ms: number): string {
  if (!Number.isFinite(ms)) return "unknown";
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * When one entry happened, as a prefix.
 *
 * The clock alone for anything from today, which is almost everything a bounded
 * tail returns. A date is added only when the entry is from another day, where
 * a bare clock would read as this morning and be wrong by however long HAL was
 * off.
 */
export function entryStamp(ms: number, now: number): string {
  if (!Number.isFinite(ms)) return "??:??:??";
  const d = new Date(ms);
  const n = new Date(now);
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return sameDay ? clockTime(ms) : `${MONTHS[d.getMonth()]} ${d.getDate()} ${clockTime(ms)}`;
}

/**
 * How well a run of checks supports someone's presence, in words.
 *
 * Recognition Weight rises with consecutive recognitions and decays against
 * wall-clock, so it is precisely the "supported by a run rather than by one
 * frame" evidence a reader needs. Rendered as prose rather than as a second
 * percentage: two numbers side by side invite the model to compare them, and
 * they measure different things.
 *
 * It still decides nothing. Banding, narration, profile delivery and the
 * candidate queue all read the current frame's confidence, and this only tells
 * a Conversation what the record already holds.
 */
export function runStrength(weight: number | undefined, phrases?: PhraseSettings): string {
  if (!(typeof weight === "number" && Number.isFinite(weight))) return "";
  const id = weight >= 0.75 ? "sight.run_strong" : weight >= 0.4 ? "sight.run_building" : "sight.run_thin";
  return renderPhrase(id, phrases, {});
}

/** The caption HAL most recently received, and when. */
export interface LastLook {
  caption: string;
  at: string;
}



// ---------------------------------------------------------------------------
// The separator every rendered line carries. Named rather than inlined as `1`
// so the accounting below reads as "text plus its separator" at each site.
const NEWLINE = 1;

// ---------------------------------------------------------------------------
// Chat context slots
//
// The same text the section functions above assemble, cut into the pieces a
// template can place. Each one owns its own budget accounting, because that is
// the part a template cannot express: the give-back loop that makes room for a
// truncation notice needs to know what it already emitted.
//
// Two conventions are preserved rather than harmonised, because harmonising
// them would change what fits and therefore what HAL says. The session slot
// charges a newline per line; the sight slots charge only the text. That
// asymmetry is in the code these replace, and the golden snapshots in
// server/test/chat/context-golden.test.ts hold both to it.
// ---------------------------------------------------------------------------

// The two truncation notices, which are rebuilt inside a give-back loop as the
// count changes — so they are helpers rather than inline, and both go through
// the phrase layer like every other line.
const remarksNote = (dropped: number, phrases?: PhraseSettings): string =>
  renderPhrase("session.remarks_truncated", phrases, {
    count: String(dropped),
    plural: dropped === 1 ? "" : "s",
  });

const facesNote = (dropped: number, phrases?: PhraseSettings): string =>
  renderPhrase("sight.faces_truncated", phrases, {
    count: String(dropped),
    plural: dropped === 1 ? "" : "s",
  });

/** How the watched session is named, or empty when nothing is watched. */
export function sessionLabelSlot(
  entries: readonly { sessionId?: string | null; sessionLabel?: string }[],
  watchedSessionId: string | null,
): string {
  if (!watchedSessionId) return "";
  const mine = entries.filter((e) => e.sessionId === watchedSessionId);
  if (mine.length === 0) return "";
  return mine.at(-1)?.sessionLabel ?? "the session I am watching";
}

/**
 * What HAL has lately been saying about the watched session, oldest first.
 *
 * The budget handed in is what remains after the heading the template already
 * charged for, and the accounting below is written so that fitting this text
 * into it permits exactly what the previous implementation permitted: it counts
 * a newline per line, including the one that separates it from the heading.
 */
export function sessionRemarksSlot(
  entries: readonly { text: string; at: string; sessionId?: string | null; sessionLabel?: string }[],
  watchedSessionId: string | null,
  budget: number,
  now: Date = new Date(),
  limit?: number,
  phrases?: PhraseSettings,
): string {
  if (!(budget > 0) || !watchedSessionId) return "";
  const mine = entries.filter((e) => e.sessionId === watchedSessionId);
  if (mine.length === 0) return "";

  // The heading's own newline is already spent, so one more character is
  // available here than the raw budget suggests.
  const cap = budget + NEWLINE;

  const chosen: string[] = [];
  let spent = 0;
  let dropped = 0;
  // Newest first so the bound drops the oldest, and a long entry being skipped
  // still leaves room for a shorter older one — which is what `continue`
  // rather than `break` has always done here.
  for (let i = mine.length - 1; i >= 0; i -= 1) {
    if (limit !== undefined && chosen.length >= limit) {
      dropped += 1;
      continue;
    }
    const line = renderPhrase("session.remark_line", phrases, {
      stamp: entryStamp(Date.parse(mine[i]!.at), now.getTime()),
      text: mine[i]!.text.trim(),
    });
    if (!(spent + NEWLINE + line.length <= cap)) {
      dropped += 1;
      continue;
    }
    chosen.unshift(line);
    spent += NEWLINE + line.length;
  }

  if (dropped > 0) {
    let note = remarksNote(dropped, phrases);
    while (spent + NEWLINE + note.length > cap && chosen.length > 0) {
      spent -= NEWLINE + chosen.shift()!.length;
      dropped += 1;
      note = remarksNote(dropped, phrases);
    }
    if (chosen.length === 0) return "";
    return `${chosen.join("\n")}\n${note}`;
  }

  return chosen.join("\n");
}

/** The camera-off line, or empty when HAL is looking. */
export function visionOffSlot(
  presence: { watching: boolean },
  budget: number,
  phrases?: PhraseSettings,
): string {
  const line = renderPhrase("sight.camera_off", phrases, {});
  if (presence.watching || !(line.length <= budget)) return "";
  return line;
}

/** The watching-but-placing-nobody line, or empty otherwise. */
export function visionNobodySlot(
  presence: { watching: boolean; present: readonly unknown[] },
  budget: number,
  phrases?: PhraseSettings,
): string {
  const line = renderPhrase("sight.nobody_placed", phrases, {});
  if (!presence.watching || presence.present.length > 0 || !(line.length <= budget)) return "";
  return line;
}

/**
 * Who is in view, one line each.
 *
 * Counts only the text of the lines against the budget, not the newlines that
 * join them — which is what the implementation this replaces did, and changing
 * it would move the point at which a crowded frame starts being truncated.
 */
export function visionFacesSlot(
  presence: {
    watching: boolean;
    present: readonly { match: { name: string; confidence: number } | null; since?: string; weight?: number }[];
  },
  thresholds: { recognition: number; statement: number },
  budget: number,
  now: Date = new Date(),
  phrases?: PhraseSettings,
  count?: number,
): { text: string; spent: number } {
  const nothing = { text: "", spent: 0 };
  if (!presence.watching || presence.present.length === 0) return nothing;
  // A count bounds how many of the people in view are listed. Unbounded is the
  // default and stays the default: leaving somebody out of "who I can see" is a
  // claim about the room, so it happens only when asked for.
  if (count !== undefined) {
    presence = { watching: presence.watching, present: presence.present.slice(0, count) };
  }
  // The heading's newline is already charged by the template; the previous
  // implementation charged neither it nor the joins, so it is added back here.
  const cap = budget + NEWLINE;

  const lines: string[] = [];
  let spent = 0;
  let droppedPeople = 0;

  for (const face of presence.present) {
    const band = face.match
      ? identityBand(face.match.confidence, thresholds.recognition, thresholds.statement)
      : "unrecognised";
    const who =
      face.match && band !== "unrecognised"
        ? formatIdentity(face.match.name, face.match.confidence, band, phrases)
        : renderPhrase("sight.unrecognised", phrases, {});
    const since = face.since ? Date.parse(face.since) : Number.NaN;
    const strength = runStrength(face.weight, phrases);
    const line = renderPhrase("sight.face_line", phrases, {
      who,
      // Conditions, so a face with no duration or no run drops that clause
      // rather than leaving a dangling comma.
      held: Number.isFinite(since) ? "set" : "",
      age: Number.isFinite(since) ? relativeAge(now.getTime() - since) : "",
      run: strength ? "set" : "",
      strength,
    });
    if (!(spent + line.length <= cap)) {
      droppedPeople += 1;
      continue;
    }
    lines.push(line);
    spent += line.length;
  }

  if (droppedPeople > 0) {
    // Room is made for the notice by giving back the lines it reports on. A
    // bound that silently drops its own "I dropped things" notice is worse
    // than no bound: the result reads as a complete list.
    let note = facesNote(droppedPeople, phrases);
    while (spent + note.length > cap && lines.length > 0) {
      spent -= lines.pop()!.length;
      droppedPeople += 1;
      note = facesNote(droppedPeople, phrases);
    }
    // The notice is only added if it fits, exactly as the assembly's `spend`
    // decided. A notice on its own with every face given back is a legitimate
    // outcome: the heading above it says what the list would have been.
    if (spent + note.length <= cap) {
      lines.push(note);
      spent += note.length;
    }
  }

  if (lines.length === 0) return nothing;
  // `spent` counts line TEXT only, never the newlines joining them, which is
  // what the assembly charged. Reported rather than left to the renderer to
  // infer from the rendered length, because getting it from the length would
  // bill the sight budget for separators it never paid for and hand the caption
  // and the profiles below fewer characters than they used to get — enough, at
  // some budgets, for the caption to vanish entirely.
  //
  // One is given back for the newline the template already charged between the
  // heading and this slot, which the assembly did not charge either.
  return { text: lines.join("\n"), spent: Math.max(0, spent - NEWLINE) };
}

/** One person the record shows was recognised, and when. */
export interface RecentSighting {
  name: string;
  confidence: number | null;
  band: IdentityBand;
  at: string;
}

/**
 * Who HAL has recognised lately, newest first, whether or not they are still here.
 *
 * The live list goes empty the moment somebody leaves, so a thread could see a
 * room and never learn who had just been in it. This reads the record of checks
 * instead — and states an age on every line, because without one it would read
 * as a claim about the present and contradict a room HAL can see is empty.
 *
 * Banded by what the check actually found. A marginal reading is attributed
 * here exactly as it is in the live list; a name is spoken plainly only where
 * the reading earned it.
 */
export function recentPeopleSlot(
  sightings: readonly RecentSighting[],
  budget: number,
  now: Date = new Date(),
  limit?: number,
  phrases?: PhraseSettings,
): string {
  if (!(budget > 0) || sightings.length === 0) return "";

  const lines: string[] = [];
  let spent = 0;
  for (const seen of sightings) {
    if (limit !== undefined && lines.length >= limit) break;
    if (seen.band === "unrecognised") continue;
    const at = Date.parse(seen.at);
    if (!Number.isFinite(at)) continue;
    const line = renderPhrase("sight.recent_person", phrases, {
      who: formatIdentity(seen.name, seen.confidence, seen.band, phrases),
      ago: relativeAge(now.getTime() - at),
    });
    if (!(spent + line.length <= budget)) break;
    lines.push(line);
    spent += line.length;
  }

  return lines.join("\n");
}

/**
 * What HAL has lately been saying about the Monitors.
 *
 * Selected newest-first so the bound drops the oldest, rendered oldest-first so
 * the model reads them in the order they happened — the same shape the session
 * remarks follow, and for the same reason.
 */
export function monitorRemarksSlot(
  entries: readonly { text: string; at: string; monitorId?: string | null; sessionLabel?: string }[],
  labelFor: (monitorId: string) => string,
  budget: number,
  now: Date = new Date(),
  limit?: number,
  phrases?: PhraseSettings,
): string {
  if (!(budget > 0)) return "";
  const mine = entries.filter((e) => e.monitorId);
  if (mine.length === 0) return "";

  const chosen: string[] = [];
  let spent = 0;
  let dropped = 0;
  for (let i = mine.length - 1; i >= 0; i -= 1) {
    if (limit !== undefined && chosen.length >= limit) {
      dropped += 1;
      continue;
    }
    const entry = mine[i]!;
    const line = renderPhrase("monitor.remark_line", phrases, {
      stamp: entryStamp(Date.parse(entry.at), now.getTime()),
      label: labelFor(entry.monitorId!),
      text: entry.text.trim(),
    });
    if (!(spent + NEWLINE + line.length <= budget)) {
      dropped += 1;
      continue;
    }
    chosen.unshift(line);
    spent += NEWLINE + line.length;
  }

  if (dropped > 0) {
    let note = renderPhrase("monitor.remarks_truncated", phrases, {
      count: String(dropped),
      plural: dropped === 1 ? "" : "s",
    });
    while (!(spent + NEWLINE + note.length <= budget) && chosen.length > 0) {
      spent -= NEWLINE + chosen.shift()!.length;
      dropped += 1;
      note = renderPhrase("monitor.remarks_truncated", phrases, {
        count: String(dropped),
        plural: dropped === 1 ? "" : "s",
      });
    }
    if (chosen.length === 0) return "";
    return `${chosen.join("\n")}\n${note}`;
  }

  return chosen.join("\n");
}

/** Today's date, coarse on purpose. */
export function dateStamp(ms: number): string {
  if (!Number.isFinite(ms)) return "an unknown day";
  const d = new Date(ms);
  const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** The newest caption, quoted and dated, or empty when there is none. */
export function visionCaptionSlot(
  looks: LastLook | readonly LastLook[] | null,
  budget: number,
  now: Date = new Date(),
  phrases?: PhraseSettings,
  count?: number,
): string {
  // One look or several. A count asks for the last N descriptions of the room,
  // which is a different question from "what does it look like now" — it is how
  // a thread asks what has been going on, and each line still arrives quoted
  // and dated rather than asserted, because the captioner invents object counts.
  const list = looks === null ? [] : Array.isArray(looks) ? looks : [looks as LastLook];
  const wanted = count === undefined ? 1 : count;
  const lines: string[] = [];
  let spent = 0;
  for (const look of list.slice(0, wanted)) {
    if (!look || !look.caption.trim()) continue;
    const at = Date.parse(look.at);
    const when = Number.isFinite(at) ? `${relativeAge(now.getTime() - at)} ago at ${clockTime(at)}` : "at an unknown time";
    const line = renderPhrase("sight.last_look", phrases, { when, caption: look.caption.trim() });
    // Acceptance-shaped, and a line at a time: a caption cut in half reads as a
    // confident half-observation, which is the failure the guardrail cannot
    // catch. What does not fit is left out whole.
    if (!(spent + line.length <= budget)) break;
    lines.push(line);
    spent += line.length;
  }
  return lines.join("\n");
}

/** One profile per person a stated band unlocked, plus the operator's. */
export function visionProfilesSlot(
  presence: {
    watching: boolean;
    present: readonly { match: { name: string; confidence: number } | null }[];
  },
  people: readonly { name: string; profile?: string; isOperator?: boolean }[],
  thresholds: { recognition: number; statement: number },
  budget: number,
  phrases?: PhraseSettings,
): { text: string; redact: string[] } {
  if (!(budget > 0)) return { text: "", redact: [] };
  const statedNames = new Set(
    presence.present
      .filter((f) => f.match && identityBand(f.match.confidence, thresholds.recognition, thresholds.statement) === "stated")
      .map((f) => f.match!.name),
  );
  const unlocked = people.filter((p) => p.profile?.trim() && (p.isOperator || statedNames.has(p.name)));
  // The redaction list comes back with the text, from the code that rendered
  // it. Recovering it afterwards by searching the finished string is what broke
  // — rendering normalises whitespace inside the substituted profile, so a
  // profile containing a blank line was present in the prompt and absent from
  // the search, and went to the never-pruned inference log in full.
  //
  // `phrases` is threaded through so a Conversation's profile lines obey an
  // edited wording, which is also why the search could never have stayed
  // correct: once the text around `{profile}` is the user's, nothing about the
  // finished string is predictable.
  return knownPeopleSection(
    unlocked.map((p) => ({ name: p.name, profile: p.profile!, ...(p.isOperator ? { isOperator: true } : {}) })),
    budget,
    { closing: false, phrases },
  );
}

/**
 * What a Conversation is told, as shipped.
 *
 * Reproduces the assembly it replaces character for character. Each section is
 * a conditional block so that a source with nothing to say takes its own
 * heading with it, and the separators sit between the blocks rather than inside
 * them — a block that drops takes one following line break along, which is what
 * keeps the sight lines single-spaced while the sections stay double-spaced.
 */
// ---------------------------------------------------------------------------
// The universal tier's resolver
// ---------------------------------------------------------------------------

/**
 * What every render is told about the send it is building.
 *
 * One value per render, built by the call site before the render starts,
 * because resolving a Backend is asynchronous and a slot resolver is not. It is
 * what makes the universal tier one registration rather than nine: a new
 * universal reading is added to `UNIVERSAL_SLOTS` and answered here, and every
 * role has it.
 *
 * `now` is captured once by the caller rather than read per slot. Two
 * resolutions of `{clock}` in one message must not disagree, and once a slot
 * can be repeated — which is what the decomposition makes ordinary — reading
 * the wall clock inside the resolver is how a message ends up stating two
 * different times.
 */
export interface SendDescription {
  /** The model this message is addressed to. Empty when nothing can say. */
  model: string;
  /** Where it is going. Empty when nothing can say. */
  backend: string;
  /** The instant this render describes. */
  now: Date;
}

/**
 * Answer the universal tier, and hand everything else to the role's resolver.
 *
 * Wrapping rather than editing each resolver is what keeps the promise that a
 * new universal reading needs no per-role edit. A role that happens to define a
 * slot of the same name would be shadowed, which is why `vocabularyFor` puts
 * the role's own first and nothing in the shipped vocabulary collides.
 *
 * A universal slot returns its text and nothing else — no `spent`, no `redact`.
 * It is charged what it renders, to whatever section it sits in, exactly as
 * `{clock}` is charged inside the sight and session headings today.
 */
export function withUniversalSlots(send: SendDescription, resolve: SlotResolver): SlotResolver {
  return (req) => {
    switch (req.name) {
      case "clock":
        return { text: clockTime(send.now.getTime()) };
      case "date":
        return { text: dateStamp(send.now.getTime()) };
      case "model":
        return { text: send.model };
      case "backend":
        return { text: send.backend };
      default:
        return resolve(req);
    }
  };
}

// ---------------------------------------------------------------------------
// The six prompts that are Templates too
// ---------------------------------------------------------------------------

/**
 * The prompts edited as their own setting rather than as a template role.
 *
 * They are not roles: they keep their own settings field, their presets and
 * their null-means-shipped-default convention, and they reach a message through
 * a slot in the role that carries them. What they gain is the language — the
 * same braces, the same validation, the same preview.
 *
 * `validateTemplate` already accepts an explicit field list instead of a role,
 * which is how phrases reuse the engine. These six use the same seam.
 */
export const EDITABLE_PROMPTS = [
  "narrationPrompt",
  "monitorPrompt",
  "visionPrompt",
  "captionPrompt",
  "chatDefaultPrompt",
  "chatContextPreamble",
] as const;

export type EditablePromptId = (typeof EDITABLE_PROMPTS)[number];

/**
 * What each of the six may name.
 *
 * Five get the universal tier and nothing else. Their own role's readings would
 * be circular — the narration prompt IS the value of `{narration_prompt}`, and
 * a prompt naming the slot that carries it is a prompt naming itself.
 *
 * The context preamble is the one where this is a safety property rather than
 * tidiness. It sits inside the budgeted context render, so giving it a vision
 * or session reading would be a second route to that reading with its own
 * ledger — the hazard the whole merge exists to remove.
 *
 * The default conversation prompt is the exception, and gets the vocabulary of
 * the thing it becomes. It is copied onto a Conversation at creation, so a
 * prompt that validates here and not there would be a prompt the editor accepts
 * and the thread cannot render.
 */
export const PROMPT_FIELDS: Record<EditablePromptId, readonly SlotSpec[]> = {
  narrationPrompt: UNIVERSAL_SLOTS,
  monitorPrompt: UNIVERSAL_SLOTS,
  visionPrompt: UNIVERSAL_SLOTS,
  captionPrompt: UNIVERSAL_SLOTS,
  chatContextPreamble: UNIVERSAL_SLOTS,
  chatDefaultPrompt: vocabularyFor("conversation-system"),
};

export const DEFAULT_CHAT_CONTEXT_TEMPLATE = `{#context_preamble}{context_preamble}{/}

{#session_remarks}What I have been saying about {session_label}, oldest first; it is now {clock}:
{session_remarks}{/}

{#vision_off}{vision_off}{/}
{#vision_nobody}{vision_nobody}{/}
{#vision_faces}Who I can see, read live just now at {clock}:
{vision_faces}{/}
{#vision_caption}{vision_caption}{/}
{#vision_profiles}{vision_profiles}{/}
{#monitor_remarks}What I have lately been saying about the logs I watch:
{monitor_remarks}{/}`;

// The other roles, as shipped. Each reproduces the message its call site
// assembled by hand, so an install that edits nothing hears exactly what it
// heard before.
//
// In this phase the six settings-level prompts are reached through a slot
// rather than absorbed, which is what keeps their presets, their reset and the
// null-tracks-shipped-defaults convention working untouched.

export const DEFAULT_NARRATION_SYSTEM_TEMPLATE = `{#narration_prompt}{narration_prompt}{/}`;

export const DEFAULT_NARRATION_USER_TEMPLATE = `Session activity:
{session_lines}

Narrate this activity now.`;

export const DEFAULT_MONITOR_SYSTEM_TEMPLATE = `{#monitor_prompt}{monitor_prompt}{/}`;

// The three framings sit inline on one line because exactly one of them ever
// renders, and a branch that drops must not take the blank line before the log
// lines with it.
export const DEFAULT_MONITOR_USER_TEMPLATE = `{#reason_interrupt}Something in {monitor_label} looks wrong. Report it now.{/}{#reason_full}Recent activity in {monitor_label}. Narrate it.{/}{#reason_cycle}Activity in {monitor_label} over the last period. Summarise it.{/}

{monitor_lines}`;

// The profile section is independent of the prompt being blank: blanking the
// prompt says "nothing of your own about how to narrate", not "forget who
// these people are".
export const DEFAULT_VISION_SYSTEM_TEMPLATE = `{#vision_prompt}{vision_prompt}{/}

{#known_people}{known_people}{/}`;

export const DEFAULT_VISION_USER_TEMPLATE = `{#sensitivity_always}Always remark on this cycle, even if nothing changed and nothing is notable.{/}{#sensitivity_high}Remark on this cycle unless the frames are entirely unchanged and there is truly nothing to say.{/}{#sensitivity_medium}Remark only if something in this cycle is worth a developer's attention — a change, an arrival, a departure.{/}{#sensitivity_low}Stay silent unless something clearly notable happened. Most cycles should produce nothing.{/}{#silence_expected} If there is nothing worth saying, reply with exactly {silence_token} and nothing else.{/}

Frames from the last period:
{vision_caption_lines}`;

// A Conversation seeded with nothing carries nothing: chat has never sent a
// system message by default, and the context is appended beneath when the
// template does not place it. A thread that wants its observations somewhere
// else writes {context} where it wants them.
export const DEFAULT_CONVERSATION_SYSTEM_TEMPLATE = "";

export const DEFAULT_CAPTIONER_USER_TEMPLATE = `{caption_prompt}`;

export const DEFAULT_TEMPLATES: Record<TemplateRole, string> = {
  "conversation-system": DEFAULT_CONVERSATION_SYSTEM_TEMPLATE,
  "chat-context": DEFAULT_CHAT_CONTEXT_TEMPLATE,
  "narration-system": DEFAULT_NARRATION_SYSTEM_TEMPLATE,
  "narration-user": DEFAULT_NARRATION_USER_TEMPLATE,
  "monitor-system": DEFAULT_MONITOR_SYSTEM_TEMPLATE,
  "monitor-user": DEFAULT_MONITOR_USER_TEMPLATE,
  "vision-system": DEFAULT_VISION_SYSTEM_TEMPLATE,
  "vision-user": DEFAULT_VISION_USER_TEMPLATE,
  "captioner-user": DEFAULT_CAPTIONER_USER_TEMPLATE,
};

/** The template in force for a role: the user's, or what shipped. */
export function resolveTemplate(stored: string | null | undefined, role: TemplateRole): string {
  return stored ?? DEFAULT_TEMPLATES[role];
}

/** One enrolled person as the output check sees them. */
export interface RosterBand {
  name: string;
  // Null when this person had no live reading during the period.
  confidence: number | null;
  band: IdentityBand;
}

/**
 * Rewrite any enrolled name in the model's output into the form its band allows.
 *
 * The second line of defence, applied to what the model produced rather than
 * what it was given. Rewriting rather than rejecting: dropping the entry would
 * lose a real observation to fix a phrasing problem, and the observation is
 * the thing the user wanted.
 *
 * This runs against the WHOLE roster rather than the names matched this cycle
 * (R7), because a name can reach the output without a live reading behind it —
 * the operator's profile is standing context, so the model knows that name even
 * on a cycle in which nobody was seen. Anyone with no live band is hedged, and
 * with no confidence to report, no percentage is invented. Over-hedging a name
 * HAL did not see is the accepted cost, the same way over-hedging an ordinary
 * word already is.
 *
 * It never makes HAL more confident than the model already was: a hedge the
 * model wrote is kept even when the band would allow the bare name. The
 * enforcement exists to remove unearned certainty, not to add certainty.
 *
 * This is string matching and its limits are real — it will not catch a model
 * that refers to someone by description, by a nickname, or by a possessive
 * construction it does not anticipate. It backs up the input shaping; it does
 * not replace it.
 */
export function enforceIdentityBands(text: string, roster: readonly RosterBand[]): string {
  // Longest first, so a person called "Ann" cannot rewrite the "Ann" inside a
  // mention of "Ann Marie". Regex alternation is ordered, so this ordering is
  // what makes the combined pattern prefer the longer name.
  const ordered = [...roster].filter((r) => r.name.trim()).sort((a, b) => b.name.trim().length - a.name.trim().length);
  if (ordered.length === 0) return text;

  // ONE pass over the text, not one pass per name.
  //
  // Sequential replaces looked equivalent and were not: after "Ann Marie" had
  // been rewritten, a later pass for "Ann" would match inside the result and
  // produce "Ann 90% Marie 80%". The old implementation escaped this only by
  // accident — everything it wrote began with the hedge prefix, and the
  // optional-prefix group made the second pass a no-op. The stated band has no
  // prefix, so the accident stopped holding. A single pass consumes each
  // position once and does not rely on what the replacement happens to start
  // with.
  const alternation = ordered
    .map((entry) =>
      entry.name
        .trim()
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        // Whitespace inside a name matches any run of it, so "Ann  Marie" from
        // a model still matches "Ann Marie".
        .replace(/\s+/g, "\\s+"),
    )
    .join("|");

  // Keyed on a normalised form so the matched text can be traced back to the
  // roster entry regardless of how the model cased or spaced it.
  const key = (name: string): string => name.trim().replace(/\s+/g, " ").toLowerCase();
  const byName = new Map<string, RosterBand>();
  for (const entry of ordered) if (!byName.has(key(entry.name))) byName.set(key(entry.name), entry);

  // Three optional parts around the name:
  //
  // The prefix is an OPTIONAL GROUP rather than a lookbehind. A lookbehind is
  // fixed-width and was case-sensitive, so the single most likely output shape
  // — the model starting a sentence with the hedge it was handed, capitalised —
  // slipped straight past it and produced "Someone who looks like someone who
  // looks like Dave".
  //
  // The percentage is matched as a trailing group so the rewrite is idempotent
  // in the stated band too (R8). Without it, a model echoing back "Dave 71%"
  // would match the bare name and produce "Dave 71% 71%". Its shape is loose on
  // purpose — "71%", "71 %", "(71%)" are all things a model writes — because a
  // matcher tight enough to be pretty is loose enough to miss one and
  // double-annotate.
  //
  // Case-insensitive throughout. The cost is over-hedging: a person called
  // "Bill" makes "the bill is paid" read oddly. That is the right way to be
  // wrong. Odd phrasing is cosmetic; shipping a bare name is the failure this
  // whole feature exists to prevent, and a model re-casing a name (sentence
  // start, or an initialism like "sw" written "SW") is ordinary behaviour.
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])(${HEDGE_PREFIX.trim().replace(/\s+/g, "\\s+")}\\s+)?(${alternation})(?![\\p{L}\\p{N}])(\\s*\\(?\\s*\\d{1,3}\\s*%\\s*\\)?)?`,
    "giu",
  );

  return text.replace(
    pattern,
    (match, prefix: string | undefined, name: string, percent: string | undefined) => {
      const entry = byName.get(key(name));
      if (!entry) return match;
      // A hedge the model wrote is kept verbatim, capitalisation and all — and
      // kept even in the stated band, because removing it would be this
      // function adding confidence rather than removing it.
      const lead = prefix ?? (entry.band === "hedged" ? HEDGE_PREFIX : "");
      // A percentage the model wrote is kept as written; one it omitted is
      // supplied only when there is a reading to report.
      const tail = percent ?? (entry.confidence === null ? "" : ` ${Math.round(entry.confidence * 100)}%`);
      // The enrolled spelling wins over the model's, which is what corrects an
      // initialism the model re-cased.
      return `${lead}${entry.name.trim()}${tail}`;
    },
  );
}

export function visionSensitivityInstruction(sensitivity: string): string {
  const instruction = SENSITIVITY_INSTRUCTIONS[sensitivity] ?? SENSITIVITY_INSTRUCTIONS.medium!;
  return sensitivity === "always"
    ? instruction
    : `${instruction} If there is nothing worth saying, reply with exactly ${VISION_SILENCE_TOKEN} and nothing else.`;
}

// A stored prompt is `string | null`: null means "never edited", so the shipped
// default is picked up even when a later release changes it. An empty string is
// a deliberate blanking and is returned as-is.
export function resolvePrompt(stored: string | null | undefined, shipped: string): string {
  return stored ?? shipped;
}

// Blank means blank: a prompt of only whitespace carries nothing and must not
// become a system message. Accepts unknown because a hand-edited settings file
// can put anything in the slot, and a non-string is no prompt at all.
export function isBlankPrompt(prompt: unknown): boolean {
  return typeof prompt !== "string" || prompt.trim().length === 0;
}

// Text the user did not write: the shipped default plus every preset. Seeding
// over any of these destroys nothing.
export const KNOWN_NARRATION_TEXTS: readonly string[] = [
  DEFAULT_NARRATION_PROMPT,
  ...NARRATION_PRESETS.map((p) => p.text),
];

// Everything a client needs to render and reset prompts without importing this
// module. Sent with every settings broadcast so a client that speaks only the
// wire contract can read the effective prompt, discover presets, and reproduce
// a reset — the agent-native parity rule in AGENTS.md.
export const PROMPT_CATALOG = {
  narrationDefault: DEFAULT_NARRATION_PROMPT,
  chatDefault: DEFAULT_CHAT_PROMPT,
  // The Monitor prompt was the one shipped default the catalog never carried,
  // so a protocol-only client could neither read what HAL sends a Monitor nor
  // reproduce a reset of it.
  monitorDefault: DEFAULT_MONITOR_PROMPT,
  // Vision's two prompts belong here for the same reason the others do: a
  // stored null means "never edited", and without the shipped text a
  // protocol-only client cannot read what HAL is actually sending, nor say what
  // a reset would restore.
  visionDefault: DEFAULT_VISION_PROMPT,
  visionCaptionDefault: DEFAULT_VISION_CAPTION_PROMPT,
  // Same reason as vision's two: without the shipped text a protocol-only
  // client cannot read what HAL is actually sending, nor say what a reset
  // would restore.
  contextPreambleDefault: DEFAULT_CONTEXT_PREAMBLE,
  // The per-line wording, with its fields and the reasoning behind each. Same
  // argument as the templates: a protocol-only client cannot author what it
  // cannot read, and cannot say what a reset restores.
  phrases: PHRASES,
  narrationPresets: NARRATION_PRESETS,
  // Everything a client needs to author a template without importing this
  // module: what each role ships, which slots it accepts, what each one means,
  // and what its wording is protecting.
  templateDefaults: DEFAULT_TEMPLATES,
  // The role's own, and the tier every role gets, kept apart. A client showing
  // them as one list would be showing something true; showing them apart is
  // what lets it say which are which, and the editor's slot list is the whole
  // reason the distinction exists.
  templateSlots: SLOT_VOCABULARY,
  universalSlots: UNIVERSAL_SLOTS,
  promptSlots: PROMPT_FIELDS,
} as const;
