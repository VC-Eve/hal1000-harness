// The prompt template language.
//
// Every message HAL sends a model is rendered from one of these. A template is
// literal text, slots that pull a live reading in, and conditional blocks that
// drop their contents when the slot they name has nothing to say.
//
// It lives in `shared/` for the reason `contextBudgetChars` does: the server
// renders and the client validates and previews the same text. Two
// implementations would drift, and the drift would be invisible — the editor
// would accept what the renderer refuses.
//
// What is deliberately NOT here: loops, arithmetic, comparisons, or any other
// expression. Three behaviours of the assembly this replaces cannot be written
// with slots and single-slot conditionals — the give-back loop that makes room
// for a truncation notice, the blank line that appears only BETWEEN surviving
// sections, and the preamble that disappears when everything beneath it came
// back empty. Each is pushed down into a slot renderer or into whitespace
// normalization rather than met by growing the language. See
// docs/plans/2026-08-09-003-feat-editable-prompt-templates-plan.md.

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

export type TemplateNode =
  | { kind: "text"; value: string }
  | { kind: "slot"; name: string; count?: number; at: number }
  | { kind: "block"; name: string; at: number; children: TemplateNode[] }
  /**
   * A named expansion the renderer can drop whole.
   *
   * Never produced by the parser — there is no syntax for it, and the four
   * rules stay four. A caller splices one in where a slot stood, which is how
   * `{context}` becomes the conversation-context template rendered inside the
   * same pass rather than a second render whose result is discarded.
   *
   * It is NOT a block, and calling it one would get it built wrong. A block
   * holds when the slot of its own name produced text; a group has no such slot.
   * A block drops only when its body trims to empty; a group must drop while its
   * body is non-empty, because a preamble and literal headings are in there and
   * are not observations. Two different predicates.
   */
  | { kind: "group"; name: string; at: number; children: TemplateNode[] };

export type TemplateErrorKind =
  | "unknown-slot"
  | "unclosed-block"
  | "stray-close"
  | "bad-count"
  | "bad-name"
  | "unclosed-brace"
  | "condition-inline"
  | "count-unsupported"
  | "too-deep";

export interface TemplateError {
  kind: TemplateErrorKind;
  // Character offset into the template text. R7 promises the position of a
  // malformed block, and the editor needs it to put the cursor there.
  at: number;
  name?: string;
  message: string;
  // For `unknown-slot`: what the role does accept, so the message can list it.
  valid?: readonly string[];
}

const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * Parse template text into nodes.
 *
 * Never throws. A hand-edited settings file can hold anything, and a parser
 * that threw would take down a send over text the user could not see. Errors
 * are collected and parsing continues where it can, so one bad brace does not
 * hide every later problem.
 *
 * Structural errors only — an unknown slot NAME is a vocabulary question and
 * belongs to `validateTemplate`, which knows the role.
 */
/**
 * How deep blocks may nest.
 *
 * The renderer walks nodes recursively, so an unbounded depth is a stack
 * overflow reachable from stored text — and a `RangeError` from a stored
 * template is worse than a degraded one: narration, Monitors and Vision have
 * no equivalent of chat's catch, and the settings panel that would repair it
 * validates on the same code path. Past the limit a `{#name}` is kept as
 * literal text and reported, which keeps parsing total and R8 true.
 */
const MAX_DEPTH = 64;

export function parseTemplate(text: unknown): { nodes: TemplateNode[]; errors: TemplateError[] } {
  // Line endings are normalised once, here, so every character offset an error
  // reports agrees with what the editor shows and the dropped-block newline
  // rule sees one shape rather than two.
  const source = typeof text === "string" ? text.replace(/\r\n/g, "\n") : "";
  const errors: TemplateError[] = [];

  // The open blocks, innermost last. Each carries where it opened so an
  // unclosed one can be reported at its own position rather than at the end of
  // the file, which is the position that tells the user nothing.
  const stack: { name: string; at: number; children: TemplateNode[] }[] = [];
  const root: TemplateNode[] = [];
  const current = (): TemplateNode[] => stack[stack.length - 1]?.children ?? root;

  let literal = "";
  const flush = (): void => {
    if (literal.length > 0) {
      current().push({ kind: "text", value: literal });
      literal = "";
    }
  };

  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;

    // `{{` and `}}` are the escapes. Checked before anything else so a template
    // can talk about braces — a stored prompt may contain a JSON example, and
    // R5 exists so that text survives.
    if (ch === "{" && source[i + 1] === "{") {
      literal += "{";
      i += 2;
      continue;
    }
    if (ch === "}" && source[i + 1] === "}") {
      literal += "}";
      i += 2;
      continue;
    }

    if (ch !== "{") {
      literal += ch;
      i += 1;
      continue;
    }

    const close = source.indexOf("}", i + 1);
    if (close === -1) {
      errors.push({ kind: "unclosed-brace", at: i, message: "A '{' here is never closed." });
      // Everything from here is literal; there is no more structure to find.
      literal += source.slice(i);
      break;
    }

    const body = source.slice(i + 1, close);
    const at = i;
    i = close + 1;

    if (body === "/") {
      flush();
      const open = stack.pop();
      if (!open) {
        errors.push({ kind: "stray-close", at, message: "A '{/}' here closes a block that was never opened." });
        continue;
      }
      current().push({ kind: "block", name: open.name, at: open.at, children: open.children });
      continue;
    }

    if (body.startsWith("#")) {
      const name = body.slice(1);
      if (!NAME_PATTERN.test(name)) {
        errors.push({ kind: "bad-name", at, name, message: `'${name}' is not a slot name.` });
        continue;
      }
      if (stack.length >= MAX_DEPTH) {
        errors.push({
          kind: "too-deep",
          at,
          name,
          message: `Blocks are nested more than ${MAX_DEPTH} deep here; this one is read as text.`,
        });
        literal += source.slice(at, close + 1);
        continue;
      }
      flush();
      stack.push({ name, at, children: [] });
      continue;
    }

    // A slot, with or without a count argument.
    const counted = /^([a-z][a-z0-9_]*)\[(-?\d+)\]$/.exec(body);
    if (counted) {
      const name = counted[1]!;
      const count = Number(counted[2]);
      if (!Number.isInteger(count) || count < 1) {
        errors.push({ kind: "bad-count", at, name, message: `'${name}' needs a count of 1 or more.` });
        continue;
      }
      flush();
      current().push({ kind: "slot", name, count, at });
      continue;
    }

    if (!NAME_PATTERN.test(body)) {
      errors.push({ kind: "bad-name", at, name: body, message: `'${body}' is not a slot name.` });
      continue;
    }

    flush();
    current().push({ kind: "slot", name: body, at });
  }

  flush();

  // Anything still open never closed. Reported innermost first so the first
  // error the user sees is the one nearest their cursor.
  while (stack.length > 0) {
    const open = stack.pop()!;
    errors.push({
      kind: "unclosed-block",
      at: open.at,
      name: open.name,
      message: `This '{#${open.name}}' is never closed with '{/}'.`,
    });
    // Keep the children so a render of a broken template still produces its
    // text. R8 promises a stored template always renders. Pushed one at a time
    // rather than spread: `push(...huge)` passes every element as an argument
    // and blows the call stack on a wide unclosed block.
    for (const child of open.children) root.push(child);
  }

  return { nodes: root, errors };
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const TEMPLATE_ROLES = [
  "conversation-system",
  "chat-context",
  "narration-system",
  "narration-user",
  "monitor-system",
  "monitor-user",
  "vision-system",
  "vision-user",
  "captioner-user",
] as const;

