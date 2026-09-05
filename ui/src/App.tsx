import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { ClientMessage } from "../../shared/src/types";
import { WsClient } from "./ws-client";
import { initialState, reducer, type AppState } from "./store";
import { HalEye, type EyeState } from "./components/HalEye";
import { LayoutShell } from "./components/LayoutShell";
import { LivePane } from "./components/LivePane";
import { BroadcastStage } from "./components/BroadcastStage";
import { SettingsPanel } from "./components/SettingsPanel";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { personaCopy } from "./persona";
import { currentRoute, navigate, onRouteChange, titleFor, type Route } from "./route";
import "./styles.css";

function eyeState(state: AppState): EyeState {
  if (state.connection !== "open") return "disconnected";
  // Either backend being unreachable is a fault worth showing in the eye. The
  // chat leg reads "disabled" when chat uses the shared backend, which is a
  // choice rather than a fault and must not light it up.
  const backendDown =
    state.readiness?.observationBackend === "unreachable" || state.readiness?.chatBackend === "unreachable";
  if (state.chatError || state.narrationStatus === "provider-unavailable" || backendDown) return "error";
  if (state.streaming !== null) return "streaming";
  if (state.narrationStatus === "narrating" || state.narrationStatus === "catching-up") return "narrating";
  return "idle";
}

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const clientRef = useRef<WsClient | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Read once at mount so a deep load of /live renders the live surface rather
  // than the chat shell flashing past it first.
  const [route, setRoute] = useState<Route>(currentRoute);

  useEffect(() => onRouteChange(setRoute), []);

  // The identifying title is set by the operator routes; index.html ships the
  // neutral one. See the note on `titleFor`.
  useEffect(() => {
    document.title = titleFor(route);
  }, [route]);

  // Held in a ref so the socket callback below, which is created once, reads
  // the route the browser is on now rather than the one it was on at mount.
  const routeRef = useRef<Route>(route);
  routeRef.current = route;

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
          // Sent on every open rather than once at mount, because this client
          // reconnects: a declaration that lapsed on the first blip would hand
          // the audio grant to the broadcast window at the moment nobody is
          // watching for it. The server accepts it idempotently for exactly
          // this reason.
          if (routeRef.current === "broadcast") client.send({ type: "observe" });
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

  /**
   * The output surface returns before anything else in this component.
   *
   * Above the topbar, above the settings drawer, and — the part that matters —
   * above `<ErrorBoundary label="The main view">`. That boundary renders the
   * throw's own message and the words "This is a fault in HAL", which on a
   * projector is the leak this surface exists to prevent. Inside the switch it
   * would catch a broadcast throw and paint exactly that. Outside it, a throw
   * unmounts the tree to the black the root element is already carrying, which
   * is the required outcome reached by having no code that could do otherwise.
   *
   * The broadcast tree gets no boundary of its own for the same reason: one
   * rendering `null` still holds a fallback a later edit could give something
   * to say.
   */
  if (route === "broadcast") return <BroadcastStage state={state} send={send} />;

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
          <button className="ghost" onClick={() => navigate(route === "live" ? "home" : "live")}>
            {route === "live" ? "chat" : "live"}
          </button>
          <button className="ghost" onClick={() => setSettingsOpen(true)} aria-label="Settings">
            ⚙ settings
          </button>
        </div>
      </header>
      {/* Two boundaries rather than one around the app, because the useful
          property is that a crash in either surface leaves the other usable.
          Settings is where someone goes to fix a fault, so a settings throw
          must not take the feed and the conversation with it — and a throw in
          the panes must not lock someone out of the settings that would let
          them recover. */}
      {/* The switch sits inside the boundary, not around it: a crash in the
          live surface must leave the base HAL page usable, and vice versa. */}
      <ErrorBoundary label="The main view">
        {route === "live" ? (
          <LivePane state={state} send={send} />
        ) : (
          <LayoutShell state={state} send={send} dispatch={dispatch} intensity={intensity} onOpenSettings={() => setSettingsOpen(true)} />
        )}
      </ErrorBoundary>
      {/* Gated on loaded settings: the drawer seeds its prompt drafts from them
          once at mount, so opening before they arrive would show the shipped
          default and let apply overwrite a stored prompt. */}
      {settingsOpen && state.settings && (
        <ErrorBoundary label="Settings" onDismiss={() => setSettingsOpen(false)}>
          <SettingsPanel state={state} send={send} onClose={() => setSettingsOpen(false)} />
        </ErrorBoundary>
      )}
    </div>
  );
}
