import { useMemo, useState } from "react";
import type { ClientMessage, Conversation } from "../../../shared/src/types";
import { SLOT_VOCABULARY, validateTemplate } from "../../../shared/src/templates";
import { renderPreview } from "../templatePreview";

interface Props {
  conversation: Conversation;
  // The current resolved global chat default. A conversation's prompt is a
  // copy taken at creation, so "reset" means re-copying this rather than
  // clearing a value the server would re-resolve.
  chatDefault: string;
  send: (msg: ClientMessage) => void;
  disabled: boolean;
}

const SLOTS = SLOT_VOCABULARY["conversation-system"];

/**
 * Escape braces that were written before braces meant anything.
 *
 * A prompt saved when this field was literal text may contain `{` — a JSON
 * example, a placeholder from somewhere else. Opting that thread into templates
 * without escaping would read it as a slot and silently drop it. Done in the
 * draft rather than on the server so the user watches it happen and can undo it.
 */
function escapeLiteralBraces(text: string): string {
  return text.replace(/\{/g, "{{").replace(/\}/g, "}}");
}

// Rendered with key={conversation.id} so switching threads remounts it and the
// draft cannot leak from one conversation into another.
export function ConversationPrompt({ conversation, chatDefault, send, disabled }: Props) {
  const stored = conversation.systemPrompt ?? "";
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(stored);

  // Opting in is recorded locally the moment the button is pressed, as well as
  // on the server. Waiting for the round trip left the button live, and a second
  // press escaped the already-escaped text — turning every brace into four with
  // no way back.
  const [optedIn, setOptedIn] = useState(false);
  const isTemplate = conversation.promptIsTemplate === true || optedIn;

  // Re-seed when the stored prompt changes underneath, the way the template and
  // phrase editors do. Without it a second tab keeps a stale unescaped draft
  // after the first opts in, and applying it would undo the escaping.
  const [seen, setSeen] = useState(stored);
  if (seen !== stored) {
    setSeen(stored);
    setDraft(stored);
  }

  const summary = stored.trim().length === 0 ? "none" : isTemplate ? "template" : "set";

  // Only meaningful once the thread is a template. A literal prompt is not
  // parsed, so reporting slot errors against it would be describing a rule that
  // is not being applied.
  const errors = useMemo(
    () => (isTemplate ? validateTemplate(draft, "conversation-system") : []),
    [draft, isTemplate],
  );
  const preview = useMemo(
    () => (isTemplate ? renderPreview("conversation-system", draft) : null),
    [draft, isTemplate],
  );

  const placesContext = draft.includes("{context}");
  const hasBraces = /[{}]/.test(draft);

  const apply = (text: string, asTemplate: boolean): void => {
    setDraft(text);
    send({
      type: "set-conversation-prompt",
      conversationId: conversation.id,
      prompt: text,
      ...(asTemplate ? { isTemplate: true } : {}),
    });
  };

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

          {errors.length > 0 ? (
            <ul className="template-errors" data-testid="convo-prompt-errors">
              {errors.map((err, i) => (
                <li key={i}>
                  {err.message}
                  {err.valid ? <span className="template-valid"> valid here: {err.valid.join(", ")}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}

          <div className="prompt-actions">
            <button
              className="ghost"
              disabled={disabled || draft === stored || errors.length > 0}
              onClick={() => apply(draft, isTemplate)}
            >
              apply
            </button>
            <button
              className="ghost"
              disabled={disabled || stored === chatDefault}
              // The global default is plain text. Pushed into a template thread
              // unescaped, its braces would become slots.
              onClick={() => apply(isTemplate && /[{}]/.test(chatDefault) ? escapeLiteralBraces(chatDefault) : chatDefault, isTemplate)}
            >
              reset to default
            </button>
            {!isTemplate ? (
              <button
                className="ghost"
                data-testid="convo-prompt-enable-slots"
                disabled={disabled}
                // Escaping first is the whole point: whatever braces this prompt
                // already contains keep meaning braces.
                onClick={() => {
                  setOptedIn(true);
                  apply(hasBraces ? escapeLiteralBraces(draft) : draft, true);
                }}
              >
                use slots here
              </button>
            ) : null}
          </div>

          {isTemplate ? (
            <>
              <div className="convo-prompt-slots" data-testid="convo-prompt-slots">
                {SLOTS.map((slot) => (
                  <button
                    key={slot.name}
                    className="phrase-chip linkish"
                    title={slot.meaning}
                    onClick={() => setDraft(`${draft}{${slot.name}}`)}
                  >
                    {`{${slot.name}}`}
                  </button>
                ))}
              </div>
              <small>
                {placesContext
                  ? "what I can see and what I have been saying go where you put {context}."
                  : "no {context} here, so what I can see and what I have been saying are appended beneath, as before."}
              </small>
              {preview ? (
                <div className="template-preview" data-testid="convo-prompt-preview">
                  <span className="preview-label">renders as</span>
                  <pre>{preview.text.length > 0 ? preview.text : "(nothing)"}</pre>
                </div>
              ) : null}
            </>
          ) : (
            <small data-testid="convo-prompt-literal">
              plain text — braces mean braces. “use slots here” turns this thread into a template so{" "}
              {"{context}"} can place what I can see.
            </small>
          )}

          <small>applies to the next message; replies already sent are unchanged</small>
        </div>
      )}
    </div>
  );
}
