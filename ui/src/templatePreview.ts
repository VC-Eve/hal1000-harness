import { renderTemplateText, vocabularyFor, type SlotSpec, type TemplateRole } from "../../shared/src/templates";

// What a template renders, for the editor.
//
// Against a fixed sample rather than live readings, deliberately for now: a
// preview that used the real camera would be blank on the machine where most
// editing happens — the one with Vision switched off — and would change under
// the user's hands while they typed. The sample is chosen to exercise the
// interesting shapes: somebody recognised and somebody not, a caption, a
// truncation notice, a profile.
//
// The values here are illustrative and clearly so. They are never sent.

const SAMPLE: Record<string, Record<string, string>> = {
  "conversation-system": {
    context:
      "The rest of this is mine rather than anything said to me: what my own eyes have…\n\n" +
      "Who I can see, read live just now at 18:22:04:\n" +
      "- Creator 74%, recognised without a break as the same person for 6 minutes, steadily across that whole run.",
  },
  "chat-context": {
    context_preamble:
      "The rest of this is mine rather than anything said to me: what my own eyes have, and what I have lately been remarking on elsewhere.",
    session_label: "Claude Code [a408c0a1]",
    session_remarks:
      "- [18:14:51] I see it reading the router.\n- [18:19:30] It is editing the parser.\n(214 earlier remarks not recalled here.)",
    // Only one of the three sight states is ever set at once; the sample picks
    // the one with the most to show.
    vision_off: "",
    vision_nobody: "",
    vision_faces:
      "- Creator 74%, recognised without a break as the same person for 6 minutes, steadily across that whole run.\n- someone I do not recognise, recognised without a break as the same person for 40 seconds, on only a check or two so far.",
    vision_caption:
      'Separately, and this is the one thing above that is not current — my last description of the room, 12 seconds ago at 18:21:52: "A person sits at a desk, facing the screen."',
    vision_profiles: "You know Creator, whose machine this is: builds HAL, prefers blunt answers.",
  },
  "narration-system": {
    narration_prompt: "You are HAL 1000, the calm and precise observer aboard this development machine…",
  },
  "narration-user": {
    session_lines:
      "[user] fix the parser\n[assistant] looking at it now (tools: Read(parser.ts))\n[tool-result] failed: no such file",
  },
  "monitor-system": {
    monitor_prompt: "You are HAL 1000, watching a log on this machine for the developer…",
  },
  "monitor-user": {
    monitor_label: "windows event log",
    monitor_lines: "Service Control Manager: the Print Spooler service entered the stopped state.",
    // The preview shows the quiet-cycle branch, which is the common one.
    reason_interrupt: "",
    reason_full: "",
    reason_cycle: "set",
  },
  "vision-system": {
    vision_prompt: "You are HAL 1000, watching through a camera…",
    known_people: "You know Creator, whose machine this is: builds HAL, prefers blunt answers.",
  },
  "vision-user": {
    vision_caption_lines:
      "[Creator 74%] A person sits at a desk, facing the screen.\nA person at a desk, typing, seen from the side.",
    silence_token: "(nothing)",
    silence_expected: "set",
    sensitivity_always: "",
    sensitivity_high: "",
    sensitivity_medium: "set",
    sensitivity_low: "",
  },
  "captioner-user": {
    caption_prompt: "Describe this camera frame plainly and briefly…",
  },
  // The six settings-level prompts. Five accept the universal tier and nothing
  // else, so their sample is the shared one below and the entry is empty; the
  // default conversation prompt previews what a Conversation would render.
  narrationPrompt: {},
  monitorPrompt: {},
  visionPrompt: {},
  captionPrompt: {},
  chatContextPreamble: {},
  chatDefaultPrompt: {
    context:
      "The rest of this is mine rather than anything said to me: what my own eyes have…\n\n" +
      "Who I can see, read live just now at 18:22:04:\n" +
      "- Creator 74%, recognised without a break as the same person for 6 minutes, steadily across that whole run.",
  },
};

// The universal tier, sampled once rather than nine times.
//
// `{clock}` used to appear in two of these maps and in neither of the other
// seven, which is the same asymmetry the tier removes from the vocabulary. A
// per-role copy would also be a second place for the preview to disagree with
// what a send actually renders.
const UNIVERSAL_SAMPLE: Record<string, string> = {
  clock: "18:22:04",
  date: "Sunday 9 August 2026",
  model: "qwen2.5:14b",
  backend: "http://127.0.0.1:11434",
};

export interface TemplatePreview {
  text: string;
  dropped: string[];
  degraded: string[];
}

/**
 * Preview one template.
 *
 * Keyed by a sample name rather than a role, because the six settings-level
 * prompts are Templates now and none of them is a role. A vocabulary is passed
 * alongside so the preview refuses exactly what the editor refuses — the two
 * disagreeing is how a user learns a slot exists by being told it does not.
 */
export function renderPreview(
  key: TemplateRole | string,
  template: string,
  slots?: readonly SlotSpec[],
): TemplatePreview {
  const values = SAMPLE[key] ?? {};
  const out = renderTemplateText(template, {
    vocabulary: slots ?? vocabularyFor(key as TemplateRole),
    // The role's own first, so a role that ever defines a name the tier also
    // has previews what it would actually render.
    resolve: (req) => ({ text: values[req.name] ?? UNIVERSAL_SAMPLE[req.name] ?? "" }),
  });
  return { text: out.text, dropped: out.dropped, degraded: out.degraded };
}
