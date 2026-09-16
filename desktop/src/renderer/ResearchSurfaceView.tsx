import { useEffect, useRef, useState } from "react";
import type {
  ResearchDesktopApi,
  ResearchResult,
  ResearchSelection,
} from "../shared/research-contracts";
import "./ResearchSurfaceView.css";

type Vec3 = [number, number, number];
export type SurfaceMesh = {
  schema: "loci.surface-display/v1";
  vertices_world_xyz: Vec3[];
  faces: [number, number, number][];
  world_bounds: [Vec3, Vec3];
  geometry: { unit: string; frame: string };
  source_shape: number[];
  display_shape: number[];
  strides_zyx: number[];
  marching_step: number;
  isovalue: number;
  display_range: [number, number];
  purpose: string;
  mode: "intensity" | "labels";
  binding: { result_id?: string; revision_hash?: string; source_id?: string };
  adopted: false;
};

export function rotateWorld(point: Vec3, yaw: number, pitch: number): Vec3 {
  const x = Math.cos(yaw) * point[0] + Math.sin(yaw) * point[2];
  const z = -Math.sin(yaw) * point[0] + Math.cos(yaw) * point[2];
  return [
    x,
    Math.cos(pitch) * point[1] - Math.sin(pitch) * z,
    Math.sin(pitch) * point[1] + Math.cos(pitch) * z,
  ];
}

function checkedMesh(value: unknown): SurfaceMesh {
  const mesh = value as SurfaceMesh;
  if (
    !mesh ||
    mesh.schema !== "loci.surface-display/v1" ||
    mesh.adopted !== false ||
    !Array.isArray(mesh.vertices_world_xyz) ||
    mesh.vertices_world_xyz.length > 60000 ||
    !mesh.vertices_world_xyz.every(
      (point) =>
        Array.isArray(point) &&
        point.length === 3 &&
        point.every(Number.isFinite),
    ) ||
    !Array.isArray(mesh.faces) ||
    !mesh.faces.length ||
    mesh.faces.length > 20000 ||
    !mesh.faces.every(
      (face) =>
        Array.isArray(face) &&
        face.length === 3 &&
        face.every(
          (index) =>
            Number.isSafeInteger(index) &&
            index >= 0 &&
            index < mesh.vertices_world_xyz.length,
        ),
    ) ||
    !Array.isArray(mesh.world_bounds) ||
    mesh.world_bounds.length !== 2 ||
    !mesh.world_bounds.every(
      (point) => point.length === 3 && point.every(Number.isFinite),
    ) ||
    !mesh.geometry ||
    !mesh.binding ||
    !Number.isFinite(mesh.isovalue)
  ) {
    throw new Error("The engine returned an invalid bounded surface display.");
  }
  return mesh;
}

function draw(
  canvas: HTMLCanvasElement,
  mesh: SurfaceMesh,
  yaw: number,
  pitch: number,
  zoom: number,
) {
  const bounds = canvas.getBoundingClientRect();
  const width = Math.max(100, Math.round(bounds.width || 640));
  const height = Math.max(100, Math.round(bounds.height || 440));
  const ratio = Math.min(3, window.devicePixelRatio || 1);
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const context = canvas.getContext("2d");
  if (!context) return;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.fillStyle = "#090e12";
  context.fillRect(0, 0, width, height);
  const center = mesh.world_bounds[0].map(
    (value, i) => (value + mesh.world_bounds[1][i]) / 2,
  ) as Vec3;
  const diagonal = Math.hypot(
    ...mesh.world_bounds[1].map((value, i) => value - mesh.world_bounds[0][i]),
  );
  const scale =
    (Math.min(width, height) * 0.84 * zoom) / Math.max(diagonal, 1e-12);
  const rotated = mesh.vertices_world_xyz.map((point) =>
    rotateWorld(point.map((v, i) => v - center[i]) as Vec3, yaw, pitch),
  );
  const depthOrder = mesh.faces
    .map((face) => ({
      face,
      depth: face.reduce((sum, index) => sum + rotated[index][2], 0),
    }))
    .sort((a, b) => a.depth - b.depth);
  for (const { face } of depthOrder) {
    const a = rotated[face[0]],
      b = rotated[face[1]],
      c = rotated[face[2]];
    const u = b.map((v, i) => v - a[i]),
      v = c.map((n, i) => n - a[i]);
    const normal = [
      u[1] * v[2] - u[2] * v[1],
      u[2] * v[0] - u[0] * v[2],
      u[0] * v[1] - u[1] * v[0],
    ];
    const light =
      0.3 +
      0.7 *
        Math.abs(
          (normal[0] * 0.2 + normal[1] * 0.4 + normal[2] * 0.89) /
            (Math.hypot(...normal) || 1),
        );
    context.fillStyle = `rgb(${Math.round(82 * light)},${Math.round(195 * light)},${Math.round(181 * light)})`;
    context.beginPath();
    context.moveTo(width / 2 + a[0] * scale, height / 2 - a[1] * scale);
    context.lineTo(width / 2 + b[0] * scale, height / 2 - b[1] * scale);
    context.lineTo(width / 2 + c[0] * scale, height / 2 - c[1] * scale);
    context.closePath();
    context.fill();
  }
  const directions =
    mesh.geometry.frame === "LPS"
      ? ["+X Left", "+Y Posterior", "+Z Superior"]
      : mesh.geometry.frame === "RAS"
        ? ["+X Right", "+Y Anterior", "+Z Superior"]
        : ["+X", "+Y", "+Z"];
  const colors = ["#ff978d", "#8dd99b", "#88b8ed"];
  context.font = "11px system-ui";
  for (let i = 0; i < 3; i++) {
    const vector = [0, 0, 0] as Vec3;
    vector[i] = 42;
    const endpoint = rotateWorld(vector, yaw, pitch);
    context.strokeStyle = colors[i];
    context.fillStyle = colors[i];
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(58, height - 62);
    context.lineTo(58 + endpoint[0], height - 62 - endpoint[1]);
    context.stroke();
    context.fillText(
      directions[i],
      62 + endpoint[0],
      height - 64 - endpoint[1],
    );
  }
  context.fillStyle = "#bed0d8";
  context.fillText(
    `World ${mesh.geometry.frame} · ${mesh.geometry.unit}`,
    12,
    20,
  );
}

