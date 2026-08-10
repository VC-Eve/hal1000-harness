import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import "./harness";
import { ConversationPrompt } from "../../src/components/ConversationPrompt";
import type { Conversation } from "../../../shared/src/types";

// Behaviour a reader cannot check by eye: what is sent, when the opt-in is
// irreversible, and whether braces survive the crossing.

const convo = (over: Partial<Conversation> = {}): Conversation => ({
  id: "11111111-1111-4111-8111-111111111111",
  title: "t",
  model: "m",
  systemPrompt: "You are HAL.",
  createdAt: "",
  updatedAt: "",
  messages: [],
  ...over,
});

function setup(over: Partial<Conversation> = {}, chatDefault = "") {
  const send = vi.fn();
  const c = convo(over);
  const view = render(
    <ConversationPrompt conversation={c} chatDefault={chatDefault} send={send} disabled={false} />,
  );
  fireEvent.click(screen.getByRole("button", { name: /system prompt:/ }));
  return { send, conversation: c, ...view };
}

const box = (): HTMLTextAreaElement => screen.getByLabelText("Conversation system prompt") as HTMLTextAreaElement;

describe("a thread that has never opted in", () => {
  it("says it is plain text and offers the opt-in", () => {
    setup();
    expect(screen.getByTestId("convo-prompt-literal")).toBeInTheDocument();
    expect(screen.getByTestId("convo-prompt-enable-slots")).toBeInTheDocument();
  });

  it("reports no slot errors, because the prompt is not parsed", () => {
    setup({ systemPrompt: "Mention {nonsense} please." });
    expect(screen.queryByTestId("convo-prompt-errors")).toBeNull();
  });

  it("sends no isTemplate flag on an ordinary apply", () => {
    const { send } = setup();
    fireEvent.change(box(), { target: { value: "Changed." } });
    fireEvent.click(screen.getByRole("button", { name: "apply" }));
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "set-conversation-prompt", prompt: "Changed." }),
    );
    expect(send.mock.calls[0][0].isTemplate).toBeUndefined();
  });
});

describe("opting in", () => {
  it("escapes existing braces so they keep meaning braces", () => {
    const { send } = setup({ systemPrompt: 'Answer as {"tone": "dry"}.' });
    fireEvent.click(screen.getByTestId("convo-prompt-enable-slots"));
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'Answer as {{"tone": "dry"}}.', isTemplate: true }),
    );
  });

  it("leaves a brace-free prompt untouched", () => {
    const { send } = setup({ systemPrompt: "You are HAL." });
    fireEvent.click(screen.getByTestId("convo-prompt-enable-slots"));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ prompt: "You are HAL.", isTemplate: true }));
  });

  it("cannot be pressed twice, so braces are never double-escaped", () => {
    // The server round trip has not landed yet; without a local flag the button
    // stays live and a second press escapes the escaping.
    const { send } = setup({ systemPrompt: "Answer as {x}." });
    fireEvent.click(screen.getByTestId("convo-prompt-enable-slots"));
    expect(screen.queryByTestId("convo-prompt-enable-slots")).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].prompt).toBe("Answer as {{x}}.");
  });
});

describe("a thread already opted in", () => {
  const templated = { promptIsTemplate: true, systemPrompt: "{context}\n\nYou are HAL." };

  it("says where the context will go", () => {
    setup(templated);
    expect(screen.getByText(/go where you put/)).toBeInTheDocument();
  });

  it("says the context is appended when the template does not place it", () => {
    setup({ promptIsTemplate: true, systemPrompt: "You are HAL." });
    expect(screen.getByText(/appended beneath/)).toBeInTheDocument();
  });

  it("accepts an observation reading, now that a thread can place one", () => {
    // `{vision_faces}` used to be refused here on purpose: with two renders it
    // would have been a second, unbudgeted route to the reading. One pass
    // removed that, so the thread can arrange its own observations — which is
    // the thing no editor change could have given it, because the context
    // template is one global setting and this prompt is per thread.
    setup(templated);
    fireEvent.change(box(), { target: { value: "{vision_faces}" } });
    expect(screen.queryByTestId("convo-prompt-errors")).toBeNull();
    expect(screen.getByRole("button", { name: "apply" })).toBeEnabled();
  });

  it("still refuses a name that is not a reading at all", () => {
    setup(templated);
    fireEvent.change(box(), { target: { value: "{not_a_reading}" } });
    const errors = screen.getByTestId("convo-prompt-errors");
    expect(errors).toHaveTextContent("not a slot here");
    expect(screen.getByRole("button", { name: "apply" })).toBeDisabled();
  });

  it("escapes the global default on reset, so its braces do not become slots", () => {
    const { send } = setup(templated, 'Be terse. {"x":1}');
    fireEvent.click(screen.getByRole("button", { name: "reset to default" }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'Be terse. {{"x":1}}' }));
  });

  it("shows a preview of what the thread will send", () => {
    setup(templated);
    expect(screen.getByTestId("convo-prompt-preview")).toHaveTextContent("Who I can see");
  });
});

describe("the draft follows the stored prompt", () => {
  it("re-seeds when another tab changes it", () => {
    const { rerender, conversation } = setup();
    fireEvent.change(box(), { target: { value: "local edit" } });
    rerender(
      <ConversationPrompt
        conversation={{ ...conversation, systemPrompt: "from elsewhere" }}
        chatDefault=""
        send={vi.fn()}
        disabled={false}
      />,
    );
    expect(box().value).toBe("from elsewhere");
  });
});
