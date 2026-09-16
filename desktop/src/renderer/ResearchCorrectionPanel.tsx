import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ResearchDesktopApi,
  ResearchResult,
} from "../shared/research-contracts";

export type Plane = "XY" | "XZ" | "YZ";
export type Point = { u: number; v: number };
type Seed3D = { x: number; y: number; z: number };
export type CorrectionPreview =
  | {
      kind: "brush";
      radiusU: number;
      radiusV: number;
      unit: string;
      savedSeeds: Point[];
    }
  | { kind: "polygon"; savedSeeds: Point[] }
  | { kind: "seeds"; savedSeeds: Point[] }
  | {
      kind: "vertices";
      savedSeeds: Point[];
      sourceVertices: Point[];
      selectedIndex: number;
      onSelectVertex: (index: number) => void;
      onMoveVertex: (index: number, point: Point) => void;
    };
type Boundary = {
  label: number;
  plane: Plane;
  index: number;
  plane_axes_uv: [string, string];
  vertices_uv: Point[];
  world_vertices_xyz: [number, number, number][];
  geometry_sha256: string;
  distance_unit: string;
  world_frame: string;
  coordinate_convention: string;
  simplified: boolean;
};
type Info = {
  result_id: string;
  revision_hash: string;
  label_sha256: string | null;
  shape: number[];
  label_ids: number[];
  parent_id: string | null;
  measurement_channels: Array<{ index: number; name: string; basis: string }>;
  derived_measurement_arrays: string[] | null;
};

const MAX_LABEL = 0xffffffff;

function smallestUnused(labels: number[]): number | null {
  let candidate = 1;
  for (const label of [...labels].sort((a, b) => a - b)) {
    if (label < candidate) continue;
    if (label > candidate) break;
    candidate += 1;
  }
  return candidate <= MAX_LABEL ? candidate : null;
}

function normalSize(shape: number[], plane: Plane): number {
  if (shape.length === 2) return 1;
  return plane === "XY" ? shape[0] : plane === "XZ" ? shape[1] : shape[2];
}

function planeSize(shape: number[], plane: Plane): { width: number; height: number } {
  if (shape.length === 2) return { width: shape[1], height: shape[0] };
  if (plane === "XY") return { width: shape[2], height: shape[1] };
  if (plane === "XZ") return { width: shape[2], height: shape[0] };
  return { width: shape[1], height: shape[0] };
}

function pointToSeed(point: Point, plane: Plane, index: number): Seed3D {
  if (plane === "XY") return { x: point.u, y: point.v, z: index };
  if (plane === "XZ") return { x: point.u, y: index, z: point.v };
  return { x: index, y: point.u, z: point.v };
}

function seedOnPlane(seed: Seed3D, plane: Plane, index: number): Point | null {
  if (plane === "XY") return seed.z === index ? { u: seed.x, v: seed.y } : null;
  if (plane === "XZ") return seed.y === index ? { u: seed.x, v: seed.z } : null;
  return seed.x === index ? { u: seed.y, v: seed.z } : null;
}

function safeMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message
    ? error.message.replace(/\/?(?:Users|Volumes)\/[^\s]+/g, "selected source")
    : fallback;
}

function childFrom(output: unknown, parent: ResearchResult) {
  if (!output || typeof output !== "object")
    throw new Error(
      "The correction did not return an immutable child revision.",
    );
  const record = output as {
    result?: ResearchResult;
    measurements?: Array<Record<string, unknown>>;
  };
  const child = record.result;
  if (
    !child ||
    typeof child.id !== "string" ||
    child.id === parent.id ||
    child.parent_id !== parent.id ||
    child.source_id !== parent.source_id ||
    typeof child.revision_hash !== "string" ||
    child.review != null
  )
    throw new Error(
      "The correction response was not a new unreviewed child of the selected revision.",
    );
  return { result: child, measurements: record.measurements };
}

