import { useEffect, useRef, useState } from "react";
import type { ClientMessage, PersonaIntensity } from "../../../shared/src/types";
import type { Action, AppState } from "../store";
import { personaCopy } from "../persona";
import { chatColor } from "../colors";
import { ModelOptions } from "./ModelOptions";

interface Props {
  state: AppState;
  send: (msg: ClientMessage) => void;
  dispatch: (action: Action) => void;
  intensity: PersonaIntensity;
}

export function ChatPane({ state, send, dispatch, intensity }: Props) {
  const { active, conversations, models, modelsError, streaming, chatError, drafts, connection } = state;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [reselect, setReselect] = useState<string>("");
  // Follow new content only while pinned to the bottom; when the user has
  // scrolled up to read history, hold their position.
  const [pinned, setPinned] = useState(true);

  useEffect(() => {
    setPinned(true);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [active?.id]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinned) el.scrollTop = el.scrollHeight;
  }, [active?.messages.length, streaming, pinned]);

  const onMessagesScroll = () => {
    const el = scrollRef.current;
    if (el) setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  };

  const defaultModel = state.settings?.chatModel ?? models[0] ?? null;
  const draft = active ? (drafts[active.id] ?? "") : "";

  const newConversation = () => {
    if (!defaultModel) return;
    // First conversation on a fresh install also pins the default chat model,
    // so narration's follow-chat-model default has something to follow.
    if (!state.settings?.chatModel) send({ type: "update-settings", patch: { chatModel: defaultModel } });
    send({ type: "new-conversation", model: defaultModel });
  };

  const sendDraft = () => {
    if (!active || !draft.trim() || streaming !== null || connection !== "open") return;
    send({ type: "send-message", conversationId: active.id, content: draft });
    dispatch({ type: "draft", conversationId: active.id, value: "" });
    // Sending your own message always snaps the view back to the bottom.
    setPinned(true);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  const switchModel = (model: string) => {
    if (!active) return;
    send({ type: "select-model", conversationId: active.id, model });
    send({ type: "update-settings", patch: { chatModel: model } });
  };

  return (
    <section className="pane chat-pane" data-testid="chat-pane">
      <aside className="sidebar">
        <button className="primary new-convo" onClick={newConversation} disabled={!defaultModel || connection !== "open"}>
          + new conversation
        </button>
        {models.length === 0 && (
          <div className="empty-state">
            <p>{personaCopy(modelsError ? "ollama-down" : "no-models", intensity)}</p>
            {!modelsError && <code>ollama pull llama3.2</code>}
            <button
              className="ghost"
              onClick={() => {
                send({ type: "check-readiness" });
                send({ type: "list-models" });
              }}
            >
              re-check
            </button>
          </div>
        )}
        {conversations.length === 0 && models.length > 0 && <p className="empty-state">{personaCopy("empty-conversations", intensity)}</p>}
        <ul className="convo-list">
          {conversations.map((c) => (
            <li key={c.id} className={active?.id === c.id ? "selected" : ""}>
              <button className="convo-open" onClick={() => send({ type: "open-conversation", conversationId: c.id })}>
                <span className="convo-title">{c.title}</span>
                <span className="convo-model">{c.model}</span>
              </button>
              <button
                className="convo-delete"
                aria-label={`Delete ${c.title}`}
                onClick={() => {
                  send({ type: "delete-conversation", conversationId: c.id });
                  if (active?.id === c.id) dispatch({ type: "close-conversation" });
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <div className="chat-main">
        {!active ? (
          <div className="chat-placeholder">
            <p>Select a conversation, or begin a new one. I am completely operational.</p>
          </div>
        ) : (
          <>
            <div className="chat-header">
              <span className="chat-title">{active.title}</span>
              <label className="model-picker">
                model:
                <select value={active.model} onChange={(e) => switchModel(e.target.value)}>
                  {!models.includes(active.model) && <option value={active.model}>{active.model} (missing)</option>}
                  <ModelOptions models={models} />
                </select>
              </label>
            </div>
            <div className="messages" ref={scrollRef} onScroll={onMessagesScroll}>
              {active.messages.map((m, i) => (
                <div
                  key={i}
                  className={`message ${m.role}${m.interrupted ? " interrupted" : ""}`}
                  style={{ ["--message-color" as string]: chatColor(m.role, state.settings) }}
                >
                  <div className="message-body">{m.content}</div>
                  {m.interrupted && (
                    <div className="interrupted-row">
                      <span>{personaCopy("interrupted", intensity)}</span>
                      <button
                        className="ghost"
                        disabled={streaming !== null || connection !== "open"}
                        onClick={() => send({ type: "regenerate", conversationId: active.id })}
                      >
                        regenerate
                      </button>
                    </div>
                  )}
                </div>
              ))}
              {streaming !== null && (
                // The reply takes the assistant colour while it streams, not
                // only once chat-done swaps it into the message list.
                <div className="message assistant streaming" style={{ ["--message-color" as string]: chatColor("assistant", state.settings) }}>
                  <div className="message-body">
                    {streaming}
                    <span className="cursor">▌</span>
                  </div>
                </div>
              )}
            </div>
            {chatError && (
              <div className="banner error" data-testid="chat-error">
                <span>{personaCopy(chatError.code, intensity)}</span>
                {chatError.code === "model_not_found" && models.length > 0 && (
                  <span className="reselect">
                    <select value={reselect} onChange={(e) => setReselect(e.target.value)}>
                      <option value="">choose a model…</option>
                      <ModelOptions models={models} />
                    </select>
                    <button
                      className="ghost"
                      disabled={!reselect}
                      onClick={() => {
                        switchModel(reselect);
                        dispatch({ type: "clear-chat-error" });
                      }}
                    >
                      switch
                    </button>
                  </span>
                )}
                <button className="ghost dismiss" onClick={() => dispatch({ type: "clear-chat-error" })} aria-label="Dismiss">
                  ×
                </button>
              </div>
            )}
            <div className="composer">
              <textarea
                value={draft}
                placeholder={connection === "open" ? "Speak, and I will listen…" : "connection lost…"}
                disabled={connection !== "open"}
                onChange={(e) => dispatch({ type: "draft", conversationId: active.id, value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    sendDraft();
                  }
                }}
              />
              <button className="primary" onClick={sendDraft} disabled={!draft.trim() || streaming !== null || connection !== "open"}>
                send
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
