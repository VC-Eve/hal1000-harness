import { useEffect, useRef, useState } from "react";
import type { ClientMessage, PersonaIntensity } from "../../../shared/src/types";
import type { Action, AppState } from "../store";
import {
  canCollapse,
  clampSplit,
  deriveTracks,
  leftIsRails,
  loadLayout,
  railIsVertical,
  saveLayout,
  showHorizontalDivider,
  showVerticalDivider,
  toggleCollapse,
  type SectionId,
} from "../layout";
import { ChatPane } from "./ChatPane";
import { NarrationPane } from "./NarrationPane";
import { WebcamPane } from "./WebcamPane";
import { SectionRail } from "./SectionRail";

interface Props {
  state: AppState;
  send: (msg: ClientMessage) => void;
  dispatch: (action: Action) => void;
  intensity: PersonaIntensity;
  onOpenSettings: () => void;
}

/**
 * The body: three sections, two dividers, and the rails that stand in for
 * whichever sections are collapsed.
 *
 * Split out of `App` so it can be mounted without a WebSocket. The layout rules
 * worth asserting — which rails appear, which dividers exist, when the collapse
 * control locks — are about what the tree renders, and pinning them behind
 * `App`'s connection lifecycle would have meant testing them through a socket
 * that has nothing to do with them.
 *
 * Layout state lives here rather than in `App` for the same reason: nothing
 * above this component needs to know which sections are collapsed.
 */
export function LayoutShell({ state, send, dispatch, intensity, onOpenSettings }: Props) {
  // Seeded from storage once, lazily, so the first paint is already the layout
  // the user left rather than the default flashing past it.
  const [layout, setLayout] = useState(loadLayout);
  const layoutRef = useRef<HTMLDivElement>(null);
  const leftRef = useRef<HTMLDivElement>(null);

  useEffect(() => saveLayout(layout), [layout]);

  const collapse = (id: SectionId) => setLayout((l) => toggleCollapse(l, id));

  // Both dividers are the same gesture along different axes, so they share one
  // handler: measure the container once on press, then map pointer position to
  // a percentage of it.
  const onDividerDown = (axis: "x" | "y", key: "split" | "leftSplit") => (down: React.PointerEvent) => {
    down.preventDefault();
    const container = (axis === "x" ? layoutRef : leftRef).current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const move = (e: PointerEvent) => {
      const pct = axis === "x" ? ((e.clientX - rect.left) / rect.width) * 100 : ((e.clientY - rect.top) / rect.height) * 100;
      setLayout((l) => ({ ...l, [key]: clampSplit(pct) }));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const { collapsed } = layout;
  const leftCollapsed = leftIsRails(layout);
  // Resizing only means something with an expanded section on either side of
  // the seam. Anywhere else the divider is not narrowed or hidden but absent,
  // so there is no invisible drag target where the bar used to be — and the
  // feed genuinely reaches the edge.
  const showVertical = showVerticalDivider(layout);
  const showHorizontal = showHorizontalDivider(layout);

  // Both track lists and the stacked variant come from one derivation, so the
  // narrow viewport cannot disagree with the wide one about which sections are
  // collapsed. The stylesheet reads them as custom properties.
  const tracks = deriveTracks(layout);
  const rail = (id: SectionId) => (railIsVertical(layout, id) ? "vertical" : "horizontal");

  return (
    <div
      className="layout"
      ref={layoutRef}
      style={{ ["--cols" as string]: tracks.columns, ["--stack-rows" as string]: tracks.stackRows }}
    >
      <div className="left-column" ref={leftRef} style={{ ["--rows" as string]: tracks.rows }}>
        {collapsed.conversation ? (
          <SectionRail id="conversation" orientation={rail("conversation")} onExpand={() => collapse("conversation")} />
        ) : (
          <ChatPane
            state={state}
            send={send}
            dispatch={dispatch}
            intensity={intensity}
            collapseDisabled={!canCollapse(layout, "conversation")}
            onCollapse={() => collapse("conversation")}
          />
        )}
        {showHorizontal && (
          <div
            className="divider horizontal"
            data-testid="divider-horizontal"
            onPointerDown={onDividerDown("y", "leftSplit")}
            role="separator"
            aria-orientation="horizontal"
          />
        )}
        {collapsed.webcam ? (
          <SectionRail id="webcam" orientation={rail("webcam")} onExpand={() => collapse("webcam")} />
        ) : (
          <WebcamPane collapseDisabled={!canCollapse(layout, "webcam")} onCollapse={() => collapse("webcam")} />
        )}
      </div>
      {showVertical && (
        <div
          className="divider"
          data-testid="divider-vertical"
          onPointerDown={onDividerDown("x", "split")}
          role="separator"
          aria-orientation="vertical"
        />
      )}
      {collapsed.observation ? (
        <SectionRail id="observation" orientation={rail("observation")} onExpand={() => collapse("observation")} />
      ) : (
        <NarrationPane
          state={state}
          send={send}
          dispatch={dispatch}
          intensity={intensity}
          onOpenSettings={onOpenSettings}
          collapseDisabled={!canCollapse(layout, "observation")}
          onCollapse={() => collapse("observation")}
        />
      )}
    </div>
  );
}
