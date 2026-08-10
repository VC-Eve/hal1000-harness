import {
  DEFAULT_CHAT_CONTEXT_TEMPLATE,
  sessionLabelSlot,
  sessionRemarksSlot,
  monitorRemarksSlot,
  withUniversalSlots,
  recentPeopleSlot,
  visionCaptionSlot,
  visionFacesSlot,
  visionNobodySlot,
  visionOffSlot,
  visionProfilesSlot,
  type LastLook,
  type RecentSighting,
} from "../../../shared/src/prompts.js";
import { renderTemplateText, type SlotRequest, type SlotResult } from "../../../shared/src/templates.js";
import type { PhraseSettings } from "../../../shared/src/phrases.js";
import { reportDegraded } from "./roleMessages.js";

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
  // The narration feed, carrying session AND Monitor entries together. Each
  // slot filters to its own: the session block on a session id, the Monitor
  // block on a monitor id, so neither can pick up the other by accident.
  entries: readonly {
    text: string;
    at: string;
    sessionId?: string | null;
    sessionLabel?: string;
    monitorId?: string | null;
  }[];
  watchedSessionId: string | null;
  preamble: string;
  /** Characters the sight slots may spend. Zero when the source is off. */
  visionBudget: number;
  /** Characters the session slots may spend. Zero when the source is off. */
  sessionBudget: number;
  /** Characters the Monitor slots may spend. Absent or zero means off, which
   * is what keeps a caller written before this source existed unchanged. */
  monitorBudget?: number;
  /** Who the record shows was recognised lately, newest first. */
  recentlySeen?: readonly RecentSighting[];
  /** How a Monitor is named in the feed. */
  monitorLabel?: (monitorId: string) => string;
  /** The user's wording for the individual lines these slots build. */
  phrases?: PhraseSettings;
  now?: Date;
  /** The model this context is being assembled for, if the caller knows it. */
  model?: string;
  /** Where the send is going, if the caller knows it. */
  backend?: string;
}

export interface ChatContextRender {
  text: string;
  redact: string[];
  degraded: string[];
}

/**
 * Which slots count as HAVING something to say.
 *
 * The clock and the session label are furniture — the clock always resolves,
 * and the label resolves from the entry list alone — so treating either as
 * content would mean a heading whose list the budget emptied still counted as
 * a context. Carrying a budget source is NOT the test for the same reason:
 * `session_label` carries one and is furniture.
 *
 * At module scope because the merged pass needs it as the group's predicate,
 * and two copies of this list is how the two renders come to disagree about
 * whether HAL has anything to say at all.
 */
export const CONTENT_SLOTS: readonly string[] = [
  "session_remarks",
  "vision_recent_people",
  "monitor_remarks",
  "vision_off",
  "vision_nobody",
  "vision_faces",
  "vision_caption",
  "vision_profiles",
];

const CONTENT = new Set(CONTENT_SLOTS);

/**
 * What each context reading resolves to.
 *
 * A module-level function rather than a closure inside the render, because the
 * merged pass needs the same resolver and a second copy is how the two renders
 * come to disagree about what a reading says.
 */
export function contextResolverFor(inputs: ChatContextInputs, now: Date): (req: SlotRequest) => SlotResult {
  return (req) => resolveContextSlot(req, inputs, now);
}

function resolveContextSlot(req: SlotRequest, inputs: ChatContextInputs, now: Date): SlotResult {
  switch (req.name) {
    case "context_preamble":
      return { text: inputs.preamble.trim().length > 0 ? inputs.preamble : "" };
    case "session_label":
      return { text: sessionLabelSlot(inputs.entries, inputs.watchedSessionId) };
    case "session_remarks":
      return {
        text: sessionRemarksSlot(inputs.entries, inputs.watchedSessionId, req.budgetLeft, now, req.count, inputs.phrases),
      };
    case "vision_off":
      return { text: visionOffSlot(inputs.presence, req.budgetLeft, inputs.phrases) };
    case "vision_nobody":
      return { text: visionNobodySlot(inputs.presence, req.budgetLeft, inputs.phrases) };
    case "vision_faces":
      return visionFacesSlot(inputs.presence, inputs.thresholds, req.budgetLeft, now, inputs.phrases);
    case "vision_recent_people":
      return {
        text: recentPeopleSlot(inputs.recentlySeen ?? [], req.budgetLeft, now, req.count, inputs.phrases),
      };
    case "monitor_remarks":
      return {
        text: monitorRemarksSlot(
          inputs.entries,
          inputs.monitorLabel ?? ((id) => id),
          req.budgetLeft,
          now,
          req.count,
          inputs.phrases,
        ),
      };
    case "vision_caption":
      return { text: visionCaptionSlot(inputs.lastLook, req.budgetLeft, now, inputs.phrases) };
    case "vision_profiles": {
      const out = visionProfilesSlot(inputs.presence, inputs.people, inputs.thresholds, req.budgetLeft, inputs.phrases);
      return out;
    }
    default:
      return { text: "" };
  }
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
  const resolve = (req: SlotRequest): SlotResult => resolveContextSlot(req, inputs, now);

  const rendered = renderTemplateText(template ?? DEFAULT_CHAT_CONTEXT_TEMPLATE, {
    // `{clock}` and `{date}` used to be answered in the switch above and are now
    // the universal tier's. The instant is the one this render was given, not a
    // fresh reading, which is what keeps two mentions of the clock in one
    // message agreeing with each other.
    resolve: withUniversalSlots({ model: inputs.model ?? "", backend: inputs.backend ?? "", now }, resolve),
    role: "chat-context",
    budgets: { vision: inputs.visionBudget, session: inputs.sessionBudget, monitor: inputs.monitorBudget ?? 0 },
  });

  reportDegraded("chat-context", rendered.degraded);

  // The clock alone is not content. It resolves inside a heading, so a template
  // that kept a heading and lost its list would otherwise look like it had
  // something to say.
  //
  // Decided from what actually reached the output, not from what the resolver
  // was asked for. A content slot inside a block that then dropped resolved —
  // and contributed nothing — so asking the resolver would call that a context
  // and send HAL a page of the user's own headings with no readings under them.
  if (!rendered.emitted.some((name) => CONTENT.has(name))) {
    return { text: "", redact: [], degraded: rendered.degraded };
  }
  return rendered;
}
