import {
  DEFAULT_CHAT_CONTEXT_TEMPLATE,
  clockTime,
  sessionLabelSlot,
  sessionRemarksSlot,
  visionCaptionSlot,
  visionFacesSlot,
  visionNobodySlot,
  visionOffSlot,
  visionProfilesSlot,
  type LastLook,
} from "../../../shared/src/prompts.js";
import { renderTemplateText, type SlotRequest, type SlotResult } from "../../../shared/src/templates.js";

/**
 * Everything the chat context template may draw on, read at send time.
 *
 * A plain value object rather than the services themselves: the renderer has no
 * business knowing about appearance continuity or day-partitioned logs, and
 * every field here must be read per request — a value captured once for one
 * caller is stale for the next, which this project has already paid for.
 */
export interface ChatContextInputs {
  presence: {
    watching: boolean;
    present: readonly { match: { name: string; confidence: number } | null; since?: string; weight?: number }[];
  };
  lastLook: LastLook | null;
  people: readonly { name: string; profile?: string; isOperator?: boolean }[];
  thresholds: { recognition: number; statement: number };
  entries: readonly { text: string; at: string; sessionId?: string | null; sessionLabel?: string }[];
  watchedSessionId: string | null;
  preamble: string;
  /** Characters the sight slots may spend. Zero when the source is off. */
  visionBudget: number;
  /** Characters the session slots may spend. Zero when the source is off. */
  sessionBudget: number;
  now?: Date;
}

export interface ChatContextRender {
  text: string;
  redact: string[];
  degraded: string[];
}

/**
 * Render one Conversation's observation context.
 *
 * The preamble is not what decides whether there is a context at all — the
 * content slots are. It sits first in the template, so it cannot know what
 * follows it; instead the whole render is discarded when no content slot
 * produced anything, which is what the previous `if (parts.length === 0)`
 * did and keeps a lone preamble from ever being sent as though it introduced
 * something.
 */
export function renderChatContext(
  template: string | null | undefined,
  inputs: ChatContextInputs,
): ChatContextRender {
  const now = inputs.now ?? new Date();
  let producedContent = false;

  // Which slots count as HAVING something to say. The clock and the session
  // label are furniture — the clock always resolves, and the label resolves
  // from the entry list alone, so treating either as content would mean a
  // heading whose list the budget emptied still counted as a context.
  const CONTENT = new Set([
    "session_remarks",
    "vision_off",
    "vision_nobody",
    "vision_faces",
    "vision_caption",
    "vision_profiles",
  ]);

  const note = (name: string, result: SlotResult): SlotResult => {
    if (CONTENT.has(name) && result.text.length > 0) producedContent = true;
    return result;
  };

  const resolve = (req: SlotRequest): SlotResult => {
    switch (req.name) {
      case "context_preamble":
        return { text: inputs.preamble.trim().length > 0 ? inputs.preamble : "" };
      case "clock":
        return note(req.name, { text: clockTime(now.getTime()) });
      case "session_label":
        return note(req.name, { text: sessionLabelSlot(inputs.entries, inputs.watchedSessionId) });
      case "session_remarks":
        return note(req.name, {
          text: sessionRemarksSlot(inputs.entries, inputs.watchedSessionId, req.budgetLeft, now, req.count),
        });
      case "vision_off":
        return note(req.name, { text: visionOffSlot(inputs.presence, req.budgetLeft) });
      case "vision_nobody":
        return note(req.name, { text: visionNobodySlot(inputs.presence, req.budgetLeft) });
      case "vision_faces":
        return note(req.name, {
          text: visionFacesSlot(inputs.presence, inputs.thresholds, req.budgetLeft, now),
        });
      case "vision_caption":
        return note(req.name, { text: visionCaptionSlot(inputs.lastLook, req.budgetLeft, now) });
      case "vision_profiles": {
        const out = visionProfilesSlot(inputs.presence, inputs.people, inputs.thresholds, req.budgetLeft);
        return note(req.name, out);
      }
      default:
        return { text: "" };
    }
  };

  const rendered = renderTemplateText(template ?? DEFAULT_CHAT_CONTEXT_TEMPLATE, {
    resolve,
    role: "chat-context",
    budgets: { vision: inputs.visionBudget, session: inputs.sessionBudget },
  });

  // The clock alone is not content. It resolves inside a heading, so a template
  // that kept a heading and lost its list would otherwise look like it had
  // something to say.
  if (!producedContent || rendered.text.trim().length === 0) {
    return { text: "", redact: [], degraded: rendered.degraded };
  }
  return rendered;
}
