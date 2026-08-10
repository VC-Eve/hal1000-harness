import {
  isBlankPrompt,
  resolveTemplate,
  withUniversalSlots,
  type SendDescription,
} from "../../../shared/src/prompts.js";
import {
  renderTemplateText,
  type SlotResult,
  type SlotSpec,
  type TemplateRole,
} from "../../../shared/src/templates.js";

/**
 * Describe the send a render is building, from what the call site already has.
 *
 * One helper rather than an object literal at each of eight sites, so a new
 * universal reading is added here and in `withUniversalSlots` and every role
 * has it — which is the whole claim the tier rests on.
 *
 * The Backend is named by its endpoint rather than by its role, because two
 * roles can share a destination and the question a prompt asks is which machine
 * is answering. A key is never part of it: settings are broadcast whole, so a
 * credential is not something anything outside the server is told.
 */
export function sendTo(
  model: string | null | undefined,
  // A Backend, or a bare endpoint — the Monitor path resolves its Backend
  // inside the queue, after the message it is about to send has been rendered,
  // and the Captioner is not a Backend at all.
  backend: { endpoint: string } | string | null | undefined,
  now: Date = new Date(),
): SendDescription {
  const endpoint = typeof backend === "string" ? backend : (backend?.endpoint ?? "");
  return { model: model ?? "", backend: endpoint, now };
}

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
  // Required rather than optional. A call site that forgot it would render the
  // universal readings empty on every send, forever, and an empty slot is
  // indistinguishable from a reading with nothing to say — so the compiler is
  // asked to notice instead of the user.
  send: SendDescription,
): { text: string; redact: string[]; degraded: string[] } {
  const rendered = renderTemplateText(resolveTemplate(stored, role), {
    role,
    resolve: withUniversalSlots(send, (req) => {
      const value = values[req.name];
      if (value === undefined) return { text: "" };
      return typeof value === "string" ? { text: value } : value;
    }),
  });
  reportDegraded(role, rendered.degraded);
  return rendered;
}

/**
 * Resolve one of the six settings-level prompts, rendering it if it is a Template.
 *
 * Literal is the default and stays the default. A prompt written when braces
 * meant braces keeps them, because the alternative is worse than it looks: an
 * unrecognised brace is not rendered literally by the parser, it is reported as
 * a bad name and its text is DROPPED. A caption prompt containing a JSON
 * example would lose that example on the first send after an upgrade, silently.
 *
 * `normalize: false`, like a phrase and unlike a whole message. The outer
 * render normalizes the finished message, which is where a prompt's blank lines
 * and trailing whitespace are already dealt with today. Normalizing here as
 * well would trim the value before the outer render saw it, and the separator
 * the template placed around it would then collapse differently — a change to
 * what an unedited install hears, arriving through a refactor.
 */
export function renderPrompt(
  stored: unknown,
  isTemplate: boolean | undefined,
  fields: readonly SlotSpec[],
  send: SendDescription,
  id: string,
): { text: string; redact: string[] } {
  // Blanked from the raw value, before anything else: a hand-edited settings
  // file can put a number here, and `String(42)` is not a prompt.
  if (isBlankPrompt(stored)) return { text: "", redact: [] };
  const text = String(stored);
  if (!isTemplate) return { text, redact: [] };
  const rendered = renderTemplateText(text, {
    vocabulary: fields,
    resolve: withUniversalSlots(send, () => ({ text: "" })),
    normalize: false,
  });
  reportDegraded(id, rendered.degraded);
  return { text: rendered.text, redact: rendered.redact };
}

/**
 * Say when a stored template named a slot that no longer exists.
 *
 * The section renders empty and the message goes out short. Left unreported
 * that is indistinguishable from the reading simply having nothing to say, on
 * every send, forever — the settings editor is the only place it currently
 * shows, and nobody opens settings because a prompt got quietly shorter.
 *
 * Once per role per process: this sits on every inference path, and a line per
 * send would bury the log it is trying to be visible in.
 */
const reported = new Set<string>();

// Takes a plain string rather than a role: the six converted prompts render
// against an explicit field list and have no role key, so a role-typed
// parameter would leave their degraded slots unreported — which is the exact
// silence this function exists to break.
export function reportDegraded(role: TemplateRole | string, degraded: readonly string[]): void {
  if (degraded.length === 0) return;
  const key = `${role}:${[...degraded].sort().join(",")}`;
  if (reported.has(key)) return;
  reported.add(key);
  console.error(
    `template ${role} names ${degraded.length === 1 ? "a slot that no longer exists" : "slots that no longer exist"}: ` +
      `${degraded.join(", ")}. That part of the message is rendering empty; edit the template in settings to repair it.`,
  );
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