export type TemplateRole = (typeof TEMPLATE_ROLES)[number];

export interface SlotSpec {
  name: string;
  /** One line, shown beside the slot in the editor (R30). */
  meaning: string;
  /**
   * What this slot's wording is protecting, and which measured failure produced
   * it (R32). Sourced from the comments in `shared/src/prompts.ts` — the
   * reasoning was already written down and had simply never reached a surface
   * the user could read.
   */
  note: string;
  /** Accepts a `[N]` argument selecting how many items to draw. */
  count?: boolean;
  /**
   * Which budget this slot spends from. Chat has two — Context Level is set per
   * source — and everything else has one.
   */
  source?: string;
  /** Renders a name or a face. Drives the editor's standing caution (R36). */
  identity?: boolean;
  /**
   * Usable only as a block condition. Rendering one inline produces nothing,
   * because the alternative is leaking a marker word like "interrupt" into a
   * prompt whenever someone types the bare name.
   */
  condition?: boolean;
}

// ---------------------------------------------------------------------------
// The universal tier
// ---------------------------------------------------------------------------

/**
 * Readings every role gets, without being listed in any of them.
 *
 * Membership is narrow on purpose: no identity, no budget source of its own,
 * and a meaning in every message HAL sends. `{clock}` and `{date}` were in two
 * role vocabularies and missing from the other seven, which all run on a timer
 * — an asymmetry with no reason recorded anywhere.
 *
 * "No budget source of its own" is not "free". A universal slot placed inside a
 * budgeted section charges that section, because `renderTemplate` bills a
 * sourceless slot to whatever it sits in. That is what `{clock}` does in the
 * sight and session headings today, and the eight characters it costs there are
 * load-bearing: billing it once globally moved where a crowded frame starts
 * truncating. See docs/solutions/a-sweep-that-varies-one-input-cannot-see-the-other.md.
 *
 * `{off_machine}` was considered and left out. It reports a policy decision
 * rather than a reading, and a prompt that branches on whether a send leaves the
 * machine is a prompt being invited to write a prohibition — which this project
 * has measured becoming the model's subject six times. The Off-Machine
 * Acknowledgement acts on the readings themselves, where nothing has to be said
 * about it.
 */
const DATE: SlotSpec = {
  name: "date",
  meaning: "today's date, as this machine reads it",
  note:
    "The clock alone cannot answer what day it is, which is a question a conversation asks and HAL could not previously reach. Coarse on purpose — a date, not a timestamp.",
};

const CLOCK: SlotSpec = {
  name: "clock",
  meaning: "the time right now, as this machine reads it",
  note:
    "Supplied alongside relative ages rather than instead of them. Without a wall clock a freshness claim cannot be audited, which once sent someone hunting for a bug in the file read. It is a known risk: timestamps have become the subject of narration before.",
};

const MODEL: SlotSpec = {
  name: "model",
  meaning: "the model this message is being sent to",
  note:
    "The model this message is addressed to, not the one chat happens to be using — in the Captioner's question it is the Captioner. HAL runs several models at once across two Backends, and which one is answering is something it could not previously say about itself.",
};

const BACKEND: SlotSpec = {
  name: "backend",
  meaning: "where this message is going",
  note:
    "Named as the endpoint rather than as chat-or-observation, because the two roles can share a destination and the question a prompt asks is which machine is answering. Carries no key: a credential is never part of a Backend as anything outside the server sees it.",
};

export const UNIVERSAL_SLOTS: readonly SlotSpec[] = [CLOCK, DATE, MODEL, BACKEND];