export function ResearchSurfaceView({
  api,
  sourceId,
  selection,
  result,
  onClose,
}: {
  api: ResearchDesktopApi;
  sourceId: string | null;
  selection: ResearchSelection;
  result: ResearchResult | null;
  onClose: () => void;
}) {
  const [mesh, setMesh] = useState<SurfaceMesh | null>(null);
  const [level, setLevel] = useState("");
  const [edge, setEdge] = useState(80);
  const [mode, setMode] = useState<"intensity" | "labels">("intensity");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [camera, setCamera] = useState({ yaw: -0.6, pitch: 0.4, zoom: 1 });
  const canvas = useRef<HTMLCanvasElement>(null);
  const generation = useRef(0);
  const drag = useRef<{
    x: number;
    y: number;
    yaw: number;
    pitch: number;
  } | null>(null);
  const bindingKey = JSON.stringify(
    result
      ? { id: result.id, revision: result.revision_hash }
      : { sourceId, selection },
  );
  const resultShape = result?.arrays?.image?.shape;
  const canBuild = result
    ? resultShape?.length === 3 && resultShape.every((size) => size >= 2)
    : !!sourceId &&
      selection.z_stop !== undefined &&
      selection.z_stop - selection.z >= 2;
  useEffect(() => {
    generation.current += 1;
    setMesh(null);
    setError(null);
    setBusy(false);
    setLevel("");
    setMode("intensity");
    setLabel("");
    return () => {
      generation.current += 1;
    };
  }, [bindingKey]);
  useEffect(() => {
    const element = canvas.current;
    if (!element || !mesh) return;
    const redraw = () =>
      draw(element, mesh, camera.yaw, camera.pitch, camera.zoom);
    redraw();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(redraw);
    observer?.observe(element);
    window.addEventListener("resize", redraw);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", redraw);
    };
  }, [mesh, camera]);
  const build = async () => {
    if (busy || !canBuild) return;
    const token = ++generation.current;
    setBusy(true);
    setError(null);
    setMesh(null);
    try {
      if (
        mode === "intensity" &&
        level.trim() &&
        !Number.isFinite(Number(level))
      )
        throw new Error("Choose a finite display level.");
      if (
        mode === "labels" &&
        label.trim() &&
        (!Number.isSafeInteger(Number(label)) ||
          Number(label) < 1 ||
          Number(label) > 0xffffffff)
      )
        throw new Error(
          "Choose an integer label ID from 1 through 4294967295.",
        );
      const binding = result
        ? { result_id: result.id, revision_hash: result.revision_hash }
        : { source_id: sourceId, selection };
      const response = checkedMesh(
        await api.execute("surface_view", {
          ...binding,
          mode,
          max_edge: edge,
          ...(mode === "intensity" && level.trim()
            ? { isovalue: Number(level) }
            : {}),
          ...(mode === "labels" && label.trim()
            ? { label: Number(label) }
            : {}),
        }),
      );
      if (token !== generation.current) return;
      if (
        result
          ? response.binding.result_id !== result.id ||
            response.binding.revision_hash !== result.revision_hash
          : response.binding.source_id !== sourceId
      )
        throw new Error(
          "Surface display did not match the selected source or exact result.",
        );
      setMesh(response);
      setLevel(String(response.isovalue));
    } catch (caught) {
      if (token === generation.current)
        setError(
          caught instanceof Error ? caught.message : "Surface display failed.",
        );
    } finally {
      if (token === generation.current) setBusy(false);
    }
  };
  return (
    <section
      className="research-surface"
      aria-label="Calibrated 3D surface viewer"
    >
      <div className="research-surface-controls">
        <button onClick={onClose}>Back to planes</button>
        <label>
          Surface{" "}
          <select
            aria-label="Surface basis"
            value={mode}
            disabled={busy}
            onChange={(e) => {
              setMode(e.target.value as "intensity" | "labels");
              setMesh(null);
            }}
          >
            <option value="intensity">Intensity</option>
            <option value="labels" disabled={!result?.arrays?.labels}>
              Labels
            </option>
          </select>
        </label>
        {mode === "intensity" ? (
          <label>
            Display level{" "}
            <input
              aria-label="Surface display level"
              type="number"
              step="any"
              placeholder="Mid-range"
              value={level}
              disabled={busy}
              onChange={(e) => {
                setLevel(e.target.value);
                setMesh(null);
              }}
            />
          </label>
        ) : (
          <label>
            Label ID{" "}
            <input
              aria-label="Surface label ID"
              type="number"
              min="1"
              step="1"
              placeholder="All labels"
              value={label}
              disabled={busy}
              onChange={(e) => {
                setLabel(e.target.value);
                setMesh(null);
              }}
            />
          </label>
        )}
        <label>
          Display edge{" "}
          <select
            aria-label="Surface display edge"
            value={edge}
            disabled={busy}
            onChange={(e) => {
              setEdge(Number(e.target.value));
              setMesh(null);
            }}
          >
            {[32, 48, 64, 80, 96].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <button disabled={busy || !canBuild} onClick={() => void build()}>
          {busy ? "Building surface…" : "Build surface"}
        </button>
        <button
          disabled={!mesh}
          onClick={() => setCamera({ yaw: -0.6, pitch: 0.4, zoom: 1 })}
        >
          Reset view
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {!canBuild && (
        <p>
          Select a volume result, or a source crop with at least two Z planes.
        </p>
      )}
      {!mesh && canBuild && (
        <p>
          Choose a display level and build the surface. This view preserves
          world orientation and physical aspect ratio.
        </p>
      )}
      {mesh && (
        <>
          <canvas
            ref={canvas}
            tabIndex={0}
            aria-label="Interactive world-coordinate surface. Drag or use arrow keys to orbit; plus and minus to zoom."
            onPointerDown={(event) => {
              drag.current = {
                x: event.clientX,
                y: event.clientY,
                yaw: camera.yaw,
                pitch: camera.pitch,
              };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (drag.current)
                setCamera((current) => ({
                  ...current,
                  yaw:
                    drag.current!.yaw +
                    (event.clientX - drag.current!.x) * 0.008,
                  pitch: Math.max(
                    -1.55,
                    Math.min(
                      1.55,
                      drag.current!.pitch +
                        (event.clientY - drag.current!.y) * 0.008,
                    ),
                  ),
                }));
            }}
            onPointerUp={() => {
              drag.current = null;
            }}
            onPointerCancel={() => {
              drag.current = null;
            }}
            onWheel={(event) => {
              event.preventDefault();
              setCamera((current) => ({
                ...current,
                zoom: Math.max(
                  0.25,
                  Math.min(4, current.zoom * (event.deltaY > 0 ? 0.9 : 1.1)),
                ),
              }));
            }}
            onKeyDown={(event) => {
              const keys = [
                "ArrowLeft",
                "ArrowRight",
                "ArrowUp",
                "ArrowDown",
                "+",
                "=",
                "-",
              ];
              if (!keys.includes(event.key)) return;
              event.preventDefault();
              setCamera((current) => ({
                yaw:
                  current.yaw +
                  (event.key === "ArrowLeft"
                    ? -0.1
                    : event.key === "ArrowRight"
                      ? 0.1
                      : 0),
                pitch: Math.max(
                  -1.55,
                  Math.min(
                    1.55,
                    current.pitch +
                      (event.key === "ArrowUp"
                        ? -0.1
                        : event.key === "ArrowDown"
                          ? 0.1
                          : 0),
                  ),
                ),
                zoom: Math.max(
                  0.25,
                  Math.min(
                    4,
                    current.zoom *
                      (["+", "="].includes(event.key)
                        ? 1.1
                        : event.key === "-"
                          ? 0.9
                          : 1),
                  ),
                ),
              }));
            }}
          />
          <p className="research-surface-caption">
            Display only · {mesh.faces.length.toLocaleString()} faces · sampled
            Z,Y,X {mesh.display_shape.join(" × ")} · source strides{" "}
            {mesh.strides_zyx.join(", ")} · surface step {mesh.marching_step}.
            Measurements use their recorded analysis grid. Positive world axes
            are shown; drag or use arrow keys to orbit.
          </p>
        </>
      )}
    </section>
  );
}
