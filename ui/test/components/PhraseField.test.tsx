import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { PHRASES } from "../../../shared/src/phrases";
import { PhraseField, SAMPLE } from "../../src/components/PhraseField";

// The preview is the only place a user finds out what their edit does, so a
// field with no sample renders empty and the phrase looks broken while it is
// correct. That is what `[{kind}] {text}` previewing as `[] …` was.

describe("every phrase field has a sample", () => {
  it("names a value for each field in the catalogue", () => {
    const missing = PHRASES.flatMap((p) =>
      p.fields.filter((f) => !(f.name in SAMPLE)).map((f) => `${p.id}.${f.name}`),
    );
    expect(missing, `add a sample value in PhraseField.tsx for: ${missing.join(", ")}`).toEqual([]);
  });

  const previewOf = (id: string): string => {
    const spec = PHRASES.find((p) => p.id === id)!;
    // Queried through this render's own result rather than through `screen`:
    // the sweep below renders many fields into one document, and the draft text
    // sits in a textarea that matches the same words as the preview.
    const view = render(<PhraseField spec={spec} stored={null} onApply={() => {}} onReset={() => {}} />);
    const text = view.getByTestId(`phrase-preview-${id}`).textContent ?? "";
    view.unmount();
    return text;
  };

  it("renders a shipped phrase as a line, not as a form", () => {
    // The tag is filled in, which is the thing that was empty.
    expect(previewOf("narration.event_line")).toContain("[assistant] I see it reading the router.");
  });

  it("renders the Vision caption line with somebody in it", () => {
    expect(previewOf("sight.caption_line")).toContain("[Creator 74%");
  });

  it("renders the Monitor line with its marker and source", () => {
    expect(previewOf("monitor.event_line")).toContain("[severe] kernel: ");
  });

  it("never previews a substituted phrase with an empty brace pair", () => {
    // The failure this file exists for: a field with no sample renders empty
    // and leaves the punctuation around it stranded.
    for (const spec of PHRASES.filter((p) => p.fields.some((f) => !f.condition))) {
      expect(previewOf(spec.id), spec.id).not.toMatch(/\[\]|\(\)|\{\}/);
    }
  });
});