const CHAT_CONTEXT_SLOTS: readonly SlotSpec[] = [
  {
    name: "context_preamble",
    meaning: "what I am told this material is, before any of it arrives",
    note:
      "Descriptive rather than instructional, deliberately. Unheaded, the context read as a report handed over for comment and HAL answered it — but a rule about the input becomes the subject of the output. Resolves empty when nothing else in the context produced anything, so it never introduces an empty section.",
  },
  {
    name: "session_label",
    meaning: "how the watched session is named in the feed",
    note: "Stamped when the entry was made rather than derived now, so a remark about a session that has since ended still says what it was about.",
    source: "session",
  },
  {
    name: "session_remarks",
    meaning: "what I have lately been saying about the watched session, oldest first",
    note:
      "Scoped to the watched session alone: a budget split across four followed sessions follows none of them far enough to be a story. Carries its own 'earlier remarks not recalled here' notice when the budget cut it, and gives back remarks to make room for that notice — a bound that drops its own truncation notice reads as a complete list.",
    count: true,
    source: "session",
  },
  {
    name: "vision_off",
    meaning: "the line saying my camera is off — empty when it is on",
    note: "Whether HAL is looking is not the same claim as whether anyone is there. A section saying 'nobody is in view' with the camera off would be inventing an observation.",
    source: "vision",
  },
  {
    name: "vision_nobody",
    meaning: "the line for watching and placing no face — empty otherwise",
    note:
      "Claims what recognition knows and nothing more. This comes from face detection, so it means 'no face I can place', not 'the room is empty'. Phrased as the latter it outranked a caption describing someone sitting in frame, and HAL called an occupied room empty.",
    source: "vision",
  },
  {
    name: "vision_faces",
    meaning: "who is in view right now, one line each, with how long and how steadily",
    count: true,
    note:
      "The percentage is supplied bare. An earlier version glossed it — 'a percentage is how strongly that face matched, nothing more' — and the model escalated the gloss into a prohibition it invented and then obeyed against its own data, refusing to name someone it had recognised continuously for two minutes. The band already decides what may be said; the evidence is supplied instead of explained.",
    source: "vision",
    identity: true,
  },
  {
    name: "vision_caption",
    meaning: "my most recent description of the room, quoted and dated — takes a count for several",
    count: true,
    note:
      "Quoted and dated rather than asserted, because it comes from a small vision model that invents object counts. It is the one place a caption reaches a conversation. Its own age is stated separately from the live readings: with only the caption carrying a time, HAL applied that age to everything and said it could not know what had happened, about a reading taken that same second.",
    source: "vision",
  },
  {
    name: "vision_recent_people",
    meaning: "who I have recognised lately and how long ago, whether or not they are still here",
    note:
      "Distinct from who is in view: that goes empty the moment someone leaves, so a thread could see a room and never learn who had just been in it. Read from the record of checks rather than from the live set, and banded by what each check actually found — a name is spoken plainly only where the reading earned it, exactly as it is in the live list. Takes a count; [1] is the most recent recognition alone.",
    count: true,
    source: "vision",
    identity: true,
  },
  {
    name: "monitor_remarks",
    meaning: "what I have lately been saying about the logs I watch",
    note:
      "Monitors are the observation role a Conversation could not see at all. The feed has always carried their entries; the session block filters on a session id a Monitor does not have, so they were excluded by construction rather than by choice. Off unless the Monitor context switch is on, because a machine log is watched for the exception and most cycles produce nothing worth carrying into a chat.",
    count: true,
    source: "monitor",
  },
  {
    name: "vision_profiles",
    meaning: "what I know about the people I can currently see, and about the operator",
    note:
      "Only a stated band unlocks a profile — handing HAL someone's history on the strength of a maybe is how a marginal match becomes a confident story about the wrong person. Phrased as things HAL knows rather than as a document it was given, because naming the source makes the source the subject. Carries no closing instruction in a conversation: a standing rule to speak of people only as far as sight supports made ordinary talk stilted.",
    source: "vision",
    identity: true,
  },
];

// A Conversation's own prompt, which is a template like everything else.
//
// This WAS deliberately not the chat-context vocabulary, and the reasoning was
// sound while it held: a reading available here as well would have rendered
// twice, the second time outside the path that budgets it against Context
// Level, applies the Off-Machine Acknowledgement, and registers profile text
// for redaction from the never-pruned inference log.
//
// What changed is not the risk tolerance, it is the mechanism. That hazard was
// two renders with two ledgers, not repetition — so the two were merged into
// one pass. A reading named here and again inside `{context}` is now drawn
// once, charged once against the same Context Level, and redacted once. The
// guard is kept by construction rather than by keeping the vocabulary short.
//
// `{context}` is retained and still means the whole block in the
// conversation-context template's own order. What is new is that a thread can
// place a reading itself — which no editor change could have given it, because
// that template is one global setting and a Conversation prompt is per thread.
const CONVERSATION_SYSTEM_SLOTS: readonly SlotSpec[] = [
  {
    name: "context",
    meaning: "everything this thread is told about what I can see and what I have been saying",
    note:
      "Assembled per request and never written into the thread: persisting it would put Character Profile text beyond the reach of deletion and freeze the Gallery at the moment the thread was created. What it contains, and in what order, is the conversation-context template; this only decides where the whole block sits relative to your own words. Leave it out and it is appended beneath, as it always was.",
    identity: true,
  },
  ...CHAT_CONTEXT_SLOTS,
];

const NARRATION_SYSTEM_SLOTS: readonly SlotSpec[] = [
  {
    name: "narration_prompt",
    meaning: "the narration prompt from settings",
    note: "Still its own setting in this phase, with its presets and its reset intact. This slot is how the template reaches it.",
  },
];

