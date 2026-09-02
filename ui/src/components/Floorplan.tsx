import { useMemo, useRef, useState } from "react";
import type { ClientMessage, Edge, EdgeKind, FrameEdge, Pairing } from "../../../shared/src/types";
import { FRAME_EDGES, EDGE_KINDS } from "../../../shared/src/worlds";
import type { AppState } from "../store";
import { conePath, planBounds, planEdges, flip, stateLabel, toWorld } from "../floorplan";

interface Props {
  state: AppState;
  send: (msg: ClientMessage) => void;
}

type Mode = "select" | "position" | "camera";

const pairingKey = (p: Pairing) => `${p.sceneId}/${p.positionId}`;

/**
 * The top-down plan: where things are, what is wrong with the World, and every
 * control that authors one.
 *
 * All geometry comes from `../floorplan` and `shared/src/world-geometry` — this
 * positions and renders, it does not derive. The three reports render as marks
 * on the plan as well as text, because their whole value is spatial: "this
 * Position is not covered" means the one over there.
 *
 * What is drawn is always the broadcast World, never a local optimistic copy.
 * The manifest is a folder on disk and the server is the only thing that knows
 * what landed in it.
 */
export function Floorplan({ state, send }: Props) {
  const world = state.world;
  const reports = state.worldReports;
  const [mode, setMode] = useState<Mode>("select");
  const [name, setName] = useState("");
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [selectedScene, setSelectedScene] = useState<string | null>(null);
  const [selectedPairing, setSelectedPairing] = useState<string | null>(null);
  const [edgeFrom, setEdgeFrom] = useState<string | null>(null);
  const [edgeTo, setEdgeTo] = useState<string | null>(null);
  const [edgeKind, setEdgeKind] = useState<EdgeKind>("travel");
  const svgRef = useRef<SVGSVGElement>(null);
  const dragging = useRef<string | null>(null);

  const bounds = useMemo(() => planBounds(world), [world]);
  const edges = useMemo(() => planEdges(bounds, world), [bounds, world]);

  if (!world) return null;
  const worldId = world.id;

  const uncovered = new Set(reports?.uncoveredPositions ?? []);
  const deadEnds = new Set((reports?.deadEnds ?? []).map((d) => d.stateId));
  const reversed = new Set((reports?.reversedCuts ?? []).flatMap((r) => [r.edgeId, r.returnEdgeId]));
  const deadEndPositions = new Set(world.states.filter((s) => deadEnds.has(s.id)).map((s) => s.positionId));
  const struck = new Set((world.struck ?? []).map(pairingKey));

  const pointAt = (clientX: number, clientY: number) => {
    const rect = svgRef.current?.getBoundingClientRect() ?? { left: 0, top: 0, width: 0, height: 0 };
    return toWorld(bounds, rect, clientX, clientY);
  };

  const place = (event: React.MouseEvent<SVGSVGElement>) => {
    if (mode === "select") return;
    const point = pointAt(event.clientX, event.clientY);
    const label = name.trim() || (mode === "position" ? "position" : "camera");
    if (mode === "position") {
      send({ type: "add-position", worldId, name: label, x: point.x, y: point.y });
    } else {
      send({ type: "add-scene", worldId, name: label, camera: { x: point.x, y: point.y, facing: 0, fov: 90, range: 20 } });
    }
    setName("");
    setMode("select");
  };

  // Dragging a Position is the mutation the plan doc anticipated ("a floorplan
  // drag produces bursts of small mutations"); the message goes on release, not
  // per pointer move, so one drag is one write.
  const endDrag = (event: React.PointerEvent) => {
    const positionId = dragging.current;
    dragging.current = null;
    if (!positionId || mode !== "select") return;
    const point = pointAt(event.clientX, event.clientY);
    send({ type: "move-position", worldId, positionId, x: point.x, y: point.y });
  };

  const edge = world.edges.find((e) => e.id === selectedEdge) ?? null;
  const scene = world.scenes.find((s) => s.id === selectedScene) ?? null;
  const live = state.worldLive;
  const currentPositionId = world.states.find((s) => s.id === live?.stateId)?.positionId ?? null;

  // Every Scene/Position pairing the cones cover, derived by the server. This
  // is the list a State is authored from — a State has no identity of its own
  // until a clip is assigned to the pairing.
  const coverage = reports?.coverage ?? [];
  const stateAt = (p: Pairing) => world.states.find((s) => s.sceneId === p.sceneId && s.positionId === p.positionId && !s.pose);
  const pairing = coverage.find((p) => pairingKey(p) === selectedPairing) ?? null;

  const nameOfPosition = (id: string) => world.positions.find((p) => p.id === id)?.name ?? id;
  const nameOfScene = (id: string) => world.scenes.find((s) => s.id === id)?.name ?? id;

  return (
    <div className="floorplan" data-testid="floorplan">
      <div className="plan-tools">
        <input aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="couch" />
        <button className={mode === "position" ? "active" : "ghost"} onClick={() => setMode(mode === "position" ? "select" : "position")}>
          place position
        </button>
        <button className={mode === "camera" ? "active" : "ghost"} onClick={() => setMode(mode === "camera" ? "select" : "camera")}>
          place camera
        </button>
      </div>

      <svg
        ref={svgRef}
        className="plan"
        data-testid="plan-svg"
        viewBox={`${bounds.minX} ${bounds.minY} ${bounds.width} ${bounds.height}`}
        onClick={place}
        onPointerUp={endDrag}
      >
        {world.scenes.map((s) => {
          const path = conePath(bounds, s.camera);
          return (
            <g
              key={s.id}
              data-testid={`scene-${s.id}`}
              onClick={(e) => {
                // Without this the click also reaches the svg's placement
                // handler, so aiming at a camera while in placement mode both
                // selected it and dropped a new one on top of it.
                if (mode !== "select") return;
                e.stopPropagation();
                setSelectedScene(s.id);
              }}
            >
              {path && <path className="cone" d={path} />}
              <circle className="camera" cx={s.camera.x} cy={flip(bounds, s.camera.y)} r={1.4} />
            </g>
          );
        })}

        {edges.map((line) => (
          <line
            key={line.id}
            data-testid={`edge-${line.id}`}
            className={["plan-edge", line.kind, line.inPlace ? "in-place" : "", reversed.has(line.id) ? "reversed" : ""]
              .filter(Boolean)
              .join(" ")}
            x1={line.x1}
            y1={line.y1}
            x2={line.x2}
            y2={line.y2}
            onClick={(e) => {
              if (mode !== "select") return;
              e.stopPropagation();
              setSelectedEdge(line.id);
            }}
          />
        ))}

        {world.positions.map((p) => (
          <g key={p.id} data-testid={`position-${p.id}`}>
            <circle
              data-testid={`position-dot-${p.id}`}
              className={p.id === currentPositionId ? "position current" : "position"}
              cx={p.x}
              cy={flip(bounds, p.y)}
              r={1.8}
              onPointerDown={(e) => {
                if (mode !== "select") return;
                e.stopPropagation();
                dragging.current = p.id;
              }}
              onClick={(e) => {
                if (mode !== "select") return;
                e.stopPropagation();
              }}
            />
            {uncovered.has(p.id) && (
              <circle data-testid={`uncovered-${p.id}`} className="mark uncovered" cx={p.x} cy={flip(bounds, p.y)} r={3.4} />
            )}
            {deadEndPositions.has(p.id) && (
              <circle data-testid={`dead-end-${p.id}`} className="mark dead-end" cx={p.x} cy={flip(bounds, p.y)} r={4.6} />
            )}
            <text className="plan-label" x={p.x + 2.5} y={flip(bounds, p.y)}>
              {p.name}
            </text>
          </g>
        ))}
      </svg>

      <div className="plan-side">
        <section className="live-readout" data-testid="live-readout">
          <h3>now</h3>
          <p data-testid="current-state">{live?.stateId ? stateLabel(world, live.stateId) : "nowhere yet"}</p>
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
          <ParameterForm send={send} worldId={worldId} />
        </section>

        <StatesPanel
          coverage={coverage}
          struck={struck}
          selected={selectedPairing}
          onSelect={setSelectedPairing}
          nameOfPosition={nameOfPosition}
          nameOfScene={nameOfScene}
          hasClip={(p) => !!stateAt(p)?.clip}
        />

        {pairing && (
          <StatePanel
            send={send}
            worldId={worldId}
            pairing={pairing}
            struck={struck.has(pairingKey(pairing))}
            stateId={stateAt(pairing)?.id ?? null}
            clipPath={stateAt(pairing)?.clip?.path ?? null}
            label={`${nameOfPosition(pairing.positionId)} · ${nameOfScene(pairing.sceneId)}`}
            onPickEnd={(end, stateId) => (end === "from" ? setEdgeFrom(stateId) : setEdgeTo(stateId))}
          />
        )}

        <section className="edge-builder" data-testid="edge-builder">
          <h3>connect</h3>
          <p className="muted" data-testid="edge-from">
            from: {edgeFrom ? stateLabel(world, edgeFrom) : "—"}
          </p>
          <p className="muted" data-testid="edge-to">
            to: {edgeTo ? stateLabel(world, edgeTo) : "—"}
          </p>
          <label>
            kind
            <select aria-label="edge kind" value={edgeKind} onChange={(e) => setEdgeKind(e.target.value as EdgeKind)}>
              {EDGE_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>
          </label>
          <button
            disabled={!edgeFrom || !edgeTo}
            onClick={() => {
              if (!edgeFrom || !edgeTo) return;
              send({ type: "add-edge", worldId, edge: { kind: edgeKind, from: edgeFrom, to: edgeTo } });
              setEdgeFrom(null);
              setEdgeTo(null);
            }}
          >
            add edge
          </button>
        </section>

        <section className="plan-reports" data-testid="plan-reports">
          <h3>what is missing</h3>
          {(reports?.uncoveredPositions ?? []).map((id) => (
            <p key={id} className="warn">
              {nameOfPosition(id)} is covered by no camera.
            </p>
          ))}
          {(reports?.missingClips ?? []).map((p) => (
            <p key={pairingKey(p)} className="warn">
              {nameOfPosition(p.positionId)} needs a clip from {nameOfScene(p.sceneId)}.
            </p>
          ))}
          {(reports?.reversedCuts ?? []).map((r) => (
            <p key={r.edgeId} className="warn" data-testid={`reversed-${r.edgeId}`}>
              This Cut and its return both leave through the {r.exitEdge} edge, which reads as turning around.
            </p>
          ))}
          {(reports?.deadEnds ?? []).map((d) => (
            <p key={`${d.stateId}-${d.parameter}-${d.value}`} className="warn" data-testid={`dead-end-report-${d.stateId}`}>
              {stateLabel(world, d.stateId)} has no way out while {d.parameter} is {d.value}.
            </p>
          ))}
          {(reports?.staleStrikes ?? []).map((p) => (
            <p key={pairingKey(p)} className="warn">
              A struck pairing no longer exists — the camera or the Position moved.
            </p>
          ))}
          {state.worldIncomplete.map((item) => (
            <p key={`${item.id}-${item.slot}`} className="warn">
              {item.path} could not be used ({item.reason}).
            </p>
          ))}
        </section>

        {scene && (
          <section className="camera-panel" data-testid={`camera-panel-${scene.id}`}>
            <h3>{scene.name}</h3>
            {(["facing", "fov", "range"] as const).map((field) => (
              <label key={field}>
                {field}
                <input
                  aria-label={`${scene.name} ${field}`}
                  type="number"
                  value={scene.camera[field]}
                  onChange={(e) => send({ type: "aim-camera", worldId, sceneId: scene.id, camera: { [field]: Number(e.target.value) } })}
                />
              </label>
            ))}
          </section>
        )}

        {edge && <EdgePanel state={state} send={send} edge={edge} />}
      </div>
    </div>
  );
}

/** Declaring a Parameter (R18). Without this a World can never get its first condition. */
function ParameterForm({ send, worldId }: { send: (msg: ClientMessage) => void; worldId: string }) {
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
    <div className="parameter-form" data-testid="parameter-form">
      <input aria-label="parameter name" value={name} onChange={(e) => setName(e.target.value)} placeholder="location" />
      <input aria-label="parameter values" value={values} onChange={(e) => setValues(e.target.value)} placeholder="couch, booth" />
      <button onClick={declare} disabled={name.trim().length === 0 || values.trim().length === 0}>
        declare
      </button>
    </div>
  );
}

