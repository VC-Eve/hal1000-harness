import { useState } from "react";
import type { ClientMessage, Conversation } from "../../../shared/src/types";

interface Props {
  conversation: Conversation;
  // The current resolved global chat default. A conversation's prompt is a
  // copy taken at creation, so "reset" means re-copying this rather than
  // clearing a value the server would re-resolve.
  chatDefault: string;
  send: (msg: ClientMessage) => void;
  disabled: boolean;
}

// Rendered with key={conversation.id} so switching threads remounts it and the
// draft cannot leak from one conversation into another.
export function ConversationPrompt({ conversation, chatDefault, send, disabled }: Props) {
  const stored = conversation.systemPrompt ?? "";
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(stored);

  const summary = stored.trim().length === 0 ? "none" : "set";

  return (
    <div className="convo-prompt">
      <button className="convo-prompt-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="convo-prompt-caret">{open ? "▾" : "▸"}</span>
        system prompt: {summary}
      </button>
      {open && (
        <div className="convo-prompt-body">
          <textarea
            className="prompt-input"
            rows={5}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            aria-label="Conversation system prompt"
          />
          <div className="prompt-actions">
            <button
              className="ghost"
              disabled={disabled || draft === stored}
              onClick={() => send({ type: "set-conversation-prompt", conversationId: conversation.id, prompt: draft })}
            >
              apply
            </button>
            <button
              className="ghost"
              disabled={disabled || stored === chatDefault}
              onClick={() => {
                setDraft(chatDefault);
                send({ type: "set-conversation-prompt", conversationId: conversation.id, prompt: chatDefault });
              }}
            >
              reset to default
            </button>
          </div>
          <small>applies to the next message; replies already sent are unchanged</small>
        </div>
      )}
    </div>
  );
}