const NARRATION_USER_SLOTS: readonly SlotSpec[] = [
  {
    name: "session_lines",
    meaning: "the tagged log lines from the session being narrated",
    note:
      "Handed over already rendered. How a line is composed — whether it carries a timestamp or an ordinal — stays in code deliberately: both were tried and both became the subject of the narration, and removing them from the lines is the repair that worked where a prompt rule against them did not.",
  },
];

const MONITOR_SYSTEM_SLOTS: readonly SlotSpec[] = [
  {
    name: "monitor_prompt",
    meaning: "the Monitor prompt from settings",
    note: "Monitors get their own prompt because narration's tag glossary describes coding-agent log entries and would mislead about a machine log line.",
  },
];

const MONITOR_USER_SLOTS: readonly SlotSpec[] = [
  {
    name: "monitor_label",
    meaning: "the name of the Monitor this batch came from",
    note: "A Monitor carries no project identity, so its label is the only thing naming what is being reported on.",
  },
  {
    name: "monitor_lines",
    meaning: "the log lines this Monitor collected",
    note: "Severe lines are spent first, then routine ones from the end of the batch, so a truncated batch keeps the part worth reading.",
  },
  {
    name: "reason_interrupt",
    meaning: "set when a severe line interrupted the cycle",
    note: "Severity is judged without the model, so a severe line is recognised even while chat holds the queue. Interrupting changes nothing else about the Monitor.",
    condition: true,
  },
  {
    name: "reason_full",
    meaning: "set when this Monitor narrates every batch",
    note: "Full verbosity suits a log the user is actively working against, rather than one they are merely keeping an eye on.",
    condition: true,
  },
  {
    name: "reason_cycle",
    meaning: "set when this is a quiet Monitor's periodic summary",
    note: "Quiet is the default and the point: a machine log is watched for the exception, so a cycle that saw nothing produces nothing. An all-clear on a timer is noise.",
    condition: true,
  },
];

const VISION_SYSTEM_SLOTS: readonly SlotSpec[] = [
  {
    name: "vision_prompt",
    meaning: "the Vision summariser prompt from settings",
    note:
      "This prompt was three times longer once and worked worse: every failure was met with another prohibition until roughly ten competed for a small model's attention, and it began narrating the rules themselves. Cutting the rule count fixed more than any single rule did.",
  },
  {
    name: "known_people",
    meaning: "what I know about the people this cycle may show",
    note:
      "Independent of the prompt being blank. Blanking the prompt means 'say nothing of your own about how to narrate' — it does not mean 'forget who these people are', and gating this on a blank prompt would silently delete standing knowledge.",
    identity: true,
  },
];

const VISION_USER_SLOTS: readonly SlotSpec[] = [
  {
    name: "vision_caption_lines",
    meaning: "what the camera reported this cycle, in the order it was seen",
    note:
      "Bare lines in order — no timestamps, no ordinals. Both were tried and both became the subject: stamped times were quoted back as though the clock were the event, and numbers turned the summary into 'Frame 1 showed…, Frame 2 repeated…'. Anything given a label invites being referred to by it.",
  },
  {
    name: "sensitivity_always",
    meaning: "set at the 'always' sensitivity",
    note: "Where the line between worth-remarking and not sits is taste, so it belongs to the user rather than to the product.",
    condition: true,
  },
  { name: "sensitivity_high", meaning: "set at the 'high' sensitivity", note: "See the note on the 'always' slot.", condition: true },
  { name: "sensitivity_medium", meaning: "set at the 'medium' sensitivity", note: "See the note on the 'always' slot.", condition: true },
  { name: "sensitivity_low", meaning: "set at the 'low' sensitivity", note: "See the note on the 'always' slot.", condition: true },
  {
    name: "silence_expected",
    meaning: "set whenever HAL is allowed to stay silent about a cycle",
    note: "Empty at the 'always' sensitivity, where silence is not on offer.",
    condition: true,
  },
  {
    name: "silence_token",
    meaning: "the exact literal a summariser returns to say nothing",
    note: "A sentinel rather than an empty reply, because models reliably produce something and an empty string is indistinguishable from a failed stream.",
  },
];

const CAPTIONER_USER_SLOTS: readonly SlotSpec[] = [
  {
    name: "caption_prompt",
    meaning: "the question put to the captioner about each frame",
    note:
      "Addressed to a small vision model rather than to HAL. Every requirement in the shipped text is phrased as a thing to do: the previous version carried three prohibitions, one of which handed the model the words 'states you cannot see', and 4 captions in 10 came back as a refusal on frames the same model described perfectly under a positive prompt.",
  },
];

export const SLOT_VOCABULARY: Record<TemplateRole, readonly SlotSpec[]> = {
  "conversation-system": CONVERSATION_SYSTEM_SLOTS,
  "chat-context": CHAT_CONTEXT_SLOTS,
  "narration-system": NARRATION_SYSTEM_SLOTS,
  "narration-user": NARRATION_USER_SLOTS,
  "monitor-system": MONITOR_SYSTEM_SLOTS,
  "monitor-user": MONITOR_USER_SLOTS,
  "vision-system": VISION_SYSTEM_SLOTS,
  "vision-user": VISION_USER_SLOTS,
  "captioner-user": CAPTIONER_USER_SLOTS,
};

/**
 * Everything a role accepts: its own readings, and the universal tier.
 *
 * The single place `SLOT_VOCABULARY[role]` is read, so adding a universal
 * reading is one registration and reaches every role rather than nine edits.
 *
 * Deliberately NOT applied to the explicit-vocabulary path. Phrases reuse this
 * engine by handing in their own small field set, and a phrase is one line
 * inside a slot — `{clock}` there would be a second, unbudgeted route to a
 * reading the surrounding template already places. `renderTemplate` and
 * `validateTemplate` both prefer an explicit vocabulary over a role for that
 * reason, and this function is only ever reached through the role branch.
 *
 * Cached per role rather than concatenated per call: this sits on every render
 * and every keystroke in the editor's validation.
 */
