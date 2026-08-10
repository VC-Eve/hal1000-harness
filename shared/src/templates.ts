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
  | { kind: "block"; name: string; at: number; children: TemplateNode[] };

export type TemplateErrorKind =
  | "unknown-slot"
  | "unclosed-block"
  | "stray-close"
  | "bad-count"
  | "bad-name"
  | "unclosed-brace"
  | "condition-inline"
  | "count-unsupported";

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
export function parseTemplate(text: unknown): { nodes: TemplateNode[]; errors: TemplateError[] } {
  const source = typeof text === "string" ? text : "";
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
    // text. R8 promises a stored template always renders.
    root.push(...open.children);
  }

  return { nodes: root, errors };
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const TEMPLATE_ROLES = [
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

const CLOCK: SlotSpec = {
  name: "clock",
  meaning: "the time right now, as this machine reads it",
  note:
    "Supplied alongside relative ages rather than instead of them. Without a wall clock a freshness claim cannot be audited, which once sent someone hunting for a bug in the file read. It is a known risk: timestamps have become the subject of narration before.",
};

const CHAT_CONTEXT_SLOTS: readonly SlotSpec[] = [
  {
    name: "context_preamble",
    meaning: "what I am told this material is, before any of it arrives",
    note:
      "Descriptive rather than instructional, deliberately. Unheaded, the context read as a report handed over for comment and HAL answered it — but a rule about the input becomes the subject of the output. Resolves empty when nothing else in the context produced anything, so it never introduces an empty section.",
  },
  CLOCK,
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
    note:
      "The percentage is supplied bare. An earlier version glossed it — 'a percentage is how strongly that face matched, nothing more' — and the model escalated the gloss into a prohibition it invented and then obeyed against its own data, refusing to name someone it had recognised continuously for two minutes. The band already decides what may be said; the evidence is supplied instead of explained.",
    source: "vision",
    identity: true,
  },
  {
    name: "vision_caption",
    meaning: "my most recent description of the room, quoted and dated",
    note:
      "Quoted and dated rather than asserted, because it comes from a small vision model that invents object counts. It is the one place a caption reaches a conversation. Its own age is stated separately from the live readings: with only the caption carrying a time, HAL applied that age to everything and said it could not know what had happened, about a reading taken that same second.",
    source: "vision",
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
  "chat-context": CHAT_CONTEXT_SLOTS,
  "narration-system": NARRATION_SYSTEM_SLOTS,
  "narration-user": NARRATION_USER_SLOTS,
  "monitor-system": MONITOR_SYSTEM_SLOTS,
  "monitor-user": MONITOR_USER_SLOTS,
  "vision-system": VISION_SYSTEM_SLOTS,
  "vision-user": VISION_USER_SLOTS,
  "captioner-user": CAPTIONER_USER_SLOTS,
};

export function slotSpec(role: TemplateRole, name: string): SlotSpec | undefined {
  return SLOT_VOCABULARY[role].find((s) => s.name === name);
}

export function slotNames(role: TemplateRole): readonly string[] {
  return SLOT_VOCABULARY[role].map((s) => s.name);
}

/**
 * Whether this template is acceptable for this role.
 *
 * Separate from parsing because the renderer must be able to parse a stored
 * template that names a slot the vocabulary no longer has, and render it,
 * without this function's verdict (R8, R35). Validation gates the APPLY; it
 * does not gate the send.
 */
export function validateTemplate(text: unknown, role: TemplateRole): TemplateError[] {
  const { nodes, errors } = parseTemplate(text);
  const valid = slotNames(role);
  const out = [...errors];

  const walk = (list: readonly TemplateNode[], inConditionOf: string | null): void => {
    for (const node of list) {
      if (node.kind === "text") continue;
      const spec = slotSpec(role, node.name);
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
}

export interface RenderResult {
  text: string;
  redact: string[];
  /**
   * Slots the template names that the vocabulary no longer has. They rendered
   * empty; the editor says so rather than leaving the gap silent (R35).
   */
  degraded: string[];
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
function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

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
  /** Which slots produced text this render, for deciding whether a block holds. */
  produced: Map<string, boolean>;
}

export function renderTemplate(nodes: readonly TemplateNode[], opts: RenderOptions): RenderResult {
  const ledger: Ledger = {
    spent: new Map(),
    redact: [],
    degraded: new Set(),
    memo: new Map(),
    charged: new Set(),
    produced: new Map(),
  };
  const budgets = opts.budgets ?? {};

  const budgetLeft = (source?: string): number => {
    if (source === undefined) return Number.POSITIVE_INFINITY;
    const cap = budgets[source];
    if (cap === undefined) return Number.POSITIVE_INFINITY;
    return Math.max(0, cap - (ledger.spent.get(source) ?? 0));
  };

  const charge = (source: string | undefined, amount: number): void => {
    if (source === undefined || amount <= 0) return;
    ledger.spent.set(source, (ledger.spent.get(source) ?? 0) + amount);
  };

  const specOf = (name: string): SlotSpec | undefined =>
    opts.role ? slotSpec(opts.role, name) : undefined;

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
    if (opts.role && !spec) {
      // Renders empty and is reported. R6 forbids accepting a MISSPELLING and
      // rendering it empty; this is the other case — a stored template holding
      // a name the vocabulary used to have — and R35 governs it.
      ledger.degraded.add(name);
      const empty: SlotResult = { text: "" };
      ledger.memo.set(key, empty);
      ledger.produced.set(name, false);
      return empty;
    }

    // A slot without a source of its own spends from whatever section it sits
    // in. That is what makes `{clock}` charge the vision budget inside the
    // sight block and the session budget inside the session one, the way the
    // clock inside a header is charged today as part of that header.
    const result = opts.resolve({ name, count, budgetLeft: budgetLeft(spec?.source ?? ambient) });
    ledger.memo.set(key, result);
    ledger.produced.set(name, result.text.length > 0);
    return result;
  };

  /** Resolve, charge once, and hand back the text to emit. */
  const emitSlot = (name: string, count: number | undefined, ambient: string | undefined): string => {
    const key = `${name}#${count ?? ""}`;
    const result = resolveSlot(name, count, ambient);
    if (!ledger.charged.has(key)) {
      ledger.charged.add(key);
      charge(specOf(name)?.source ?? ambient, result.text.length);
      if (result.redact) ledger.redact.push(...result.redact);
    }
    return result.text;
  };

  const snapshot = () => ({
    spent: new Map(ledger.spent),
    redactLen: ledger.redact.length,
    memoKeys: new Set(ledger.memo.keys()),
    chargedKeys: new Set(ledger.charged),
    producedKeys: new Set(ledger.produced.keys()),
  });

  const rollback = (snap: ReturnType<typeof snapshot>): void => {
    ledger.spent = snap.spent;
    ledger.redact.length = snap.redactLen;
    for (const key of [...ledger.memo.keys()]) if (!snap.memoKeys.has(key)) ledger.memo.delete(key);
    for (const key of [...ledger.charged]) if (!snap.chargedKeys.has(key)) ledger.charged.delete(key);
    for (const key of [...ledger.produced.keys()]) if (!snap.producedKeys.has(key)) ledger.produced.delete(key);
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

      // Whether the block holds is decided by its named slot. If the body
      // mentioned it, the answer is already known; if not — the condition-slot
      // case — ask now.
      const held = ledger.produced.has(node.name)
        ? ledger.produced.get(node.name) === true
        : resolveSlot(node.name, undefined, blockSource).text.length > 0;

      if (!held || body.trim().length === 0) {
        rollback(snap);
        swallowNewline = true;
        continue;
      }
      out += body;
    }
    return out;
  };

  const text = normalize(walk(nodes, undefined));
  return { text, redact: ledger.redact, degraded: [...ledger.degraded] };
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
