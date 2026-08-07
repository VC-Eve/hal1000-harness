import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { ClientMessage } from "../../shared/src/types";
import { WsClient } from "./ws-client";
import { initialState, reducer, type AppState } from "./store";
import { HalEye, type EyeState } from "./components/HalEye";
import { LayoutShell } from "./components/LayoutShell";
import { SettingsPanel } from "./components/SettingsPanel";
import { personaCopy } from "./persona";
import "./styles.css";

function eyeState(state: AppState): EyeState {
  if (state.connection !== "open") return "disconnected";
  if (state.chatError || state.narrationStatus === "provider-unavailable" || state.readiness?.ollama === "unreachable") return "error";
  if (state.streaming !== null) return "streaming";
  if (state.narrationStatus === "narrating" || state.narrationStatus === "catching-up") return "narrating";
  return "idle";
}

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const clientRef = useRef<WsClient | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  activeIdRef.current = state.active?.id ?? null;

  useEffect(() => {
    const client = new WsClient(
      (msg) => dispatch({ type: "server", msg }),
      (value) => {
        dispatch({ type: "conn", value });
        if (value === "open") {
          client.send({ type: "list-models" });
          client.send({ type: "list-sessions" });
          client.send({ type: "list-adapters" });
          // Chat state (conversations, settings) is pushed by the server's
          // on-connect greeter; re-open the active conversation to recover
          // anything missed while disconnected.
          if (activeIdRef.current) client.send({ type: "open-conversation", conversationId: activeIdRef.current });
        }
      },
    );
    clientRef.current = client;
    client.connect();
    return () => client.close();
  }, []);

  // Stable across renders. A fresh function each render is a trap for any child
  // that lists `send` in an effect's deps: the effect re-runs, its request
  // triggers a broadcast, the broadcast re-renders, and the effect runs again.
  // The ref it closes over is what actually changes, so there is nothing to
  // re-create.
  const send = useCallback((msg: ClientMessage) => clientRef.current?.send(msg), []);
  const intensity = state.settings?.personaIntensity ?? "medium";

  const eye = eyeState(state);

  return (
    <div className="app">
      <header className="topbar">
        <HalEye state={eye} />
        <div className="titles">
          <h1>HAL 1000</h1>
          <span className="subtitle">heuristically programmed algorithmic harness</span>
        </div>
        <div className="topbar-right">
          {state.connection !== "open" && <span className="reconnect-banner">{personaCopy("reconnecting", intensity)}</span>}
          <button className="ghost" onClick={() => setSettingsOpen(true)} aria-label="Settings">
            ⚙ settings
          </button>
        </div>
      </header>
      <LayoutShell state={state} send={send} dispatch={dispatch} intensity={intensity} onOpenSettings={() => setSettingsOpen(true)} />
      {/* Gated on loaded settings: the drawer seeds its prompt drafts from them
          once at mount, so opening before they arrive would show the shipped
          default and let apply overwrite a stored prompt. */}
      {settingsOpen && state.settings && <SettingsPanel state={state} send={send} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