const VOCABULARY_CACHE = new Map<TemplateRole, readonly SlotSpec[]>();

export function vocabularyFor(role: TemplateRole): readonly SlotSpec[] {
  const hit = VOCABULARY_CACHE.get(role);
  if (hit) return hit;
  // The role's own first, so a slot list reads as "what this message can see"
  // before "what everything can see".
  const merged = [...SLOT_VOCABULARY[role], ...UNIVERSAL_SLOTS];
  VOCABULARY_CACHE.set(role, merged);
  return merged;
}

export function slotSpec(role: TemplateRole, name: string): SlotSpec | undefined {
  return vocabularyFor(role).find((s) => s.name === name);
}

export function slotNames(role: TemplateRole): readonly string[] {
  return vocabularyFor(role).map((s) => s.name);
}

/**
 * Turn every brace into a literal one.
 *
 * A prompt saved while its field was plain text may contain `{` — a JSON
 * example, a placeholder from somewhere else. Converting it to a Template
 * without escaping does not render those braces as slots; the parser reports a
 * bad name and DROPS the text, so the example disappears. Done in the draft so
 * the user watches it happen and can undo it.
 *
 * Lives here rather than in one editor because two surfaces now need it, and
 * two copies of an escaping rule is how they come to disagree.
 */
export function escapeLiteralBraces(text: string): string {
  return text.replace(/\{/g, "{{").replace(/\}/g, "}}");
}

/**
 * The largest count any mention of a slot asks for, across a whole template.
 *
 * Read before anything is fetched, because a slot resolver is synchronous and
 * cannot go back for more: what a template asks for has to be known before the
 * render starts, and the number lives in the template text. An uncounted
 * mention asks for the default, which is one.
 */
export function largestCount(nodes: readonly TemplateNode[], name: string): number {
  let largest = 0;
  const walk = (list: readonly TemplateNode[]): void => {
    for (const node of list) {
      if (node.kind === "slot" && node.name === name) largest = Math.max(largest, node.count ?? 1);
      else if (node.kind === "block" || node.kind === "group") walk(node.children);
    }
  };
  walk(nodes);
  return largest;
}

/**
 * Which budget sources a template draws on, by naming their readings.
 *
 * Placing a reading IS asking for that source. The Context Level switch decides
 * whether the whole block is appended automatically and how much of it may be
 * spent; it was never meant to be a second permission on a reading the user has
 * typed out by name. A slot offered in the editor, accepted by the validator
 * and previewed against sample data, that then renders empty on send because a
 * switch elsewhere is off, is a control rendered by nothing.
 */
export function sourcesNamed(nodes: readonly TemplateNode[], role: TemplateRole): Set<string> {
  const vocabulary = vocabularyFor(role);
  const found = new Set<string>();
  const walk = (list: readonly TemplateNode[]): void => {
    for (const node of list) {
      if (node.kind === "text") continue;
      const source = vocabulary.find((s) => s.name === node.name)?.source;
      if (source !== undefined) found.add(source);
      if (node.kind === "block" || node.kind === "group") walk(node.children);
    }
  };
  walk(nodes);
  return found;
}

/** Whether a name belongs to the universal tier rather than to any one role. */
export function isUniversalSlot(name: string): boolean {
  return UNIVERSAL_SLOTS.some((s) => s.name === name);
}

/**
 * Whether this template is acceptable for this role.
 *
 * Separate from parsing because the renderer must be able to parse a stored
 * template that names a slot the vocabulary no longer has, and render it,
 * without this function's verdict (R8, R35). Validation gates the APPLY; it
 * does not gate the send.
 */
