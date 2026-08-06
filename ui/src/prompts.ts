// Prompt-editor decisions, kept pure so they are testable without a component
// harness — the same shape as lens.ts and colors.ts.

// Would seeding a preset destroy something the user actually wrote?
//
// "Edited" is deliberately narrower than "differs from the shipped default":
// text the user got from a preset is not work, so cycling between presets must
// not nag. Only text that is neither unedited nor any known shipped wording
// counts. An empty string does count — blanking a prompt is a deliberate act,
// and silently refilling it would undo a real decision.
export function isHandEdited(stored: string | null | undefined, knownTexts: readonly string[]): boolean {
  if (stored === null || stored === undefined) return false;
  return !knownTexts.includes(stored);
}
