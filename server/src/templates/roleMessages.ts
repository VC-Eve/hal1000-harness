import { resolveTemplate } from "../../../shared/src/prompts.js";
import { renderTemplateText, type SlotResult, type TemplateRole } from "../../../shared/src/templates.js";

/**
 * Render one role's message from a flat map of slot values.
 *
 * The observation roles have no budget to divide — narration, Monitors and
 * Vision each size their own batch before it reaches here — so this is the
 * simple case: name what each slot resolves to and let the template place it.
 *
 * A slot absent from the map resolves empty, which is what makes the branch
 * slots work: exactly one reason or one sensitivity is supplied and the rest
 * drop with their wording.
 *
 * Note that the rendered message is trimmed and runs of blank lines in it
 * collapse to one. That is what lets a dropped section take its separators
 * with it, and it means a slot value carrying three consecutive newlines comes
 * out with two. Prompts here are paragraphs, so this has no practical effect —
 * but it is a property of the renderer rather than an accident.
 */
export function renderRoleMessage(
  role: TemplateRole,
  stored: string | null | undefined,
  values: Readonly<Record<string, string | SlotResult | undefined>>,
): { text: string; redact: string[]; degraded: string[] } {
  const rendered = renderTemplateText(resolveTemplate(stored, role), {
    role,
    resolve: (req) => {
      const value = values[req.name];
      if (value === undefined) return { text: "" };
      return typeof value === "string" ? { text: value } : value;
    },
  });
  return rendered;
}

/**
 * A system message, or nothing.
 *
 * Blank means blank: a template whose whole render is empty sends no system
 * message rather than an empty one, which is what preserved pre-prompt
 * behaviour byte for byte and is now a property of the rendered result rather
 * than of the prompt text. That distinction matters for Vision, where blanking
 * the prompt must not delete the standing knowledge about people that sits in
 * the same message.
 */
export function systemMessages(text: string): { role: "system"; content: string }[] {
  return text.length > 0 ? [{ role: "system" as const, content: text }] : [];
}
