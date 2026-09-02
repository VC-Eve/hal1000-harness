import { useMemo, useState } from "react";
import type { ClientMessage, Edge, EdgeKind, FrameEdge } from "../../../shared/src/types";
import { EDGE_KINDS, FRAME_EDGES } from "../../../shared/src/worlds";
import type { AppState } from "../store";
import { graphLayout, nodeKey, NODE_H, NODE_W, type GraphNode } from "../graph";

interface Props {
  state: AppState;
  send: (msg: ClientMessage) => void;
}

/**
 * The state machine, as a graph.
 *
 * A node is a State, an arrow is a transition, and selecting an arrow opens its
 * conditions — the shape an Animator has, because that is what this is. The
 * floorplan next door owns geometry only: where the cameras are, and which
 * Positions their cones reach. Nodes come from that derivation, and everything
 * about behaviour is authored here.
 *
 * All layout comes from `../graph`; this positions and renders.
 */
export function StateGraph({ state, send }: Props) {
  const world = state.world;
  const reports = state.worldReports;
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  // Set when the author has asked to draw a transition out of a node; the next
  // node clicked is the destination. Unity's "Make Transition", which is the
  // gesture anyone who has used one will reach for.
  const [connecting, setConnecting] = useState<string | null>(null);
  const [kind, setKind] = useState<EdgeKind>("travel");

  const graph = useMemo(() => graphLayout(world, reports), [world, reports]);

  if (!world) return null;
  const worldId = world.id;

  const live = state.worldLive;
  const currentKey = (() => {
    const s = world.states.find((x) => x.id === live?.stateId);
    return s ? nodeKey(s.sceneId, s.positionId, s.pose) : null;
  })();

  const node = graph.nodes.find((n) => n.key === selectedNode) ?? null;
  const edge = world.edges.find((e) => e.id === selectedEdge) ?? null;

  const clickNode = (target: GraphNode) => {
    if (connecting && connecting !== target.key) {
      const from = graph.nodes.find((n) => n.key === connecting);
      // Both ends have to be real States. A pairing with no clip has no id to
      // reference, which is what the node panel's "create state" is for.
      if (from?.stateId && target.stateId) {
        send({ type: "add-edge", worldId, edge: { kind, from: from.stateId, to: target.stateId } });
      }
      setConnecting(null);
      return;
    }
    setConnecting(null);
    setSelectedEdge(null);
    setSelectedNode(target.key);
  };

  return (
    <div className="state-graph" data-testid="state-graph">
      <div className="graph-canvas">
        <svg width={graph.width} height={graph.height} data-testid="graph-svg">
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" className="arrowhead" />
            </marker>
          </defs>

          {graph.edges.map((line) => (
            <g key={line.id} data-testid={`transition-${line.id}`} onClick={() => { setSelectedNode(null); setSelectedEdge(line.id); }}>
              {/* A wide invisible stroke under the visible one: a 2px curve is
                  a hard thing to hit with a mouse. */}
              <path className="transition-hit" d={line.d} />
              <path
                className={[
                  "transition",
                  line.kind,
                  line.reversed ? "reversed" : "",
                  line.id === selectedEdge ? "selected" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                d={line.d}
                markerEnd="url(#arrow)"
              />
            </g>
          ))}

          {graph.nodes.map((n) => (
            <g
              key={n.key}
              data-testid={`node-${n.key}`}
              className="graph-node"
              transform={`translate(${n.x} ${n.y})`}
              onClick={() => clickNode(n)}
            >
              <rect
                width={NODE_W}
                height={NODE_H}
                rx={6}
                className={[
                  "node-box",
                  n.key === currentKey ? "current" : "",
                  n.key === selectedNode ? "selected" : "",
                  n.stateId ? "" : "undeclared",
                  n.missingClip ? "no-clip" : "",
                  n.deadEnd ? "dead-end" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              />
              <text className="node-title" x={12} y={22}>
                {n.positionName}
                {n.pose ? ` (${n.pose})` : ""}
              </text>
              <text className="node-sub" x={12} y={40}>
                {n.sceneName} · {n.clipPath ? n.clipPath.replace(/^clips\//, "") : "no clip"}
              </text>
              {n.deadEnd && (
                <text className="node-flag" data-testid={`node-dead-end-${n.key}`} x={NODE_W - 12} y={22}>
                  !
                </text>
              )}
            </g>
          ))}
        </svg>
        {graph.nodes.length === 0 && (
          <p className="muted" data-testid="graph-empty">
            No States yet. Place a Position and a camera on the cameras tab — a Position inside a cone becomes a State here.
          </p>
        )}
        {connecting && (
          <p className="muted" data-testid="connecting">
            Click the destination State to finish the transition, or press the button again to cancel.
          </p>
        )}
      </div>

      <div className="graph-side">
        <ParametersPanel state={state} send={send} worldId={worldId} />

        {node && (
          <NodePanel
            node={node}
            send={send}
            worldId={worldId}
            struck={(world.struck ?? []).some((p) => p.sceneId === node.sceneId && p.positionId === node.positionId)}
            connecting={connecting === node.key}
            kind={kind}
            onKind={setKind}
            onConnect={() => setConnecting(connecting === node.key ? null : node.key)}
          />
        )}

        {edge && <TransitionPanel state={state} send={send} edge={edge} />}

        {!node && !edge && (
          <section className="graph-hint" data-testid="graph-hint">
            <h3>editing</h3>
            <p className="muted">Select a State or a transition to edit it.</p>
          </section>
        )}
      </div>
    </div>
  );
}

/** Parameters: what conditions read, and what drives the World while it runs. */
function ParametersPanel({ state, send, worldId }: Props & { worldId: string }) {
  const world = state.world!;
  const live = state.worldLive;
  const [name, setName] = useState("");
  const [values, setValues] = useState("");

  const declare = () => {
    const list = values
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
    if (name.trim().length === 0 || list.length === 0) return;
    send({ type: "declare-parameter", worldId, parameter: { name: name.trim(), values: list, defaultValue: list[0]! } });
    setName("");
    setValues("");
  };

  return (
    <section className="parameters-panel" data-testid="parameters-panel">
      <h3>parameters</h3>
      <p className="muted" data-testid="current-state">
        now: {live?.stateId ? describeState(world, live.stateId) : "nowhere yet"}
      </p>
      {world.parameters.map((parameter) => (
        <label key={parameter.name} data-testid={`parameter-${parameter.name}`}>
          {parameter.name}
          <select
            aria-label={parameter.name}
            value={live?.parameters[parameter.name] ?? parameter.defaultValue}
            onChange={(e) => send({ type: "set-parameter", worldId, name: parameter.name, value: e.target.value })}
          >
            {parameter.values.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      ))}
      <div className="parameter-form" data-testid="parameter-form">
        <input aria-label="parameter name" value={name} onChange={(e) => setName(e.target.value)} placeholder="location" />
        <input aria-label="parameter values" value={values} onChange={(e) => setValues(e.target.value)} placeholder="couch, booth" />
        <button onClick={declare} disabled={name.trim().length === 0 || values.trim().length === 0}>
          declare
        </button>
      </div>
      {live?.fault && <p className="warn">{live.fault}</p>}
    </section>
  );
}

/** One State: the clip that loops while it holds, and the transitions out of it. */
function NodePanel({
  node,
  send,
  worldId,
  struck,
  connecting,
  kind,
  onKind,
  onConnect,
}: {
  node: GraphNode;
  send: (msg: ClientMessage) => void;
  worldId: string;
  struck: boolean;
  connecting: boolean;
  kind: EdgeKind;
  onKind: (kind: EdgeKind) => void;
  onConnect: () => void;
}) {
  const [path, setPath] = useState("");

  // Assigned with a duration of zero on purpose: the clip route serves only
  // clips the manifest already references, so nothing can measure the file
  // before it is assigned. The player reports its real length at first play.
  const assign = (value: string | null) =>
    send({
      type: "assign-clip",
      worldId,
      target: { kind: "state", sceneId: node.sceneId, positionId: node.positionId, ...(node.pose ? { pose: node.pose } : {}) },
      clip: value ? { path: value, durationMs: 0 } : null,
    });

  return (
    <section className="node-panel" data-testid={`node-panel-${node.key}`}>
      <h3>
        {node.positionName}
        {node.pose ? ` (${node.pose})` : ""} · {node.sceneName}
      </h3>
      <p className="muted">{node.clipPath ?? "no clip"}</p>

      <div className="clip-assign">
        <input aria-label="state clip path" value={path} onChange={(e) => setPath(e.target.value)} placeholder="clips/couch-idle.mp4" />
        <button
          disabled={path.trim().length === 0}
          onClick={() => {
            assign(path.trim());
            setPath("");
          }}
        >
          assign clip
        </button>
      </div>

      <div className="condition">
        <button className="ghost" onClick={() => assign(null)}>
          {node.stateId ? "clear clip" : "create state"}
        </button>
        <button
          className="ghost"
          onClick={() => send({ type: "strike-pairing", worldId, sceneId: node.sceneId, positionId: node.positionId, struck: !struck })}
        >
          {struck ? "restore pairing" : "strike pairing"}
        </button>
      </div>

      <div className="condition">
        <select aria-label="transition kind" value={kind} onChange={(e) => onKind(e.target.value as EdgeKind)}>
          {EDGE_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <button disabled={!node.stateId} className={connecting ? "active" : "ghost"} onClick={onConnect}>
          {connecting ? "cancel" : "make transition"}
        </button>
      </div>
      {!node.stateId && <p className="muted">Assign a clip, or create the State, before drawing a transition from it.</p>}
    </section>
  );
}

/** One transition: when it fires, what it plays, and where it leaves frame. */
function TransitionPanel({ state, send, edge }: Props & { edge: Edge }) {
  const world = state.world!;
  const worldId = world.id;
  const [clipPath, setClipPath] = useState("");

  const assign = (slot: "clip" | "entry") => {
    const path = clipPath.trim();
    if (path.length === 0) return;
    send({ type: "assign-clip", worldId, target: { kind: "edge", edgeId: edge.id, slot }, clip: { path, durationMs: 0 } });
    setClipPath("");
  };

  const setConditions = (conditions: Edge["conditions"]) =>
    send({ type: "update-edge", worldId, edgeId: edge.id, patch: { conditions } });

  return (
    <section className="transition-panel" data-testid={`transition-panel-${edge.id}`}>
      <h3>
        {describeState(world, edge.from)} → {describeState(world, edge.to)}
      </h3>
      <p className="muted">{edge.kind}</p>

      <h4>conditions</h4>
      {edge.conditions.length === 0 && <p className="muted">None — this transition is offered whenever it is evaluated.</p>}
      {edge.conditions.map((condition, index) => (
        <div key={index} className="condition">
          <select
            aria-label={`condition ${index} parameter`}
            value={condition.parameter}
            onChange={(e) => setConditions(edge.conditions.map((c, i) => (i === index ? { ...c, parameter: e.target.value } : c)))}
          >
            {world.parameters.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
          <select
            aria-label={`condition ${index} operator`}
            value={condition.op}
            onChange={(e) => setConditions(edge.conditions.map((c, i) => (i === index ? { ...c, op: e.target.value as "eq" | "ne" } : c)))}
          >
            <option value="eq">is</option>
            <option value="ne">is not</option>
          </select>
          <select
            aria-label={`condition ${index} value`}
            value={condition.value}
            onChange={(e) => setConditions(edge.conditions.map((c, i) => (i === index ? { ...c, value: e.target.value } : c)))}
          >
            {(world.parameters.find((p) => p.name === condition.parameter)?.values ?? [condition.value]).map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <button className="ghost" onClick={() => setConditions(edge.conditions.filter((_, i) => i !== index))}>
            remove
          </button>
        </div>
      ))}
      {world.parameters.length > 0 && (
        <button
          className="ghost"
          onClick={() =>
            setConditions([...edge.conditions, { parameter: world.parameters[0]!.name, op: "eq", value: world.parameters[0]!.defaultValue }])
          }
        >
          add condition
        </button>
      )}

      <label>
        has exit time
        <input
          type="checkbox"
          aria-label="has exit time"
          checked={edge.onClipEnd !== false}
          onChange={(e) => send({ type: "update-edge", worldId, edgeId: edge.id, patch: { onClipEnd: e.target.checked } })}
        />
      </label>
      <p className="muted">
        {edge.onClipEnd !== false
          ? "Waits for the current clip to finish, then takes this transition if its conditions hold."
          : "Taken the moment its conditions hold, cutting the current clip short."}
      </p>

      {edge.kind === "cut" &&
        (["exitEdge", "entryEdge"] as const).map((field) => (
          <label key={field}>
            {field === "exitEdge" ? "leaves through" : "enters through"}
            <select
              aria-label={field}
              value={edge[field] ?? ""}
              onChange={(e) => send({ type: "update-edge", worldId, edgeId: edge.id, patch: { [field]: e.target.value as FrameEdge } })}
            >
              <option value="">—</option>
              {FRAME_EDGES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
        ))}

      <h4>clips</h4>
      <div className="clip-assign">
        <input aria-label="clip path" value={clipPath} onChange={(e) => setClipPath(e.target.value)} placeholder="clips/walk.mp4" />
        <button onClick={() => assign("clip")}>{edge.kind === "cut" ? "assign exit clip" : "assign clip"}</button>
        {edge.kind === "cut" && <button onClick={() => assign("entry")}>assign entry clip</button>}
      </div>
      <p className="muted">
        {edge.clip?.path ?? "no clip"}
        {edge.kind === "cut" ? ` / ${edge.entryClip?.path ?? "no entry clip"}` : ""}
      </p>
    </section>
  );
}

/** A State named the way the graph labels it: Position, pose, camera. */
function describeState(world: NonNullable<AppState["world"]>, stateId: string): string {
  const state = world.states.find((s) => s.id === stateId);
  if (!state) return stateId;
  const scene = world.scenes.find((s) => s.id === state.sceneId)?.name ?? "?";
  const position = world.positions.find((p) => p.id === state.positionId)?.name ?? "?";
  return state.pose ? `${position} (${state.pose}) · ${scene}` : `${position} · ${scene}`;
}