export function validateTemplate(
  text: unknown,
  roleOrVocabulary: TemplateRole | readonly SlotSpec[],
): TemplateError[] {
  const { nodes, errors } = parseTemplate(text);
  const vocabulary =
    typeof roleOrVocabulary === "string" ? vocabularyFor(roleOrVocabulary) : roleOrVocabulary;
  const slotSpecIn = (name: string): SlotSpec | undefined => vocabulary.find((s) => s.name === name);
  const valid = vocabulary.map((s) => s.name);
  const out = [...errors];

  const walk = (list: readonly TemplateNode[], inConditionOf: string | null): void => {
    for (const node of list) {
      if (node.kind === "text") continue;
      const spec = slotSpecIn(node.name);
      if (!spec) {
        out.push({
          kind: "unknown-slot",
          at: node.at,
          name: node.name,
          valid,
          message: `'${node.name}' is not a slot here.`,
        });
        if (node.kind === "block") walk(node.children, inConditionOf);
        continue;
      }
      if (node.kind === "slot") {
        if (node.count !== undefined && !spec.count) {
          out.push({
            kind: "count-unsupported",
            at: node.at,
            name: node.name,
            message: `'${node.name}' does not take a [count].`,
          });
        }
        // A condition slot inside its own block is how the shipped defaults are
        // written and is fine; one standing on its own would render nothing,
        // which is a silent surprise rather than an error the user can see.
        if (spec.condition && inConditionOf !== node.name) {
          out.push({
            kind: "condition-inline",
            at: node.at,
            name: node.name,
            message: `'${node.name}' only works as a condition: write {#${node.name}}…{/}.`,
          });
        }
        continue;
      }
      walk(node.children, spec.condition ? node.name : inConditionOf);
    }
  };

  walk(nodes, null);
  return out;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface SlotRequest {
  name: string;
  /** The `[N]` argument, when the template supplied one. */
  count?: number;
  /**
   * What this slot may still spend, in characters. `Infinity` when its source
   * is unbudgeted. A list slot is expected to honour this and to say what it
   * dropped.
   */
  budgetLeft: number;
}

export interface SlotResult {
  /** Empty means the slot has nothing to say, and any block around it drops. */
  text: string;
  /**
   * What this slot should be charged, when that is not simply its length.
   *
   * The sections this replaced did not agree about separators: the session
   * block charged a newline per line, the sight block charged none. A slot that
   * joins its own lines therefore renders more characters than the budget it is
   * accounted against, and saying so here is what keeps the two conventions
   * reproducible without the renderer having to know which is which.
   */
  spent?: number;
  /**
   * Exact strings that must be withheld from the inference log.
   *
   * Part of the result rather than something the caller works out afterwards,
   * which is the whole point: the log keeps every prompt verbatim and is never
   * pruned, so a profile that reached it would outlive deleting the person it
   * describes. Recovering that by substring-matching the rendered output stops
   * working the moment the text around the slot is the user's.
   */
  redact?: readonly string[];
}

export type SlotResolver = (req: SlotRequest) => SlotResult;

export interface RenderOptions {
  resolve: SlotResolver;
  /** Characters each source may spend. A source absent here is unbudgeted. */
  budgets?: Readonly<Record<string, number>>;
  role?: TemplateRole;
  /**
   * An explicit vocabulary, instead of the one the role carries.
   *
   * Phrases — the single lines a slot renderer builds — are templates too, with
   * their own small set of fields. Handing the vocabulary in lets them reuse
   * this engine whole: the same braces, the same escapes, the same conditional
   * blocks, the same rejection of a name that does not exist. A second
   * substitution routine would be a second syntax to learn and a second place
   * for the two to disagree.
   */
  vocabulary?: readonly SlotSpec[];
  /**
   * Whether to collapse blank-line runs and trim the result.
   *
   * On for a whole message, where it reproduces the blank line that used to sit
   * between assembled sections. Off for a phrase, which is one line: there the
   * collapse has nothing to do except reach inside a substituted value and
   * reflow it. That is not cosmetic — a Character Profile containing a blank
   * line came out of the render reflowed, no longer matched the string the
   * redaction list was built from, and reached the never-pruned inference log
   * in full.
   */
  normalize?: boolean;
  /**
   * Which slot names count as having something to say.
   *
   * A group's whole question is "did an observation reading reach the output
   * inside me". Carrying a budget source is not the test: `session_label` has
   * one and is furniture, so a heading whose list the budget emptied would keep
   * the group alive and ship a page of headings with nothing under them. That
   * exact failure is already on record.
   *
   * Absent means every slot counts, which is what a render with no group wants.
   */
  contentSlots?: readonly string[];
  /**
   * The most each source may EMIT, as opposed to be charged.
   *
   * Charging and emitting stop being the same number once a reading can be
   * named twice: the second mention is charged nothing, but its characters are
   * still in the message and still take room from the window the Context Level
   * was apportioning. Without this, repetition is free in budget terms and
   * unbounded in the only terms that matter to the model.
   *
   * Per source rather than one total, because a total would let a saturated
   * sight source absorb an unused Monitor allowance — which is not what a
   * per-source level means.
   */
  emissionCaps?: Readonly<Record<string, number>>;
}

export interface RenderResult {
  text: string;
  redact: string[];
  /**
   * Slots the template names that the vocabulary no longer has. They rendered
   * empty; the editor says so rather than leaving the gap silent (R35).
   */
  degraded: string[];
  /**
   * Blocks that dropped, by the slot they name.
   *
   * A conditional block's whole behaviour is invisible in the source text —
   * it either renders or silently vanishes — so a preview that did not say
   * which ones went would be showing an outcome without its cause.
   */
  dropped: string[];
  /**
   * Slots whose text actually reached the output.
   *
   * Distinct from "was resolved": a slot inside a block that then dropped
   * resolved and contributed nothing. A caller deciding whether a render says
   * anything has to ask this rather than watching its own resolver, or a
   * template that kept only its literal headings counts as having spoken.
   */
  emitted: string[];
}

/**
 * Collapse runs of blank lines and trim the ends.
 *
 * This is what reproduces `[...lead, ...parts].join("\n\n")` when some parts
 * dropped. It is NOT the auto-prune heuristic this feature deliberately
 * rejected: it never removes a line that still has literal text on it, so a
 * heading whose slot came back empty survives, visibly, and the user fixes it
 * by wrapping it in a block.
 */
export function normalizeRendered(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

const normalize = normalizeRendered;

interface Ledger {
  spent: Map<string, number>;
  redact: string[];
  degraded: Set<string>;
  /**
   * Slots already resolved this render, so a slot appearing twice costs one
   * resolution. Two calls would charge the budget twice and could disagree
   * with each other about a live reading taken between them.
   */
  memo: Map<string, SlotResult>;
  /** Which memo keys have been charged, so a repeat mention is free. */
  charged: Set<string>;
  /** Slot names whose text reached the output and survived rollback. */
  emitted: string[];
  /** Blocks that dropped, by the slot they name. */
  dropped: Set<string>;
  /**
   * Which resolutions produced text, keyed the way the memo is — by name AND
   * count. Keyed by name alone, a second block asking for `{remarks[3]}` after
   * a first asked for `{remarks[40]}` overwrote the first's verdict, so a block
   * could drop while its own slot still had something to say.
   */
  produced: Map<string, boolean>;
  /**
   * Every emission, in order, whether or not the charge key was already spent.
   *
   * `emitted` cannot answer "did an observation reading reach the output inside
   * this subtree": its push sits behind `if (!charged.has(key))`, so a reading
   * named in the prompt and again inside a group is recorded once, at its first
   * occurrence — outside. A verdict reading it would drop a group that rendered
   * text. This list records each reach with its position, which is what the
   * group predicate and the emission counter both need.
   */
  occurrences: { name: string; source: string | undefined; chars: number }[];
}

export function renderTemplate(nodes: readonly TemplateNode[], opts: RenderOptions): RenderResult {
  const ledger: Ledger = {
    spent: new Map(),
    redact: [],
    degraded: new Set(),
    memo: new Map(),
    charged: new Set(),
    emitted: [],
    dropped: new Set(),
    produced: new Map(),
    occurrences: [],
  };
  const budgets = opts.budgets ?? {};

  const budgetLeft = (source?: string): number => {
    if (source === undefined) return Number.POSITIVE_INFINITY;
    const cap = budgets[source];
    if (cap === undefined) return Number.POSITIVE_INFINITY;
    return Math.max(0, cap - (ledger.spent.get(source) ?? 0));
  };

  /** What this source has actually put in the message so far. */
  const emittedFor = (source: string | undefined): number => {
    let total = 0;
    for (const o of ledger.occurrences) if (o.source === source) total += o.chars;
    return total;
  };

  const charge = (source: string | undefined, amount: number): void => {
    if (source === undefined || amount <= 0) return;
    ledger.spent.set(source, (ledger.spent.get(source) ?? 0) + amount);
  };

  // An explicit vocabulary wins over the role's, so a phrase validates and
  // renders against its own small field set using this same engine.
  const known = opts.vocabulary ?? (opts.role ? vocabularyFor(opts.role) : undefined);
  const specOf = (name: string): SlotSpec | undefined => known?.find((s) => s.name === name);

  /**
   * Resolve a slot once, without charging for it.
   *
   * Charging is separated from resolving because a block asks whether its slot
   * has anything to say, and the answer must not spend budget the block may
   * then discard.
   */
  const resolveSlot = (name: string, count: number | undefined, ambient: string | undefined): SlotResult => {
    const key = `${name}#${count ?? ""}`;
    const hit = ledger.memo.get(key);
    if (hit) return hit;

    const spec = specOf(name);
    if (known && !spec) {
      // Renders empty and is reported. R6 forbids accepting a MISSPELLING and
      // rendering it empty; this is the other case — a stored template holding
      // a name the vocabulary used to have — and R35 governs it.
      ledger.degraded.add(name);
      const empty: SlotResult = { text: "" };
      ledger.memo.set(key, empty);
      ledger.produced.set(key, false);
      return empty;
    }

    // A slot without a source of its own spends from whatever section it sits
    // in. That is what makes `{clock}` charge the vision budget inside the
    // sight block and the session budget inside the session one, the way the
    // clock inside a header is charged today as part of that header.
    const result = opts.resolve({ name, count, budgetLeft: budgetLeft(spec?.source ?? ambient) });
    ledger.memo.set(key, result);
    ledger.produced.set(key, result.text.length > 0);
    return result;
  };

  /** Whether any resolution of this slot, at any count, produced text. */
  const producedAny = (name: string): boolean | undefined => {
    let seen: boolean | undefined;
    for (const [key, made] of ledger.produced) {
      if (!key.startsWith(`${name}#`)) continue;
      if (made) return true;
      seen = false;
    }
    return seen;
  };

  /** Resolve, charge once per budget source, and hand back the text to emit. */
  const emitSlot = (name: string, count: number | undefined, ambient: string | undefined): string => {
    const result = resolveSlot(name, count, ambient);
    const source = specOf(name)?.source ?? ambient;
    // Keyed by SOURCE as well as slot. A slot mentioned twice inside one
    // section is billed once, but a sourceless slot appearing in two
    // differently-budgeted sections — `{clock}`, which sits in both the session
    // heading and the sight heading — must be billed to each, because each
    // section paid for its own copy in the assembly this reproduces. Keying on
    // the name alone made the second section eight characters richer and moved
    // where a crowded frame starts truncating.
    // The cap is decided BEFORE anything is charged. Charging first and then
    // returning empty spent the source's allowance on characters that never
    // reached the message — and the slots after it saw the reduced budget and
    // rendered empty, which could take the whole observation block down with
    // them. A suppressed repeat must cost nothing at all.
    //
    // A repeat is the same reading FROM THE SAME SOURCE. Keyed by name alone,
    // `{clock}` in the sight heading counted as a repeat of `{clock}` in the
    // session heading — a different section, a different budget — and was
    // blanked, leaving "read live just now at :" in the message.
    //
    // Universal readings are exempt outright. They are not what a Context Level
    // apportions, and suppressing eight characters of clock inside a heading
    // produces a malformed line rather than a smaller one.
    const cap = opts.emissionCaps?.[source ?? ""];
    const repeat = !isUniversalSlot(name) && ledger.occurrences.some((o) => o.name === name && o.source === source);
    // Acceptance-shaped, not `> cap`. The two are identical for finite numbers
    // and opposite for NaN, and the opposite is the direction that fails open.
    if (repeat && cap !== undefined && !(emittedFor(source) + result.text.length <= cap)) return "";

    const key = `${source ?? ""}|${name}#${count ?? ""}`;
    if (!ledger.charged.has(key)) {
      ledger.charged.add(key);
      if (result.text.length > 0) ledger.emitted.push(name);
      charge(source, result.spent ?? result.text.length);
      if (result.redact) ledger.redact.push(...result.redact);
    }

    if (result.text.length > 0) {
      ledger.occurrences.push({ name, source, chars: result.text.length });
    }
    return result.text;
  };

  const snapshot = () => ({
    spent: new Map(ledger.spent),
    redactLen: ledger.redact.length,
    memoKeys: new Set(ledger.memo.keys()),
    chargedKeys: new Set(ledger.charged),
    emittedLen: ledger.emitted.length,
    // A ledger has more than one field and every one of them has to be
    // restored. This one decides whether a group survives, so leaving it behind
    // would let a dropped block keep a group alive on text nobody can read.
    occurrencesLen: ledger.occurrences.length,
    // The whole map, not its keys: restoring which slots were resolved without
    // restoring what they resolved to let a dropped block leave a stale verdict
    // behind for a later one to read.
    produced: new Map(ledger.produced),
  });

  const rollback = (snap: ReturnType<typeof snapshot>): void => {
    ledger.spent = snap.spent;
    ledger.redact.length = snap.redactLen;
    ledger.emitted.length = snap.emittedLen;
    ledger.occurrences.length = snap.occurrencesLen;
    ledger.produced = snap.produced;
    for (const key of [...ledger.memo.keys()]) if (!snap.memoKeys.has(key)) ledger.memo.delete(key);
    for (const key of [...ledger.charged]) if (!snap.chargedKeys.has(key)) ledger.charged.delete(key);
  };

  const walk = (list: readonly TemplateNode[], source: string | undefined): string => {
    let out = "";
    // Set when a block just dropped. The separator the user typed after it
    // belongs to that block, so it goes too — otherwise removing the middle of
    // three sections leaves a gap the collapse rule cannot tell apart from a
    // paragraph break the user meant. One line break, not all of them: a
    // deliberate blank line between two surviving sections must survive.
    let swallowNewline = false;

    for (const node of list) {
      if (node.kind === "text") {
        let value = node.value;
        if (swallowNewline && value.startsWith("\n")) value = value.slice(1);
        swallowNewline = false;
        // Literal text inside a section is charged to that section, which is
        // what today's assembly does: the session header's own length is the
        // opening balance the remarks are then fitted into.
        charge(source, value.length);
        out += value;
        continue;
      }
      swallowNewline = false;
      if (node.kind === "slot") {
        // A condition slot inline contributes nothing. The alternative is
        // leaking a marker word into a prompt whenever someone types the bare
        // name, and the validator already tells them to use a block.
        if (specOf(node.name)?.condition) continue;
        out += emitSlot(node.name, node.count, source);
        continue;
      }

      // A block renders its body FIRST, so literals inside it charge in the
      // order they appear and the slot beneath them sees the budget that is
      // actually left — which is how `sessionContextSection` fits remarks under
      // a header it has already paid for.
      const snap = snapshot();
      const blockSource = specOf(node.name)?.source ?? source;
      const body = walk(node.children, blockSource);

      if (node.kind === "group") {
        // A group asks a different question from a block, which is why it is a
        // different node and not a block wearing a name. There is no slot of
        // its own name to have produced anything; what decides it is whether an
        // observation reading landed INSIDE it.
        //
        // Read from the occurrence record and not from `emitted`: `emitted` is
        // charge-gated, so a reading named in the prompt and again in here is
        // recorded once, at the earlier mention, outside this subtree. Reading
        // it would drop a group that plainly rendered text.
        //
        // Scoped to occurrences appended since the snapshot, which is what
        // keeps a reading the user placed in their own prompt from holding the
        // group open around a preamble and a set of empty headings.
        const content = opts.contentSlots;
        const held = ledger.occurrences
          .slice(snap.occurrencesLen)
          .some((o) => content === undefined || content.includes(o.name));
        if (!held) {
          rollback(snap);
          ledger.dropped.add(node.name);
          swallowNewline = out.length === 0 || out.endsWith("\n");
          continue;
        }
        out += body;
        continue;
      }

      // Whether the block holds is decided by its named slot. If the body
      // mentioned it, the answer is what actually EMITTED inside this block —
      // not what the resolver produced. The two used to be the same thing, and
      // stopped being once a reading could be suppressed after resolving: the
      // memo still said "produced", so a block kept its heading with nothing
      // under it. That is the failure the group predicate was built to prevent,
      // one level down. If the body never mentioned the slot — the
      // condition-slot case — ask the resolver, which is the only way to know.
      const mentioned = producedAny(node.name) !== undefined;
      const held = mentioned
        ? ledger.occurrences.slice(snap.occurrencesLen).some((o) => o.name === node.name)
        : resolveSlot(node.name, undefined, blockSource).text.length > 0;

      if (!held || body.trim().length === 0) {
        rollback(snap);
        ledger.dropped.add(node.name);
        // Only a block that stood on its own line takes a line break with it.
        // An inline block — one of several branches sharing a line — has no
        // line of its own to remove, and swallowing the break after the group
        // would pull the next paragraph up.
        swallowNewline = out.length === 0 || out.endsWith("\n");
        continue;
      }
      out += body;
    }
    return out;
  };

  const walked = walk(nodes, undefined);
  const text = opts.normalize === false ? walked : normalize(walked);
  return {
    text,
    redact: ledger.redact,
    emitted: [...new Set(ledger.emitted)],
    degraded: [...ledger.degraded],
    dropped: [...ledger.dropped],
  };
}

/**
 * Parse, then render. The ordinary entry point.
 *
 * Structural errors do not stop a render — R8 promises a stored template is
 * always renderable, and a send is not the place to discover that someone
 * hand-edited the settings file.
 */
export function renderTemplateText(text: unknown, opts: RenderOptions): RenderResult {
  const { nodes } = parseTemplate(text);
  return renderTemplate(nodes, opts);
}
