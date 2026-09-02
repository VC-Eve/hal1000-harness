import { useMemo, useRef, useState } from "react";
import type {
  ClientMessage,
  ClipOwner,
  ClipRef,
  World,
  Condition,
  ParameterType,
  Transition,
  TransitionPatch,
} from "../../../shared/src/types";
import { PARAMETER_TYPES, opsFor } from "../../../shared/src/worlds";
import { defaultValueOf } from "../../../shared/src/world-graph";
import type { AppState } from "../store";
import { ANY_STATE_KEY, NODE_H, NODE_W, graphLayout, outbound, placeFor, stateName, transitionLabel } from "../graph";
import { ClipBrowser } from "./ClipBrowser";

interface Props {
  state: AppState;
  send: (msg: ClientMessage) => void;
}

const OP_LABEL: Record<string, string> = {
  is: "is",
  isNot: "is not",
  gt: ">",
  lt: "<",
  eq: "==",
  neq: "!=",
};

/**
 * The machine, as a graph.
 *
 * A node is a State, an arrow is a transition, and selecting an arrow opens its
 * conditions — the shape an Animator has, because that is what this is. All
 * layout comes from `../graph`; this positions and renders.
 */
export function StateGraph({ state, send }: Props) {
  const world = state.world;
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [selectedTransition, setSelectedTransition] = useState<string | null>(null);
  // Set when the author has asked to draw a transition; the next node clicked
  // is the destination. Unity's "Make Transition", which is the gesture anyone
  // who has used one will reach for.
  const [connecting, setConnecting] = useState<string | null>(null);
  const [browsingFor, setBrowsingFor] = useState<ClipOwner | null>(null);
  const [newName, setNewName] = useState("");
  const dragging = useRef<{ id: string; x: number; y: number; from: { x: number; y: number } } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const graph = useMemo(() => graphLayout(world, state.worldReports), [world, state.worldReports]);

  if (!world) return null;
  const worldId = world.id;
  const editable = state.worldReadable;

  const live = state.worldLive;
  const node = graph.nodes.find((n) => n.id === selectedNode) ?? null;
  const transition = world.transitions.find((t) => t.id === selectedTransition) ?? null;

  const addState = () => {
    const at = placeFor(world.states.length);
    send({ type: "add-state", worldId, state: { name: newName.trim() || "state", x: at.x, y: at.y } });
    setNewName("");
  };

  const clickNode = (id: string) => {
    if (connecting) {
      const from = connecting === ANY_STATE_KEY ? { fromAny: true } : { from: connecting };
      send({ type: "add-transition", worldId, transition: { ...from, to: id } });
      setConnecting(null);
      return;
    }
    setSelectedTransition(null);
    setSelectedNode(id);
  };

  // One write per drag, on release, rather than one per pointer move.
  const endDrag = (event: React.PointerEvent) => {
    const held = dragging.current;
    dragging.current = null;
    if (!held || !editable) return;
    const moved = { x: held.x + event.clientX, y: held.y + event.clientY };
    if (!Number.isFinite(moved.x) || !Number.isFinite(moved.y)) return;
    // A plain click is a pointerdown and a pointerup with nothing between them.
    // Writing on those too sent a mutation per click — each one a manifest
    // write, a broadcast and a reports pass, for a node that never moved.
    if (moved.x === held.from.x && moved.y === held.from.y) return;
    send({ type: "update-state", worldId, stateId: held.id, patch: { x: moved.x, y: moved.y } });
  };

  return (
    <div className="state-graph" data-testid="state-graph">
      <div className="graph-canvas">
        <div className="graph-tools">
          <input aria-label="new state name" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="idle" />
          <button onClick={addState} disabled={!editable}>
            add state
          </button>
          <button
            className={connecting === ANY_STATE_KEY ? "active" : "ghost"}
            disabled={!editable}
            onClick={() => setConnecting(connecting === ANY_STATE_KEY ? null : ANY_STATE_KEY)}
          >
            {connecting === ANY_STATE_KEY ? "cancel" : "from Any State"}
          </button>
        </div>

        <svg ref={svgRef} width={graph.width} height={graph.height} data-testid="graph-svg" onPointerUp={endDrag}>
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" className="arrowhead" />
            </marker>
          </defs>

          {graph.lines.map((line) => (
            <g
              key={line.id}
              data-testid={`transition-${line.id}`}
              onClick={() => {
                setSelectedNode(null);
                setSelectedTransition(line.id);
              }}
            >
              {/* A wide invisible stroke under the visible one: a 1.5px curve
                  is a hard thing to hit with a mouse. */}
              <path className="transition-hit" d={line.d} />
              <path
                className={[
                  "transition",
                  line.fromAny ? "from-any" : "",
                  line.muted ? "muted" : "",
                  line.solo ? "solo" : "",
                  line.id === selectedTransition ? "selected" : "",
                  line.id === live?.transitionId ? "crossing" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                d={line.d}
                markerEnd="url(#arrow)"
              />
            </g>
          ))}

          {graph.anyState && (
            <g data-testid="node-any" className="graph-node" transform={`translate(${graph.anyState.x} ${graph.anyState.y})`}>
              <rect width={NODE_W} height={NODE_H} rx={28} className="node-box any-state" />
              <text className="node-title" x={16} y={33}>
                Any State
              </text>
            </g>
          )}

          {graph.nodes.map((n) => (
            <g
              key={n.id}
              data-testid={`node-${n.id}`}
              className="graph-node"
              transform={`translate(${n.x} ${n.y})`}
              onClick={() => clickNode(n.id)}
              onPointerDown={(e) => {
                if (!editable || connecting) return;
                // Captured, so a release over the side panel — a sibling of the
                // svg, not a descendant — still reaches `endDrag` instead of
                // silently dropping the move.
                e.currentTarget.setPointerCapture?.(e.pointerId);
                dragging.current = { id: n.id, x: n.x - e.clientX, y: n.y - e.clientY, from: { x: n.x, y: n.y } };
              }}
              onPointerUp={endDrag}
            >
              <rect
                width={NODE_W}
                height={NODE_H}
                rx={6}
                className={[
                  "node-box",
                  !live?.transitionId && n.id === live?.stateId ? "current" : "",
                  n.id === selectedNode ? "selected" : "",
                  n.isDefault ? "is-default" : "",
                  n.missingClip ? "no-clip" : "",
                  n.brokenClips ? "broken-clips" : "",
                  n.deadEnd ? "dead-end" : "",
                  n.unreachable ? "unreachable" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              />
              <text className="node-title" x={12} y={22}>
                {n.name}
              </text>
              <text className="node-sub" x={12} y={40}>
                {n.clipCount === 0
                  ? "no clips"
                  : n.brokenClips
                    ? `${n.clipCount} missing`
                    : n.clipCount === 1
                      ? "1 clip"
                      : `${n.clipCount} clips`}
              </text>
              {n.isDefault && (
                <text className="node-flag default" data-testid={`node-default-${n.id}`} x={NODE_W - 12} y={40}>
                  ▶
                </text>
              )}
              {n.deadEnd && (
                <text className="node-flag" data-testid={`node-dead-end-${n.id}`} x={NODE_W - 12} y={22}>
                  !
                </text>
              )}
              {n.unreachable && (
                <text className="node-flag" data-testid={`node-unreachable-${n.id}`} x={NODE_W - 28} y={22}>
                  ⌀
                </text>
              )}
            </g>
          ))}
        </svg>

        {graph.nodes.length === 0 && (
          <p className="muted" data-testid="graph-empty">
            No States yet. Name one and add it — the first becomes where the machine starts.
          </p>
        )}
        {connecting && (
          <p className="muted" data-testid="connecting">
            Click the destination State to finish the transition.
          </p>
        )}
      </div>

      <div className="graph-side">
        {!editable && (
          <p className="warn" data-testid="read-only">
            {state.worldReadOnlyReason ?? "This World cannot be edited."}
          </p>
        )}

        <ParametersPanel state={state} send={send} />

        {browsingFor ? (
          <ClipBrowser state={state} send={send} owner={browsingFor} onClose={() => setBrowsingFor(null)} />
        ) : null}

        {node && !browsingFor && (
          <NodePanel
            key={node.id}
            state={state}
            send={send}
            nodeId={node.id}
            editable={editable}
            connecting={connecting === node.id}
            onConnect={() => setConnecting(connecting === node.id ? null : node.id)}
            onBrowse={() => setBrowsingFor({ kind: "state", id: node.id })}
          />
        )}

        {transition && !browsingFor && (
          <TransitionPanel
            key={transition.id}
            state={state}
            send={send}
            transition={transition}
            editable={editable}
            onBrowse={() => setBrowsingFor({ kind: "transition", id: transition.id })}
          />
        )}

        {!node && !transition && (
          <section className="graph-hint" data-testid="graph-hint">
            <h3>editing</h3>
            <p className="muted">Select a State or a transition to edit it.</p>
          </section>
        )}

        {state.worldIncomplete.length > 0 && (
          <section data-testid="incomplete-clips">
            <h3>clips</h3>
            {state.worldIncomplete.map((item) => (
              <p key={`${item.ownerId}-${item.index}`} className="warn">
                {item.ownerKind === "state" ? stateName(world, item.ownerId) : "a transition"}: {item.path} could
                not be used ({item.reason}).
              </p>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}

/** Parameters: what conditions read, and what drives the machine while it runs. */
function ParametersPanel({ state, send }: Props) {
  const world = state.world!;
  const worldId = world.id;
  const live = state.worldLive;
  const [name, setName] = useState("");
  const [type, setType] = useState<ParameterType>("bool");

  const declare = () => {
    if (name.trim().length === 0) return;
    send({
      type: "declare-parameter",
      worldId,
      parameter: { name: name.trim(), type, defaultValue: type === "bool" || type === "trigger" ? false : 0 },
    });
    setName("");
  };

  return (
    <section className="parameters-panel" data-testid="parameters-panel">
      <h3>parameters</h3>
      <p className="muted" data-testid="current-state">
        now:{" "}
        {live?.transitionId
          ? crossingLabel(world, live.transitionId)
          : live?.stateId
            ? stateName(world, live.stateId)
            : "nowhere yet"}
      </p>

      {world.parameters.map((parameter) => {
        const value = live?.parameters[parameter.name] ?? parameter.defaultValue;
        return (
          <div key={parameter.name} className="condition" data-testid={`parameter-${parameter.name}`}>
            <span className="muted">{parameter.name}</span>
            {parameter.type === "trigger" ? (
              // A Trigger is fired, not set: it clears itself once a transition
              // consumes it, so a checkbox would be lying about its own state.
              <button
                className="ghost"
                onClick={() => send({ type: "set-parameter", worldId, name: parameter.name, value: true })}
              >
                fire
              </button>
            ) : parameter.type === "bool" ? (
              <input
                type="checkbox"
                aria-label={parameter.name}
                checked={value === true}
                onChange={(e) => send({ type: "set-parameter", worldId, name: parameter.name, value: e.target.checked })}
              />
            ) : (
              <input
                type="number"
                aria-label={parameter.name}
                value={typeof value === "number" ? value : 0}
                step={parameter.type === "float" ? 0.1 : 1}
                onChange={(e) => {
                  // An empty field is somebody midway through retyping, not a
                  // request for zero — and `Number("")` is 0, so the guard has
                  // to be on the raw text rather than the parsed number.
                  const raw = e.target.value.trim();
                  if (raw.length === 0) return;
                  const next = parameter.type === "int" ? Math.trunc(Number(raw)) : Number(raw);
                  if (Number.isFinite(next)) send({ type: "set-parameter", worldId, name: parameter.name, value: next });
                }}
              />
            )}
            <button className="ghost" onClick={() => send({ type: "remove-parameter", worldId, name: parameter.name })}>
              remove
            </button>
          </div>
        );
      })}

      <div className="parameter-form" data-testid="parameter-form">
        <input aria-label="parameter name" value={name} onChange={(e) => setName(e.target.value)} placeholder="ready" />
        <select aria-label="parameter type" value={type} onChange={(e) => setType(e.target.value as ParameterType)}>
          {PARAMETER_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <button onClick={declare} disabled={name.trim().length === 0}>
          declare
        </button>
      </div>

      {live?.fault && <p className="warn">{live.fault}</p>}
    </section>
  );
}

/** One State: its clip, whether it is the default, and its transitions out. */
function NodePanel({
  state,
  send,
  nodeId,
  editable,
  connecting,
  onConnect,
  onBrowse,
}: Props & {
  nodeId: string;
  editable: boolean;
  connecting: boolean;
  onConnect: () => void;
  onBrowse: () => void;
}) {
  const world = state.world!;
  const worldId = world.id;
  const node = world.states.find((s) => s.id === nodeId)!;
  const transitions = outbound(world, nodeId);

  // A clip-set edit sends the whole next array, computed from the last
  // broadcast. Two edits made before the first comes back are both computed
  // from the same stale list, so the second silently resurrects what the first
  // removed. The controls wait for the round trip rather than losing the edit.
  //
  // Released by the *next answer*, whatever it says, rather than by the set
  // coming back equal to what was sent: a refusal, a concurrent edit, or a
  // server that trimmed a path all leave those two different forever, and the
  // controls would never come back.
  const inFlight = useClipEdit(node.clips, state.worldResults["update-state"]);

  const setClips = (clips: ClipRef[]) => {
    inFlight.sent();
    send({ type: "update-state", worldId, stateId: nodeId, patch: { clips } });
  };

  /** Move one clip within the set. The order is the author's, so it is theirs to change. */
  const reorder = (from: number, to: number) => {
    const next = [...node.clips];
    const [moved] = next.splice(from, 1);
    if (!moved) return;
    next.splice(to, 0, moved);
    setClips(next);
  };

  return (
    <section className="node-panel" data-testid={`node-panel-${nodeId}`}>
      <h3>{node.name}</h3>

      <label>
        name
        <input
          aria-label="state name"
          value={node.name}
          onChange={(e) => send({ type: "update-state", worldId, stateId: nodeId, patch: { name: e.target.value } })}
        />
      </label>

      <ul className="clip-set" data-testid={`clip-set-${nodeId}`}>
        {node.clips.length === 0 && <li className="muted">No clips yet. One is drawn each time round.</li>}
        {node.clips.map((clip, index) => (
          <li key={`${clip.path}-${index}`} data-testid={`clip-${index}-${nodeId}`}>
            <span className="muted">{clip.path.replace(/^clips\//, "")}</span>
            <button
              className="ghost"
              aria-label={`move ${clip.path} up`}
              disabled={!editable || inFlight.waiting || index === 0}
              onClick={() => reorder(index, index - 1)}
            >
              ↑
            </button>
            <button
              className="ghost"
              aria-label={`move ${clip.path} down`}
              disabled={!editable || inFlight.waiting || index === node.clips.length - 1}
              onClick={() => reorder(index, index + 1)}
            >
              ↓
            </button>
            <button
              className="ghost"
              aria-label={`remove ${clip.path}`}
              disabled={!editable || inFlight.waiting}
              onClick={() => setClips(node.clips.filter((_, i) => i !== index))}
            >
              remove
            </button>
          </li>
        ))}
      </ul>
      {node.clips.length > 1 && (
        <p className="muted">
          One is drawn each time round, never the same twice running. The order is yours to arrange —
          it does not change which plays.
        </p>
      )}
      <div className="condition">
        <button onClick={onBrowse} disabled={!editable}>
          add clip…
        </button>
        <button
          className="ghost"
          disabled={!editable || inFlight.waiting || node.clips.length === 0}
          onClick={() => setClips([])}
        >
          clear
        </button>
      </div>

      <div className="condition">
        <button
          className="ghost"
          disabled={world.defaultStateId === nodeId}
          onClick={() => send({ type: "set-default-state", worldId, stateId: nodeId })}
        >
          {world.defaultStateId === nodeId ? "is the default" : "make default"}
        </button>
        <button className={connecting ? "active" : "ghost"} disabled={!editable} onClick={onConnect}>
          {connecting ? "cancel" : "make transition"}
        </button>
      </div>

      <TransitionOrder state={state} send={send} fromKey={nodeId} transitions={transitions} />

      <button className="ghost" onClick={() => send({ type: "remove-state", worldId, stateId: nodeId })}>
        delete state
      </button>
    </section>
  );
}

/**
 * The order a State's transitions are tried in.
 *
 * Order is load-bearing — the first satisfied transition is taken — so it is
 * something the author sets rather than something that falls out of the
 * sequence they happened to draw them in.
 */
function TransitionOrder({
  state,
  send,
  fromKey,
  transitions,
}: Props & { fromKey: string; transitions: Transition[] }) {
  const world = state.world!;
  const worldId = world.id;
  if (transitions.length < 2) return null;

  const move = (index: number, by: number) => {
    const order = transitions.map((t) => t.id);
    const target = index + by;
    if (target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target]!, order[index]!];
    send({
      type: "reorder-transitions",
      worldId,
      ...(fromKey === ANY_STATE_KEY ? { fromAny: true } : { from: fromKey }),
      order,
    });
  };

  return (
    <div className="transition-order" data-testid={`order-${fromKey}`}>
      <h4>tried in this order</h4>
      {transitions.map((t, index) => (
        <div key={t.id} className="condition">
          <span className="muted">{transitionLabel(world, t)}</span>
          <button className="ghost" aria-label={`move ${index} up`} disabled={index === 0} onClick={() => move(index, -1)}>
            ↑
          </button>
          <button
            className="ghost"
            aria-label={`move ${index} down`}
            disabled={index === transitions.length - 1}
            onClick={() => move(index, 1)}
          >
            ↓
          </button>
        </div>
      ))}
    </div>
  );
}

/** One transition: when it fires, and what has to hold for it. */
/**
 * Hold a clip set's controls until the edit just sent has been answered.
 *
 * Every edit replaces the whole set, computed from the last broadcast, so two
 * made from one snapshot lose each other. Waiting is what stops that — and the
 * wait ends on the next answer of any kind, because a refusal or a concurrent
 * edit means the set will never come back equal to what was sent.
 */
function useClipEdit(
  clips: readonly ClipRef[],
  result: { ok: boolean; error?: string } | undefined,
): { waiting: boolean; sent: () => void } {
  const [pending, setPending] = useState(false);
  const answered = useRef<{ clips: readonly ClipRef[]; result: unknown }>({ clips, result });

  if (pending && (clips !== answered.current.clips || result !== answered.current.result)) {
    setPending(false);
  }
  answered.current = { clips, result };

  return { waiting: pending, sent: () => setPending(true) };
}

/** What the readout says while the machine is between States. */
function crossingLabel(world: World, transitionId: string): string {
  const transition = world.transitions.find((t) => t.id === transitionId);
  return transition ? `crossing ${transitionLabel(world, transition)}` : "crossing";
}

function TransitionPanel({
  state,
  send,
  transition,
  editable,
  onBrowse,
}: Props & { transition: Transition; editable: boolean; onBrowse: () => void }) {
  const world = state.world!;
  const worldId = world.id;

  const patch = (values: TransitionPatch) =>
    send({ type: "update-transition", worldId, transitionId: transition.id, patch: values });

  const setConditions = (conditions: Condition[]) => patch({ conditions });

  // The same round-trip guard the State's set uses, for the same reason.
  const bridge = useClipEdit(transition.clips, state.worldResults["update-transition"]);
  const bridgeInFlight = bridge.waiting;

  const typeOf = (name: string): ParameterType =>
    world.parameters.find((p) => p.name === name)?.type ?? "bool";

  return (
    <section className="transition-panel" data-testid={`transition-panel-${transition.id}`}>
      <h3>{transitionLabel(world, transition)}</h3>

      <label>
        has exit time
        <input
          type="checkbox"
          aria-label="has exit time"
          checked={transition.hasExitTime !== false}
          onChange={(e) => patch({ hasExitTime: e.target.checked })}
        />
      </label>
      {transition.hasExitTime !== false ? (
        <>
          <label>
            exit time
            <input
              type="number"
              aria-label="exit time"
              min={0}
              max={1}
              step={0.05}
              value={transition.exitTime}
              onChange={(e) => {
                // An empty field is somebody midway through retyping, not a
                // request for zero — and `Number("")` is 0, so the guard has to
                // be on the raw text rather than the parsed number.
                const raw = e.target.value.trim();
                if (raw.length === 0) return;
                const next = Number(raw);
                if (Number.isFinite(next)) patch({ exitTime: next });
              }}
            />
          </label>
          <p className="muted">
            Offered {Math.round((transition.exitTime ?? 1) * 100)}% of the way through whichever clip is playing,
            and again on every loop.
          </p>
        </>
      ) : (
        <p className="muted">Taken the moment its conditions hold, cutting the current clip short.</p>
      )}

      <h4>bridge</h4>
      <ul className="clip-set" data-testid={`clip-set-${transition.id}`}>
        {transition.clips.length === 0 && (
          <li className="muted">No clips, so this transition is an instant cut. Add one to make the move visible.</li>
        )}
        {transition.clips.map((clip, index) => (
          <li key={`${clip.path}-${index}`} data-testid={`clip-${index}-${transition.id}`}>
            <span className="muted">{clip.path.replace(/^clips\//, "")}</span>
            <button
              className="ghost"
              aria-label={`remove ${clip.path}`}
              disabled={!editable || bridgeInFlight}
              onClick={() => {
                bridge.sent();
                patch({ clips: transition.clips.filter((_, i) => i !== index) });
              }}
            >
              remove
            </button>
          </li>
        ))}
      </ul>
      <div className="condition">
        <button onClick={onBrowse} disabled={!editable}>
          add clip…
        </button>
      </div>
      {transition.clips.length > 0 && (
        <p className="muted">
          One is played whole before the destination begins. Nothing is evaluated while it runs.
        </p>
      )}

      <h4>conditions</h4>
      {transition.conditions.length === 0 && <p className="muted">None — offered whenever it is evaluated.</p>}
      {transition.conditions.map((condition, index) => {
        const type = typeOf(condition.parameter);
        return (
          <div key={index} className="condition">
            <select
              aria-label={`condition ${index} parameter`}
              value={condition.parameter}
              onChange={(e) =>
                setConditions(
                  transition.conditions.map((c, i) => (i === index ? { ...c, parameter: e.target.value } : c)),
                )
              }
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
              onChange={(e) =>
                setConditions(
                  transition.conditions.map((c, i) => (i === index ? { ...c, op: e.target.value as Condition["op"] } : c)),
                )
              }
            >
              {opsFor(type).map((op) => (
                <option key={op} value={op}>
                  {OP_LABEL[op]}
                </option>
              ))}
            </select>
            {type === "bool" || type === "trigger" ? (
              <select
                aria-label={`condition ${index} value`}
                value={condition.value === true ? "true" : "false"}
                onChange={(e) =>
                  setConditions(
                    transition.conditions.map((c, i) => (i === index ? { ...c, value: e.target.value === "true" } : c)),
                  )
                }
              >
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            ) : (
              <input
                type="number"
                aria-label={`condition ${index} value`}
                value={typeof condition.value === "number" ? condition.value : 0}
                step={type === "float" ? 0.1 : 1}
                onChange={(e) =>
                  setConditions(
                    transition.conditions.map((c, i) => (i === index ? { ...c, value: Number(e.target.value) } : c)),
                  )
                }
              />
            )}
            <button className="ghost" onClick={() => setConditions(transition.conditions.filter((_, i) => i !== index))}>
              remove
            </button>
          </div>
        );
      })}
      {world.parameters.length > 0 && (
        <button
          className="ghost"
          disabled={!editable}
          onClick={() => {
            const first = world.parameters[0]!;
            setConditions([
              ...transition.conditions,
              { parameter: first.name, op: opsFor(first.type)[0]!, value: defaultValueOf(first) },
            ]);
          }}
        >
          add condition
        </button>
      )}

      <div className="condition">
        <label>
          mute
          <input
            type="checkbox"
            aria-label="mute"
            checked={transition.muted === true}
            onChange={(e) => patch({ muted: e.target.checked })}
          />
        </label>
        <label>
          solo
          <input
            type="checkbox"
            aria-label="solo"
            checked={transition.solo === true}
            onChange={(e) => patch({ solo: e.target.checked })}
          />
        </label>
      </div>
      <p className="muted">Mute disables this transition. Solo silences the others out of the same source.</p>

      <button
        className="ghost"
        onClick={() => send({ type: "remove-transition", worldId, transitionId: transition.id })}
      >
        delete transition
      </button>
    </section>
  );
}
