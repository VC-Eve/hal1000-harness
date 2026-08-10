import {
  DEFAULT_CHAT_CONTEXT_TEMPLATE,
  isBlankPrompt,
  withUniversalSlots,
  type SendDescription,
} from "../../../shared/src/prompts.js";
import {
  parseTemplate,
  renderTemplate,
  type SlotRequest,
  type SlotResult,
  type TemplateNode,
} from "../../../shared/src/templates.js";
import { CONTENT_SLOTS, contextResolverFor, type ChatContextInputs } from "./chatContext.js";
import { reportDegraded } from "./roleMessages.js";

/**
 * A Conversation's system message: its own prompt and its observations, in one pass.
 *
 * Two renders is what the old shape was, and two renders meant two ledgers —
 * which is why a Conversation prompt could only ever place the whole context
 * block and never a reading inside it. A second, separately-budgeted route to a
 * reading is the hazard `shared/src/templates.ts` records; merging the passes
 * removes it rather than forbidding the thing it made dangerous.
 *
 * What that buys, concretely: one budget ledger, so a reading named twice is
 * drawn once and charged once; one redaction list, so a Character Profile
 * placed by the user's own wording is withheld from the never-pruned inference
 * log on the same terms as one placed by the context template; and one place
 * where the whole observation block can be dropped.
 */
export interface MergedRender {
  text: string;
  redact: string[];
  degraded: string[];
  /** Whether any observation reading reached the message. */
  spoke: boolean;
}

export interface MergedInput {
  /** The Conversation's own prompt, raw — a hand-edited store can hold anything. */
  prompt: unknown;
  /** Whether that prompt is read as a Template rather than as literal text. */
  promptIsTemplate: boolean | undefined;
  /** The stored conversation-context template, or null for the shipped one. */
  contextTemplate: string | null | undefined;
  /**
   * What the context may draw on, or null when there is no context at all —
   * every switch off, or the Off-Machine Acknowledgement withheld.
   *
   * Null rather than zero budgets, because those are different states: zero
   * budgets still consult the sources and then render nothing, and the gate's
   * whole promise is that nothing is consulted.
   */
  inputs: ChatContextInputs | null;
  send: SendDescription;
}

/** Slot names that are observations, for deciding whether the group holds. */
const CONTENT = new Set(CONTENT_SLOTS);

/**
 * Replace `{context}` with the context template's nodes, as a droppable group.
 *
 * Returns null when the prompt never names it, so the caller can decide whether
 * to append the group beneath instead — a decision that depends on what else
 * the prompt named and is not this function's business.
 */
function spliceGroup(nodes: readonly TemplateNode[], group: TemplateNode): TemplateNode[] | null {
  let found = false;
  const walk = (list: readonly TemplateNode[]): TemplateNode[] =>
    list.map((node) => {
      if (node.kind === "slot" && node.name === "context") {
        found = true;
        return group;
      }
      // `{#context}…{context}…{/}` becomes a group rather than staying a block.
      //
      // A block holds when the slot of its own name produced text, and there is
      // no longer a `context` slot to produce anything — it is this group. Left
      // as a block it would drop every time, taking its wording and the whole
      // context with it. As a group it asks the question the user meant by
      // typing it: keep this wording only while there is something under it.
      if (node.kind === "block" && node.name === "context") {
        return { kind: "group", name: "context", at: node.at, children: walk(node.children) };
      }
      if (node.kind === "block" || node.kind === "group") {
        return { ...node, children: walk(node.children) };
      }
      return node;
    });
  const spliced = walk(nodes);
  return found ? spliced : null;
}

/** Whether a template names any observation reading anywhere in it. */
function namesAnObservation(nodes: readonly TemplateNode[]): boolean {
  return nodes.some((node) => {
    if (node.kind === "slot") return CONTENT.has(node.name);
    if (node.kind === "block" || node.kind === "group") return namesAnObservation(node.children);
    return false;
  });
}

export function renderConversationMessage(input: MergedInput): MergedRender {
  const { prompt, promptIsTemplate, contextTemplate, inputs, send } = input;
  const now = inputs?.now ?? send.now;

  // Blanked from the raw value before anything else: a hand-edited store can
  // put a number in this slot, and `String(42)` is not a prompt.
  const text = isBlankPrompt(prompt) ? "" : String(prompt);

  // A prompt that has not opted in is one text node. It shares the ledger like
  // everything else, and its braces are never parsed — which is the whole
  // reason the literal branch exists, and it is the default install rather than
  // an afterthought of the template branch.
  const promptNodes: TemplateNode[] = promptIsTemplate
    ? parseTemplate(text).nodes
    : text.length > 0
      ? [{ kind: "text", value: text }]
      : [];

  const group: TemplateNode | null =
    inputs === null
      ? null
      : {
          kind: "group",
          name: "context",
          at: 0,
          children: parseTemplate(contextTemplate ?? DEFAULT_CHAT_CONTEXT_TEMPLATE).nodes,
        };

  let nodes = promptNodes;
  if (group) {
    const spliced = spliceGroup(promptNodes, group);
    if (spliced) {
      nodes = spliced;
    } else if (!namesAnObservation(promptNodes)) {
      // Appended beneath, as it always was — but only when the prompt placed no
      // reading of its own. A prompt that arranged its own observations and
      // deliberately left `{context}` out would otherwise get everything twice.
      nodes = promptNodes.length > 0 ? [...promptNodes, { kind: "text", value: "\n\n" }, group] : [group];
    }
  }

  const resolveContext = inputs
    ? (req: SlotRequest): SlotResult => contextResolverFor(inputs, now)(req)
    : (): SlotResult => ({ text: "" });

  const budgets: Record<string, number> = inputs
    ? { vision: inputs.visionBudget, session: inputs.sessionBudget, monitor: inputs.monitorBudget ?? 0 }
    : {};

  const rendered = renderTemplate(nodes, {
    role: "conversation-system",
    resolve: withUniversalSlots(send, resolveContext),
    budgets,
    // Charging and emitting are different numbers once a reading can be named
    // twice: the repeat is charged nothing but its characters are still in the
    // message. The Context Levels bound both.
    emissionCaps: budgets,
    contentSlots: CONTENT_SLOTS,
  });

  reportDegraded("conversation-system", rendered.degraded);

  return {
    text: rendered.text,
    redact: rendered.redact,
    degraded: rendered.degraded,
    spoke: rendered.emitted.some((name) => CONTENT.has(name)),
  };
}