export function ResearchCorrectionPanel({
  api,
  result,
  points,
  setPoints,
  report,
  onResult,
  onUndo,
  onRedo,
  onViewChange,
  onPreviewChange,
  onMutationBusyChange,
  planeSpacing,
  viewReady,
  busy,
  canUndo,
  canRedo,
}: {
  api: ResearchDesktopApi;
  result: ResearchResult | null;
  points: Point[];
  setPoints: React.Dispatch<React.SetStateAction<Point[]>>;
  report: <T>(
    work: () => Promise<T>,
    fallback: string,
  ) => Promise<T | undefined>;
  onResult: (
    result: ResearchResult,
    measurements?: Array<Record<string, unknown>>,
  ) => Promise<boolean>;
  onUndo: () => Promise<void>;
  onRedo: () => Promise<void>;
  onViewChange: (plane: Plane, index: number) => void;
  onPreviewChange: (preview: CorrectionPreview | null) => void;
  onMutationBusyChange: (busy: boolean) => void;
  planeSpacing: { u: number; v: number; unit: string } | null;
  viewReady: boolean;
  busy: boolean;
  canUndo: boolean;
  canRedo: boolean;
}): React.JSX.Element {
  const [info, setInfo] = useState<Info | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [plane, setPlane] = useState<Plane>("XY");
  const [index, setIndex] = useState(0);
  const [label, setLabel] = useState(1);
  const [newLabel, setNewLabel] = useState(1);
  const [mergeLabels, setMergeLabels] = useState<number[]>([]);
  const [mergeTarget, setMergeTarget] = useState(1);
  const [radius, setRadius] = useState(1);
  const [tool, setTool] = useState("paint");
  const [boundary, setBoundary] = useState<Boundary | null>(null);
  const [boundaryLoading, setBoundaryLoading] = useState(false);
  const [boundaryError, setBoundaryError] = useState<string | null>(null);
  const [selectedVertex, setSelectedVertex] = useState(0);
  const [seedPoints2D, setSeedPoints2D] = useState<{
    plane: Plane;
    index: number;
    points: Point[];
  } | null>(null);
  const [seedPoints3D, setSeedPoints3D] = useState<Seed3D[]>([]);
  const [splitMode, setSplitMode] = useState<"2D" | "3D">("2D");
  const [roiId, setRoiId] = useState("roi-1");
  const [slabStart, setSlabStart] = useState(0);
  const [slabStop, setSlabStop] = useState(1);
  const [roiChannels, setRoiChannels] = useState<number[]>([0]);
  const [mutationBusy, setMutationBusy] = useState(false);
  const locked = busy || mutationBusy;

  useEffect(() => {
    let active = true;
    setPoints([]);
    setSeedPoints2D(null);
    setSeedPoints3D([]);
    setBoundary(null);
    setBoundaryError(null);
    setBoundaryLoading(false);
    setSelectedVertex(0);
    setInfo(null);
    setInfoError(null);
    setPlane("XY");
    setIndex(0);
    setSlabStart(0);
    setSlabStop(1);
    onViewChange("XY", 0);
    if (!result) return () => void (active = false);
    void api
      .execute("correction_info", {
        result_id: result.id,
        revision_hash: result.revision_hash,
      })
      .then((value) => {
        if (!active) return;
        const next = value as Info;
        if (
          next.result_id !== result.id ||
          next.revision_hash !== result.revision_hash ||
          !Array.isArray(next.shape) ||
          !Array.isArray(next.label_ids) ||
          !Array.isArray(next.measurement_channels) ||
          (next.label_sha256 !== null && typeof next.label_sha256 !== "string")
        )
          throw new Error(
            "Correction information did not match the selected exact revision.",
          );
        const existing = next.label_ids[0] ?? 1;
        setInfo(next);
        setTool(next.label_sha256 ? "paint" : "roi");
        setLabel(existing);
        setNewLabel(smallestUnused(next.label_ids) ?? 1);
        setMergeLabels(next.label_ids.slice(0, 2));
        setMergeTarget(existing);
        setRoiChannels(
          next.measurement_channels.length ? [next.measurement_channels[0].index] : [],
        );
      })
      .catch((caught) => {
        if (active)
          setInfoError(
            safeMessage(
              caught,
              "Could not bind corrections to this exact result revision.",
            ),
          );
      });
    return () => {
      active = false;
    };
  }, [
    api,
    result?.id,
    result?.revision_hash,
    onViewChange,
    setPoints,
  ]);

  const savedSeeds = useMemo(() => {
    if (splitMode === "2D")
      return seedPoints2D?.plane === plane && seedPoints2D.index === index
        ? seedPoints2D.points
        : [];
    return seedPoints3D
      .map((seed) => seedOnPlane(seed, plane, index))
      .filter((point): point is Point => point !== null);
  }, [index, plane, seedPoints2D, seedPoints3D, splitMode]);

  useEffect(() => {
    if (tool !== "vertex" || !result || !info || !viewReady) {
      setBoundary(null);
      setBoundaryError(null);
      setBoundaryLoading(false);
      return;
    }
    let active = true;
    setBoundary(null);
    setBoundaryError(null);
    setBoundaryLoading(true);
    setSelectedVertex(0);
    setPoints([]);
    void api
      .execute("correction_info", {
        result_id: result.id,
        revision_hash: result.revision_hash,
        label,
        plane,
        index,
      })
      .then((value) => {
        if (!active) return;
        const response = value as Info & { boundary?: Boundary };
        const next = response.boundary;
        if (
          response.result_id !== result.id ||
          response.revision_hash !== result.revision_hash ||
          response.label_sha256 !== info.label_sha256 ||
          !next ||
          next.label !== label ||
          next.plane !== plane ||
          next.index !== index ||
          !Array.isArray(next.vertices_uv) ||
          next.vertices_uv.length < 3 ||
          next.vertices_uv.length > 96 ||
          next.vertices_uv.some(
            (point) => !Number.isFinite(point.u) || !Number.isFinite(point.v),
          )
        )
          throw new Error(
            "Editable boundary did not match the selected exact label revision.",
          );
        setBoundary(next);
        setPoints(next.vertices_uv.map((point) => ({ ...point })));
      })
      .catch((caught) => {
        if (active)
          setBoundaryError(
            safeMessage(caught, "Could not load this label's editable boundary."),
          );
      })
      .finally(() => {
        if (active) setBoundaryLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, index, info, label, plane, result, setPoints, tool, viewReady]);

  const moveVertex = useCallback(
    (vertexIndex: number, point: Point) => {
      if (!boundary || locked || vertexIndex < 0 || vertexIndex >= boundary.vertices_uv.length)
        return;
      const size = planeSize(info?.shape ?? [], plane);
      const next = boundary.vertices_uv.map((value) => ({ ...value }));
      next[vertexIndex] = {
        u: Math.min(size.width - 1, Math.max(0, point.u)),
        v: Math.min(size.height - 1, Math.max(0, point.v)),
      };
      setSelectedVertex(vertexIndex);
      setPoints(next);
    },
    [boundary, info?.shape, locked, plane, setPoints],
  );

  useEffect(() => {
    if (!result || !info) {
      onPreviewChange(null);
      return;
    }
    if (tool === "paint" || tool === "erase")
      onPreviewChange({
        kind: "brush",
        radiusU: planeSpacing ? radius / planeSpacing.u : 0,
        radiusV: planeSpacing ? radius / planeSpacing.v : 0,
        unit: planeSpacing?.unit ?? "physical units",
        savedSeeds: [],
      });
    else if (tool === "split") onPreviewChange({ kind: "seeds", savedSeeds });
    else if (tool === "vertex" && boundary)
      onPreviewChange({
        kind: "vertices",
        savedSeeds: [],
        sourceVertices: boundary.vertices_uv,
        selectedIndex: selectedVertex,
        onSelectVertex: setSelectedVertex,
        onMoveVertex: moveVertex,
      });
    else onPreviewChange({ kind: "polygon", savedSeeds: [] });
  }, [
    boundary,
    info,
    moveVertex,
    onPreviewChange,
    planeSpacing,
    radius,
    result,
    savedSeeds,
    selectedVertex,
    tool,
  ]);

  useEffect(() => () => onPreviewChange(null), [onPreviewChange]);

  if (!result)
    return (
      <div className="research-panel">
        <h2>Corrections & ROI</h2>
        <p>Select an exact segmented result first.</p>
      </div>
    );
  if (!info)
    return (
      <div className="research-panel">
        <h2>Corrections & ROI</h2>
        {infoError ? (
          <p role="alert">{infoError}</p>
        ) : (
          <p>Loading the exact label revision…</p>
        )}
      </div>
    );

  const selected = info.label_ids.includes(label);
  const hasLabels = typeof info.label_sha256 === "string";
  const polygon = points.length >= 3;
  const movedVertices = boundary
    ? points.flatMap((point, pointIndex) => {
        const source = boundary.vertices_uv[pointIndex];
        return source && (source.u !== point.u || source.v !== point.v)
          ? [pointIndex]
          : [];
      })
    : [];
  const vertexValid =
    Boolean(boundary) &&
    points.length === boundary?.vertices_uv.length &&
    movedVertices.length === 1;
  const planeLimit = normalSize(info.shape, plane);
  const newLabelValid =
    Number.isInteger(newLabel) &&
    newLabel >= 1 &&
    newLabel <= MAX_LABEL &&
    !info.label_ids.includes(newLabel);
  const mergeValid =
    mergeLabels.length >= 2 &&
    mergeLabels.length <= 32 &&
    mergeLabels.includes(mergeTarget);
  const seeds = splitMode === "3D" ? seedPoints3D : savedSeeds;
  const splitValid = seeds.length >= 2 && seeds.length <= 32;
  const slabValid =
    Number.isInteger(slabStart) &&
    Number.isInteger(slabStop) &&
    slabStart >= 0 &&
    slabStart <= index &&
    slabStop > index &&
    slabStop <= planeLimit;

  const setMutation = (value: boolean) => {
    setMutationBusy(value);
    onMutationBusyChange(value);
  };
  const mutate = async (work: () => Promise<void>) => {
    if (locked) return;
    setMutation(true);
    try {
      await work();
    } finally {
      setMutation(false);
    }
  };
  const apply = async (operation: Record<string, unknown>) => {
    if (!info.label_sha256) return;
    const child = await report(async () => {
      const output = await api.execute("correct_result", {
        result_id: result.id,
        revision_hash: result.revision_hash,
        operations: [
          { ...operation, expected_input_sha256: info.label_sha256 },
        ],
      });
      return childFrom(output, result);
    }, "Correction could not be applied to this exact revision.");
    if (child) await onResult(child.result, child.measurements);
  };
  const planeOperation = (op: "brush" | "polygon_add" | "polygon_replace") =>
    op === "brush"
      ? {
          op,
          mode: tool === "erase" ? "erase" : "paint",
          plane,
          index,
          points,
          radius,
          label,
        }
      : {
          op,
          plane,
          index,
          points,
          label: op === "polygon_add" ? newLabel : label,
        };
  const addRoi = async () => {
    const child = await report(async () => {
      const output = await api.execute("roi_add", {
        result_id: result.id,
        revision_hash: result.revision_hash,
        roi: {
          annotation_id: roiId,
          plane,
          index,
          points,
          slab_start: slabStart,
          slab_stop_exclusive: slabStop,
        },
        measurement_channels: roiChannels,
      });
      return childFrom(output, result);
    }, "ROI could not be added to this exact revision.");
    if (child) await onResult(child.result, child.measurements);
  };
  const changePlane = (next: Plane) => {
    setPlane(next);
    setIndex(0);
    setSlabStart(0);
    setSlabStop(1);
    setPoints([]);
    if (splitMode === "2D") setSeedPoints2D(null);
    onViewChange(next, 0);
  };
  const changeIndex = (value: number) => {
    const next = Math.min(Math.max(0, Math.round(value)), planeLimit - 1);
    setIndex(next);
    setSlabStart(next);
    setSlabStop(next + 1);
    setPoints([]);
    if (splitMode === "2D") setSeedPoints2D(null);
    onViewChange(plane, next);
  };
  const changeSplitMode = (next: "2D" | "3D") => {
    setSplitMode(next);
    setPoints([]);
    setSeedPoints2D(null);
  };
  const addSeeds = () => {
    if (!points.length) return;
    if (splitMode === "3D")
      setSeedPoints3D((old) => [
        ...old,
        ...points.map((point) => pointToSeed(point, plane, index)),
      ]);
    else setSeedPoints2D({ plane, index, points });
    setPoints([]);
  };

  return (
    <div className="research-panel research-correction">
      <h2>Corrections & ROI</h2>
      <p>
        Edits create an unreviewed child revision. Canvas points are
        voxel-center coordinates on the displayed exact revision.
      </p>
      <div className="research-actions">
        <button
          disabled={locked || !canUndo}
          onClick={() => void mutate(onUndo)}
        >
          Undo revision
        </button>
        <button
          disabled={locked || !canRedo}
          onClick={() => void mutate(onRedo)}
        >
          Redo revision
        </button>
      </div>
      <div className="research-grid">
        <label>
          Plane
          <select
            aria-label="Correction plane"
            value={plane}
            disabled={locked}
            onChange={(event) => changePlane(event.target.value as Plane)}
          >
            <option>XY</option>
            <option disabled={info.shape.length < 3}>XZ</option>
            <option disabled={info.shape.length < 3}>YZ</option>
          </select>
        </label>
        <label>
          Plane index
          <input
            aria-label="Correction plane index"
            type="number"
            min="0"
            max={planeLimit - 1}
            value={index}
            disabled={locked}
            onChange={(event) => changeIndex(Number(event.target.value))}
          />
        </label>
      </div>
      <label>
        Existing target label
        <select
          aria-label="Correction label"
          value={selected ? label : ""}
          disabled={locked || !info.label_ids.length}
          onChange={(event) => setLabel(Number(event.target.value))}
        >
          {!info.label_ids.length && (
            <option value="">No existing labels</option>
          )}
          {info.label_ids.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      <label>
        Tool
        <select
          aria-label="Correction tool"
          value={tool}
          disabled={locked}
          onChange={(event) => {
            setTool(event.target.value);
            setPoints([]);
          }}
        >
            <option value="paint" disabled={!hasLabels}>Paint brush</option>
            <option value="erase" disabled={!hasLabels}>Erase brush</option>
            <option value="add" disabled={!hasLabels}>Add polygon</option>
            <option value="replace" disabled={!hasLabels}>Replace boundary polygon</option>
            <option value="vertex" disabled={!hasLabels}>Move one boundary vertex</option>
            <option value="split" disabled={!hasLabels}>Seeded watershed split</option>
          <option value="roi">Measure ROI</option>
        </select>
      </label>
      {(tool === "paint" || tool === "erase") && (
        <label>
          Physical brush radius ({planeSpacing?.unit ?? "declared unit"})
          <input
            aria-label="Physical brush radius"
            type="number"
            min="0.000001"
            step="any"
            value={radius}
            disabled={locked}
            onChange={(event) => setRadius(Number(event.target.value))}
          />
        </label>
      )}
      {tool === "add" && (
        <label>
          New unused label ID
          <input
            aria-label="New unused label ID"
            type="number"
            min="1"
            max={MAX_LABEL}
            step="1"
            value={newLabel}
            disabled={locked}
            onChange={(event) => setNewLabel(Number(event.target.value))}
          />
        </label>
      )}
      {tool === "vertex" && (
        <fieldset className="research-vertex-editor" disabled={locked}>
          <legend>Selected boundary vertex</legend>
          {boundaryLoading ? (
            <p role="status">Loading exact label boundary…</p>
          ) : boundaryError ? (
            <p role="alert">{boundaryError}</p>
          ) : boundary ? (
            <>
              <p>
                Vertex {selectedVertex + 1} of {boundary.vertices_uv.length} on {boundary.plane}{" "}
                {boundary.index}. Drag the selected handle on the image or move it one voxel.
              </p>
              {boundary.simplified && (
                <p>The displayed outer boundary is deterministically simplified to a bounded vertex set.</p>
              )}
              <div className="research-actions">
                <button
                  aria-label="Select previous boundary vertex"
                  onClick={() =>
                    setSelectedVertex(
                      (selectedVertex - 1 + boundary.vertices_uv.length) %
                        boundary.vertices_uv.length,
                    )
                  }
                >
                  Previous vertex
                </button>
                <button
                  aria-label="Select next boundary vertex"
                  onClick={() =>
                    setSelectedVertex((selectedVertex + 1) % boundary.vertices_uv.length)
                  }
                >
                  Next vertex
                </button>
                {([
                  ["left", -1, 0],
                  ["right", 1, 0],
                  ["up", 0, -1],
                  ["down", 0, 1],
                ] as const).map(([direction, du, dv]) => (
                  <button
                    key={direction}
                    aria-label={`Nudge selected vertex ${direction} one voxel`}
                    onClick={() => {
                      const current =
                        points[selectedVertex] ?? boundary.vertices_uv[selectedVertex];
                      moveVertex(selectedVertex, { u: current.u + du, v: current.v + dv });
                    }}
                  >
                    {direction[0].toUpperCase() + direction.slice(1)} 1
                  </button>
                ))}
              </div>
              <div className="research-actions">
                <button
                  onClick={() =>
                    setPoints(boundary.vertices_uv.map((point) => ({ ...point })))
                  }
                >
                  Reset boundary vertex
                </button>
                <button
                  className="vertex-commit-button"
                  disabled={!viewReady || !vertexValid}
                  onClick={() =>
                    void mutate(() =>
                      apply({
                        op: "move_boundary_vertex",
                        plane,
                        index,
                        label,
                        source_vertices: boundary.vertices_uv,
                        vertices: points,
                      }),
                    )
                  }
                >
                  Commit boundary vertex
                </button>
              </div>
            </>
          ) : null}
        </fieldset>
      )}
      <div className="research-actions">
        <button
          disabled={locked || !points.length}
          onClick={() => setPoints([])}
        >
          Clear drawn points
        </button>
        {(tool === "paint" || tool === "erase") && (
          <button
            disabled={
              locked || !viewReady || !points.length || !selected || radius <= 0
            }
            onClick={() => void mutate(() => apply(planeOperation("brush")))}
          >
            Commit brush
          </button>
        )}
        {tool === "add" && (
          <button
            disabled={locked || !hasLabels || !viewReady || !polygon || !newLabelValid}
            onClick={() =>
              void mutate(() => apply(planeOperation("polygon_add")))
            }
          >
            Commit add polygon
          </button>
        )}
        {tool === "replace" && (
          <button
            disabled={locked || !viewReady || !polygon || !selected}
            onClick={() =>
              void mutate(() => apply(planeOperation("polygon_replace")))
            }
          >
            Commit boundary polygon
          </button>
        )}
      </div>

      <h3>Whole-label operations</h3>
      <button
        disabled={locked || !hasLabels || !selected}
        onClick={() => void mutate(() => apply({ op: "delete", label }))}
      >
        Delete selected label
      </button>
      <fieldset disabled={locked || !hasLabels}>
        <legend>Merge labels</legend>
        <div className="research-label-list">
          {info.label_ids.map((value) => (
            <label className="research-check" key={value}>
              <input
                type="checkbox"
                aria-label={`Merge label ${value}`}
                checked={mergeLabels.includes(value)}
                onChange={(event) => {
                  const next = event.target.checked
                    ? [...mergeLabels, value]
                    : mergeLabels.filter((item) => item !== value);
                  setMergeLabels(next);
                  if (!next.includes(mergeTarget)) setMergeTarget(next[0] ?? 1);
                }}
              />
              Label {value}
            </label>
          ))}
        </div>
        <label>
          Retained merge label
          <select
            aria-label="Retained merge label"
            value={mergeLabels.includes(mergeTarget) ? mergeTarget : ""}
            onChange={(event) => setMergeTarget(Number(event.target.value))}
          >
            {!mergeLabels.length && (
              <option value="">Select merge labels</option>
            )}
            {mergeLabels.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <button
          disabled={!mergeValid}
          onClick={() =>
            void mutate(() =>
              apply({
                op: "merge",
                source_labels: mergeLabels,
                target_label: mergeTarget,
              }),
            )
          }
        >
          Merge selected labels
        </button>
      </fieldset>

      {tool === "split" && (
        <fieldset disabled={locked}>
          <legend>Watershed seeds</legend>
          <label>
            Split mode
            <select
              aria-label="Split mode"
              value={splitMode}
              onChange={(event) =>
                changeSplitMode(event.target.value as "2D" | "3D")
              }
            >
              <option value="2D">2D selected plane</option>
              <option value="3D" disabled={info.shape.length < 3}>
                3D ZYX across planes
              </option>
            </select>
          </label>
          <div className="research-actions">
            <button
              disabled={!points.length || seeds.length + points.length > 32}
              onClick={addSeeds}
            >
              {splitMode === "3D" ? "Add drawn 3D seeds" : "Use drawn 2D seeds"}
            </button>
            <button
              disabled={!seeds.length}
              onClick={() => {
                setSeedPoints2D(null);
                setSeedPoints3D([]);
              }}
            >
              Clear saved seeds
            </button>
            <button
              disabled={!viewReady || !selected || !splitValid}
              onClick={() =>
                void mutate(() =>
                  apply(
                    splitMode === "3D"
                      ? {
                          op: "watershed_split",
                          label,
                          mode: "3D",
                          seeds: seedPoints3D,
                        }
                      : {
                          op: "watershed_split",
                          label,
                          mode: "2D",
                          plane,
                          index,
                          seeds: savedSeeds,
                        },
                  ),
                )
              }
            >
              Commit seeded split
            </button>
          </div>
          <p>
            {seeds.length} saved {splitMode === "3D" ? "XYZ" : "plane"} seeds;
            draw voxel centers on the current exact plane.
          </p>
        </fieldset>
      )}

      {tool === "roi" && (
        <>
          <h3>Polygon ROI</h3>
          <label>
            ROI ID
            <input
              aria-label="ROI ID"
              value={roiId}
              disabled={locked}
              onChange={(event) => setRoiId(event.target.value)}
            />
          </label>
          <div className="research-grid">
            <label>
              Slab start
              <input
                aria-label="ROI slab start"
                type="number"
                min="0"
                max={index}
                value={slabStart}
                disabled={locked}
                onChange={(event) => setSlabStart(Number(event.target.value))}
              />
            </label>
            <label>
              Slab stop exclusive
              <input
                aria-label="ROI slab stop"
                type="number"
                min={index + 1}
                max={planeLimit}
                value={slabStop}
                disabled={locked}
                onChange={(event) => setSlabStop(Number(event.target.value))}
              />
            </label>
          </div>
          <fieldset disabled={locked}>
            <legend>Exact result measurement values (up to 16)</legend>
            <div className="research-label-list">
              {info.measurement_channels.slice(0, 16).map((channel) => (
                  <label className="research-check" key={channel.index}>
                    <input
                      type="checkbox"
                      aria-label={`Measure ${channel.name}`}
                      checked={roiChannels.includes(channel.index)}
                      onChange={(event) =>
                        setRoiChannels((old) =>
                          event.target.checked
                            ? [...old, channel.index].sort((a, b) => a - b)
                            : old.filter((value) => value !== channel.index),
                        )
                      }
                    />
                    {channel.name}
                  </label>
                ))}
            </div>
          </fieldset>
          {info.measurement_channels[0] && (
            <p className="research-derived-notice">
              Measurement basis: {info.measurement_channels[0].basis}. ROI statistics
              remain bound to these exact result values.
            </p>
          )}
          <button
            disabled={
              locked ||
              !viewReady ||
              !polygon ||
              !roiId.trim() ||
              !slabValid ||
              !roiChannels.length
            }
            onClick={() => void mutate(addRoi)}
          >
            Add measured ROI
          </button>
        </>
      )}
      {!viewReady && <p role="status">Loading the selected exact plane…</p>}
      <p>
        {info.label_sha256
          ? `Exact label SHA-256: ${info.label_sha256.slice(0, 12)}…`
          : "No label array: ROI measurement only"}{" "}
        · {points.length} drawn points
      </p>
    </div>
  );
}
