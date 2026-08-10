import { renderTemplateText, type TemplateRole } from "../../shared/src/templates";

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

const SAMPLE: Record<TemplateRole, Record<string, string>> = {
  "chat-context": {
    context_preamble:
      "The rest of this is mine rather than anything said to me: what my own eyes have, and what I have lately been remarking on elsewhere.",
    clock: "18:22:04",
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
};

export interface TemplatePreview {
  text: string;
  dropped: string[];
  degraded: string[];
}

export function renderPreview(role: TemplateRole, template: string): TemplatePreview {
  const values = SAMPLE[role];
  const out = renderTemplateText(template, {
    role,
    resolve: (req) => ({ text: values[req.name] ?? "" }),
  });
  return { text: out.text, dropped: out.dropped, degraded: out.degraded };
}
