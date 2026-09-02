import { useMemo, useRef, useState } from "react";
import type { ClientMessage } from "../../../shared/src/types";
import type { AppState } from "../store";
import { conePath, planBounds, flip, toWorld } from "../floorplan";

interface Props {
  state: AppState;
  send: (msg: ClientMessage) => void;
}

type Mode = "select" | "position" | "camera";

/**
 * Where the cameras are, and what their cones reach.
 *
 * Geometry only. The state machine is authored in the graph next door — this
 * view exists because nodes have to come from somewhere: a camera's cone
 * decides which Positions it sees, and each Scene/Position pairing it covers
 * becomes a State. That derivation is the reason a spatial view is here at all,
 * and it is the whole of its job.
 *
 * All geometry comes from `../floorplan`; this positions and renders.
 */
export function Floorplan({ state, send }: Props) {
  const world = state.world;
  const reports = state.worldReports;
  const [mode, setMode] = useState<Mode>("select");
  const [name, setName] = useState("");
  const [selectedScene, setSelectedScene] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const dragging = useRef<string | null>(null);

  const bounds = useMemo(() => planBounds(world), [world]);

  if (!world) return null;
  const worldId = world.id;

  const uncovered = new Set(reports?.uncoveredPositions ?? []);

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

  // The message goes on release, not per pointer move, so one drag is one write.
  const endDrag = (event: React.PointerEvent) => {
    const positionId = dragging.current;
    dragging.current = null;
    if (!positionId || mode !== "select") return;
    const point = pointAt(event.clientX, event.clientY);
    send({ type: "move-position", worldId, positionId, x: point.x, y: point.y });
  };

  const scene = world.scenes.find((s) => s.id === selectedScene) ?? null;
  const currentPositionId = world.states.find((s) => s.id === state.worldLive?.stateId)?.positionId ?? null;

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
            <g key={s.id} data-testid={`scene-${s.id}`}>
              {path && <path className="cone" d={path} />}
              <circle
                data-testid={`camera-dot-${s.id}`}
                className="camera"
                cx={s.camera.x}
                cy={flip(bounds, s.camera.y)}
                r={1.4}
                onClick={(e) => {
                  // Without this the click also reaches the placement handler,
                  // so selecting a camera would drop a new one on top of it.
                  if (mode !== "select") return;
                  e.stopPropagation();
                  setSelectedScene(s.id);
                }}
              />
            </g>
          );
        })}

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
            />
            {uncovered.has(p.id) && (
              <circle data-testid={`uncovered-${p.id}`} className="mark uncovered" cx={p.x} cy={flip(bounds, p.y)} r={3.4} />
            )}
            <text className="plan-label" x={p.x + 2.5} y={flip(bounds, p.y)}>
              {p.name}
            </text>
          </g>
        ))}
      </svg>

      <div className="plan-side">
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

        <section className="plan-reports" data-testid="plan-reports">
          <h3>coverage</h3>
          {(reports?.coverage ?? []).length === 0 && <p className="muted">No Position sits inside a cone yet.</p>}
          {(reports?.coverage ?? []).map((p) => (
            <p key={`${p.sceneId}-${p.positionId}`} className="muted">
              {world.scenes.find((s) => s.id === p.sceneId)?.name} sees {world.positions.find((x) => x.id === p.positionId)?.name}
            </p>
          ))}
          {(reports?.uncoveredPositions ?? []).map((id) => (
            <p key={id} className="warn">
              {world.positions.find((p) => p.id === id)?.name ?? id} is covered by no camera.
            </p>
          ))}
          {(reports?.staleStrikes ?? []).map((p) => (
            <p key={`${p.sceneId}-${p.positionId}`} className="warn">
              A struck pairing no longer exists — the camera or the Position moved.
            </p>
          ))}
        </section>
      </div>
    </div>
  );
}
