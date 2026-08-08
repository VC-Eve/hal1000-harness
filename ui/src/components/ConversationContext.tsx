import { useState } from "react";
import type { ClientMessage, Conversation, ContextLevel, Settings } from "../../../shared/src/types";
import { CONTEXT_LEVELS } from "../../../shared/src/types";
import { contextBudgetChars, usableWindowTokens } from "../../../shared/src/prompts";

interface Props {
  conversation: Conversation;
  settings: Settings | null;
  // The window of this conversation's model, when the provider could say.
  modelTokens: number | undefined;
  // Null when nothing is being watched — the session source has nothing to
  // draw on, and saying so here is the whole point of surfacing it.
  watchedSessionId: string | null;
  send: (msg: ClientMessage) => void;
  disabled: boolean;
}

// A level is a share of the model's window, so the label has to be computed
// rather than written down. Printing the characters is what R5 asked for; the
// number moving when the model changes is what makes it true.
function levelLabel(level: ContextLevel, windowTokens: number): string {
  if (level === "off") return "off";
  return `${contextBudgetChars(level, windowTokens).toLocaleString()} chars`;
}

// Rendered with key={conversation.id} so switching threads remounts it and one
// conversation's setting can never appear under another.
export function ConversationContext({
  conversation,
  settings,
  modelTokens,
  watchedSessionId,
  send,
  disabled,
}: Props) {
  const [open, setOpen] = useState(false);
  const context = conversation.context ?? { vision: "off" as const, session: "off" as const };
  const windowTokens = usableWindowTokens(modelTokens, settings?.chatContextCap ?? 8192);

  const visionChars = contextBudgetChars(context.vision, windowTokens);
  // The session source draws on the watched session alone, so with nothing
  // watched its real budget is zero however the level is set. Showing the level
  // as though it would send is the failure this guards: two controls, one
  // invisible dependency, discovered from HAL's reply.
  const sessionBlocked = context.session !== "off" && !watchedSessionId;
  const sessionChars = sessionBlocked ? 0 : contextBudgetChars(context.session, windowTokens);

  // Gated on the endpoint in effect, matching the server, so the notice appears
  // for the same requests the gate withholds.
  const remote = settings ? !isLoopback(settings.providerEndpoint) : false;
  const blocked = remote && !(settings?.offMachineAcknowledged ?? false);
  const total = blocked ? 0 : visionChars + sessionChars;

  const summary =
    context.vision === "off" && context.session === "off"
      ? "none"
      : blocked
        ? "withheld"
        : `~${total.toLocaleString()} chars`;

  const setLevel = (key: "vision" | "session", level: ContextLevel) => {
    if (blocked && level !== "off") {
      send({ type: "acknowledge-off-machine", accepted: true });
    }
    send({ type: "set-conversation-context", conversationId: conversation.id, context: { [key]: level } });
  };

  return (
    <div className="convo-context">
      <button className="convo-prompt-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="convo-prompt-caret">{open ? "▾" : "▸"}</span>
        what I can see: {summary}
      </button>
      {open && (
        <div className="convo-prompt-body">
          <Row
            label="vision"
            level={context.vision}
            windowTokens={windowTokens}
            disabled={disabled}
            onPick={(l) => setLevel("vision", l)}
          />
          <Row
            label="session"
            level={context.session}
            windowTokens={windowTokens}
            disabled={disabled}
            onPick={(l) => setLevel("session", l)}
          />
          <small className="context-readout">
            {blocked ? (
              <>
                nothing will be sent. {settings?.providerEndpoint} is not on this machine, and enrolled names,
                character profiles, a record of who was in the room and my commentary on your sessions would
                leave it. turning a source on accepts that.
              </>
            ) : (
              <>
                sending ~{total.toLocaleString()} of {(windowTokens * 4).toLocaleString()} chars
                {sessionBlocked && <> — session is on but no session is being watched, so it sends nothing</>}
              </>
            )}
          </small>
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  level,
  windowTokens,
  disabled,
  onPick,
}: {
  label: string;
  level: ContextLevel;
  windowTokens: number;
  disabled: boolean;
  onPick: (level: ContextLevel) => void;
}) {
  return (
    <label className="context-row">
      <span className="context-row-label">{label}:</span>
      <select value={level} disabled={disabled} onChange={(e) => onPick(e.target.value as ContextLevel)}>
        {CONTEXT_LEVELS.map((l) => (
          <option key={l} value={l}>
            {l === "off" ? "off" : `${l} — ${levelLabel(l, windowTokens)}`}
          </option>
        ))}
      </select>
    </label>
  );
}

// Mirrors the server's classification: anything that does not positively parse
// as loopback is treated as remote, so an endpoint nobody can read is not
// quietly assumed local.
function isLoopback(endpoint: string): boolean {
  try {
    const { hostname } = new URL(endpoint);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
  } catch {
    return false;
  }
}
