import { useMemo, useRef, useState } from "react";
import type { ClientMessage, Edge, FrameEdge } from "../../../shared/src/types";
import type { AppState } from "../store";
import { conePath, planBounds, planEdges, flip, stateLabel, toWorld } from "../floorplan";
import { clipUrl, probeClipDuration } from "./ClipPlayer";

interface Props {
  state: AppState;
  send: (msg: ClientMessage) => void;
}

type Mode = "select" | "position" | "camera";

const FRAME_EDGES: FrameEdge[] = ["left", "right", "top", "bottom"];

/**
 * The top-down plan: where things are, and what is wrong with the World.
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
  const svgRef = useRef<SVGSVGElement>(null);

  const bounds = useMemo(() => planBounds(world), [world]);
  const edges = useMemo(() => planEdges(bounds, world), [bounds, world]);

  if (!world) return null;
  const worldId = world.id;

  const uncovered = new Set(reports?.uncoveredPositions ?? []);
  const deadEnds = new Set((reports?.deadEnds ?? []).map((d) => d.stateId));
  const reversed = new Set((reports?.reversedCuts ?? []).flatMap((r) => [r.edgeId, r.returnEdgeId]));
  const deadEndPositions = new Set(
    world.states.filter((s) => deadEnds.has(s.id)).map((s) => s.positionId),
  );

  const place = (event: React.MouseEvent<SVGSVGElement>) => {
    if (mode === "select") return;
    const rect = svgRef.current?.getBoundingClientRect() ?? { left: 0, top: 0, width: 0, height: 0 };
    const point = toWorld(bounds, rect, event.clientX, event.clientY);
    const label = name.trim() || (mode === "position" ? "position" : "camera");
    if (mode === "position") {
      send({ type: "add-position", worldId, name: label, x: point.x, y: point.y });
    } else {
      send({ type: "add-scene", worldId, name: label, camera: { x: point.x, y: point.y, facing: 0, fov: 90, range: 20 } });
    }
    setName("");
    setMode("select");
  };

  const edge = world.edges.find((e) => e.id === selectedEdge) ?? null;
  const scene = world.scenes.find((s) => s.id === selectedScene) ?? null;
  const live = state.worldLive;
  const currentPositionId = world.states.find((s) => s.id === live?.stateId)?.positionId ?? null;

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
      >
        {world.scenes.map((s) => {
          const path = conePath(bounds, s.camera);
          return (
            <g key={s.id} data-testid={`scene-${s.id}`} onClick={() => setSelectedScene(s.id)}>
              {path && <path className="cone" d={path} />}
              <circle className="camera" cx={s.camera.x} cy={flip(bounds, s.camera.y)} r={1.4} />
            </g>
          );
        })}

        {edges.map((line) => (
          <line
            key={line.id}
            data-testid={`edge-${line.id}`}
            className={[
              "plan-edge",
              line.kind,
              line.inPlace ? "in-place" : "",
              reversed.has(line.id) ? "reversed" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            x1={line.x1}
            y1={line.y1}
            x2={line.x2}
            y2={line.y2}
            onClick={(e) => {
              e.stopPropagation();
              setSelectedEdge(line.id);
            }}
          />
        ))}

        {world.positions.map((p) => (
          <g key={p.id} data-testid={`position-${p.id}`}>
            <circle
              className={p.id === currentPositionId ? "position current" : "position"}
              cx={p.x}
              cy={flip(bounds, p.y)}
              r={1.8}
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
        </section>

        <section className="plan-reports" data-testid="plan-reports">
          <h3>what is missing</h3>
          {(reports?.uncoveredPositions ?? []).map((id) => (
            <p key={id} className="warn">
              {world.positions.find((p) => p.id === id)?.name ?? id} is covered by no camera.
            </p>
          ))}
          {(reports?.missingClips ?? []).map((pairing) => (
            <p key={`${pairing.sceneId}-${pairing.positionId}`} className="warn">
              {world.positions.find((p) => p.id === pairing.positionId)?.name} needs a clip from{" "}
              {world.scenes.find((s) => s.id === pairing.sceneId)?.name}.
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
            <p key={`${p.sceneId}-${p.positionId}`} className="warn">
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
                  onChange={(e) =>
                    send({ type: "aim-camera", worldId, sceneId: scene.id, camera: { [field]: Number(e.target.value) } })
                  }
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

/** One edge's conditions, clips and frame edges (R25). */
function EdgePanel({ state, send, edge }: Props & { edge: Edge }) {
  const world = state.world!;
  const worldId = world.id;
  const [clipPath, setClipPath] = useState("");

  const assign = async (slot: "clip" | "entry") => {
    const path = clipPath.trim();
    if (path.length === 0) return;
    // The duration comes from the file, in the browser, and travels with the
    // assignment — which is how the server records a length without ever
    // opening a video.
    const durationMs = await probeClipDuration(clipUrl(worldId, { path, durationMs: 0 }));
    send({ type: "assign-clip", worldId, target: { kind: "edge", edgeId: edge.id, slot }, clip: { path, durationMs } });
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
            onChange={(e) =>
              setConditions(edge.conditions.map((c, i) => (i === index ? { ...c, parameter: e.target.value } : c)))
            }
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
            setConditions([
              ...edge.conditions,
              { parameter: world.parameters[0]!.name, op: "eq", value: world.parameters[0]!.defaultValue },
            ])
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
              onChange={(e) =>
                send({ type: "update-edge", worldId, edgeId: edge.id, patch: { [field]: e.target.value as FrameEdge } })
              }
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
        <button onClick={() => void assign("clip")}>{edge.kind === "cut" ? "assign exit clip" : "assign clip"}</button>
        {edge.kind === "cut" && <button onClick={() => void assign("entry")}>assign entry clip</button>}
      </div>
      <p className="muted">
        {edge.clip?.path ?? "no clip"}
        {edge.kind === "cut" ? ` / ${edge.entryClip?.path ?? "no entry clip"}` : ""}
      </p>
    </section>
  );
}