/**
 * Every Scene/Position pairing the cones derive.
 *
 * The list a State is authored from: a State has no identity until a clip is
 * assigned to its pairing, so the pairing is what the author picks.
 */
function StatesPanel({
  coverage,
  struck,
  selected,
  onSelect,
  nameOfPosition,
  nameOfScene,
  hasClip,
}: {
  coverage: Pairing[];
  struck: Set<string>;
  selected: string | null;
  onSelect: (key: string | null) => void;
  nameOfPosition: (id: string) => string;
  nameOfScene: (id: string) => string;
  hasClip: (p: Pairing) => boolean;
}) {
  return (
    <section className="states-panel" data-testid="states-panel">
      <h3>states</h3>
      {coverage.length === 0 && <p className="muted">No Position sits inside a camera's cone yet.</p>}
      {coverage.map((p) => {
        const key = pairingKey(p);
        return (
          <button
            key={key}
            data-testid={`pairing-${p.sceneId}-${p.positionId}`}
            className={key === selected ? "active" : "ghost"}
            onClick={() => onSelect(key === selected ? null : key)}
          >
            {nameOfPosition(p.positionId)} · {nameOfScene(p.sceneId)}
            {hasClip(p) ? "" : " — no clip"}
            {struck.has(key) ? " — struck" : ""}
          </button>
        );
      })}
    </section>
  );
}

/** One State: its own looping clip, its strike, and its use as an edge endpoint. */
function StatePanel({
  send,
  worldId,
  pairing,
  struck,
  stateId,
  clipPath,
  label,
  onPickEnd,
}: {
  send: (msg: ClientMessage) => void;
  worldId: string;
  pairing: Pairing;
  struck: boolean;
  stateId: string | null;
  clipPath: string | null;
  label: string;
  onPickEnd: (end: "from" | "to", stateId: string) => void;
}) {
  const [path, setPath] = useState("");

  // Assigned with a duration of zero on purpose. The clip route serves only
  // clips the manifest already references, so nothing can measure the file
  // before it is assigned — the player reports its real length the first time
  // it plays it.
  const assign = (value: string | null) =>
    send({
      type: "assign-clip",
      worldId,
      target: { kind: "state", sceneId: pairing.sceneId, positionId: pairing.positionId },
      clip: value ? { path: value, durationMs: 0 } : null,
    });

  return (
    <section className="state-panel" data-testid={`state-panel-${pairing.sceneId}-${pairing.positionId}`}>
      <h3>{label}</h3>
      <p className="muted">{clipPath ?? "no clip"}</p>
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
          {stateId ? "clear clip" : "create state"}
        </button>
        <button
          className="ghost"
          onClick={() => send({ type: "strike-pairing", worldId, sceneId: pairing.sceneId, positionId: pairing.positionId, struck: !struck })}
        >
          {struck ? "restore pairing" : "strike pairing"}
        </button>
      </div>
      {stateId && (
        <div className="condition">
          <button className="ghost" onClick={() => onPickEnd("from", stateId)}>
            connect from
          </button>
          <button className="ghost" onClick={() => onPickEnd("to", stateId)}>
            connect to
          </button>
        </div>
      )}
    </section>
  );
}

/** One edge's conditions, clips and frame edges (R25). */
function EdgePanel({ state, send, edge }: Props & { edge: Edge }) {
  const world = state.world!;
  const worldId = world.id;
  const [clipPath, setClipPath] = useState("");

  const assign = (slot: "clip" | "entry") => {
    const path = clipPath.trim();
    if (path.length === 0) return;
    // Zero duration; the player measures the file at first play and corrects it.
    send({ type: "assign-clip", worldId, target: { kind: "edge", edgeId: edge.id, slot }, clip: { path, durationMs: 0 } });
    setClipPath("");
  };

  const setConditions = (conditions: Edge["conditions"]) => {
    send({ type: "update-edge", worldId, edgeId: edge.id, patch: { conditions } });
  };

  return (
    <section className="edge-panel" data-testid={`edge-panel-${edge.id}`}>
      <h3>
        {stateLabel(world, edge.from)} → {stateLabel(world, edge.to)}
      </h3>
      <p className="muted">{edge.kind}</p>

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
        waits for the clip to end
        <input
          type="checkbox"
          aria-label="waits for the clip to end"
          checked={edge.onClipEnd !== false}
          onChange={(e) => send({ type: "update-edge", worldId, edgeId: edge.id, patch: { onClipEnd: e.target.checked } })}
        />
      </label>

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
