import { useEffect, useReducer, useRef, useState } from "react";
import type { ClientMessage } from "../../shared/src/types";
import { WsClient } from "./ws-client";
import { initialState, reducer, type AppState } from "./store";
import { HalEye, type EyeState } from "./components/HalEye";
import { ChatPane } from "./components/ChatPane";
import { NarrationPane } from "./components/NarrationPane";
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
  const [split, setSplit] = useState(60);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const layoutRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const client = new WsClient(
      (msg) => dispatch({ type: "server", msg }),
      (value) => {
        dispatch({ type: "conn", value });
        if (value === "open") {
          client.send({ type: "list-conversations" });
          client.send({ type: "list-models" });
          client.send({ type: "get-settings" });
          client.send({ type: "list-sessions" });
        }
      },
    );
    clientRef.current = client;
    client.connect();
    return () => client.close();
  }, []);

  const send = (msg: ClientMessage) => clientRef.current?.send(msg);
  const intensity = state.settings?.personaIntensity ?? "medium";

  const eye = eyeState(state);

  const onDividerDown = (down: React.PointerEvent) => {
    down.preventDefault();
    const layout = layoutRef.current;
    if (!layout) return;
    const rect = layout.getBoundingClientRect();
    const move = (e: PointerEvent) => {
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      setSplit(Math.min(80, Math.max(30, pct)));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

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
      <div className="layout" ref={layoutRef} style={{ ["--split" as string]: `${split}%` }}>
        <ChatPane state={state} send={send} dispatch={dispatch} intensity={intensity} />
        <div className="divider" onPointerDown={onDividerDown} role="separator" aria-orientation="vertical" />
        <NarrationPane state={state} send={send} dispatch={dispatch} intensity={intensity} onOpenSettings={() => setSettingsOpen(true)} />
      </div>
      {settingsOpen && <SettingsPanel state={state} send={send} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
