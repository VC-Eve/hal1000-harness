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

// What the captioner is asked of each frame. Addressed to a small vision model,
// not to HAL: short, literal, and explicitly permitted to say a person is
// absent. Measured captioners drift into describing furniture at length and
// silently skipping the question that matters, so the question comes first.
export const DEFAULT_VISION_CAPTION_PROMPT =
  "Describe this camera frame plainly. " +
  "Is a person visible? If yes, say whether it is one person or several, what they appear to be doing, and their posture or which way they are facing. " +
  "If no person is visible, say so first. " +
  // The frame is whatever the camera points at — a room, a doorway, a garden.
  // Asking for the setting is what lets the summariser speak about it without
  // inventing one.
  "Note the setting when it is clear: indoors or outdoors, and what kind of place. " +
  "Report only what is actually visible. Do not guess at motion, lighting, states you cannot see, or what anyone intends. " +
  // Exact counts are the single largest source of false change. A captioner
  // counts the same five fan blades as three, four, and five across identical
  // frames, and the summariser reads that wobble as something happening.
  // "One or several" carries what matters about people without that cost.
  "Do not give exact counts of objects. Be brief and literal.";

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

export function hedgedIdentity(name: string): string {
  return `${HEDGE_PREFIX}${name}`;
}

// Which of the three things HAL can say about a face (R1).
export type IdentityBand = "unrecognised" | "hedged" | "stated";

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
export function formatIdentity(name: string, confidence: number, band: IdentityBand): string {
  const percent = `${Math.round(confidence * 100)}%`;
  // Stated: the bare name, with the number that earned it. The percentage is
  // deliberately supplied to the model as well as shown to the user; see the
  // note on `enforceIdentityBands` for what that costs and why it is tested.
  if (band === "stated") return `${name} ${percent}`;
  return `${hedgedIdentity(name)} ${percent}`;
}

/**
 * Rewrite any bare enrolled name in the model's output into the hedged form.
 *
 * The second line of defence, applied to what the model produced rather than
 * what it was given. Rewriting rather than rejecting: dropping the entry would
 * lose a real observation to fix a phrasing problem, and the observation is
 * the thing the user wanted.
 *
 * This is string matching and its limits are real — it will not catch a model
 * that refers to someone by description, by a nickname, or by a possessive
 * construction it does not anticipate. It backs up the input shaping; it does
 * not replace it.
 */
export function enforceIdentityHedge(text: string, names: readonly string[]): string {
  let out = text;
  // Longest first, so a person called "Ann" cannot partially rewrite a mention
  // of "Ann Marie" before the longer name has had its turn.
  for (const name of [...names].filter((n) => n.trim()).sort((a, b) => b.length - a.length)) {
    const trimmed = name.trim();
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Whitespace inside a name matches any run of it, so "Ann  Marie" from a
    // model still matches "Ann Marie".
    const spaced = escaped.replace(/\s+/g, "\\s+");

    // The prefix is matched as an OPTIONAL GROUP rather than excluded by a
    // lookbehind. A lookbehind is fixed-width and was case-sensitive, so the
    // single most likely output shape — the model starting a sentence with the
    // hedge it was handed, capitalised — slipped straight past it and produced
    // "Someone who looks like someone who looks like Dave".
    //
    // Case-insensitive throughout. The cost is over-hedging: a person called
    // "Bill" makes "the bill is paid" read oddly. That is the right way to be
    // wrong. Odd phrasing is cosmetic; shipping a bare name is the failure this
    // whole feature exists to prevent, and a model re-casing a name (sentence
    // start, or an initialism like "sw" written "SW") is ordinary behaviour.
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}])(${HEDGE_PREFIX.trim().replace(/\s+/g, "\\s+")}\\s+)?${spaced}(?![\\p{L}\\p{N}])`,
      "giu",
    );

    out = out.replace(pattern, (match, prefix: string | undefined) =>
      // Already hedged: leave it exactly as the model wrote it, capitalisation
      // and all.
      prefix ? match : hedgedIdentity(trimmed),
    );
  }
  return out;
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
  // Vision's two prompts belong here for the same reason the others do: a
  // stored null means "never edited", and without the shipped text a
  // protocol-only client cannot read what HAL is actually sending, nor say what
  // a reset would restore.
  visionDefault: DEFAULT_VISION_PROMPT,
  visionCaptionDefault: DEFAULT_VISION_CAPTION_PROMPT,
  narrationPresets: NARRATION_PRESETS,
} as const;
