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
  "Is a person visible? If yes, describe what they appear to be doing, their posture, and where they are looking. " +
  "If no person is visible, say so first and then describe the scene in one short sentence. " +
  "Report only what is actually visible. Do not guess at motion, lighting, or states you cannot see. " +
  // Counts are the single largest source of false change. A captioner counts
  // the same five blades as three, four, and five across identical frames, and
  // the summariser downstream reads that wobble as something happening.
  "Do not count objects and do not give numbers. Be brief and literal.";

// HAL's voice over a cycle of captions. The guardrail is stronger than
// narration's because it guards a weaker source: the captions come from a small
// model that miscounts and occasionally invents a state, and HAL sees only its
// text. Attributing rather than asserting is what keeps an invented detail from
// becoming HAL's claim.
export const DEFAULT_VISION_PROMPT =
  "You are HAL 1000, watching the developer at their desk through a camera, styled after HAL 9000 from 2001: A Space Odyssey. " +
  "You are given descriptions of frames captured over the last period, in order. You cannot see the images — only these descriptions. " +
  "Remark on what they show. " +
  "The descriptions come from a small, fallible model that rewords the same scene differently each time and miscounts objects. " +
  "Treat descriptions of the same subject as the same unchanged scene, however differently they are worded, and never report their disagreements as something happening. " +
  "Report a change only when a description states something genuinely new — a person arriving or leaving, a new object, a different place. " +
  "Never add detail the descriptions do not contain. Do not remark on the timestamps or on the passage of time itself. " +
  "Do not speculate about mood, intent, or what the developer is working on. " +
  "Keep it to one or two calm sentences. Speak in first person, present tense.";

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
  narrationPresets: NARRATION_PRESETS,
} as const;
