import { describe, expect, it } from "vitest";
import { composeSystemMessage } from "../../src/templates/conversationSystem.js";

// A Conversation's own prompt, now a template like everything else — and the
// rules that keep an install that has never touched it unchanged.

const CONTEXT = "Who I can see, read live just now at 18:22:04:\n- Creator 74%.";

const legacy = (systemPrompt: string) => ({ systemPrompt });
const templated = (systemPrompt: string) => ({ systemPrompt, promptIsTemplate: true });

describe("a Conversation that predates templates", () => {
  it("renders its prompt literally, context beneath, exactly as before", () => {
    expect(composeSystemMessage(legacy("You are HAL."), "You are HAL.", CONTEXT)).toBe(
      `You are HAL.\n\n${CONTEXT}`,
    );
  });

  it("leaves braces alone rather than reading them as slots", () => {
    // The whole reason opting in is a deliberate act. A prompt written when
    // braces meant braces must not lose them to an unknown-slot render.
    const prompt = 'Answer as {"tone": "dry"} and mention {context} by name.';
    expect(composeSystemMessage(legacy(prompt), prompt, "")).toBe(prompt);
  });

  it("sends no system message when the prompt is blank and there is no context", () => {
    expect(composeSystemMessage(legacy(""), "", "")).toBe("");
  });

  it("sends the context alone when the prompt is blank", () => {
    expect(composeSystemMessage(legacy(""), "", CONTEXT)).toBe(CONTEXT);
  });

  it("drops a non-string prompt rather than stringifying it", () => {
    expect(composeSystemMessage(legacy(""), 42, CONTEXT)).toBe(CONTEXT);
    expect(composeSystemMessage(legacy(""), null, CONTEXT)).toBe(CONTEXT);
  });
});

describe("a Conversation that opted in", () => {
  it("puts the context where {context} is typed", () => {
    const prompt = "Before.\n\n{context}\n\nAfter.";
    expect(composeSystemMessage(templated(prompt), prompt, CONTEXT)).toBe(
      `Before.\n\n${CONTEXT}\n\nAfter.`,
    );
  });

  it("lets a thread put its observations above its own instructions", () => {
    const prompt = "{context}\n\nYou are HAL. Answer briefly.";
    const out = composeSystemMessage(templated(prompt), prompt, CONTEXT);
    expect(out.indexOf("Who I can see")).toBeLessThan(out.indexOf("You are HAL."));
  });

  it("appends the context beneath when the template does not place it", () => {
    // The shipped default is empty, so this is the ordinary case and the
    // switches must keep meaning what they say.
    const prompt = "You are HAL.";
    expect(composeSystemMessage(templated(prompt), prompt, CONTEXT)).toBe(`You are HAL.\n\n${CONTEXT}`);
  });

  it("honours a placed {context} that resolved to nothing, and does not append", () => {
    // A bare slot leaves the whitespace the user typed around it — the renderer
    // never removes a line that still has literal text on it. What matters here
    // is that the context is not ALSO appended beneath: the thread placed it.
    const prompt = "Before.\n{context}\nAfter.";
    expect(composeSystemMessage(templated(prompt), prompt, "")).toBe("Before.\n\nAfter.");
  });

  it("closes the gap when the slot is wrapped in a block", () => {
    const prompt = "Before.\n{#context}{context}\n{/}After.";
    expect(composeSystemMessage(templated(prompt), prompt, "")).toBe("Before.\nAfter.");
  });

  it("renders {clock}", () => {
    const out = composeSystemMessage(templated("It is {clock}."), "It is {clock}.", "");
    expect(out).toMatch(/^It is \d{2}:\d{2}:\d{2}\.$/);
  });

  it("keeps escaped braces literal", () => {
    const prompt = 'Answer as {{"tone": "dry"}}.';
    expect(composeSystemMessage(templated(prompt), prompt, "")).toBe('Answer as {"tone": "dry"}.');
  });

  it("renders a slot the vocabulary does not have as nothing rather than failing the send", () => {
    const prompt = "Kept {vision_faces} kept";
    // The sight slots belong to the context template alone, so the readings
    // cannot reach a request twice — once budgeted and once not.
    expect(composeSystemMessage(templated(prompt), prompt, "")).toBe("Kept  kept");
  });

  it("still sends nothing when both the render and the context are empty", () => {
    expect(composeSystemMessage(templated(""), "", "")).toBe("");
  });
});
