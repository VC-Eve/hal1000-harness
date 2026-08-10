import { clockTime, isBlankPrompt } from "../../../shared/src/prompts.js";
import { renderTemplateText } from "../../../shared/src/templates.js";
import { reportDegraded } from "./roleMessages.js";

/**
 * Build the system message a Conversation sends.
 *
 * The prompt is the user's text and the context is what HAL was told about the
 * world; this decides how the two sit together. Until now the answer was fixed
 * — prompt first, context beneath — and this makes it the Conversation's own.
 *
 * Two rules, and both exist to keep an existing install unchanged:
 *
 * A Conversation whose prompt predates templates is rendered literally. Its
 * text was written when braces meant braces, and reading a stored `{name}` as a
 * slot would silently drop it from a prompt somebody is relying on. A thread
 * opts in by being saved through the editor, which is also where its braces get
 * escaped, so nothing is migrated behind anyone's back.
 *
 * A template that does not mention `{context}` still gets its context, appended
 * beneath. The shipped default is empty — chat has never sent a system message
 * by default — so a rule that only placed context when asked would mean the
 * ordinary Conversation silently stopped receiving what its switches promised.
 */
export function composeSystemMessage(
  conversation: { systemPrompt?: string; promptIsTemplate?: boolean },
  // Unknown rather than string: a hand-edited store can hold anything here.
  prompt: unknown,
  context: string,
): string {
  // Blanked before anything else, and from the raw value: a hand-edited store
  // can put a number here, and `String(42)` is not a prompt.
  const text = isBlankPrompt(prompt) ? "" : String(prompt);

  // Legacy: exactly what this did before templates existed.
  if (!conversation.promptIsTemplate) {
    return [text, context].filter((p) => p.length > 0).join("\n\n");
  }

  const rendered = renderTemplateText(text, {
    role: "conversation-system",
    resolve: (req) => {
      if (req.name === "clock") return { text: clockTime(Date.now()) };
      return { text: req.name === "context" ? context : "" };
    },
  });
  reportDegraded("conversation-system", rendered.degraded);

  // Whether the context was placed is read from what reached the output, not
  // from whether the resolver was asked. A `{#context}` block resolves the slot
  // to decide whether it holds, and a block that holds without containing
  // `{context}` would otherwise count as having placed it — leaving the context
  // neither placed nor appended, and silently gone. `emitted` exists for exactly
  // this distinction; the same mistake was caught once already in
  // `renderChatContext`.
  if (rendered.emitted.includes("context")) return rendered.text;
  return [rendered.text, context].filter((p) => p.length > 0).join("\n\n");
}
