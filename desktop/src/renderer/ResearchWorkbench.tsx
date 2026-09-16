import { ResearchAdaptivePanel, type ResearchAdaptiveBatchConfiguration } from "./ResearchAdaptivePanel";
import { WorkspaceRecordActions } from "./WorkspaceRecordActions";
import {
  ChevronLeft,
  FolderOpen,
  GripVertical,
  ImagePlus,
  Lightbulb,
  Play,
  Plus,
  Save,
  Settings2,
  SlidersHorizontal,
  Trash2,
  Box,
  Activity,
  X,
  LoaderCircle,
  Clock3,
  CheckCircle2,
  XCircle,
  Ban,
  Laptop,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, memo } from "react";
import { flushSync } from "react-dom";
import { InspectorResizeHandle, loadInspectorWidth } from "./InspectorResizeHandle";
import { rawVolumeUnavailableReason } from "./raw-volume-eligibility";
import type {
  ResearchDesktopApi,
  BatchChannelColorsResponse,
  ResearchBatchReceipt,
  ResearchBatchTask,
  ResearchJob,
  ResearchRecipe,
  ResearchResult,
  ResearchSampleData,
  ResearchSelection,
  ResearchSnapshot,
  ResearchSource,
  ResearchWorkspaceChange,
  ManagedSessionState,
} from "../shared/research-contracts";
import "./ResearchWorkbench.css";
import {
  ResearchCorrectionPanel,
  type CorrectionPreview,
  type Plane,
  type Point,
} from "./ResearchCorrectionPanel";
import { ResearchRegistrationPanel } from "./ResearchRegistrationPanel";
import { ResearchQuantificationPanel } from "./ResearchQuantificationPanel";
import { ResearchAgentPanel } from "./ResearchAgentPanel";
import { ResearchPortabilityPanel } from "./ResearchPortabilityPanel";
import { ResearchVendorPanel } from "./ResearchVendorPanel";
import { ResearchRemotePanel } from "./ResearchRemotePanel";
import { ResearchSurfaceView } from "./ResearchSurfaceView";
import { ResearchTemporalPanel } from "./ResearchTemporalPanel";
import {
  clampNativeSelection,
  maxNativeViewPixels,
} from "./ResearchNativeViewport";
import { ResearchHistologyPanel } from "./ResearchHistologyPanel";
import { ImageViewport, type ImageAnnotation, type ImagePoint, type ViewerChannel } from "./ImageViewport";
import { resolveResultPlaneOverlay, resultPixelToSourcePoint, sourcePointToResultPixel } from "./result-plane-overlay";
import { SourceAnnotationPanel, type AnnotationTool } from "./SourceAnnotationPanel";
import { ImageWelcome, WorkbenchTools, type WorkbenchTab } from "./WorkbenchChrome";
import { RawVolumeViewport, type RawVolumeResponse, type RawVolumeRefinementRequest } from "./RawVolumeViewport";
import BrandMark from "./BrandMark";
import { SourceDisplayPanel, type SourceInterpretation } from "./SourceDisplayPanel";
import { SourceExportPanel } from "./SourceExportPanel";
import { SourceViewStore, type SavedSourceView } from "./source-view-store";
import type { Camera } from "./viewer-camera";
import { ContextHelp, ResearchError } from "./ContextHelp";
import { DEFAULT_PREFERENCES, type UserPreferences } from "./preferences";
import {
  ResearchCellposePanel,
  type ResearchCellposeBatchConfiguration,
} from "./ResearchCellposePanel";

type Props = {
  preferences?: UserPreferences;
  api: ResearchDesktopApi;
  onBack: () => void;
  onOpenSettings?: () => void;
  onSourcesReorder?: (sources: ResearchSource[]) => void;
};
type Tab = WorkbenchTab;
type Channel = ViewerChannel;
type Volume = {
  shape: [number, number, number];
  planes: Record<"xy" | "xz" | "yz", string>;
  crosshair: [number, number, number];
  world_xyz: number[];
  value: number;
};
type ResultGeometry = {
  axes: string;
  affine: number[][];
  unit: string;
  frame?: string;
};
type ResultView = {
  image: string;
  shape: number[];
  resultId: string;
  revisionHash: string;
  axis: "x" | "y" | "z";
  index: number;
  geometry: ResultGeometry;
};
const DEFAULT_SELECTION: ResearchSelection = {
  x: 0,
  y: 0,
  width: 512,
  height: 512,
  t: 0,
  c: 0,
  z: 0,
  level: 0,
};
const DEFAULT_RECIPE: ResearchRecipe = {
  steps: [] as Array<Record<string, unknown>>,
  segmentation: {
    method: "components",
    threshold: 0,
    polarity: "bright",
    min_size: 10,
    exclude_border: false,
  },
  measurement_channels: [0],
  gates: [],
  working_bytes: 268435456,
};
const WORKING_BYTES = [
  512 * 1024 ** 2,
  1024 ** 3,
  2 * 1024 ** 3,
  4 * 1024 ** 3,
];
type PendingModelPreview = { id: string; sha256: string; overlay: string };
type ModelRecord = Record<string, unknown>;
type StudyComparisonGroup = {
  bindings: Array<{
    result_id: string;
    revision_hash: string;
    source_id: string;
    source_sha256: string;
    review: { disposition: string };
    scope?: {
      selection: Record<string, unknown> | null;
      geometry: Record<string, unknown>;
    };
  }>;
};
type StudyComparisonReceipt = {
  schema: "loci.study-run-comparison/v1";
  value: string;
  unit: string | null;
  method: string | null;
  run_scope: string | null;
  independent_n_basis: string;
  left: StudyComparisonGroup;
  right: StudyComparisonGroup;
  comparisons: Array<{
    condition: string;
    left_mean: number | null;
    right_mean: number | null;
    difference: number | null;
    left_n_biological_replicates: number;
    right_n_biological_replicates: number;
  }>;
  p_values: null;
  interpretation: string;
  receipt_sha256: string;
  comparison_document?: { id: string; revision: number };
};

function savedStudyComparison(snapshot: ResearchSnapshot): StudyComparisonReceipt | null {
  const documents = [...(snapshot.comparisons ?? [])].sort((left, right) =>
    left.updated_at.localeCompare(right.updated_at),
  );
  const document = documents.at(-1);
  const data = document?.data;
  const receipt =
    data && typeof data.receipt === "object" && data.receipt !== null
      ? (data.receipt as Partial<StudyComparisonReceipt>)
      : null;
  return receipt?.schema === "loci.study-run-comparison/v1" &&
    Array.isArray(receipt.left?.bindings) &&
    Array.isArray(receipt.right?.bindings) &&
    Array.isArray(receipt.comparisons) &&
    typeof receipt.receipt_sha256 === "string"
    ? {
        ...(receipt as StudyComparisonReceipt),
        comparison_document: document
          ? { id: document.id, revision: document.revision }
          : undefined,
      }
    : null;
}

function message(error: unknown, fallback: string): string {
  const value = error instanceof Error ? error.message : typeof error === "string" ? error : fallback;
  return value.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "")
    .replace(/\/?(?:Users|Volumes)\/[^\s]+/g, "selected source").slice(0, 1000);
}
function meta(source: ResearchSource) {
  const value = source.metadata ?? {};
  const shape = value.shape ?? [];
  return {
    ...value,
    dimensions: value.dimensions ?? {
      t: 1,
      c: 1,
      z: shape.length === 3 ? shape[0] : 1,
      y: shape.at(-2) ?? 1,
      x: shape.at(-1) ?? 1,
    },
  };
}
function clamp(
  value: ResearchSelection,
  d: { t: number; c: number; z: number; y: number; x: number },
): ResearchSelection {
  const x = Math.min(Math.max(0, Math.round(value.x)), d.x - 1),
    y = Math.min(Math.max(0, Math.round(value.y)), d.y - 1),
    z = Math.min(Math.max(0, value.z), d.z - 1),
    zStop =
      value.z_stop === undefined
        ? undefined
        : Math.min(d.z, Math.max(z + 1, Math.round(value.z_stop)));
  return {
    ...value,
    x,
    y,
    c: Math.min(Math.max(0, value.c), d.c - 1),
    z,
    t: Math.min(Math.max(0, value.t), d.t - 1),
    width: Math.max(1, Math.min(value.width, d.x - x)),
    height: Math.max(1, Math.min(value.height, d.y - y)),
    ...(zStop === undefined ? {} : { z_stop: zStop }),
  };
}

type ComparisonPaneView = {
  sourceId: string;
  sourceSha256: string;
  selection: ResearchSelection;
  channels: Channel[];
  initialCamera: Camera | null;
  loading: boolean;
};

function comparisonSelection(source: ResearchSource): ResearchSelection {
  const dimensions = meta(source).dimensions;
  return {
    ...DEFAULT_SELECTION,
    width: dimensions.x,
    height: dimensions.y,
    z: Math.floor(dimensions.z / 2),
  };
}

function comparisonChannels(value: unknown, source: ResearchSource): Channel[] {
  const dimensions = meta(source).dimensions;
  if (!Array.isArray(value) || value.length < 1 || value.some((item) => {
    if (!item || typeof item !== "object") return true;
    const channel = item as Partial<Channel>;
    return !Number.isInteger(channel.channel) || channel.channel! < 0 || channel.channel! >= dimensions.c ||
      typeof channel.low !== "number" || !Number.isFinite(channel.low) ||
      typeof channel.high !== "number" || !Number.isFinite(channel.high) || channel.high <= channel.low ||
      typeof channel.gamma !== "number" || !Number.isFinite(channel.gamma) ||
      typeof channel.visible !== "boolean" || typeof channel.color !== "string";
  })) throw new Error("Comparison display settings do not match this source's channels.");
  return value.map((item) => ({ ...(item as Channel) }));
}

function comparisonCamera(value: unknown): Camera | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object") throw new Error("Comparison camera is invalid.");
  const camera = value as Partial<Camera>;
  if (![camera.x, camera.y, camera.scale].every((item) => typeof item === "number" && Number.isFinite(item)) ||
    camera.scale! <= 0) throw new Error("Comparison camera is invalid.");
  return { x: camera.x!, y: camera.y!, scale: camera.scale! };
}

function useComparisonPane(
  api: ResearchDesktopApi,
  source: ResearchSource,
  onError: (value: string) => void,
) {
  const token = useRef(0);
  const dimensions = useMemo(() => meta(source).dimensions, [source.id, source.sha256]);
  const [view, setView] = useState<ComparisonPaneView>(() => ({
    sourceId: source.id,
    sourceSha256: source.sha256,
    selection: comparisonSelection(source),
    channels: [],
    initialCamera: null,
    loading: true,
  }));

  useEffect(() => {
    const currentToken = ++token.current;
    setView({
      sourceId: source.id,
      sourceSha256: source.sha256,
      selection: comparisonSelection(source),
      channels: [],
      initialCamera: null,
      loading: true,
    });
    void Promise.all([
      api.execute("viewer_defaults", { source_id: source.id, t: 0, z: 0, auto: false }),
      api.execute("source_view", { source_id: source.id }),
    ]).then(([defaultsValue, savedValue]) => {
      if (token.current !== currentToken) return;
      const defaults = defaultsValue as {
        source_id?: string;
        source_sha256?: string;
        channels?: unknown;
      };
      const saved = savedValue as Partial<SavedSourceView>;
      if (defaults.source_id !== source.id || defaults.source_sha256 !== source.sha256)
        throw new Error("Comparison defaults do not match the selected source.");
      if (saved.source_id !== source.id || saved.source_sha256 !== source.sha256 || !Number.isInteger(saved.revision))
        throw new Error("Saved comparison display does not match the selected source.");
      const channels = comparisonChannels(saved.state?.channels ?? defaults.channels, source);
      const selection = clamp(saved.state?.selection ?? comparisonSelection(source), dimensions);
      const initialCamera = comparisonCamera(saved.state?.camera);
      setView({
        sourceId: source.id,
        sourceSha256: source.sha256,
        selection,
        channels,
        initialCamera,
        loading: false,
      });
    }).catch((caught) => {
      if (token.current !== currentToken) return;
      setView((previous) => ({ ...previous, loading: false }));
      onError(message(caught, "Could not prepare the comparison display."));
    });
    return () => { if (token.current === currentToken) token.current++; };
  }, [api, dimensions, onError, source.id, source.sha256]);

  const ready = view.sourceId === source.id && view.sourceSha256 === source.sha256 &&
    !view.loading && view.channels.length > 0;
  const setSelection = useCallback((selection: ResearchSelection) => {
    setView((previous) => previous.sourceId === source.id && previous.sourceSha256 === source.sha256
      ? { ...previous, selection: clamp(selection, dimensions) }
      : previous);
  }, [dimensions, source.id, source.sha256]);
  const setChannels = useCallback((channels: Channel[]) => {
    setView((previous) => previous.sourceId === source.id && previous.sourceSha256 === source.sha256
      ? { ...previous, channels }
      : previous);
  }, [source.id, source.sha256]);
  return { ...view, ready, setSelection, setChannels };
}

function displayMatchCompatibility(
  sourceA: ResearchSource,
  sourceB: ResearchSource,
  channelsA: Channel[],
  channelsB: Channel[],
): { compatible: true } | { compatible: false; reason: string } {
  const dimensionsA = meta(sourceA).dimensions;
  const dimensionsB = meta(sourceB).dimensions;
  if (dimensionsA.c !== dimensionsB.c)
    return { compatible: false, reason: "source channel counts differ" };
  const semanticsA = sourceA.metadata.sample_semantics ?? "none";
  const semanticsB = sourceB.metadata.sample_semantics ?? "none";
  if (semanticsA !== semanticsB)
    return { compatible: false, reason: "sample layouts differ" };
  const namesA = sourceA.metadata.channel_names;
  const namesB = sourceB.metadata.channel_names;
  if (Boolean(namesA) !== Boolean(namesB) || namesA?.length !== namesB?.length ||
    namesA?.some((name, index) => name !== namesB?.[index]))
    return { compatible: false, reason: "declared channel mappings differ" };
  const dtypesA = sourceA.metadata.channel_dtypes;
  const dtypesB = sourceB.metadata.channel_dtypes;
  if (Boolean(dtypesA) !== Boolean(dtypesB) || dtypesA?.length !== dtypesB?.length ||
    dtypesA?.some((dtype, index) => dtype !== dtypesB?.[index]))
    return { compatible: false, reason: "channel data types differ" };
  const indicesA = channelsA.map((item) => item.channel).sort((left, right) => left - right);
  const indicesB = channelsB.map((item) => item.channel).sort((left, right) => left - right);
  if (indicesA.length !== indicesB.length || indicesA.some((value, index) => value !== indicesB[index]))
    return { compatible: false, reason: "display channel mappings differ" };
  return { compatible: true };
}

function ComparisonPane({
  label,
  api,
  source,
  pane,
  preferences,
  controlledCamera,
  onCamera,
  onError,
}: {
  label: "A" | "B";
  api: ResearchDesktopApi;
  source: ResearchSource;
  pane: ReturnType<typeof useComparisonPane>;
  preferences: UserPreferences;
  controlledCamera: Camera | null;
  onCamera: (camera: Camera) => void;
  onError: (value: string) => void;
}) {
  const dimensions = meta(source).dimensions;
  const visible = pane.channels.filter((item) => item.visible).map((item) => item.channel);
  const channelMode = visible.length === 1
    ? String(visible[0])
    : visible.length === pane.channels.length
      ? "all"
      : "custom";
  return <div className="research-ab-pane">
    <div className="research-ab-header">
      <strong>Pane {label}</strong>
      <span>{source.name}</span>
      <div className="research-ab-plane-controls" aria-label={`Pane ${label} plane controls`}>
        {dimensions.t > 1 && <label>
          T
          <input aria-label={`Pane ${label} time`} type="number" min={1} max={dimensions.t}
            value={pane.selection.t + 1} disabled={dimensions.t <= 1 || !pane.ready}
            onChange={(event) => pane.setSelection({ ...pane.selection, t: Number(event.target.value) - 1 })} />
        </label>}
        {dimensions.z > 1 && <label>
          Z
          <input aria-label={`Pane ${label} Z`} type="number" min={1} max={dimensions.z}
            value={pane.selection.z + 1} disabled={dimensions.z <= 1 || !pane.ready}
            onChange={(event) => pane.setSelection({ ...pane.selection, z: Number(event.target.value) - 1 })} />
        </label>}
        <label>
          View
          <select aria-label={`Pane ${label} channel view`} value={channelMode} disabled={!pane.ready}
            onChange={(event) => {
              if (event.target.value === "all") {
                pane.setChannels(pane.channels.map((item) => ({ ...item, visible: true })));
                return;
              }
              const selected = Number(event.target.value);
              pane.setChannels(pane.channels.map((item) => ({ ...item, visible: item.channel === selected })));
              pane.setSelection({ ...pane.selection, c: selected });
            }}>
            {channelMode === "custom" && <option value="custom" disabled>Custom</option>}
            <option value="all">All visible</option>
            {pane.channels.map((item) => <option key={item.channel} value={item.channel}>
              {source.metadata.channel_names?.[item.channel] ?? `Channel ${item.channel + 1}`}
            </option>)}
          </select>
        </label>
      </div>
    </div>
    <div className="research-ab-viewport">
      {pane.ready ? <ImageViewport
        showScaleBar={preferences.viewer.showScaleBar}
        showNavigator={preferences.viewer.showNavigator}
        api={api}
        source={source}
        selection={pane.selection}
        channels={pane.channels}
        projection="plane"
        initialCamera={pane.initialCamera}
        controlledCamera={controlledCamera}
        onCamera={onCamera}
        onError={onError}
        requestLane={`comparison-${label.toLowerCase()}`}
      /> : <p role="status" className="research-ab-loading">Preparing {source.name}…</p>}
    </div>
  </div>;
}

function ResearchAbComparison({
  api,
  sources,
  initialSourceId,
  preferences,
  onExit,
  onError,
}: {
  api: ResearchDesktopApi;
  sources: ResearchSource[];
  initialSourceId: string;
  preferences: UserPreferences;
  onExit: () => void;
  onError: (value: string) => void;
}) {
  const firstId = sources.some((item) => item.id === initialSourceId) ? initialSourceId : sources[0].id;
  const [sourceAId, setSourceAId] = useState(firstId);
  const [sourceBId, setSourceBId] = useState(sources.find((item) => item.id !== firstId)?.id ?? firstId);
  const sourceA = sources.find((item) => item.id === sourceAId) ?? sources[0];
  const sourceB = sources.find((item) => item.id === sourceBId) ?? sourceA;
  const paneA = useComparisonPane(api, sourceA, onError);
  const paneB = useComparisonPane(api, sourceB, onError);
  const [linkPanZoom, setLinkPanZoom] = useState(false);
  const linkPanZoomRef = useRef(false);
  linkPanZoomRef.current = linkPanZoom;
  const [linkedCamera, setLinkedCamera] = useState<Camera | null>(null);
  const [cameraA, setCameraA] = useState<Camera | null>(null);
  const [cameraB, setCameraB] = useState<Camera | null>(null);
  const [matchNotice, setMatchNotice] = useState<string | null>(null);
  const exactCoordinateBasis = sourceA.id === sourceB.id && sourceA.sha256 === sourceB.sha256;
  const match = displayMatchCompatibility(sourceA, sourceB, paneA.channels, paneB.channels);

  useEffect(() => {
    if (exactCoordinateBasis) return;
    setLinkPanZoom(false);
    setLinkedCamera(null);
  }, [exactCoordinateBasis]);
  useEffect(() => { setMatchNotice(null); }, [sourceA.id, sourceA.sha256, sourceB.id, sourceB.sha256]);

  const publishLinkedCamera = useCallback((camera: Camera) => {
    setLinkedCamera((previous) => previous && previous.x === camera.x && previous.y === camera.y &&
      previous.scale === camera.scale ? previous : camera);
  }, []);

  const onCameraA = useCallback((camera: Camera) => {
    setCameraA(camera);
    if (linkPanZoomRef.current) publishLinkedCamera(camera);
  }, [publishLinkedCamera]);
  const onCameraB = useCallback((camera: Camera) => {
    setCameraB(camera);
    if (linkPanZoomRef.current) publishLinkedCamera(camera);
  }, [publishLinkedCamera]);
  const matchDisplaySettings = () => {
    if (!match.compatible) return;
    const byIndex = new Map(paneA.channels.map((item) => [item.channel, item]));
    paneB.setChannels(paneB.channels.map((item) => {
      const source = byIndex.get(item.channel)!;
      return { ...item, low: source.low, high: source.high, gamma: source.gamma,
        color: source.color, opacity: source.opacity, visible: source.visible };
    }));
    setMatchNotice("Display settings matched (A → B). Raw pixel values remain unchanged.");
  };

  return <div className="research-ab-comparison">
    <div className="research-ab-toolbar" aria-label="A/B image comparison toolbar">
      <strong>A/B Visual Comparison</strong>
      <label>
        Pane A:
        <select aria-label="Pinned Source A" value={sourceA.id} onChange={(event) => setSourceAId(event.target.value)}>
          {sources.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>
      <label>
        Pane B:
        <select aria-label="Pinned Source B" value={sourceB.id} onChange={(event) => setSourceBId(event.target.value)}>
          {sources.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>
      <button type="button" onClick={matchDisplaySettings} disabled={!paneA.ready || !paneB.ready || !match.compatible}
        title={match.compatible
          ? "Copy verified channel display settings from A to B; source pixels remain unchanged"
          : `Unavailable: ${match.reason}`}>
        Match display (A &rarr; B)
      </button>
      <label className="research-check" title={exactCoordinateBasis
        ? "Synchronize pan and zoom for the same immutable source"
        : "Disabled: no verified coordinate transform connects these sources"}>
        <input type="checkbox" aria-label="Link pan and zoom"
          disabled={!exactCoordinateBasis || !paneA.ready || !paneB.ready}
          checked={linkPanZoom && exactCoordinateBasis}
          onChange={(event) => {
            const checked = event.target.checked;
            setLinkPanZoom(checked);
            linkPanZoomRef.current = checked;
            setLinkedCamera(checked ? cameraA ?? paneA.initialCamera ?? cameraB ?? paneB.initialCamera : null);
          }} />
        Link pan/zoom ({exactCoordinateBasis ? "Exact source" : "No verified transform"})
      </label>
      <button type="button" onClick={onExit} className="research-ab-exit">Exit A/B</button>
    </div>
    {matchNotice && <div role="status" className="research-ab-notice">{matchNotice}</div>}
    <div className="research-ab-container">
      <ComparisonPane label="A" api={api} source={sourceA} pane={paneA} preferences={preferences}
        controlledCamera={linkPanZoom ? linkedCamera : null} onCamera={onCameraA} onError={onError} />
      <ComparisonPane label="B" api={api} source={sourceB} pane={paneB} preferences={preferences}
        controlledCamera={linkPanZoom ? linkedCamera : null} onCamera={onCameraB} onError={onError} />
    </div>
  </div>;
}

function planeAxis(plane: Plane): "x" | "y" | "z" {
  return plane === "XY" ? "z" : plane === "XZ" ? "y" : "x";
}

function planeDimensions(shape: number[], plane: Plane) {
  if (shape.length === 2)
    return { width: shape[1] ?? 0, height: shape[0] ?? 0 };
  return plane === "XY"
    ? { width: shape[2] ?? 0, height: shape[1] ?? 0 }
    : plane === "XZ"
      ? { width: shape[2] ?? 0, height: shape[0] ?? 0 }
      : { width: shape[1] ?? 0, height: shape[0] ?? 0 };
}

function planeSpacing(geometry: ResultGeometry | null, plane: Plane) {
  const basis = geometry?.affine;
  if (!basis || basis.length < 3 || basis.some((row) => row.length < 3))
    return null;
  const length = (column: number) =>
    Math.hypot(basis[0][column], basis[1][column], basis[2][column]);
  const x = length(0),
    y = length(1),
    z = length(2);
  const [u, v] = plane === "XY" ? [x, y] : plane === "XZ" ? [x, z] : [y, z];
  return Number.isFinite(u) && Number.isFinite(v) && u > 0 && v > 0
    ? { u, v, unit: geometry?.unit ?? "physical units" }
    : null;
}

function exactResultView(
  value: unknown,
  result: ResearchResult,
  axis?: "x" | "y" | "z",
  index?: number,
): ResultView {
  if (!value || typeof value !== "object")
    throw new Error("The engine did not return an exact result view.");
  const view = value as {
    image?: unknown;
    shape?: unknown;
    result_id?: unknown;
    revision_hash?: unknown;
    axis?: unknown;
    index?: unknown;
    geometry?: unknown;
  };
  const geometry = view.geometry as ResultGeometry | undefined;
  if (
    typeof view.image !== "string" ||
    !Array.isArray(view.shape) ||
    !view.shape.every((size) => Number.isSafeInteger(size) && size > 0) ||
    view.result_id !== result.id ||
    view.revision_hash !== result.revision_hash ||
    !["x", "y", "z"].includes(String(view.axis)) ||
    !Number.isSafeInteger(view.index) ||
    !geometry ||
    !Array.isArray(geometry.affine)
  )
    throw new Error(
      "The rendered plane did not match the selected exact revision.",
    );
  if (
    (axis !== undefined && view.axis !== axis) ||
    (index !== undefined && view.index !== index)
  )
    throw new Error(
      "The rendered plane did not match the requested axis and index.",
    );
  return {
    image: view.image,
    shape: view.shape as number[],
    resultId: result.id,
    revisionHash: result.revision_hash,
    axis: view.axis as "x" | "y" | "z",
    index: view.index as number,
    geometry,
  };
}

function centroidOnView(
  center: unknown,
  view: ResultView | null,
): Point | null {
  if (
    !view ||
    !Array.isArray(center) ||
    !center.every((value) => typeof value === "number")
  )
    return null;
  if (center.length === 2 && view.axis === "z" && view.index === 0)
    return { u: center[1], v: center[0] };
  if (center.length !== 3) return null;
  if (view.axis === "z" && Math.round(center[0]) === view.index)
    return { u: center[2], v: center[1] };
  if (view.axis === "y" && Math.round(center[1]) === view.index)
    return { u: center[2], v: center[0] };
  if (view.axis === "x" && Math.round(center[2]) === view.index)
    return { u: center[1], v: center[0] };
  return null;
}

export function findNearestObject(
  clickUV: { u: number; v: number },
  objectRows: Array<Record<string, unknown>>,
  view: ResultView | null,
  maxDistance = 25,
): number | null {
  let closestIndex: number | null = null;
  let minDistanceSq = Infinity;

  for (let i = 0; i < objectRows.length; i++) {
    const row = objectRows[i];
    const center = row?.centroid_index;
    const uv = centroidOnView(center, view);
    if (!uv) continue;

    const area = typeof row?.area === "number" && Number.isFinite(row.area) && row.area > 0 ? row.area : 0;
    const effectiveRadius = area > 0 ? Math.max(maxDistance, Math.sqrt(area / Math.PI)) : maxDistance;

    // Fast bounding box rejection
    const du = Math.abs(uv.u - clickUV.u);
    if (du > effectiveRadius) continue;
    const dv = Math.abs(uv.v - clickUV.v);
    if (dv > effectiveRadius) continue;

    const distSq = du * du + dv * dv;
    const allowedDistSq = effectiveRadius * effectiveRadius;

    if (distSq <= allowedDistSq && distSq < minDistanceSq) {
      minDistanceSq = distSq;
      closestIndex = i;
    }
  }
  return closestIndex;
}

interface SourceListItemProps {
  item: ResearchSource;
  index: number;
  isSelected: boolean;
  isActive: boolean;
  isGhost: boolean;
  isDropped: boolean;
  shiftY: number;
  isDraggingAny: boolean;
  dimensions: { c: number; z: number };
  onClick: (item: ResearchSource, event: React.MouseEvent) => void;
  onPointerDown: (item: ResearchSource, event: React.PointerEvent) => void;
  onKeyDown: (item: ResearchSource, index: number, event: React.KeyboardEvent) => void;
}

const SourceListItem = memo(function SourceListItem({
  item,
  index,
  isSelected,
  isActive,
  isGhost,
  isDropped,
  shiftY,
  isDraggingAny,
  dimensions,
  onClick,
  onPointerDown,
  onKeyDown,
}: SourceListItemProps) {
  const classList: string[] = [];
  if (isSelected) classList.push("selected");
  if (isActive) classList.push("active");
  const classNames = classList.join(" ");

  return (
    <button
      key={item.id}
      data-source-id={item.id}
      className={`research-source-item ${classNames} ${isGhost ? "is-ghost" : ""} ${isDropped ? "is-dropped" : ""}`}
      aria-selected={isSelected}
      aria-current={isActive ? "true" : undefined}
      title={item.name}
      style={{
        transform: shiftY ? `translateY(${shiftY}px)` : undefined,
        transition: isDraggingAny ? "transform 180ms cubic-bezier(0.2, 0, 0, 1)" : undefined,
      }}
      onPointerDown={(e) => onPointerDown(item, e)}
      onClick={(e) => onClick(item, e)}
      onKeyDown={(e) => onKeyDown(item, index, e)}
    >
      <span className="research-source-drag-handle" aria-hidden="true" title="Drag to reorder">
        <GripVertical size={13} />
      </span>
      <div className="research-source-item-content">
        <div className="research-source-name-row">
          <span className="research-source-name">{item.name}</span>
          {isActive && <span className="research-source-viewing-pill">Viewing</span>}
        </div>
        <small>
          {dimensions.c} C / {dimensions.z} Z
        </small>
      </div>
    </button>
  );
});

export default function ResearchWorkbench({
  api: desktopApi,
  onBack,
  onOpenSettings,
  onSourcesReorder,
  preferences = DEFAULT_PREFERENCES,
}: Props): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<ResearchSnapshot | null>(null);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("Display");
  const [selection, setSelection] = useState(DEFAULT_SELECTION);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [image, setImage] = useState<string | null>(null);
  const [volume, setVolume] = useState<Volume | null>(null);
  const [projection, setProjection] = useState<"plane" | "max" | "mean">(
    "plane",
  );
  const [recipe, setRecipe] = useState(DEFAULT_RECIPE);
  const [segmentationFamily, setSegmentationFamily] = useState<"classical" | "stain" | "adaptive" | "cellpose-sam" | "cellpose-sam-v2">("classical");
  const [adaptiveBatchConfiguration, setAdaptiveBatchConfiguration] = useState<ResearchAdaptiveBatchConfiguration | null>(null);
  const [resultId, setResultId] = useState<string | null>(null);
  const [resultView, setResultView] = useState<ResultView | null>(null);
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
  const [selectedRow, setSelectedRow] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [models, setModels] = useState<ModelRecord[]>([]);
  const [modelId, setModelId] = useState("");
  const [modelMapping, setModelMapping] = useState<
    Array<{
      model_input_index: number;
      model_channel: string;
      source_channel: number;
    }>
  >([]);
  const [modelScale, setModelScale] = useState<"source" | "override">("source");
  const [modelScaleY, setModelScaleY] = useState(1);
  const [modelScaleX, setModelScaleX] = useState(1);
  const [modelScaleUnit, setModelScaleUnit] = useState("um");
  const [modelDeclaration, setModelDeclaration] = useState("");
  const [modelProbabilityChannel, setModelProbabilityChannel] = useState(0);
  const [modelThreshold, setModelThreshold] = useState(0.5);
  const [modelMethod, setModelMethod] = useState<"components" | "watershed">(
    "components",
  );
  const [modelMinSize, setModelMinSize] = useState(0);
  const [modelSplitHeight, setModelSplitHeight] = useState(1);
  const [modelMeasurementChannels, setModelMeasurementChannels] = useState<
    number[]
  >([0]);
  const [modelWorkingBytes, setModelWorkingBytes] = useState(WORKING_BYTES[0]);
  const [pendingModel, setPendingModel] = useState<PendingModelPreview | null>(
    null,
  );
  const [studyRecipeName, setStudyRecipeName] = useState("Reusable recipe");
  const [studySourceIds, setStudySourceIds] = useState<string[]>([]);
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([]);
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null);
  const [selectionPivotIds, setSelectionPivotIds] = useState<string[]>([]);
  const [sourcesWidth, setSourcesWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem("loci-research-sources-width");
      const parsed = saved ? parseInt(saved, 10) : NaN;
      if (Number.isFinite(parsed) && parsed >= 160 && parsed <= 500) {
        return parsed;
      }
    } catch {
      // ignore
    }
    return 210;
  });
  const [inspectorWidth, setInspectorWidth] = useState(loadInspectorWidth);
  const [isDraggingSources, setIsDraggingSources] = useState(false);
  const sourcesWidthRef = useRef(sourcesWidth);
  sourcesWidthRef.current = sourcesWidth;
  const [sourceDragState, setSourceDragState] = useState<{
    sourceId: string;
    item: ResearchSource;
    startIndex: number;
    currentIndex: number;
    rect: DOMRect;
    grabOffsetY: number;
    currentY: number;
    rowRects: DOMRect[];
    bounds: { minTop: number; maxTop: number };
  } | null>(null);
  const [recentlyDroppedSourceId, setRecentlyDroppedSourceId] = useState<string | null>(null);
  const sourceDragPointerDownRef = useRef<{
    item: ResearchSource;
    startX: number;
    startY: number;
    startIndex: number;
  } | null>(null);
  const hasSourceDraggedRef = useRef(false);
  const [studyPreviewId, setStudyPreviewId] = useState<string | null>(null);
  const [studyRows, setStudyRows] = useState<
    Array<{
      sourceId: string;
      state: string;
      resultId?: string;
      error?: string;
    }>
  >([]);
  const [studyResultIds, setStudyResultIds] = useState<string[]>([]);
  const [studySummary, setStudySummary] = useState<
    Array<Record<string, unknown>>
  >([]);
  const [cellposeBatchConfiguration, setCellposeBatchConfiguration] =
    useState<ResearchCellposeBatchConfiguration | null>(null);
  const [correctionPoints, setCorrectionPoints] = useState<Point[]>([]);
  const correctionVertexDrag = useRef<number | null>(null);
  const [correctionView, setCorrectionView] = useState<{
    plane: Plane;
    index: number;
  }>({ plane: "XY", index: 0 });
  const [correctionPreview, setCorrectionPreview] =
    useState<CorrectionPreview | null>(null);
  const [correctionViewLoading, setCorrectionViewLoading] = useState(false);
  const [redoStack, setRedoStack] = useState<string[]>([]);
  const [emptyDropActive, setEmptyDropActive] = useState(false);
  const [imageScale, setImageScale] = useState<"fit" | "actual">("fit");
  const [canvasContentSize, setCanvasContentSize] = useState({ width: 1, height: 1 });
  const [pendingResultNavigation, setPendingResultNavigation] =
    useState<ResearchResult | null>(null);
  const [surfaceOpen, setSurfaceOpen] = useState(false);
  const [rawVolumeOpen, setRawVolumeOpen] = useState(false);
  const [rawVolume, setRawVolume] = useState<RawVolumeResponse | null>(null);
  const [rawVolumeLoading, setRawVolumeLoading] = useState(false);
  const [rawVolumeError, setRawVolumeError] = useState<string | null>(null);
  const rawVolumeToken = useRef(0);
  const [session, setSession] = useState<ManagedSessionState>({ status: "empty" });
  const [jobsOpen, setJobsOpen] = useState(false);
  const [annotationTool, setAnnotationTool] = useState<AnnotationTool>("navigate");
  const [annotationDraft, setAnnotationDraft] = useState<ImagePoint[]>([]);
  const [sourceAnnotations, setSourceAnnotations] = useState<ImageAnnotation[]>([]);
  const [defaultChannels, setDefaultChannels] = useState<Channel[]>([]);
  const [displayBasis, setDisplayBasis] = useState("");
  const [interpretation, setInterpretation] = useState<SourceInterpretation>("auto");
  const [rgbMapping, setRgbMapping] = useState<[number, number, number] | null>(null);
  const [compareDefault, setCompareDefault] = useState(false);
  const [savedCamera, setSavedCamera] = useState<Camera | null>(null);
  const [viewCamera, setViewCamera] = useState<Camera | null>(null);
  const [controlledViewCamera, setControlledViewCamera] = useState<Camera | null>(null);
  const [viewReadyKey, setViewReadyKey] = useState("");
  const [abCompareMode, setAbCompareMode] = useState(false);
  const [drawingAnalysisRegion, setDrawingAnalysisRegion] = useState(false);
  const [viewSettingsReady, setViewSettingsReady] = useState(false);
  const viewStore = useRef<SourceViewStore | null>(null);
  const batchViewAdoption = useRef<{
    sourceId: string;
    sourceSha256: string;
    channels: Channel[];
  } | null>(null);
  const viewDrain = useRef<Promise<unknown>>(Promise.resolve());
  const displayToken = useRef(0);
  const resultLoadToken = useRef(0);
  const resultViewToken = useRef(0);
  const objectPickToken = useRef(0);
  const recipePresetToken = useRef(0);
  const emptyDropDepth = useRef(0);
  const imageFrameRef = useRef<HTMLDivElement | null>(null);
  const previewScope = useRef<string | null>(null);
  const projectionSourceId = useRef<string | null>(null);
  const projectionSourceLocatorState = useRef<string | null>(null);
  const [documentEpoch, setDocumentEpoch] = useState(0);
  const [studyEpoch, setStudyEpoch] = useState(0);
  const [documentSwitching, setDocumentSwitching] = useState(false);
  const documentSwitch = useRef(false);
  const switchDocument = useCallback(async <T,>(action: () => Promise<T>, resetDisplay = true): Promise<T> => {
    if (documentSwitch.current) throw new Error("Wait for the study to finish opening.");
    documentSwitch.current = true;
    // Native dialogs may defer rendering while the window is inactive. Commit
    // the viewport pause before entering the main-process document lock.
    flushSync(() => setDocumentSwitching(true));
    const store = viewStore.current;
    const displayWasPending = Boolean(projectionSourceId.current && !store);
    if (displayWasPending) displayToken.current++;
    let adopted = false;
    store?.pause();
    try {
      await viewDrain.current;
      if (store && !await store.flush()) throw new Error("Display settings could not be saved. Resolve the displayed error before switching studies.");
      const next = await action();
      if (next && resetDisplay) {
        adopted = true;
        store?.discard();
        viewStore.current = null;
        projectionSourceId.current = null;
        projectionSourceLocatorState.current = null;
        displayToken.current++;
        setViewSettingsReady(false);
        setDocumentEpoch((value) => value + 1);
        setStudyEpoch((value) => value + 1);
      } else store?.resume();
      return next;
    } catch (error) { store?.resume(); throw error; }
    finally {
      // A cancelled picker may have interrupted preparation of the current
      // source. Its abandoned read cannot restore a view or surface a stale
      // error; restart it against the still-active study after the lock ends.
      if (displayWasPending && !adopted) {
        projectionSourceId.current = null;
        projectionSourceLocatorState.current = null;
        setDocumentEpoch((value) => value + 1);
      }
      documentSwitch.current = false;
      setDocumentSwitching(false);
    }
  }, []);
  // Native document pickers change the active engine project. Drain the previous
  // source's view writes before that boundary and force restoration even when a
  // cloned study retains the same source IDs.
  const api = useMemo<ResearchDesktopApi>(() => ({
    ...desktopApi,
    openStudy: () => switchDocument(() => desktopApi.openStudy()),
    createStudy: () => switchDocument(() => desktopApi.createStudy()),
    addSources: (kind) => switchDocument(() => desktopApi.addSources(kind)),
    ...(desktopApi.openImages ? { openImages: (kind: "files" | "folder" | "dicom" | "ome_zarr" = "files") =>
      switchDocument(() => desktopApi.openImages!(kind)) } : {}),
    ...(desktopApi.saveAs ? { saveAs: () => switchDocument(() => desktopApi.saveAs!()) } : {}),
    ...(desktopApi.importLegacyProject ? { importLegacyProject: () => switchDocument(() => desktopApi.importLegacyProject!()) } : {}),
    ...(desktopApi.importStudy ? { importStudy: () => switchDocument(() => desktopApi.importStudy!()) } : {}),
    ...(desktopApi.openDropped ? { openDropped: (files: File[]) => switchDocument(() => desktopApi.openDropped!(files)) } : {}),
    ...(desktopApi.recoveryKeep ? { recoveryKeep: (id: string) => switchDocument(() => desktopApi.recoveryKeep!(id)) } : {}),
    ...(desktopApi.newSession ? { newSession: () => switchDocument(() => desktopApi.newSession!()) } : {}),
    // Working-list changes take the same main-process lock, but retain this
    // document's camera and the close/clear action's local undo receipt.
    ...(desktopApi.updateWorkspace ? { updateWorkspace: (request) =>
      switchDocument(() => desktopApi.updateWorkspace!(request), false) } : {}),
    ...(desktopApi.reorderSources ? { reorderSources: (request) =>
      desktopApi.reorderSources!(request) } : {}),
    ...(desktopApi.submitBatch ? { submitBatch: (tasks) =>
      switchDocument(() => desktopApi.submitBatch!(tasks), false) } : {}),
    ...(desktopApi.resumeBatch ? { resumeBatch: (id) =>
      switchDocument(() => desktopApi.resumeBatch!(id), false) } : {}),
    ...(desktopApi.retryBatch ? { retryBatch: (id) =>
      switchDocument(() => desktopApi.retryBatch!(id), false) } : {}),
    ...(desktopApi.exportSourceView ? { exportSourceView: (request) =>
      switchDocument(() => desktopApi.exportSourceView!(request), false) } : {}),
    ...(desktopApi.exportVolumeFigure ? { exportVolumeFigure: (request) =>
      switchDocument(() => desktopApi.exportVolumeFigure!(request), false) } : {}),
    ...(desktopApi.exportBatch ? { exportBatch: (bindings, options) =>
      switchDocument(() => desktopApi.exportBatch!(bindings, options), false) } : {}),
    ...(desktopApi.inspectVendor ? { inspectVendor: () =>
      switchDocument(() => desktopApi.inspectVendor!(), false) } : {}),
    ...(desktopApi.convertVendor ? { convertVendor: (request) =>
      switchDocument(() => desktopApi.convertVendor!(request), false) } : {}),
  }), [desktopApi, switchDocument]);
  const source =
    snapshot?.sources.find((entry) => entry.id === sourceId) ?? null;
  const sourceIsChanging = Boolean(source && projectionSourceId.current !== source.id);
  const resolvedProjection =
    sourceIsChanging ? "plane" : projection;
  const maxViewPixels = source ? maxNativeViewPixels(source) : undefined;
  const sourceMeta = useMemo(
    () => (source ? meta(source) : null),
    [source?.id, source?.sha256, source?.locator_state],
  );
  const isRgb = sourceMeta?.sample_semantics === "RGB" || sourceMeta?.sample_semantics === "RGBA";
  const rawVolumeUnavailable = source ? rawVolumeUnavailableReason(source) : null;
  const dimensions =
    sourceMeta?.levels?.find((level) => level.index === selection.level)
      ?.dimensions ??
    sourceMeta?.dimensions ??
    null;
  const reorderQueue = useRef<Promise<unknown>>(Promise.resolve());
  const adopt = useCallback((next: ResearchSnapshot | null, preferredId?: string | null) => {
    if (!next) return; // Cancelled pickers never replace an open document.
    setSnapshot((previousSnapshot) => {
      const prevIds = new Set(previousSnapshot?.sources.map((s) => s.id) ?? []);
      const newlyAdded = next.sources.find((s) => !prevIds.has(s.id));
      const targetId = preferredId
        ? (next.sources.find((s) => s.id === preferredId)?.id ?? null)
        : newlyAdded?.id;

      setSourceId((previous) => {
        const nextId = targetId ?? (next.sources.some((item) => item.id === previous)
          ? previous
          : (next.sources[0]?.id ?? null));

        if (nextId) {
          if (targetId) {
            setSelectedSourceIds([nextId]);
            setSelectionAnchorId(nextId);
            setSelectionPivotIds([nextId]);
          } else {
            setSelectedSourceIds((prevSelected) => {
              const valid = prevSelected.filter((id) => next.sources.some((s) => s.id === id));
              return valid.length > 0 ? valid : [nextId];
            });
            setSelectionAnchorId((prevAnchor) =>
              prevAnchor && next.sources.some((s) => s.id === prevAnchor) ? prevAnchor : nextId,
            );
          }
        } else {
          setSelectedSourceIds([]);
          setSelectionAnchorId(null);
          setSelectionPivotIds([]);
        }
        return nextId;
      });
      return next;
    });
  }, []);

  const persistSourceOrder = useCallback((nextSources: ResearchSource[]) => {
    if (!snapshot) return;
    const previous = snapshot;
    setSnapshot({ ...snapshot, sources: nextSources });
    onSourcesReorder?.(nextSources);
    if (!api.reorderSources) return;
    reorderQueue.current = reorderQueue.current.then(async () => {
      try {
        const next = await api.reorderSources!({
          expected_revision: snapshot.workspace?.revision ?? 0,
          sources: nextSources.map(({ id, sha256 }) => ({ id, sha256 })),
        });
        adopt(next);
      } catch (caught) {
        const restored = await desktopApi.getSnapshot().catch(() => null);
        adopt(restored ?? previous);
        setError(message(caught, "Could not save the image order."));
      }
    });
  }, [adopt, api, desktopApi, onSourcesReorder, snapshot]);

  useEffect(() => {
    if (!snapshot?.sources?.length) {
      if (selectedSourceIds.length > 0) setSelectedSourceIds([]);
      return;
    }
    const available = new Set(snapshot.sources.map((s) => s.id));
    const pruned = selectedSourceIds.filter((id) => available.has(id));
    if (pruned.length === 0) {
      const fallback = sourceId && available.has(sourceId) ? sourceId : snapshot.sources[0].id;
      setSelectedSourceIds([fallback]);
      setSelectionAnchorId(fallback);
      setSelectionPivotIds([fallback]);
    } else if (pruned.length !== selectedSourceIds.length) {
      setSelectedSourceIds(pruned);
      setSelectionPivotIds(pruned);
      if (selectionAnchorId && !available.has(selectionAnchorId)) {
        setSelectionAnchorId(pruned[0]);
      }
    }
  }, [snapshot?.sources, sourceId]);

  const handleSourceClick = useCallback(
    (item: ResearchSource, event: React.MouseEvent) => {
      if (hasSourceDraggedRef.current) {
        hasSourceDraggedRef.current = false;
        return;
      }
      if (!snapshot) return;
      const allIds = snapshot.sources.map((s) => s.id);
      const clickedId = item.id;
      const clickedIndex = allIds.indexOf(clickedId);

      if (event.metaKey || event.ctrlKey) {
        let next: string[];
        if (selectedSourceIds.includes(clickedId)) {
          next = selectedSourceIds.filter((id) => id !== clickedId);
          if (next.length === 0) next = [clickedId];
        } else {
          next = [...selectedSourceIds, clickedId];
        }
        setSelectedSourceIds(next);
        setSelectionAnchorId(clickedId);
        setSelectionPivotIds(next);
        if (clickedId !== sourceId) {
          setProjection("plane");
          setSourceId(clickedId);
        }
      } else if (event.shiftKey && selectionAnchorId) {
        const anchorIndex = allIds.indexOf(selectionAnchorId);
        if (anchorIndex >= 0 && clickedIndex >= 0) {
          const minIdx = Math.min(anchorIndex, clickedIndex);
          const maxIdx = Math.max(anchorIndex, clickedIndex);
          const rangeIds = allIds.slice(minIdx, maxIdx + 1);
          const combined = Array.from(new Set([...selectionPivotIds, ...rangeIds]));
          setSelectedSourceIds(combined);
          if (clickedId !== sourceId) {
            setProjection("plane");
            setSourceId(clickedId);
          }
        }
      } else {
        setSelectedSourceIds([clickedId]);
        setSelectionAnchorId(clickedId);
        setSelectionPivotIds([clickedId]);
        if (clickedId !== sourceId) {
          setProjection("plane");
          setSourceId(clickedId);
        }
      }
    },
    [snapshot, selectedSourceIds, selectionAnchorId, selectionPivotIds, sourceId],
  );

  const handleSourcePointerDown = useCallback(
    (item: ResearchSource, event: React.PointerEvent) => {
      if (event.button !== 0) return;
      if (busy !== null || documentSwitching) return;
      if (!snapshot?.sources || snapshot.sources.length <= 1) return;
      const startIndex = snapshot.sources.findIndex((s) => s.id === item.id);
      if (startIndex < 0) return;

      sourceDragPointerDownRef.current = {
        item,
        startX: event.clientX,
        startY: event.clientY,
        startIndex,
      };
      hasSourceDraggedRef.current = false;

      const onPointerMove = (e: PointerEvent) => {
        const start = sourceDragPointerDownRef.current;
        if (!start) return;

        if (!hasSourceDraggedRef.current) {
          const dist = Math.hypot(e.clientX - start.startX, e.clientY - start.startY);
          if (dist > 4) {
            hasSourceDraggedRef.current = true;
            document.body.style.userSelect = "none";
            document.body.style.cursor = "grabbing";

            const rowEl = document.querySelector(`[data-source-id="${start.item.id}"]`) as HTMLElement;
            const rect = rowEl?.getBoundingClientRect() ?? new DOMRect(0, 0, 200, 48);
            const container = rowEl?.parentElement;
            const allRowEls = container
              ? (Array.from(container.querySelectorAll("[data-source-id]")) as HTMLElement[])
              : [];
            const rowRects = allRowEls.map((el) => el.getBoundingClientRect());
            const minTop = rowRects[0]?.top ?? rect.top;
            const maxTop = (rowRects[rowRects.length - 1]?.bottom ?? rect.bottom) - rect.height;

            setSourceDragState({
              sourceId: start.item.id,
              item: start.item,
              startIndex: start.startIndex,
              currentIndex: start.startIndex,
              rect,
              grabOffsetY: start.startY - rect.top,
              currentY: e.clientY,
              rowRects,
              bounds: { minTop, maxTop },
            });
          }
        } else {
          setSourceDragState((prev) => {
            if (!prev) return null;
            const currentY = Math.max(prev.bounds.minTop, Math.min(prev.bounds.maxTop + prev.rect.height, e.clientY));
            let targetIndex = 0;
            for (let i = 0; i < prev.rowRects.length; i++) {
              const r = prev.rowRects[i];
              const midY = (r.top + r.bottom) / 2;
              if (currentY > midY) {
                targetIndex = i;
              }
            }
            targetIndex = Math.max(0, Math.min(prev.rowRects.length - 1, targetIndex));
            return { ...prev, currentY, currentIndex: targetIndex };
          });
        }
      };

      const onPointerUp = () => {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerUp);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";

        setSourceDragState((prev) => {
          if (prev && prev.currentIndex !== prev.startIndex) {
            const currentIndex = snapshot?.sources.findIndex(({ id }) => id === prev.item.id) ?? -1;
            if (snapshot && currentIndex >= 0) {
              const nextSources = [...snapshot.sources];
              const [moved] = nextSources.splice(currentIndex, 1);
              nextSources.splice(prev.currentIndex, 0, moved);
              persistSourceOrder(nextSources);
            }
            setRecentlyDroppedSourceId(prev.item.id);
            window.setTimeout(() => setRecentlyDroppedSourceId(null), 300);
          }
          return null;
        });
        sourceDragPointerDownRef.current = null;
      };

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
    },
    [busy, documentSwitching, persistSourceOrder, snapshot],
  );

  const handleSourceKeyDown = useCallback(
    (item: ResearchSource, index: number, event: React.KeyboardEvent) => {
      if (event.altKey && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault();
        if (busy !== null || documentSwitching || !snapshot) return;
        const targetIndex = event.key === "ArrowDown" ? index + 1 : index - 1;
        if (targetIndex < 0 || targetIndex >= snapshot.sources.length) return;
        const currentIndex = snapshot.sources.findIndex(({ id }) => id === item.id);
        if (currentIndex < 0) return;
        const nextSources = [...snapshot.sources];
        const [moved] = nextSources.splice(currentIndex, 1);
        nextSources.splice(targetIndex, 0, moved);
        persistSourceOrder(nextSources);
        setRecentlyDroppedSourceId(item.id);
        window.setTimeout(() => setRecentlyDroppedSourceId(null), 300);
      }
    },
    [busy, documentSwitching, persistSourceOrder, snapshot],
  );

  const [workspaceUndo, setWorkspaceUndo] = useState<{
    message: string;
    request: ResearchWorkspaceChange;
  } | null>(null);

  const handleCloseSelectedSources = useCallback(async () => {
    if (!snapshot || !api.updateWorkspace || documentSwitching) return;
    const targetIds = selectedSourceIds.length > 0 ? selectedSourceIds : (source ? [source.id] : []);
    if (targetIds.length === 0) return;
    const sourcesToClose = snapshot.sources.filter((s) => targetIds.includes(s.id));
    if (sourcesToClose.length === 0) return;

    // Immediately abort any in-flight display preparation for closing sources
    displayToken.current++;
    resultLoadToken.current++;
    viewStore.current = null;
    void api.cancelView?.();
    rawVolumeToken.current++;
    setRawVolume(null);
    setRawVolumeOpen(false);
    setSurfaceOpen(false);

    const remainingSources = snapshot.sources.filter((s) => !sourcesToClose.some((c) => c.id === s.id));
    if (sourcesToClose.some((c) => c.id === sourceId)) {
      if (remainingSources.length > 0) {
        setSourceId(remainingSources[0].id);
        setSelectedSourceIds([remainingSources[0].id]);
      } else {
        setSourceId(null);
        setSelectedSourceIds([]);
        setImage(null);
        setVolume(null);
        setRawVolume(null);
        setRawVolumeOpen(false);
        setSurfaceOpen(false);
        setResultId(null);
        setResultView(null);
        setRows([]);
        setSelectedRow(null);
        setCorrectionPoints([]);
        setRedoStack([]);
      }
    } else {
      setSelectedSourceIds((prev) => prev.filter((id) => !targetIds.includes(id)));
    }

    const workspace = snapshot.workspace ?? { revision: 0, closed_sources: [], hidden_results: [] };
    const request: ResearchWorkspaceChange = {
      expected_revision: workspace.revision,
      sources: sourcesToClose.map((s) => ({ id: s.id, sha256: s.sha256, visible: false })),
      results: [],
    };

    setBusy("Removing images from workspace");
    try {
      const next = await api.updateWorkspace(request);
      if (!next.workspace || next.workspace.revision !== request.expected_revision + 1) {
        throw new Error("The saved working list did not match this change. Reopen the study to verify it.");
      }
      const count = sourcesToClose.length;
      const msg = count === 1 ? `Closed "${sourcesToClose[0].name}".` : `Closed ${count} images.`;
      setWorkspaceUndo({
        message: msg,
        request: {
          expected_revision: next.workspace.revision,
          sources: sourcesToClose.map((s) => ({ id: s.id, sha256: s.sha256, visible: true })),
          results: [],
        },
      });

      adopt(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove images from workspace.");
    } finally {
      setBusy(null);
    }
  }, [snapshot, api, documentSwitching, selectedSourceIds, source, sourceId, adopt]);

  const handleWorkspaceUndo = useCallback(async () => {
    if (!workspaceUndo || !api.updateWorkspace || busy !== null || documentSwitching) return;
    setBusy("Restoring images");
    try {
      const next = await api.updateWorkspace(workspaceUndo.request);
      setWorkspaceUndo(null);
      adopt(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not restore images.");
    } finally {
      setBusy(null);
    }
  }, [workspaceUndo, api, busy, documentSwitching, adopt]);

  useEffect(() => {
    const handleSelectChange = (event: Event) => {
      if (event.target instanceof HTMLSelectElement) {
        event.target.blur();
      }
    };
    document.addEventListener("change", handleSelectChange, true);
    return () => {
      document.removeEventListener("change", handleSelectChange, true);
    };
  }, []);

  const handleSourcesResizeStart = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sourcesWidthRef.current;
    setIsDraggingSources(true);

    const onPointerMove = (ev: PointerEvent) => {
      const delta = ev.clientX - startX;
      const newWidth = Math.max(160, Math.min(500, Math.round(startWidth + delta)));
      setSourcesWidth(newWidth);
    };

    const onPointerUp = () => {
      setIsDraggingSources(false);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      try {
        localStorage.setItem("loci-research-sources-width", String(sourcesWidthRef.current));
      } catch {}
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
  };

  const handleSourcesResizeKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      const newWidth = Math.max(160, sourcesWidth - 10);
      setSourcesWidth(newWidth);
      try {
        localStorage.setItem("loci-research-sources-width", String(newWidth));
      } catch {}
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      const newWidth = Math.min(500, sourcesWidth + 10);
      setSourcesWidth(newWidth);
      try {
        localStorage.setItem("loci-research-sources-width", String(newWidth));
      } catch {}
    }
  };
  const report = useCallback(
    async <T,>(
      work: () => Promise<T>,
      fallback: string,
    ): Promise<T | undefined> => {
      try {
        return await work();
      } catch (caught) {
        setError(message(caught, fallback));
        return undefined;
      }
    },
    [],
  );
  const resetEmptyDrop = useCallback(() => {
    emptyDropDepth.current = 0;
    setEmptyDropActive(false);
  }, []);
  useEffect(() => {
    const reset = () => resetEmptyDrop();
    window.addEventListener("dragend", reset);
    window.addEventListener("blur", reset);
    return () => {
      emptyDropDepth.current = 0;
      window.removeEventListener("dragend", reset);
      window.removeEventListener("blur", reset);
    };
  }, [resetEmptyDrop]);
  useEffect(() => {
    if (snapshot) resetEmptyDrop();
  }, [snapshot, resetEmptyDrop]);
  const shownSelection = useMemo(
    () => {
      const selected = sourceIsChanging
        ? { ...selection, level: 0, z_stop: undefined }
        : selection;
      return dimensions
        ? clamp(selected, dimensions)
        : selected;
    },
    [selection, dimensions, maxViewPixels, sourceIsChanging],
  );
  const autoPlaneKey = `${source?.id}:${source?.sha256}:${shownSelection.t}:${shownSelection.z}`;
  const autoPlaneRef = useRef(autoPlaneKey);
  autoPlaneRef.current = autoPlaneKey;
  const autoRequestToken = useRef(0);
  const sourceLevels = useMemo(
    () => sourceMeta?.levels ?? (sourceMeta?.dimensions
      ? [{ index: 0, dimensions: sourceMeta.dimensions }]
      : []),
    [sourceMeta],
  );
  useEffect(() => {
    void report(
      () => api.getSnapshot().then(adopt),
      "Could not restore this study.",
    );
  }, [api, adopt, report]);
  useEffect(() => {
    void api.sessionState?.().then(setSession).catch((caught) => setError(message(caught, "Could not inspect session recovery.")));
  }, [api, snapshot?.project]);
  const openImages = useCallback(async (kind: "files" | "folder" | "dicom" | "ome_zarr" = "files") => {
    resetEmptyDrop();
    setBusy("opening images");
    const output = await report(() => api.openImages ? api.openImages(kind) : api.addSources(kind === "folder" ? "files" : kind), "Could not open these images.");
    if (output) {
      const previous = new Set(snapshot?.sources.map((item) => item.id));
      const added = output.sources.find((item) => !previous.has(item.id)) ?? output.sources[output.sources.length - 1];
      adopt(output, added?.id);
    }
    setBusy(null);
  }, [api, report, snapshot?.sources, adopt, resetEmptyDrop]);
  const openLegacy = useCallback(async () => {
    resetEmptyDrop();
    if (!api.importLegacyProject) { onBack(); return; }
    setBusy("opening project");
    const output = await report(() => api.importLegacyProject!(), "Could not open this project.");
    if (output) adopt(output.snapshot);
    setBusy(null);
  }, [api, report, adopt, onBack, resetEmptyDrop]);
  useEffect(() => {
    if (!source) {
      setRawVolumeOpen(false);
      setSurfaceOpen(false);
      setRawVolume(null);
      setVolume(null);
      return;
    }
    if (!dimensions) return;
    const currentLocatorState = source.locator_state ?? "ok";
    if (source.locator_state === "relink-required") {
      projectionSourceId.current = source.id;
      projectionSourceLocatorState.current = "relink-required";
      const previousStore = viewStore.current;
      previousStore?.discard();
      viewStore.current = null;
      setAnnotationTool("navigate"); setAnnotationDraft([]); setSourceAnnotations([]);
      setRawVolumeOpen(false); setRawVolume(null); rawVolumeToken.current++;
      const count = isRgb ? 1 : (dimensions?.c ?? 1);
      const fallbackChannels: Channel[] = Array.from({ length: Math.max(1, count) }, (_, channel) => ({
        channel,
        low: 0,
        high: 255,
        gamma: 1,
        color: "#ffffff",
        opacity: 1,
        visible: true,
      }));
      setChannels(fallbackChannels);
      setDefaultChannels(fallbackChannels);
      setViewSettingsReady(true);
      return;
    }
    if (projectionSourceId.current === source.id && projectionSourceLocatorState.current === currentLocatorState) {
      setSelection((old) => clamp(old, dimensions));
      return;
    }
    // A Z extent belongs to the prior source grid.  Carrying it into a newly
    // selected RGB plane would turn an explicit single-plane histology request
    // into an invalid volume request.
    projectionSourceId.current = source.id;
    projectionSourceLocatorState.current = currentLocatorState;
    setProjection("plane");
    setSelection(clamp({ ...DEFAULT_SELECTION, width: dimensions.x,
      height: dimensions.y, z: Math.floor(dimensions.z / 2) }, dimensions));
    setDrawingAnalysisRegion(false);
    setSegmentationFamily("classical");
    setRecipe((old) => { const { input_transform: _conversion, ...scalar } = old; return { ...scalar, measurement_channels: [0] }; });
    setChannels([]);
    setDefaultChannels([]);
    setViewSettingsReady(false); setInterpretation("auto"); setRgbMapping(null); setSavedCamera(null); setViewCamera(null);
    const previousStore = viewStore.current;
    previousStore?.pause();
    viewDrain.current = Promise.all([viewDrain.current, previousStore?.flush()]);
    viewStore.current = null;
    setAnnotationTool("navigate"); setAnnotationDraft([]); setSourceAnnotations([]);
    setRawVolumeOpen(false); setRawVolume(null); rawVolumeToken.current++;
    const token = ++displayToken.current;
    void viewDrain.current.then(() => Promise.all([api.execute("viewer_defaults", { source_id: source.id, t: 0, z: 0, auto: false }),
      api.execute("source_view", { source_id: source.id })])).then(([value, saved]) => {
      if (displayToken.current !== token) return;
      const defaults = value as { source_id: string; source_sha256: string; channels: Channel[]; basis: unknown };
      if (defaults.source_id !== source.id || defaults.source_sha256 !== source.sha256 || !Array.isArray(defaults.channels))
        throw new Error("Display defaults do not match this source.");
      const view = saved as SavedSourceView;
      if (view.source_id !== source.id || view.source_sha256 !== source.sha256 || !Number.isInteger(view.revision))
        throw new Error("Saved display settings do not match this source.");
      setChannels(view.state?.channels ?? defaults.channels); setDefaultChannels(defaults.channels);
      if (view.state) {
        setInterpretation(view.state.interpretation); setProjection(view.state.projection);
        if (view.state.interpretation === "volume" && dimensions.z > 1 && !rawVolumeUnavailable) setRawVolumeOpen(true);
        if (view.state.interpretation === "histology" && isRgb) setSegmentationFamily("stain");
        setRgbMapping(view.state.rgb_mapping ?? null);
        setSelection(view.state.selection); setSavedCamera(view.state.camera); setViewCamera(view.state.camera);
      }
      viewStore.current = new SourceViewStore(api, source.id, source.sha256, view.revision,
        (caught) => setError(message(caught, "Could not save display settings.")));
      setViewSettingsReady(true);
      setDisplayBasis(typeof defaults.basis === "string" ? defaults.basis : "Source defaults");
    }).catch((caught) => { if (displayToken.current === token) setError(message(caught, "Could not prepare source display settings.")); });
    setImage(null);
    setVolume(null);
    setResultId(null);
    setResultView(null);
    setRows([]);
    setSelectedRow(null);
    setCorrectionPoints([]);
    setCorrectionPreview(null);
    setCorrectionView({ plane: "XY", index: 0 });
    setCorrectionViewLoading(false);
    setRedoStack([]);
    setImageScale("fit");
    setSurfaceOpen(false);
    resultLoadToken.current += 1;
    resultViewToken.current += 1;
    setPendingModel(null);
  }, [
    documentEpoch,
    source?.id,
    source?.locator_state,
    dimensions?.c,
    dimensions?.x,
    dimensions?.y,
    dimensions?.z,
    dimensions?.t,
  ]);
  useEffect(() => {
    if (viewSettingsReady && channels.length && source && projectionSourceId.current === source.id) {
      const adopted = batchViewAdoption.current;
      if (adopted?.sourceId === source.id && adopted.sourceSha256 === source.sha256 && adopted.channels === channels) {
        batchViewAdoption.current = null;
        return;
      }
      viewStore.current?.save({ interpretation, channels, projection, selection: shownSelection, camera: viewCamera, rgb_mapping: rgbMapping });
    }
  }, [viewSettingsReady, interpretation, channels, projection, shownSelection, viewCamera, rgbMapping, source?.id]);
  useEffect(() => () => { void viewStore.current?.flush(); }, []);
  const requestRawVolume = useCallback(async (refinement?: RawVolumeRefinementRequest) => {
    if (documentSwitch.current || !source) return;
    const token = ++rawVolumeToken.current;
    setRawVolumeLoading(true); setRawVolumeError(null);
    try {
      const selectedChannels = channels.filter((item) => item.visible).map((item) => item.channel);
      if (selectedChannels.length > 4) throw new Error("Choose up to four visible channels for this volume view.");
      const output = await api.execute("viewer_volume", { source_id: source.id,
        t: shownSelection.t, channel_indices: selectedChannels.length ? selectedChannels : [shownSelection.c],
        target_long_axis: 128, ...refinement }) as RawVolumeResponse;
      if (rawVolumeToken.current !== token) return;
      if (output.context.source_id !== source.id || output.context.source_sha256 !== source.sha256 || output.context.t !== shownSelection.t)
        throw new Error("The volume does not match its source and time point.");
      setRawVolume(output);
    } catch (caught) { if (rawVolumeToken.current === token) setRawVolumeError(message(caught, "Could not prepare the volume.")); }
    finally { if (rawVolumeToken.current === token) setRawVolumeLoading(false); }
  }, [api, source, shownSelection.t, shownSelection.c, channels]);
  const volumeChannelKey = channels.filter((item) => item.visible).map((item) => item.channel).join(",");
  useEffect(() => {
    if (!rawVolumeOpen) return;
    setRawVolume(null);
    void requestRawVolume();
  }, [rawVolumeOpen, source?.id, shownSelection.t, volumeChannelKey]);
  useEffect(() => {
    const key = JSON.stringify([
      source?.id,
      shownSelection,
      channels,
      resolvedProjection,
    ]);
    if (previewScope.current !== null && previewScope.current !== key)
      setImage(null);
    previewScope.current = key;
  }, [channels, resolvedProjection, shownSelection, source?.id]);
  useEffect(() => {
    setPendingModel(null);
  }, [
    selection,
    modelId,
    modelMapping,
    modelScale,
    modelScaleY,
    modelScaleX,
    modelScaleUnit,
    modelDeclaration,
    modelProbabilityChannel,
    modelThreshold,
    modelMethod,
    modelMinSize,
    modelSplitHeight,
    modelMeasurementChannels,
    modelWorkingBytes,
  ]);
  const refreshModels = useCallback(async () => {
    const output = await report(
      () =>
        api.execute("model_list", {}) as Promise<{ models?: ModelRecord[] }>,
      "Could not load project-managed model packages.",
    );
    if (output) setModels(output.models ?? []);
  }, [api, report]);
  useEffect(() => {
    if (tab === "Model") void refreshModels();
  }, [tab, refreshModels]);
  const modelRequest = useCallback(() => {
    if (!source) return null;
    const { c: _c, z_stop: _stop, ...modelSelection } = shownSelection;
    return {
      model_id: modelId,
      source_id: source.id,
      selection: modelSelection,
      channel_mapping: modelMapping,
      scale:
        modelScale === "source"
          ? { mode: "source" }
          : {
              mode: "override",
              scale_yx: [modelScaleY, modelScaleX],
              scale_unit: modelScaleUnit,
              declaration: modelDeclaration,
            },
      postprocessing: {
        probability_channel: modelProbabilityChannel,
        threshold: modelThreshold,
        method: modelMethod,
        min_size: modelMinSize,
        split_height: modelMethod === "watershed" ? modelSplitHeight : null,
        exclude_border: false,
      },
      measurement_channels: [...modelMeasurementChannels].sort((a, b) => a - b),
      display: {
        source_channel: modelMeasurementChannels[0] ?? 0,
        low: 0,
        high: 1,
        gamma: 1,
        color: "#ffffff",
      },
      working_bytes: modelWorkingBytes,
    };
  }, [
    source?.id,
    shownSelection,
    modelId,
    modelMapping,
    modelScale,
    modelScaleY,
    modelScaleX,
    modelScaleUnit,
    modelDeclaration,
    modelProbabilityChannel,
    modelThreshold,
    modelMethod,
    modelMinSize,
    modelSplitHeight,
    modelMeasurementChannels,
    modelWorkingBytes,
  ]);
  const previewModel = async () => {
    const request = modelRequest();
    if (!request) return;
    setBusy("model preview");
    const output = await report(
      () =>
        api.execute("model_preview", request) as Promise<{
          preview?: { id?: string; preview_sha256?: string };
          overlay_png?: string;
        }>,
      "Could not create an exact model preview.",
    );
    setBusy(null);
    if (
      !output?.preview?.id ||
      !output.preview.preview_sha256 ||
      !output.overlay_png
    )
      return;
    setPendingModel({
      id: output.preview.id,
      sha256: output.preview.preview_sha256,
      overlay: output.overlay_png,
    });
    setResultId(null);
    setResultView(null);
    setImage(output.overlay_png);
  };
  const adoptModel = async () => {
    if (!pendingModel) return;
    setBusy("model run");
    const output = await report(
      () =>
        api.execute("model_run", {
          preview_id: pendingModel.id,
          preview_sha256: pendingModel.sha256,
        }) as Promise<{ result?: ResearchResult }>,
      "Could not adopt the exact model preview.",
    );
    setBusy(null);
    if (output?.result?.id) {
      setPendingModel(null);
      await loadResult(output.result.id, output.result);
      await report(
        () => api.getSnapshot().then(adopt),
        "Could not refresh result history.",
      );
    }
  };
  const previewHistology = async (
    basis: "H&E" | "H-DAB",
    component: number,
    histologyRecipe: typeof DEFAULT_RECIPE,
  ) => {
    if (!source) return;
    setBusy("histology preview");
    const output = await report(
      () =>
        api.execute("histology_preview", {
          source_id: source.id,
          selection: shownSelection,
          basis,
          component,
          steps: histologyRecipe.steps,
          segmentation: histologyRecipe.segmentation,
          gates: histologyRecipe.gates,
        }) as Promise<{
          image?: string;
          measurements?: Array<Record<string, unknown>>;
        }>,
      "Could not preview the declared stain analysis.",
    );
    setBusy(null);
    if (output) {
      setPendingModel(null);
      setResultId(null);
      setResultView(null);
      setImage(output.image ?? null);
      setRows(output.measurements ?? []);
    }
  };
  const runHistology = async (
    basis: "H&E" | "H-DAB",
    component: number,
    histologyRecipe: typeof DEFAULT_RECIPE,
  ) => {
    if (!source) return;
    setBusy("histology run");
    const output = await report(
      () =>
        api.execute("histology_run", {
          source_id: source.id,
          selection: shownSelection,
          basis,
          component,
          steps: histologyRecipe.steps,
          segmentation: histologyRecipe.segmentation,
          gates: histologyRecipe.gates,
        }) as Promise<{
          result?: ResearchResult;
          measurements?: Array<Record<string, unknown>>;
        }>,
      "Could not run the declared stain analysis.",
    );
    setBusy(null);
    if (output?.result?.id) {
      setRows(output.measurements ?? []);
      await loadResult(output.result.id, output.result);
      await report(
        () => api.getSnapshot().then(adopt),
        "Could not refresh result history.",
      );
    }
  };
  useEffect(() => {
    if (
      busy !== "run" &&
      !snapshot?.jobs.some(
        (job) => job.state === "queued" || job.state === "running",
      )
    )
      return;
    let active = true;
    const timer = window.setInterval(() => {
      void report(async () => {
        const next = await api.getSnapshot();
        if (active && next) setSnapshot(next);
      }, "Could not refresh durable job status.");
    }, 1000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [api, busy, snapshot?.jobs, report]);
  const openVolume = async (crosshair?: [number, number, number]) => {
    if (!source || !dimensions) return;
    setBusy("volume");
    const scoped = {
      ...shownSelection,
      z_stop: Math.min(
        dimensions.z,
        Math.max(
          shownSelection.z + 1,
          shownSelection.z_stop ??
            shownSelection.z + Math.min(16, dimensions.z - shownSelection.z),
        ),
      ),
    };
    const output = await report(
      () =>
        api.execute("volume_view", {
          source_id: source.id,
          selection: scoped,
          ...(crosshair ? { crosshair } : {}),
          include_volume: false,
        }) as Promise<Volume>,
      "Could not render linked orthogonal planes.",
    );
    if (output) setVolume(output);
    setBusy(null);
  };
  const loadResult = async (id: string, knownResult?: ResearchResult) => {
    const exactResult =
      knownResult ?? snapshot?.results.find((item) => item.id === id);
    if (!exactResult) {
      setError(
        "The selected result is absent from the current immutable history.",
      );
      return;
    }
    const loadToken = ++resultLoadToken.current;
    // The correction effect owns its exact plane request. A second request here
    // could supersede it while source tiles are being decoded.
    const correctionOwnsPlane = tab === "Correction";
    const planeToken = correctionOwnsPlane ? resultViewToken.current : ++resultViewToken.current;
    const requestedPlane = tab === "Correction" ? correctionView.plane : "XY";
    const requestedAxis = planeAxis(requestedPlane);
    const requestedIndex =
      tab === "Correction" ? correctionView.index : undefined;
    setResultId(id);
    setSelectedRow(null);
    setBusy("result");
    const output = await report(async () => {
      const [record, rendered] = await Promise.all([
        api.execute("result", { result_id: id, offset: 0, limit: 200 }),
        correctionOwnsPlane ? Promise.resolve(null) : api.execute("result_view", {
          result_id: id,
          axis: requestedAxis,
          ...(requestedIndex === undefined ? {} : { index: requestedIndex }),
          labels: true,
        }),
      ]);
      return {
        record: record as { measurements?: Array<Record<string, unknown>> },
        rendered: rendered === null ? null : exactResultView(
          rendered,
          exactResult,
          requestedAxis,
          requestedIndex,
        ),
      };
    }, "Could not read the exact selected result.");
    if (output && loadToken === resultLoadToken.current) {
      setRows(output.record.measurements ?? []);
      if (output.rendered && planeToken === resultViewToken.current)
        setResultView(output.rendered);
    }
    if (loadToken === resultLoadToken.current)
      setBusy((current) => (current === "result" ? null : current));
  };
  const navigateExactResult = async (target: ResearchResult) => {
    if (target.source_id !== sourceId) {
      setPendingResultNavigation(target);
      setProjection("plane");
      setSourceId(target.source_id);
      return;
    }
    await loadResult(target.id, target);
  };
  useEffect(() => {
    if (
      !pendingResultNavigation ||
      sourceId !== pendingResultNavigation.source_id ||
      sourceIsChanging
    )
      return;
    const target = pendingResultNavigation;
    setPendingResultNavigation(null);
    void loadResult(target.id, target);
  }, [
    pendingResultNavigation?.id,
    pendingResultNavigation?.revision_hash,
    sourceId,
    sourceIsChanging,
  ]);
  const publishGeneratedResult = async (target: ResearchResult) => {
    const next = await report(
      () => api.getSnapshot(),
      "Could not refresh immutable result history.",
    );
    if (next) adopt(next);
    await navigateExactResult(target);
  };
  const persistRevision = async (
    target: ResearchResult,
    measurements?: Array<Record<string, unknown>>,
  ): Promise<boolean> => {
    if (!snapshot || !sourceId) return false;
    const cursor = snapshot.selections.find((item) => item.id === sourceId);
    const saved = await report(async () => {
      const output = (await api.execute("select_result", {
        result_id: target.id,
        revision_hash: target.revision_hash,
        expected_revision: cursor?.revision ?? 0,
      })) as {
        selection?: ResearchSnapshot["selections"][number];
        result?: ResearchResult;
      };
      if (
        output.result?.id !== target.id ||
        output.result.revision_hash !== target.revision_hash ||
        output.selection?.id !== sourceId ||
        output.selection.data?.result_id !== target.id ||
        output.selection.data.revision_hash !== target.revision_hash
      )
        throw new Error(
          "The durable result selection did not match the requested revision.",
        );
      return output;
    }, "Could not persist the selected immutable revision.");
    if (!saved?.selection) return false;
    setSnapshot((current) => {
      if (!current) return current;
      return {
        ...current,
        results: current.results.some((item) => item.id === target.id)
          ? current.results.map((item) =>
              item.id === target.id ? target : item,
            )
          : [...current.results, target],
        selections: [
          ...current.selections.filter((item) => item.id !== sourceId),
          saved.selection!,
        ],
      };
    });
    setCorrectionPoints([]);
    await loadResult(target.id, target);
    if (measurements) setRows(measurements);
    const next = await report(
      () => api.getSnapshot(),
      "Could not refresh immutable result history.",
    );
    if (next) adopt(next);
    return true;
  };
  const moveRevision = async (direction: "undo" | "redo") => {
    if (!snapshot || !resultId || !sourceId) return;
    const current = snapshot.results.find((item) => item.id === resultId);
    if (!current) return;
    const children = snapshot.results.filter(
      (item) => item.parent_id === resultId,
    );
    const redoId =
      redoStack.at(-1) ?? (children.length === 1 ? children[0].id : null);
    const target =
      direction === "undo"
        ? snapshot.results.find((item) => item.id === current.parent_id)
        : snapshot.results.find(
            (item) => item.id === redoId && item.parent_id === resultId,
          );
    if (!target) return;
    if (await persistRevision(target))
      setRedoStack((old) =>
        direction === "undo" ? [...old, current.id] : old.slice(0, -1),
      );
  };
  const run = async () => {
    if (!source) return;
    setBusy("run");
    const output = await report(
      () =>
        api.execute("run_recipe", {
          source_id: source.id,
          selection: shownSelection,
          recipe,
        }) as Promise<{ result?: ResearchResult }>,
      "Recipe could not be run on this scope.",
    );
    setBusy(null);
    if (output?.result?.id) {
      await loadResult(output.result.id, output.result);
      await report(
        () => api.getSnapshot().then(adopt),
        "Could not refresh result history.",
      );
    }
  };
  const preview = async () => {
    if (!source) return;
    setBusy("preview");
    const output = await report(
      () =>
        api.execute("preview_recipe", {
          source_id: source.id,
          selection: shownSelection,
          recipe,
        }) as Promise<{ image: string; object_count: number }>,
      "Could not preview this recipe.",
    );
    if (output) {
      setResultView(null);
      setResultId(null);
      setImage(output.image);
    }
    setBusy(null);
  };
  const restoreRecipePreset = async (item: unknown) => {
    if (!source) return;
    const data =
      typeof item === "object" && item !== null
        ? (item as { data?: { name?: unknown; recipe?: unknown; selection?: unknown } }).data
        : undefined;
    if (!data || typeof data.name !== "string" || !data.recipe || typeof data.recipe !== "object")
      return;

    const recipeObj = data.recipe as typeof DEFAULT_RECIPE;
    if (dimensions && typeof recipeObj.segmentation?.channel === "number") {
      if (recipeObj.segmentation.channel >= dimensions.c) {
        setError(
          `Preset '${data.name}' requires channel ${recipeObj.segmentation.channel + 1}, but this source only has ${dimensions.c} channel(s).`,
        );
        return;
      }
    }

    const token = ++recipePresetToken.current;
    const checked = await report(
      () =>
        api.execute("validate_recipe", {
          source_id: source.id,
          selection: shownSelection,
          recipe: data.recipe,
        }) as Promise<{ recipe?: typeof DEFAULT_RECIPE }>,
      "Saved recipe is no longer valid for this source.",
    );
    if (token !== recipePresetToken.current) return;
    if (checked?.recipe) {
      setImage(null);
      setRecipe(checked.recipe);
    }
  };
  const save = async (data: ResearchSampleData) => {
    if (!source || !snapshot) return;
    const prior = snapshot.samples.find((item) => item.id === source.id);
    await report(async () => {
      await api.execute("sample", {
        id: source.id,
        source_id: source.id,
        expected_revision: prior?.revision ?? 0,
        data,
      });
      adopt(await api.getSnapshot());
    }, "Could not save sample metadata.");
  };
  const selectedResult =
    snapshot?.results.find((item) => item.id === resultId) ?? null;
  const selectedResultShape = selectedResult?.arrays?.image?.shape;
  const surfaceAvailable = Boolean(
    selectedResultShape?.length === 3 ||
      (!selectedResult &&
        dimensions &&
        (shownSelection.z_stop ?? shownSelection.z + 1) - shownSelection.z >= 2),
  );
  useEffect(() => {
    if (!surfaceAvailable) setSurfaceOpen(false);
  }, [surfaceAvailable]);
  const changeCorrectionView = useCallback((plane: Plane, index: number) => {
    setCorrectionPoints([]);
    setCorrectionView({ plane, index });
  }, []);
  const setCorrectionMutationBusy = useCallback((value: boolean) => {
    setBusy((current) =>
      value
        ? (current ?? "correction")
        : current === "correction"
          ? null
          : current,
    );
  }, []);
  useEffect(() => {
    if (tab !== "Correction" || !selectedResult) {
      setCorrectionViewLoading(false);
      return;
    }
    const token = ++resultViewToken.current;
    const expected = selectedResult;
    const axis = planeAxis(correctionView.plane);
    setCorrectionViewLoading(true);
    setResultView(null);
    void api
      .execute("result_view", {
        result_id: expected.id,
        axis,
        index: correctionView.index,
        labels: true,
      })
      .then((value) => {
        const rendered = exactResultView(
          value,
          expected,
          axis,
          correctionView.index,
        );
        if (token !== resultViewToken.current) return;
        setResultView(rendered);
        setError(null);
        setCorrectionViewLoading(false);
      })
      .catch((caught) => {
        if (token !== resultViewToken.current) return;
        setResultView(null);
        setError(
          message(
            caught,
            "Could not render the selected exact correction plane.",
          ),
        );
        setCorrectionViewLoading(false);
      });
  }, [
    api,
    correctionView.index,
    correctionView.plane,
    selectedResult?.id,
    selectedResult?.revision_hash,
    tab,
  ]);
  const expectedCorrectionAxis = planeAxis(correctionView.plane);
  const correctionViewReady = Boolean(
    selectedResult &&
    resultView &&
    resultView.resultId === selectedResult.id &&
    resultView.revisionHash === selectedResult.revision_hash &&
    resultView.axis === expectedCorrectionAxis &&
    resultView.index === correctionView.index,
  );
  const correctionPlaneSpacing = useMemo(
    () =>
      planeSpacing(
        correctionViewReady ? (resultView?.geometry ?? null) : null,
        correctionView.plane,
      ),
    [correctionView.plane, correctionViewReady, resultView?.geometry],
  );
  const displayedResultView =
    tab === "Correction"
      ? correctionViewReady
        ? resultView
        : null
      : resultView?.resultId === resultId
        ? resultView
        : null;
  const displayedPlane =
    displayedResultView?.axis === "y"
      ? "XZ"
      : displayedResultView?.axis === "x"
        ? "YZ"
        : "XY";
  const displayedPlaneDimensions = displayedResultView
    ? planeDimensions(displayedResultView.shape, displayedPlane)
    : { width: 0, height: 0 };
  const displayedCentroid = centroidOnView(
    selectedRow === null ? null : rows[selectedRow]?.centroid_index,
    displayedResultView,
  );
  const sourceResultOverlay = useMemo(() => {
    if (!source || !selectedResult || !displayedResultView) return null;
    const resolved = resolveResultPlaneOverlay(source, selectedResult, displayedResultView, 1);
    return resolved.ok ? resolved.overlay : null;
  }, [source, selectedResult, displayedResultView]);
  const pendingSourceResultCanvas = useMemo(() => {
    const shape = selectedResult?.arrays?.image?.shape;
    if (tab !== "Correction" || !correctionViewLoading || !source || !selectedResult ||
        correctionView.plane !== "XY" || correctionView.index !== 0 ||
        selectedResult.source_id !== source.id || selectedResult.source_sha256 !== source.sha256 ||
        !Array.isArray(shape) || shape.length !== 2 || !selectedResult.geometry) return false;
    return resolveResultPlaneOverlay(source, selectedResult, {
      image: "data:image/png;base64,pending",
      shape,
      resultId: selectedResult.id,
      revisionHash: selectedResult.revision_hash,
      axis: "z",
      index: 0,
      geometry: selectedResult.geometry,
    }).ok;
  }, [correctionView.index, correctionView.plane, correctionViewLoading, selectedResult, source, tab]);
  const resultDrawing = useMemo(() => tab === "Correction" && correctionPreview
    ? { ...correctionPreview, points: correctionPoints } : null,
  [tab, correctionPreview, correctionPoints]);

  const selectObject = useCallback(
    async (
      index: number,
      options?: { changeSlice?: boolean; preserveZoom?: boolean; locate?: boolean },
    ) => {
      const row = rows[index];
      if (!row || !resultId) return;
      const center = row.centroid_index;
      if (
        !Array.isArray(center) ||
        center.some((v) => typeof v !== "number" || !Number.isFinite(v))
      )
        return;

      let targetX: number | null = null;
      let targetY: number | null = null;

      if (center.length === 3) {
        const targetSlice = Math.round(center[0]);
        if (options?.changeSlice !== false) {
          if (
            !displayedResultView ||
            displayedResultView.axis !== "z" ||
            displayedResultView.index !== targetSlice
          ) {
            const expectedResult = resultId;
            const exactResult = snapshot?.results.find(
              (item) => item.id === resultId,
            );
            if (!exactResult) return;
            const token = ++resultViewToken.current;
            const rendered = await report(
              async () =>
                exactResultView(
                  await api.execute("result_view", {
                    result_id: expectedResult,
                    axis: "z",
                    index: targetSlice,
                    labels: true,
                  }),
                  exactResult,
                  "z",
                  targetSlice,
                ),
              "Could not show the selected object plane.",
            );
            if (!rendered || token !== resultViewToken.current) return;
            setResultView(rendered);
          }
        }
        targetX = center[2];
        targetY = center[1];
      } else if (center.length === 2) {
        targetX = center[1];
        targetY = center[0];
      }

      if (targetX !== null && targetY !== null) {
        if (sourceResultOverlay) {
          const uv = centroidOnView(center, displayedResultView);
          if (uv) {
            const srcPoint = resultPixelToSourcePoint(sourceResultOverlay, {
              u: Math.round(uv.u),
              v: Math.round(uv.v),
            });
            if (srcPoint) {
              targetX = srcPoint.x;
              targetY = srcPoint.y;
            }
          }
        } else if (selectedResult?.selection) {
          const offsetX = selectedResult.selection.x ?? 0;
          const offsetY = selectedResult.selection.y ?? 0;
          targetX += offsetX;
          targetY += offsetY;
        }
        setControlledViewCamera({
          x: targetX,
          y: targetY,
          scale: options?.locate
            ? Math.max(viewCamera?.scale ?? 1, 1.5)
            : (viewCamera ? viewCamera.scale : 1),
        });
      }

      setSelectedRow(index);
    },
    [rows, resultId, snapshot?.results, report, api, sourceResultOverlay, displayedResultView, viewCamera, selectedResult],
  );

  const handleObjectClick = useCallback(
    async (point: { x: number; y: number }) => {
      if (drawingAnalysisRegion || !displayedResultView || !resultId) return;
      let uv: { u: number; v: number } | null = null;
      if (sourceResultOverlay) {
        uv = sourcePointToResultPixel(sourceResultOverlay, point);
      } else {
        uv = { u: Math.round(point.x), v: Math.round(point.y) };
      }
      if (!uv) return;

      const token = ++objectPickToken.current;
      try {
        const response = (await api.execute("result_label_at", {
          result_id: resultId,
          revision_hash: displayedResultView.revisionHash,
          axis: displayedResultView.axis,
          index: displayedResultView.index,
          u: Math.round(uv.u),
          v: Math.round(uv.v),
        })) as { label: number; result_id: string; revision_hash: string } | undefined;

        if (token !== objectPickToken.current) return;
        if (!response || response.label === 0) {
          setSelectedRow(null);
          return;
        }

        const label = response.label;
        const targetIndex = rows.findIndex((r) => r.label === label);
        if (targetIndex >= 0) {
          void selectObject(targetIndex, { changeSlice: false, preserveZoom: true });
        } else {
          setSelectedRow(null);
        }
      } catch {
        // Ignore pick errors or revision race
      }
    },
    [drawingAnalysisRegion, displayedResultView, resultId, sourceResultOverlay, rows, api, selectObject],
  );
  const displayedSpacing = planeSpacing(displayedResultView?.geometry ?? null, displayedPlane);
  const resultAspectY = displayedSpacing ? displayedSpacing.v / displayedSpacing.u : 1;
  const canvasPlaneDimensions = displayedResultView
    ? displayedPlaneDimensions
    : { width: 1, height: 1 };
  useEffect(() => {
    const frame = imageFrameRef.current;
    const sourceWidth = Math.max(1, canvasPlaneDimensions.width);
    const sourceHeight = Math.max(1, canvasPlaneDimensions.height);
    const update = () => {
      const bounds = frame?.getBoundingClientRect();
      const scale =
        imageScale === "fit" && bounds?.width && bounds.height
          ? Math.min(
              (bounds.width * 0.95) / sourceWidth,
              (bounds.height * 0.95) / (sourceHeight * resultAspectY),
            )
          : 1 / (window.devicePixelRatio || 1);
      const next = {
        width: sourceWidth * scale,
        height: sourceHeight * scale * resultAspectY,
      };
      setCanvasContentSize((old) =>
        Math.abs(old.width - next.width) < 0.01 &&
        Math.abs(old.height - next.height) < 0.01
          ? old
          : next,
      );
    };
    update();
    if (!frame || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [
    canvasPlaneDimensions.height,
    canvasPlaneDimensions.width,
    imageScale,
    resultAspectY,
  ]);
  const redoChildren =
    snapshot?.results.filter((item) => item.parent_id === resultId) ?? [];
  const redoTargetId =
    redoStack.at(-1) ?? (redoChildren.length === 1 ? redoChildren[0].id : null);
  const openWorkbenchTab = (next: WorkbenchTab) => {
    setTab(next);
    if (next === "Annotate" || next === "Epidermis") {
      setRawVolumeOpen(false); setSurfaceOpen(false); setAbCompareMode(false);
      setProjection("plane");
      setSelection((previous) => { const { z_stop: _stop, ...plane } = previous; return plane; });
      setAnnotationDraft([]);
      if (next === "Epidermis") {
        setResultId(null); setResultView(null); setImage(null); setVolume(null);
        setAnnotationTool("transect");
      }
    }
  };
  if (!snapshot)
    return (
      <main className={`image-first-empty${emptyDropActive ? " is-drag-active" : ""}`} aria-label="Loci workspace"
        inert={documentSwitching} aria-busy={documentSwitching || undefined}
        onDragEnter={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          emptyDropDepth.current += 1;
          setEmptyDropActive(true);
        }}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          emptyDropDepth.current = Math.max(0, emptyDropDepth.current - 1);
          if (emptyDropDepth.current === 0) setEmptyDropActive(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          resetEmptyDrop();
          const files = Array.from(event.dataTransfer.files);
          if (event.dataTransfer.types.includes("Files") && files.length && api.openDropped) {
            void report(async () => {
              const output = await api.openDropped!(files);
              if (output) {
                adopt(output, output.sources[output.sources.length - 1]?.id);
              }
            }, "Could not open the dropped images.");
          }
        }}>
        <header className="image-first-header"><div className="brand-lockup"><BrandMark /><span className="brand-name">Loci</span></div>
          <span />{onOpenSettings && <button title="Appearance and preferences" aria-label="Open settings" onClick={onOpenSettings}><Settings2 /></button>}</header>
        <ImageWelcome api={api} onOpen={(kind) => void openImages(kind)}
          onConvert={() => openWorkbenchTab("Vendor import")}
          onStudy={() => { resetEmptyDrop(); void report(() => api.openStudy().then(adopt), "Could not open this study."); }}
          onEmptyStudy={() => { resetEmptyDrop(); void report(() => api.createStudy().then(adopt), "Could not create this study."); }}
          onLegacy={() => void openLegacy()} state={session} onRecovery={adopt} onError={setError}
          dragActive={emptyDropActive} busy={busy !== null || documentSwitching} />
        {(busy || documentSwitching) && <div className="welcome-progress" role="status">{documentSwitching ? "Updating workspace…" : "Opening images…"}</div>}
        {error && <ResearchError error={error} onDismiss={() => setError(null)} />}
        <ContextHelp enabled={preferences.viewer.contextualHelp} />
      </main>
    );
  const is3D = Boolean(rawVolumeOpen || (dimensions && dimensions.z > 1));
  return (
    <main className={`research-workbench image-first-workbench ${is3D ? "is-3d-active" : ""}`} aria-label="Research workspace"
      inert={documentSwitching} aria-busy={documentSwitching || undefined}
      style={
        {
          "--research-sources-width": `${sourcesWidth}px`,
          "--research-inspector-width": `${inspectorWidth}px`,
          cursor: isDraggingSources ? "col-resize" : undefined,
          userSelect: isDraggingSources ? "none" : undefined,
        } as React.CSSProperties
      }
      onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
      onDrop={(event) => {
        event.preventDefault();
        const files = Array.from(event.dataTransfer.files);
        if (api.openDropped && files.length) {
          void report(async () => {
            const previous = new Set(snapshot?.sources.map((item) => item.id));
            const output = await api.openDropped!(files);
            if (output) {
              const added = output.sources.find((item) => !previous.has(item.id)) ?? output.sources[output.sources.length - 1];
              adopt(output, added?.id);
            }
          }, "Could not open the dropped images.");
        }
      }}
>
      <header>
        <div className="brand-lockup"><BrandMark /><span className="brand-name">Loci</span></div>
        <strong className="active-image-name" aria-label="Active image">
          {source?.name ?? (snapshot.sources.length === 0 ? "No image open" : snapshot.project.title)}
        </strong>
        <span className="session-save-state" title="Changes to annotations, results and study records are saved locally. Original images remain in their selected locations.">{session.status === "ready" && session.storage === "managed" ? "Autosaved session" : "Saved locally"}</span>
        <button title="Open images without changing the active study's existing sources" onClick={() => void openImages()}><ImagePlus /> Open images</button>
        <button aria-label="Save study" title="Choose a name and location for this study" disabled={!api.saveAs}
          onClick={() => void report(() => api.saveAs!().then(adopt), "Could not save this study.")}><Save /> Save study…</button>
        <details className="workbench-file-menu"
          onKeyDown={(event) => { if (event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); } }}
          onBlur={(event) => { if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false; }}
          onClick={(event) => { if (event.target instanceof Element && event.target.closest("button")) event.currentTarget.open = false; }}><summary title="Open folders, series and studies; save a study copy">File</summary><div>
          <button onClick={() => void openImages("folder")}>Open folder</button>
          <button onClick={() => void openImages("dicom")}>Open DICOM series</button>
          <button onClick={() => void openImages("ome_zarr")}>Open OME-Zarr store</button>
          <button onClick={() => void report(() => api.openStudy().then(adopt), "Could not open this study.")}>Open study</button>
          <button onClick={() => void openLegacy()}>Open .loci-project</button>
          <button disabled={!api.saveAs} onClick={() => void report(() => api.saveAs!().then(adopt), "Could not save this study.")}>Save as study…</button>
          <button onClick={() => void report(async () => {
            const store = viewStore.current; store?.pause();
            if (store && !await store.flush()) { store.resume(); throw new Error("Could not save display settings before opening recent work."); }
            try { if (api.newSession) setSession(await api.newSession()); }
            catch (error) { store?.resume(); throw error; }
            viewStore.current = null; projectionSourceId.current = null; displayToken.current++;
            setViewSettingsReady(false); setSnapshot(null); void api.sessionState?.().then(setSession);
          }, "Could not open recent work.")}>Recent work</button>
        </div></details>
        {onOpenSettings && (
          <button title="Appearance and preferences" aria-label="Open settings" onClick={onOpenSettings}>
            <Settings2 />
          </button>
        )}
      </header>
      {error && <ResearchError error={error} onDismiss={() => setError(null)} />}
      <ContextHelp enabled={preferences.viewer.contextualHelp} />
      <div className="research-sources-pane">
        <aside className="research-sources">
          <div className="research-sources-header">
            <h2>
              Images{" "}
              {snapshot.sources.length > 0 && (
                <span className="research-sources-count">({snapshot.sources.length})</span>
              )}
            </h2>
            <div className="research-sources-header-actions">
              <button
                type="button"
                className="research-source-icon-btn"
                title="Add images"
                aria-label="Add images"
                onClick={() => void openImages()}
              >
                <Plus size={14} />
              </button>
              <button
                type="button"
                className="research-source-icon-btn"
                disabled={snapshot.sources.length === 0}
                title={
                  selectedSourceIds.length > 1
                    ? `Remove ${selectedSourceIds.length} selected images`
                    : "Remove selected image"
                }
                aria-label="Remove selected images"
                onClick={() => void handleCloseSelectedSources()}
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
          {workspaceUndo && (
            <div className="workspace-change-receipt" role="status">
              <span>{workspaceUndo.message}</span>
              <button onClick={() => void handleWorkspaceUndo()}>Undo</button>
            </div>
          )}
          <div className="research-sources-list" role="list">
            {snapshot.sources.map((item, index) => {
              const isSelected = selectedSourceIds.includes(item.id);
              const isActive = item.id === sourceId;
              const isDragging = sourceDragState?.sourceId === item.id;
              const isGhost = isDragging;
              const isDropped = recentlyDroppedSourceId === item.id;

              let shiftY = 0;
              if (sourceDragState) {
                const { startIndex, currentIndex, rect, rowRects } = sourceDragState;
                const rowGap =
                  rowRects.length > 1
                    ? Math.abs(rowRects[1].top - rowRects[0].bottom)
                    : 6;
                const rowStep = rect.height + rowGap;

                if (index === startIndex) {
                  shiftY = (currentIndex - startIndex) * rowStep;
                } else if (currentIndex > startIndex) {
                  if (index > startIndex && index <= currentIndex) {
                    shiftY = -rowStep;
                  }
                } else if (currentIndex < startIndex) {
                  if (index >= currentIndex && index < startIndex) {
                    shiftY = rowStep;
                  }
                }
              }

              return (
                <SourceListItem
                  key={item.id}
                  item={item}
                  index={index}
                  isSelected={isSelected}
                  isActive={isActive}
                  isGhost={isGhost}
                  isDropped={isDropped}
                  shiftY={shiftY}
                  isDraggingAny={sourceDragState !== null}
                  dimensions={meta(item).dimensions}
                  onClick={handleSourceClick}
                  onPointerDown={handleSourcePointerDown}
                  onKeyDown={handleSourceKeyDown}
                />
              );
            })}
            {sourceDragState && (
              <div
                className="research-source-floating-card"
                style={{
                  left: sourceDragState.rect.left,
                  top: Math.max(
                    sourceDragState.bounds.minTop,
                    Math.min(
                      sourceDragState.bounds.maxTop,
                      sourceDragState.currentY - sourceDragState.grabOffsetY,
                    ),
                  ),
                  width: sourceDragState.rect.width,
                  height: sourceDragState.rect.height,
                }}
              >
                <span className="research-source-drag-handle" aria-hidden="true">
                  <GripVertical size={13} />
                </span>
                <div className="research-source-item-content">
                  <span className="research-source-name">{sourceDragState.item.name}</span>
                  <small>
                    {meta(sourceDragState.item).dimensions.c} C / {meta(sourceDragState.item).dimensions.z} Z
                  </small>
                </div>
              </div>
            )}
          </div>
          <h2>Layers & results</h2>
          {source && <button className={!resultId ? "selected" : ""} aria-pressed={!resultId}
            onClick={() => { setResultId(null); setResultView(null); setImage(null); }}>Original image</button>}
          {snapshot.results
            .filter((item) => item.source_id === sourceId)
            .map((item) => (
              <button
                key={item.id}
                disabled={sourceIsChanging}
                data-result-id={item.id}
                title={`Exact revision ${item.revision_hash}`}
                className={item.id === resultId ? "selected" : ""}
                aria-pressed={item.id === resultId}
                onClick={() => {
                  setRedoStack([]);
                  void loadResult(item.id, item);
                }}
              >
                {item.kind}
                <small>{item.object_count} objects</small>
              </button>
            ))}
          <WorkspaceRecordActions key={studyEpoch} api={api} snapshot={snapshot} source={source}
            busy={busy !== null} onBusy={setBusy} onError={setError} onChange={(next) => {
              if (resultId && !next.results.some((item) => item.id === resultId)) {
                setResultId(null); setResultView(null); setImage(null); setRows([]); setSelectedRow(null);
                setCorrectionPoints([]); setRedoStack([]);
              }
              adopt(next);
            }} />
        </aside>
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize image panel"
          tabIndex={0}
          className={`research-sources-resizer ${isDraggingSources ? "is-dragging" : ""}`}
          onPointerDown={handleSourcesResizeStart}
          onKeyDown={handleSourcesResizeKeyDown}
        />
      </div>
      <section className="research-canvas">
        {(resultId || (dimensions && dimensions.z > 1) || snapshot.sources.length >= 2) && <div className="research-canvas-toolbar">
          {snapshot.sources.length >= 2 && !rawVolumeOpen && !surfaceOpen && !resultId && (
            <button
              className={abCompareMode ? "active" : ""}
              aria-pressed={abCompareMode}
              title="Visual comparison of two pinned images side by side"
              onClick={() => setAbCompareMode((previous) => !previous)}
            >
              Compare A/B
            </button>
          )}
          {resultId && !sourceResultOverlay && !pendingSourceResultCanvas && <div className="research-actions" aria-label="Image scale">
            <button
              className={imageScale === "fit" ? "active" : ""}
              aria-pressed={imageScale === "fit"}
              onClick={() => setImageScale("fit")}
            >
              Fit
            </button>
            <button
              className={imageScale === "actual" ? "active" : ""}
              aria-pressed={imageScale === "actual"}
              onClick={() => setImageScale("actual")}
            >
              1:1
            </button>
          </div>}
          {sourceResultOverlay && (
            <>
              <span className="result-source-link">Result on source · Z {(selectedResult?.selection?.z ?? 0) + 1}, T {(selectedResult?.selection?.t ?? 0) + 1}</span>
              {rows.length > 0 && <span className="result-source-count">{rows.length} objects</span>}
              <button
                type="button"
                className="research-review-export-quick-btn"
                title="Inspect measurements and export results in Review panel"
                onClick={() => setTab("Info")}
              >
                Review & Export
              </button>
            </>
          )}
          {pendingSourceResultCanvas && <span className="result-source-link" role="status">Loading result…</span>}
          {dimensions && dimensions.z > 1 && <><button title={rawVolumeOpen ? "Return to the 2D source plane" : rawVolumeUnavailable ?? "Explore the complete raw volume"} aria-pressed={rawVolumeOpen}
            disabled={!rawVolumeOpen && Boolean(rawVolumeUnavailable)}
            onClick={() => { setRawVolumeOpen((open) => !open); setSurfaceOpen(false); }}><Box />{rawVolumeOpen ? "2D image" : "3D volume"}</button>
            {!rawVolumeOpen && rawVolumeUnavailable && <span role="status">{rawVolumeUnavailable}</span>}</>}
          {surfaceAvailable && <button
            aria-pressed={surfaceOpen}
            onClick={() => setSurfaceOpen((open) => !open)}
          >
            Surface
          </button>}
          {resultId && (
            <button
              onClick={() => {
                setResultId(null);
                setResultView(null);
                setSelectedRow(null);
                setRedoStack([]);
              }}
            >
              Show source
            </button>
          )}
        </div>}
        {source && rawVolumeOpen ? (
          <RawVolumeViewport volume={rawVolume} loading={rawVolumeLoading} error={rawVolumeError}
            onRequestRefinement={requestRawVolume} onExportFigure={api.exportVolumeFigure} />
        ) : source && surfaceOpen ? (
          <ResearchSurfaceView
            api={api}
            sourceId={source.id}
            selection={shownSelection}
            result={selectedResult}
            onClose={() => setSurfaceOpen(false)}
          />
        ) : !sourceResultOverlay && !pendingSourceResultCanvas && (displayedResultView ||
          (tab === "Correction" && resultId && correctionViewLoading)) ? (
        <div
          ref={imageFrameRef}
          className={`research-image-frame research-image-${imageScale}`}
          onPointerDown={(event) => {
            if (busy) return;
            const bounds = event.currentTarget
              .querySelector("img")
              ?.getBoundingClientRect();
            if (!bounds || !bounds.width || !bounds.height) return;
            if (
              tab === "Correction" &&
              correctionViewReady &&
              displayedResultView &&
              displayedPlaneDimensions.width > 0 &&
              displayedPlaneDimensions.height > 0
            ) {
              const { width, height } = displayedPlaneDimensions;
              const u = Math.round(
                ((event.clientX - bounds.left) / bounds.width) * width - 0.5,
              );
              const v = Math.round(
                ((event.clientY - bounds.top) / bounds.height) * height - 0.5,
              );
              if (correctionPreview?.kind === "vertices") {
                if (event.button !== 0) return;
                const distances = correctionPoints.map((p) => Math.hypot(
                  (p.u + 0.5) / width * bounds.width + bounds.left - event.clientX,
                  (p.v + 0.5) / height * bounds.height + bounds.top - event.clientY));
                const closest = Math.min(...distances);
                if (closest <= 10) {
                  const index = distances.indexOf(closest); correctionVertexDrag.current = index;
                  correctionPreview.onSelectVertex(index); event.currentTarget.setPointerCapture(event.pointerId);
                }
                return;
              }
              if (u >= 0 && v >= 0 && u < width && v < height)
                setCorrectionPoints((old) => [...old, { u, v }]);
              return;
            } else if (displayedResultView && displayedPlaneDimensions.width > 0 && displayedPlaneDimensions.height > 0) {
              const { width, height } = displayedPlaneDimensions;
              const u = Math.round(((event.clientX - bounds.left) / bounds.width) * width - 0.5);
              const v = Math.round(((event.clientY - bounds.top) / bounds.height) * height - 0.5);
              if (u >= 0 && v >= 0 && u < width && v < height) {
                void handleObjectClick({ x: u, y: v });
              }
            }
          }}
          onPointerMove={(event) => {
            if (busy || !correctionViewReady || correctionPreview?.kind !== "vertices" || correctionVertexDrag.current === null) return;
            const bounds = event.currentTarget.querySelector("img")?.getBoundingClientRect();
            if (!bounds?.width || !bounds.height) return;
            const { width, height } = displayedPlaneDimensions;
            const u = Math.round((event.clientX - bounds.left) / bounds.width * width - 0.5);
            const v = Math.round((event.clientY - bounds.top) / bounds.height * height - 0.5);
            if (u >= 0 && v >= 0 && u < width && v < height)
              correctionPreview.onMoveVertex(correctionVertexDrag.current, { u, v });
          }}
          onPointerUp={() => { correctionVertexDrag.current = null; }}
          onPointerCancel={() => { correctionVertexDrag.current = null; }}
        >
          {displayedResultView ? (
            <div
              className="research-result-image"
              style={
                {
                  width: canvasContentSize.width,
                  height: canvasContentSize.height,
                }
              }
            >
              <img
                src={displayedResultView.image}
                alt="Exact selected result revision"
              />
              {tab === "Correction" &&
                correctionPreview &&
                (correctionPoints.length > 0 ||
                  correctionPreview.savedSeeds.length > 0) && (
                  <svg
                    viewBox={`-0.5 -0.5 ${displayedPlaneDimensions.width} ${displayedPlaneDimensions.height}`}
                    aria-label="Correction drawing preview"
                  >
                    {correctionPreview.kind === "polygon" &&
                      (correctionPoints.length >= 3 ? (
                        <polygon
                          aria-label="Polygon preview in voxel coordinates"
                          points={correctionPoints
                            .map((point) => `${point.u},${point.v}`)
                            .join(" ")}
                          fill="rgba(255, 207, 92, 0.2)"
                          stroke="#ffcf5c"
                          strokeWidth="1.5"
                          vectorEffect="non-scaling-stroke"
                        />
                      ) : (
                        <polyline
                          aria-label="Polygon draft in voxel coordinates"
                          points={correctionPoints
                            .map((point) => `${point.u},${point.v}`)
                            .join(" ")}
                          fill="none"
                          stroke="#ffcf5c"
                          strokeWidth="1.5"
                          vectorEffect="non-scaling-stroke"
                        />
                      ))}
                    {correctionPreview.kind === "vertices" && <g aria-label="Boundary vertex preview">
                      <polygon points={correctionPreview.sourceVertices.map((p) => `${p.u},${p.v}`).join(" ")}
                        fill="none" stroke="#d9c99a" strokeWidth="1" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
                      <polygon points={correctionPoints.map((p) => `${p.u},${p.v}`).join(" ")}
                        fill="none" stroke="#ffcf5c" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
                      {correctionPoints.map((p, index) => <ellipse key={index} cx={p.u} cy={p.v}
                        rx={(index === correctionPreview.selectedIndex ? 5 : 3) * displayedPlaneDimensions.width / Math.max(1, canvasContentSize.width)}
                        ry={(index === correctionPreview.selectedIndex ? 5 : 3) * displayedPlaneDimensions.height / Math.max(1, canvasContentSize.height)}
                        fill={index === correctionPreview.selectedIndex ? "#ffcf5c" : "#151515"}
                        stroke="#ffcf5c" strokeWidth="1" vectorEffect="non-scaling-stroke" />)}
                    </g>}
                    {correctionPreview.kind === "brush" && (
                      <g
                        aria-label={`Physical brush footprint in ${correctionPreview.unit}`}
                      >
                        {correctionPoints.length > 1 && (
                          <polyline
                            points={correctionPoints
                              .map((point) => `${point.u},${point.v}`)
                              .join(" ")}
                            fill="none"
                            stroke="rgba(255, 207, 92, 0.55)"
                            strokeWidth={Math.max(
                              1,
                              2 *
                                Math.min(
                                  correctionPreview.radiusU,
                                  correctionPreview.radiusV,
                                ),
                            )}
                          />
                        )}
                        {correctionPoints.map((point, pointIndex) => (
                          <ellipse
                            key={`${point.u}-${point.v}-${pointIndex}`}
                            cx={point.u}
                            cy={point.v}
                            rx={Math.max(0.25, correctionPreview.radiusU)}
                            ry={Math.max(0.25, correctionPreview.radiusV)}
                            fill="rgba(255, 207, 92, 0.25)"
                            stroke="#ffcf5c"
                            strokeWidth="1"
                            vectorEffect="non-scaling-stroke"
                          />
                        ))}
                      </g>
                    )}
                    {correctionPreview.kind === "seeds" && (
                      <g aria-label="Watershed seed preview in voxel coordinates">
                        {[
                          ...correctionPreview.savedSeeds,
                          ...correctionPoints,
                        ].map((point, pointIndex) => (
                          <circle
                            key={`${point.u}-${point.v}-${pointIndex}`}
                            cx={point.u}
                            cy={point.v}
                            r="2.5"
                            fill={
                              pointIndex < correctionPreview.savedSeeds.length
                                ? "#61d8c0"
                                : "#ffcf5c"
                            }
                            stroke="#07100d"
                            strokeWidth="1"
                            vectorEffect="non-scaling-stroke"
                          />
                        ))}
                      </g>
                    )}
                  </svg>
                )}
              {displayedCentroid && (
                <svg
                  viewBox={`-0.5 -0.5 ${displayedPlaneDimensions.width} ${displayedPlaneDimensions.height}`}
                  aria-label="Selected object centroid"
                >
                  <circle
                    cx={displayedCentroid.u}
                    cy={displayedCentroid.v}
                    r="6"
                    fill="none"
                    stroke="#ffffff"
                    strokeWidth="1.5"
                    vectorEffect="non-scaling-stroke"
                  />
                </svg>
              )}
            </div>
          ) : (
            <p role="status">Loading exact correction plane…</p>
          )}
        </div>
        ) : abCompareMode && snapshot.sources.length >= 2 ? (
          <ResearchAbComparison
            api={api}
            sources={snapshot.sources}
            initialSourceId={source?.id ?? snapshot.sources[0].id}
            preferences={preferences}
            onExit={() => setAbCompareMode(false)}
            onError={setError}
          />
        ) : source && channels.length && viewSettingsReady && !sourceIsChanging ? (
          <ImageViewport
            showScaleBar={preferences.viewer.showScaleBar}
            showNavigator={preferences.viewer.showNavigator}
            paused={documentSwitching}
            key={`${documentEpoch}:${source.id}`}
            api={api}
            source={source}
            selection={sourceResultOverlay && selectedResult?.selection ? selectedResult.selection : shownSelection}
            channels={compareDefault ? defaultChannels : channels}
            projection={sourceResultOverlay ? "plane" : resolvedProjection}
            initialCamera={savedCamera}
            controlledCamera={controlledViewCamera}
            onCamera={(camera) => {
              setViewCamera(camera);
              if (controlledViewCamera) {
                setControlledViewCamera(null);
              }
            }}
            onObjectClick={drawingAnalysisRegion ? undefined : handleObjectClick}
            onViewReady={setViewReadyKey}
            overrideImage={sourceResultOverlay || pendingSourceResultCanvas ? null : image}
            resultOverlay={sourceResultOverlay}
            resultDrawing={sourceResultOverlay && !busy ? resultDrawing : null}
            resultCentroid={sourceResultOverlay ? displayedCentroid : null}
            onResultPoint={sourceResultOverlay && tab === "Correction" && correctionViewReady && !busy && correctionPreview?.kind !== "vertices"
              ? (point) => setCorrectionPoints((old) => [...old, point]) : undefined}
            showRegion={!sourceResultOverlay && ["Process", "Analyze", "Quantify", "Model"].includes(tab)}
            onRegion={drawingAnalysisRegion ? (region) => {
              setSelection((old) => ({ ...old, ...region, level: 0 })); setDrawingAnalysisRegion(false);
            } : undefined}
            annotations={sourceAnnotations}
            draft={tab === "Annotate" || tab === "Epidermis" ? annotationDraft : []}
            drawingMode={tab === "Annotate" || tab === "Epidermis" ? annotationTool : "navigate"}
            onDraftChange={setAnnotationDraft}
            onPoint={(tab === "Annotate" || tab === "Epidermis") && annotationTool !== "navigate" ? (point) => setAnnotationDraft((old) => {
              const maximum = annotationTool === "point" ? 1 : ["polygon", "freehand"].includes(annotationTool) ? 2048 : 2;
              return old.length >= maximum ? [point] : [...old, point];
            }) : undefined}
            overlayRight={is3D ? 0 : inspectorWidth}
            onError={setError}
          />
        ) : (
          <div className="research-image-frame research-image-frame-empty">
            <div className="research-empty-canvas-content" role={source ? "status" : undefined}>
              <h2>{source ? "Preparing image…" : "Open an image to begin"}</h2>
              <p>{source ? "Loading the selected source." : "Explore images, annotate structures, and measure with traceable results."}</p>
              {!source && (
                <p className="empty-formats">
                  TIFF · OME-TIFF · IMS · OME-Zarr · CZI · ND2 · LIF · DICOM · PNG · JPEG
                </p>
              )}
            </div>
          </div>
        )}
        {dimensions && dimensions.z > 1 && !rawVolumeOpen && <div className="research-orthogonal">
          {dimensions && dimensions.z > 1 && (
            <button disabled={source?.locator_state === "relink-required"} onClick={() => void openVolume()}>
              Load linked orthogonal crop
            </button>
          )}
          {volume && (
            <Orthogonal
              volume={volume}
              onCrosshair={(crosshair) => void openVolume(crosshair)}
            />
          )}
        </div>}
      </section>
      <div className="research-inspector-shell">
      <InspectorResizeHandle width={inspectorWidth} onChange={setInspectorWidth} />
      <aside className="research-inspector">
        <WorkbenchTools tab={tab} onTab={openWorkbenchTab} source={source} hasResult={Boolean(selectedResult)} hasStudyResults={snapshot.results.length > 0} />
        {!source && (
          <div className="research-inspector-empty">
            <div className="research-inspector-empty-body">
              <SlidersHorizontal className="research-inspector-empty-icon" size={24} />
              <h3>No image selected</h3>
              <p>Select an image to adjust display settings and channels.</p>
            </div>
          </div>
        )}
        {source && dimensions && ["Process", "Analyze", "Quantify", "Model"].includes(tab) && <div className="analysis-scope-control">
          <span>Analysis scope</span><strong>{shownSelection.width === dimensions.x && shownSelection.height === dimensions.y ? "Whole image" : "Selected region"}</strong>
          <small>{shownSelection.width.toLocaleString()} × {shownSelection.height.toLocaleString()}{shownSelection.z_stop ? ` × ${shownSelection.z_stop - shownSelection.z} Z` : " · one plane"}</small>
          <div><button aria-pressed={drawingAnalysisRegion} onClick={() => { setDrawingAnalysisRegion((value) => !value); setRawVolumeOpen(false); setResultId(null); }}>{drawingAnalysisRegion ? "Cancel drawing" : "Draw region"}</button>
            <button onClick={() => { setSelection((old) => ({ ...old, x: 0, y: 0, width: dimensions.x, height: dimensions.y, level: 0 })); setDrawingAnalysisRegion(false); }}>Whole image</button></div>
          {drawingAnalysisRegion && <p>Drag a rectangle on the image. Right-drag still pans.</p>}
          {shownSelection.width * shownSelection.height * ((shownSelection.z_stop ?? shownSelection.z + 1) - shownSelection.z) * 96 > recipe.working_bytes && <p>Select a smaller region for the current analysis memory budget.</p>}
        </div>}
        {source && <div hidden={tab !== "Annotate" && tab !== "Epidermis"}><SourceAnnotationPanel key={`${documentEpoch}:${source.id}`} api={api} source={source}
          measurementMode={tab === "Epidermis" ? "epidermis" : "general"}
          selection={shownSelection} tool={annotationTool} onTool={(tool) => {
            setAnnotationTool(tool);
            if (tool !== "navigate") {
              setResultId(null); setResultView(null); setImage(null); setVolume(null);
              setProjection("plane");
              setSelection((previous) => { const { z_stop: _stop, ...plane } = previous; return plane; });
            }
          }}
          points={annotationDraft} onPoints={setAnnotationDraft} onAnnotations={setSourceAnnotations} onError={setError} /></div>}
        {source && dimensions && tab === "Display" && rawVolumeOpen && <section className="volume-inspector" aria-label="Volume workspace information">
          <h2>Volume workspace</h2>
          <p>Explore three linked slice planes and a 3D view. Expand any pane for a closer look.</p>
          <dl><dt>Source grid</dt><dd>{dimensions.x} × {dimensions.y} × {dimensions.z}</dd>
            <dt>Coordinates</dt><dd>{rawVolume?.context.frame === "image" ? "Source image axes" : rawVolume?.context.frame ?? "Loading…"}</dd>
            <dt>Units</dt><dd>{rawVolume?.context.unit ?? "Loading…"}</dd></dl>
          {dimensions.t > 1 && <label>Time <output>{shownSelection.t + 1} / {dimensions.t}</output>
            <input aria-label="Volume time frame" type="range" min={0} max={dimensions.t - 1} value={shownSelection.t}
              onChange={(event) => setSelection((previous) => ({ ...previous, t: Number(event.target.value) }))} /></label>}
          <h3>Display controls</h3><p>Adjust volume channel colours, range and opacity below the panes. The fourth pane switches between volume rendering and intersecting planes.</p>
          <details><summary>Navigation</summary><p>Drag a slice crosshair to update all planes. Scroll or use ↑/↓ to step through that slice.</p>
            <p>In 3D, drag to rotate, right-drag or Shift-drag to pan, and scroll to zoom. R resets the camera.</p></details>
          <p className="volume-inspector-note">Slices use the displayed grid with linear resampling. PNG export captures the 3D pane and records its display settings.</p>
          <div className="research-actions"><button onClick={() => setRawVolumeOpen(false)}>Return to 2D</button>
            <button onClick={() => setTab("Info")}>Image details</button></div>
        </section>}
        {source && tab === "Display" && !rawVolumeOpen && abCompareMode && <section className="volume-inspector" aria-label="Comparison information">
          <h2>Compare images</h2><p>Choose each source above the panes. Time, depth and visible channels are controlled within each pane.</p>
          <p>Match display copies compatible channel settings from A to B for this comparison. Shared display limits do not establish equivalent biological signal.</p>
          <p>Linked navigation requires the same source coordinate grid. Different images can be compared independently.</p>
          <button onClick={() => setAbCompareMode(false)}>Return to single image</button>
        </section>}
        {source && dimensions && tab === "Display" && !rawVolumeOpen && !abCompareMode && (
          <><SourceDisplayPanel
            api={api}
            source={source}
            sources={snapshot.sources}
            selectedSourceIds={selectedSourceIds.length ? selectedSourceIds : [source.id]}
            viewReady={viewReadyKey === `${source.id}:${source.sha256}:${shownSelection.t}:${shownSelection.z}`}
            projection={resolvedProjection}
            onProjection={setProjection}
            selection={shownSelection}
            channels={channels}
            onSelection={setSelection}
            onChannels={(value) => { setChannels(value); setRgbMapping(null); }}
            onBeforeBatch={async () => {
              const store = viewStore.current;
              if (store && !await store.flush())
                throw new Error("Resolve the saved display error before applying batch colors.");
            }}
            onBatchApplied={(response: BatchChannelColorsResponse, updatedChannels) => {
              const revision = response.new_revisions[source.id];
              try {
                if (updatedChannels && revision === undefined)
                  throw new Error("The batch display response omitted the active source revision.");
                if (revision !== undefined) viewStore.current?.adoptRevision(revision);
              } catch (caught) {
                viewStore.current?.pause();
                viewStore.current = null;
                projectionSourceId.current = null;
                setViewSettingsReady(false);
                setDocumentEpoch((previous) => previous + 1);
                setError(message(caught, "Could not synchronize the batch display revision."));
                return;
              }
              if (updatedChannels) {
                batchViewAdoption.current = {
                  sourceId: source.id,
                  sourceSha256: source.sha256,
                  channels: updatedChannels,
                };
                setChannels(updatedChannels);
                setRgbMapping(null);
              }
            }}
            rgbMapping={rgbMapping}
            onRgbMapping={(mapping) => {
              setRgbMapping(mapping);
              if (!mapping) { setChannels(defaultChannels); return; }
              setChannels((old) => old.map((item) => {
                const index = mapping.indexOf(item.channel);
                return { ...item, visible: index >= 0, opacity: 1, color: ["#ff0000", "#00ff00", "#0000ff"][index] ?? item.color };
              }));
            }}
            interpretation={interpretation}
            onInterpretation={(value) => {
              setInterpretation(value);
              setRawVolumeOpen(value === "volume" && dimensions.z > 1 && !rawVolumeUnavailable);
              if (value === "histology" && isRgb) setSegmentationFamily("stain");
              else setSegmentationFamily("classical");
            }}
            onTask={(task) => { if (task === "volume") setRawVolumeOpen(!rawVolumeUnavailable); else openWorkbenchTab(task); }}
            onReset={() => { setChannels(defaultChannels); setRgbMapping(null); }}
            onCompare={setCompareDefault}
            onAuto={(channel) => {
              const currentSource = source.id;
              const token = displayToken.current;
              const autoToken = ++autoRequestToken.current;
              const planeKey = autoPlaneKey;
              void report(async () => {
                const output = await api.execute("viewer_defaults", { source_id: currentSource, t: shownSelection.t, z: shownSelection.z, auto: true }) as { source_id: string; source_sha256: string; channels: Channel[] };
                if (displayToken.current !== token || projectionSourceId.current !== currentSource ||
                    autoRequestToken.current !== autoToken || autoPlaneRef.current !== planeKey) return;
                if (output.source_id !== currentSource || output.source_sha256 !== source.sha256 || !Array.isArray(output.channels))
                  throw new Error("Auto range does not match the selected source.");
                setChannels((old) => old.map((item) => {
                  const auto = output.channels.find((candidate) => candidate.channel === item.channel);
                  return auto && (channel === undefined || item.channel === channel) ? { ...item, low: auto.low, high: auto.high } : item;
                }));
              }, "Could not calculate a full-source range.");
            }}
          /><SourceExportPanel api={api} source={source} selection={shownSelection} channels={channels} defaultDpi={preferences.figureDpi}
            projection={resolvedProjection} onError={setError} /></>
        )}
        {tab === "Process" && (
          <Process
            recipe={recipe}
            setRecipe={setRecipe}
            onPreview={() => void preview()}
            busy={busy !== null}
          />
        )}
        {source && dimensions && tab === "Analyze" && (
          <>
          <label className="segmentation-family">Segment with<select aria-label="Segmentation model" value={segmentationFamily} onChange={(event) => setSegmentationFamily(event.target.value as typeof segmentationFamily)}>
            <option value="classical">Classical methods</option><option value="adaptive">Loci Adaptive Watershed</option>{isRgb && <option value="stain">Declared stain separation</option>}<option value="cellpose-sam">Cellpose-SAM</option><option value="cellpose-sam-v2">Cellpose-SAM v2</option>
          </select></label>
          {["classical", "stain"].includes(segmentationFamily) ? <Analyze
            recipe={recipe}
            channelCount={dimensions.c}
            setRecipe={setRecipe}
            onRun={() => void run()}
            busy={busy !== null}
            rows={rows}
            selected={selectedRow}
            onSelect={(index) => void selectObject(index)}
            isRgb={Boolean(isRgb && segmentationFamily === "stain")}
            rgbIntensity={Boolean(isRgb && segmentationFamily === "classical")}
            measureLabel={`${shownSelection.z_stop === undefined ? "area" : "volume"} (${source.metadata.geometry?.unit || source.metadata.physical_calibration?.unit?.trim() || "pixel"}${shownSelection.z_stop === undefined ? "²" : "³"})`}
            stainAreaUnit={`${source.metadata.physical_calibration?.unit?.trim() || "pixel"}²`}
            onHistologyPreview={previewHistology}
            onHistologyRun={runHistology}
            snapshotRecipes={snapshot.recipes}
            onRestoreRecipe={restoreRecipePreset}
          /> : segmentationFamily === "adaptive" ? <ResearchAdaptivePanel api={api} source={source} selection={shownSelection}
            busy={busy !== null} onBusy={setBusy} onError={setError} onBatchConfiguration={setAdaptiveBatchConfiguration}
            onResult={async (result) => { await loadResult(result.id, result); await api.getSnapshot().then(adopt); }} /> : <ResearchCellposePanel api={api} source={source} selection={shownSelection} profileId={segmentationFamily as "cellpose-sam" | "cellpose-sam-v2"}
            busy={busy !== null} onBusy={setBusy} onError={setError}
            onBatchConfiguration={setCellposeBatchConfiguration}
            onResult={async (result) => { await loadResult(result.id, result); await api.getSnapshot().then(adopt); }} />}
          {!["classical", "stain"].includes(segmentationFamily) && rows.length > 0 && (
            <div className="research-panel-section" style={{ marginTop: 12 }}>
              <h3>Segmented objects ({rows.length})</h3>
              <ResultTable rows={rows} selected={selectedRow} onSelect={(index) => void selectObject(index)} />
            </div>
          )}
          {isRgb && segmentationFamily === "stain" && (
            <ResearchHistologyPanel
              api={api}
              sourceId={source.id}
              selection={shownSelection}
              busy={busy !== null}
              report={report}
              onBusyChange={setBusy}
              onPreview={(overlay, measurements) => {
                setPendingModel(null);
                setResultId(null);
                setResultView(null);
                setImage(overlay);
                setRows(measurements);
              }}
              onResult={async (target, measurements) => {
                setRedoStack([]);
                await persistRevision(target, measurements);
              }}
            />
          )}
          </>
        )}
        {source && dimensions && tab === "Quantify" && (
          <ResearchQuantificationPanel
            api={api}
            snapshot={snapshot}
            source={source}
            selection={shownSelection}
            recipe={recipe}
            setRecipe={setRecipe}
            report={report}
            busy={busy !== null}
            onBusyChange={(value) =>
              setBusy((current) =>
                value
                  ? (current ?? "quantification")
                  : current === "quantification"
                    ? null
                    : current,
              )
            }
            onPreview={(overlay, measurements) => {
              setPendingModel(null);
              setResultId(null);
              setResultView(null);
              setImage(overlay);
              setRows(measurements);
            }}
            onPublished={publishGeneratedResult}
          />
        )}
        {tab === "Correction" && (
          <ResearchCorrectionPanel
            api={api}
            result={
              snapshot.results.find((item) => item.id === resultId) ?? null
            }
            points={correctionPoints}
            setPoints={setCorrectionPoints}
            report={report}
            onResult={async (child, measurements) => {
              setRedoStack([]);
              return persistRevision(child, measurements);
            }}
            onUndo={() => moveRevision("undo")}
            onRedo={() => moveRevision("redo")}
            onViewChange={changeCorrectionView}
            onPreviewChange={setCorrectionPreview}
            onMutationBusyChange={setCorrectionMutationBusy}
            planeSpacing={correctionPlaneSpacing}
            viewReady={correctionViewReady}
            busy={busy !== null}
            canUndo={Boolean(selectedResult?.parent_id)}
            canRedo={Boolean(redoTargetId)}
          />
        )}
        {tab === "Temporal" && (
          <ResearchTemporalPanel
            api={api}
            snapshot={snapshot}
            report={report}
            busy={busy !== null}
            onBusyChange={(value) =>
              setBusy((current) =>
                value ? (current ?? "temporal") : current === "temporal" ? null : current,
              )
            }
            onOpenResult={navigateExactResult}
            onPublished={publishGeneratedResult}
          />
        )}
        {tab === "Registration" && (
          <ResearchRegistrationPanel
            api={api}
            snapshot={snapshot}
            report={report}
            busy={busy !== null}
            onBusyChange={(value) =>
              setBusy((current) =>
                value
                  ? (current ?? "registration")
                  : current === "registration"
                    ? null
                    : current,
              )
            }
            onOpenResult={navigateExactResult}
            onPublished={publishGeneratedResult}
          />
        )}
        {source && dimensions && tab === "Agent" && (
          <ResearchAgentPanel
            api={api}
            source={source}
            selection={shownSelection}
            recipe={recipe}
            report={report}
            busy={busy !== null}
            onBusyChange={(value) =>
              setBusy((current) =>
                value
                  ? (current ?? "agent policy")
                  : current === "agent policy"
                    ? null
                    : current,
              )
            }
          />
        )}
        {tab === "Remote" && (
          <ResearchRemotePanel
            api={api}
            sources={snapshot.sources}
            selection={shownSelection}
            recipe={recipe}
            busy={busy !== null}
            onResults={async () => {
              await report(
                () => api.getSnapshot().then(adopt),
                "Remote results attached, but the study could not be refreshed.",
              );
            }}
          />
        )}
        {source && dimensions && tab === "Model" && (
          <ModelPanel
            api={api}
            models={models}
            refreshModels={refreshModels}
            report={report}
            modelId={modelId}
            setModelId={setModelId}
            mapping={modelMapping}
            setMapping={setModelMapping}
            channelCount={dimensions.c}
            source={source}
            scale={modelScale}
            setScale={setModelScale}
            scaleY={modelScaleY}
            setScaleY={setModelScaleY}
            scaleX={modelScaleX}
            setScaleX={setModelScaleX}
            scaleUnit={modelScaleUnit}
            setScaleUnit={setModelScaleUnit}
            declaration={modelDeclaration}
            setDeclaration={setModelDeclaration}
            probabilityChannel={modelProbabilityChannel}
            setProbabilityChannel={setModelProbabilityChannel}
            threshold={modelThreshold}
            setThreshold={setModelThreshold}
            method={modelMethod}
            setMethod={setModelMethod}
            minSize={modelMinSize}
            setMinSize={setModelMinSize}
            splitHeight={modelSplitHeight}
            setSplitHeight={setModelSplitHeight}
            measurementChannels={modelMeasurementChannels}
            setMeasurementChannels={setModelMeasurementChannels}
            workingBytes={modelWorkingBytes}
            setWorkingBytes={setModelWorkingBytes}
            pending={pendingModel}
            onPreview={() => void previewModel()}
            onAdopt={() => void adoptModel()}
            busy={busy !== null}
          />
        )}
        {source && dimensions && tab === "Study" && (
          <StudyPanel
            snapshot={snapshot}
            api={api}
            source={source}
            selection={shownSelection}
            recipe={recipe}
            setRecipe={setRecipe}
            recipeName={studyRecipeName}
            setRecipeName={setStudyRecipeName}
            selectedSourceIds={studySourceIds}
            setSelectedSourceIds={setStudySourceIds}
            previewSourceId={studyPreviewId}
            setPreviewSourceId={setStudyPreviewId}
            batchRows={studyRows}
            setBatchRows={setStudyRows}
            batchFamily={segmentationFamily}
            cellposeBatchConfiguration={cellposeBatchConfiguration}
            adaptiveBatchConfiguration={adaptiveBatchConfiguration}
            resultIds={studyResultIds}
            setResultIds={setStudyResultIds}
            summary={studySummary}
            setSummary={setStudySummary}
            report={report}
            adopt={adopt}
            onLoadResult={loadResult}
            busy={busy !== null}
            onBusyChange={(value) => setBusy((current) =>
              value ? (current ?? "study") : current === "study" ? null : current)}
          />
        )}
        {tab === "Vendor import" && (
          <ResearchVendorPanel api={api} snapshot={snapshot} report={report}
            busy={busy !== null}
            onBusyChange={(value) => setBusy((current) => value ? (current ?? "vendor") :
              current === "vendor" ? null : current)}
            onSnapshot={adopt} />
        )}
        {tab === "Portability" && (
          <ResearchPortabilityPanel
            api={api}
            snapshot={snapshot}
            selectedSourceId={sourceId}
            selectedResult={selectedResult}
            report={report}
            busy={busy !== null}
            onBusyChange={(value) =>
              setBusy((current) =>
                value
                  ? (current ?? "portability")
                  : current === "portability"
                    ? null
                    : current,
              )
            }
            onSnapshot={adopt}
            onResult={async (child) => {
              setRedoStack([]);
              await persistRevision(child);
            }}
          />
        )}
        {source && tab === "Info" && (
          <Info
            source={source}
            snapshot={snapshot}
            api={api}
            result={
              snapshot.results.find((item) => item.id === resultId) ?? null
            }
            rows={rows}
            selectedRow={selectedRow}
            onSelectRow={(index) => void selectObject(index)}
            onSave={save}
            report={report}
            busy={busy !== null}
            onSnapshot={adopt}
          />
        )}
      </aside>
      </div>
      <footer className="workbench-status">
        <button className={`workbench-jobs__trigger ${jobsOpen ? "active" : ""}`} title="View running and completed jobs" onClick={() => setJobsOpen((open) => !open)}><Activity size={14} aria-hidden="true" /> Jobs{snapshot.jobs.some((job) => ["running", "queued"].includes(job.state)) ? <span className="workbench-jobs__badge">{snapshot.jobs.filter((job) => ["running", "queued"].includes(job.state)).length}</span> : null}</button>
        <span role="status">{documentSwitching ? "Updating workspace…" : busy ? `Working: ${busy}` : "Local"}</span>
        <span>{source ? `${meta(source).dimensions.x.toLocaleString()} × ${meta(source).dimensions.y.toLocaleString()}` : ""}</span>
      </footer>
      {jobsOpen && <section className="workbench-jobs" aria-label="Job center">
        <header className="workbench-jobs__header">
          <h2>Job Center</h2>
          <button className="workbench-jobs__close" aria-label="Close Job Center" onClick={() => setJobsOpen(false)}><X size={16} aria-hidden="true" /></button>
        </header>
        <div className="workbench-jobs__content">
          {!snapshot.jobs.length ? <p className="workbench-jobs__empty">Completed and running jobs appear here.</p> : (
            <ul className="workbench-jobs__list">
              {[...snapshot.jobs].sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id)).map((job) => {
                const isActive = ["running", "queued"].includes(job.state);
                const tone = job.state === "running" ? "processing" : job.state === "queued" ? "neutral" : job.state === "succeeded" ? "success" : job.state === "failed" || job.state === "interrupted" ? "danger" : "neutral";
                const stateLabel = job.state === "running" ? "Running" : job.state === "queued" ? "Queued" : job.state === "succeeded" ? "Completed" : job.state === "failed" ? "Failed" : job.state === "cancelled" ? "Cancelled" : "Interrupted";
                const operationLabel = job.operation === "run_recipe" ? "Analysis" : job.operation === "classical_run" ? "Classical segmentation" : job.operation === "cellpose_run" ? "Cellpose segmentation" : job.operation.replace(/_/g, " ");
                const progress = job.progress === null || job.progress === undefined ? null : Math.max(0, Math.min(1, job.progress));
                const percentage = progress === null ? null : Math.round(progress * 100);
                const timestamp = new Date(job.updated_at);
                const timeLabel = Number.isFinite(timestamp.valueOf()) ? new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(timestamp) : "";
                return <li key={job.id} className={`workbench-jobs__row tone-${tone}`}>
                  <span className="workbench-jobs__icon">
                    {job.state === "running" ? <LoaderCircle size={14} className="workbench-jobs__spinner" aria-hidden="true" /> : job.state === "queued" ? <Clock3 size={14} aria-hidden="true" /> : job.state === "succeeded" ? <CheckCircle2 size={14} aria-hidden="true" /> : job.state === "failed" || job.state === "interrupted" ? <XCircle size={14} aria-hidden="true" /> : <Ban size={14} aria-hidden="true" />}
                  </span>
                  <div className="workbench-jobs__body">
                    <div className="workbench-jobs__heading"><strong>{operationLabel}</strong><span className={`workbench-jobs__state tone-${tone}`}>{stateLabel}</span></div>
                    {job.error ? <p className="workbench-jobs__error">{job.error}</p> : null}
                    <div className="workbench-jobs__meta">
                      <span><Laptop size={11} aria-hidden="true" />Local</span>
                      <span><code>#{job.id.slice(0, 8)}</code></span>
                      {timeLabel ? <time dateTime={job.updated_at}>{timeLabel}</time> : null}
                      {job.cancel_requested && isActive ? <span className="workbench-jobs__cancelling">Cancelling</span> : null}
                    </div>
                    {isActive ? <div className="workbench-jobs__progress">
                      <span className={`workbench-jobs__bar ${progress === null || progress === 0 ? "is-indeterminate" : ""}`} role="progressbar" aria-label={percentage === null ? "Progress unavailable" : `${percentage} percent`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentage ?? undefined}><span style={progress !== null && progress > 0 ? { transform: `scaleX(${progress})` } as React.CSSProperties : undefined} /></span>
                      {percentage !== null && percentage > 0 ? <span className="workbench-jobs__percent">{percentage}%</span> : null}
                    </div> : null}
                  </div>
                  {isActive && !job.cancel_requested ? <div className="workbench-jobs__actions">
                    <button className="workbench-jobs__cancel" onClick={() => void report(() => api.cancelJob(job.id), "Could not cancel this job.")}><X size={13} aria-hidden="true" />Cancel</button>
                  </div> : null}
                </li>;
              })}
            </ul>
          )}
        </div>
      </section>}
    </main>
  );
}

function Process({
  recipe,
  setRecipe,
  onPreview,
  busy,
}: {
  recipe: typeof DEFAULT_RECIPE;
  setRecipe: React.Dispatch<React.SetStateAction<typeof DEFAULT_RECIPE>>;
  onPreview: () => void;
  busy: boolean;
}) {
  const add = (op: string) =>
    setRecipe((old) => ({
      ...old,
      steps: [
        ...old.steps,
        op === "gaussian" || op === "subtract_background"
          ? { op, sigma: 1 }
          : op === "subtract_constant"
            ? { op, value: 0 }
            : { op, radius: 1 },
      ],
    }));
  const patch = (index: number, values: Record<string, unknown>) =>
    setRecipe((old) => ({
      ...old,
      steps: old.steps.map((step, i) =>
        i === index ? { ...step, ...values } : step,
      ),
    }));
  const move = (index: number, delta: number) =>
    setRecipe((old) => {
      const steps = [...old.steps];
      const target = index + delta;
      if (target < 0 || target >= steps.length) return old;
      [steps[index], steps[target]] = [steps[target], steps[index]];
      return { ...old, steps };
    });
  return (
    <div className="research-panel">
      <h2>Non-destructive recipe</h2>
      <p>
        Steps execute in this order. Spatial scales use the selected source
        geometry units.
      </p>
      <div className="research-actions">
        {[
          "gaussian",
          "subtract_background",
          "subtract_constant",
          "median",
          "opening",
          "closing",
        ].map((op) => (
          <button key={op} onClick={() => add(op)}>
            <Plus size={12} /> {op.replaceAll("_", " ")}
          </button>
        ))}
      </div>
      <ol>
        {recipe.steps.map((step, index) => {
          const parameter =
            "sigma" in step ? "sigma" : "radius" in step ? "radius" : "value";
          return (
            <li key={index}>
              <strong>{String(step.op).replaceAll("_", " ")}</strong>
              <label>
                {parameter}
                <input
                  aria-label={`Step ${index + 1} ${parameter}`}
                  type="number"
                  step="any"
                  value={Number(step[parameter])}
                  onChange={(event) =>
                    patch(index, { [parameter]: Number(event.target.value) })
                  }
                />
              </label>
              <div className="research-actions">
                <button
                  aria-label={`Move step ${index + 1} up`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  Up
                </button>
                <button
                  aria-label={`Move step ${index + 1} down`}
                  disabled={index === recipe.steps.length - 1}
                  onClick={() => move(index, 1)}
                >
                  Down
                </button>
                <button
                  aria-label={`Remove ${String(step.op)}`}
                  onClick={() =>
                    setRecipe((old) => ({
                      ...old,
                      steps: old.steps.filter((_, i) => i !== index),
                    }))
                  }
                >
                  <X size={12} /> Remove
                </button>
              </div>
            </li>
          );
        })}
      </ol>
      <button disabled={busy} onClick={onPreview}>
        Preview selected crop
      </button>
    </div>
  );
}
function Analyze({
  recipe,
  channelCount,
  setRecipe,
  onRun,
  busy,
  rows,
  selected,
  onSelect,
  isRgb,
  rgbIntensity,
  measureLabel,
  stainAreaUnit,
  onHistologyPreview,
  onHistologyRun,
  snapshotRecipes,
  onRestoreRecipe,
}: {
  recipe: typeof DEFAULT_RECIPE;
  channelCount: number;
  setRecipe: React.Dispatch<React.SetStateAction<typeof DEFAULT_RECIPE>>;
  onRun: () => void;
  busy: boolean;
  rows: Array<Record<string, unknown>>;
  selected: number | null;
  onSelect: (row: number) => void;
  isRgb: boolean;
  rgbIntensity: boolean;
  measureLabel: string;
  stainAreaUnit: string;
  onHistologyPreview: (
    basis: "H&E" | "H-DAB",
    component: number,
    recipe: typeof DEFAULT_RECIPE,
  ) => void;
  onHistologyRun: (
    basis: "H&E" | "H-DAB",
    component: number,
    recipe: typeof DEFAULT_RECIPE,
  ) => void;
  snapshotRecipes?: ResearchSnapshot["recipes"];
  onRestoreRecipe?: (item: unknown) => void;
}) {
  const [basis, setBasis] = useState<"H&E" | "H-DAB">("H&E");
  const [component, setComponent] = useState(0);
  const [stainRuleEnabled, setStainRuleEnabled] = useState(false);
  const [stainRuleName, setStainRuleName] = useState("");
  const [stainRuleChannel, setStainRuleChannel] = useState<0 | 1>(0);
  const [stainRuleStatistic, setStainRuleStatistic] = useState<
    "mean" | "sum" | "max"
  >("mean");
  const [stainRuleThreshold, setStainRuleThreshold] = useState("0");
  const [stainRuleControl, setStainRuleControl] = useState("");
  const [histologySegmentation, setHistologySegmentation] = useState<{
    method: string;
    threshold: number;
    polarity: string;
    min_size: number;
    exclude_border: boolean;
    split_height?: number;
  }>({
    method: "components",
    threshold: 0.15,
    polarity: "bright",
    min_size: 10,
    exclude_border: false,
  });
  const segmentation = recipe.segmentation as Record<string, unknown>;
  const stainNames = basis === "H&E"
    ? (["hematoxylin-basis", "eosin-basis"] as const)
    : (["hematoxylin-basis", "DAB-basis"] as const);
  const stainRuleValid =
    stainRuleName.trim().length > 0 &&
    stainRuleName.length <= 128 &&
    stainRuleControl.trim().length > 0 &&
    stainRuleControl.length <= 2000 &&
    stainRuleThreshold.trim().length > 0 &&
    Number.isFinite(Number(stainRuleThreshold));
  const histologyRecipe: ResearchRecipe = {
    ...recipe,
    segmentation: histologySegmentation,
    gates:
      stainRuleEnabled && stainRuleValid
        ? [{
            name: stainRuleName.trim(),
            channel: stainNames[stainRuleChannel],
            statistic: stainRuleStatistic,
            threshold: Number(stainRuleThreshold),
            control: stainRuleControl.trim(),
          }]
        : [],
  };
  const patch = (value: Record<string, unknown>) =>
    setRecipe((old) => ({
      ...old,
      segmentation: { ...old.segmentation, ...value },
    }));
  return (
    <div className="research-panel">
      <h2>Objects & measurements</h2>
      {snapshotRecipes && snapshotRecipes.length > 0 && (
        <label className="research-recipe-preset-picker">
          Saved study recipe
          <select
            aria-label="Load saved recipe"
            disabled={busy}
            defaultValue=""
            onChange={(e) => {
              const selectedIdx = Number(e.target.value);
              if (!Number.isNaN(selectedIdx) && snapshotRecipes[selectedIdx]) {
                onRestoreRecipe?.(snapshotRecipes[selectedIdx]);
                e.target.value = "";
              }
            }}
          >
            <option value="" disabled>Select saved recipe…</option>
            {snapshotRecipes.map((item, idx) => {
              const name =
                typeof item === "object" &&
                item !== null &&
                typeof (item as { data?: { name?: unknown } }).data?.name === "string"
                  ? (item as { data: { name: string } }).data.name
                  : `Recipe ${idx + 1}`;
              return (
                <option key={idx} value={idx}>
                  {name}
                </option>
              );
            })}
          </select>
        </label>
      )}
      {rgbIntensity && <label>Intensity input<select aria-label="RGB analysis input" value={recipe.input_transform ?? ""} onChange={(event) => {
        const { input_transform: _conversion, ...scalar } = recipe;
        setRecipe(event.target.value === "rgb_intensity" ? { ...scalar, input_transform: "rgb_intensity", measurement_channels: [], gates: [],
          segmentation: { ...recipe.segmentation, threshold: 0.5 } } : { ...scalar, measurement_channels: [0] });
      }}><option value="">Choose an explicit conversion…</option><option value="rgb_intensity">Weighted RGB intensity</option></select>
      <small>Converts encoded RGB samples to 0–1 intensity. Counts and geometry are retained; intensities are derived, not biological channels.</small></label>}
      {isRgb && (
        <>
          <h3>Declared brightfield stain analysis</h3>
          <p>
            Declare the basis before separation. RGB components are display
            values, never biological channels.
          </p>
          <label>
            Stain basis{" "}
            <select
              aria-label="Stain basis"
              value={basis}
              onChange={(event) =>
                setBasis(event.target.value as "H&E" | "H-DAB")
              }
            >
              <option value="H&E">H&amp;E</option>
              <option value="H-DAB">H-DAB</option>
            </select>
          </label>
          <label>
            Stain component{" "}
            <select
              aria-label="Stain component"
              value={component}
              onChange={(event) => setComponent(Number(event.target.value))}
            >
              <option value={0}>Hematoxylin basis</option>
              <option value={1}>
                {basis === "H&E" ? "Eosin basis" : "DAB basis"}
              </option>
            </select>
          </label>
          <label>
            Stain-coordinate threshold
            <input
              aria-label="Stain-coordinate threshold"
              type="number"
              step="any"
              value={histologySegmentation.threshold}
              onChange={(event) =>
                setHistologySegmentation((old) => ({
                  ...old,
                  threshold: Number(event.target.value),
                }))
              }
            />
          </label>
          <label>
            Stain minimum object area ({stainAreaUnit})
            <input
              aria-label="Stain minimum object size"
              type="number"
              min="0"
              step="1"
              value={histologySegmentation.min_size}
              onChange={(event) =>
                setHistologySegmentation((old) => ({
                  ...old,
                  min_size: Number(event.target.value),
                }))
              }
            />
          </label>
          <label>
            Stain segmentation method
            <select
              aria-label="Stain segmentation method"
              value={histologySegmentation.method}
              onChange={(event) =>
                setHistologySegmentation((old) => ({
                  ...old,
                  method: event.target.value,
                }))
              }
            >
              <option value="components">Components</option>
              <option value="watershed">Watershed</option>
            </select>
          </label>
          {histologySegmentation.method === "watershed" && (
            <label>
              Stain watershed split height
              <input
                aria-label="Stain watershed split height"
                type="number"
                step="any"
                value={histologySegmentation.split_height ?? 1}
                onChange={(event) =>
                  setHistologySegmentation((old) => ({
                    ...old,
                    split_height: Number(event.target.value),
                  }))
                }
              />
            </label>
          )}
          <fieldset>
            <legend>Optional declared stain measurement rule</legend>
            <label className="research-check">
              <input
                aria-label="Enable stain measurement rule"
                type="checkbox"
                checked={stainRuleEnabled}
                onChange={(event) => setStainRuleEnabled(event.target.checked)}
              />
              Classify each segmented object by an explicit stain-coordinate threshold
            </label>
            {stainRuleEnabled && (
              <>
                <label>
                  Rule name
                  <input
                    aria-label="Stain rule name"
                    maxLength={128}
                    value={stainRuleName}
                    onChange={(event) => setStainRuleName(event.target.value)}
                  />
                </label>
                <label>
                  Derived stain coordinate
                  <select
                    aria-label="Stain rule channel"
                    value={stainRuleChannel}
                    onChange={(event) =>
                      setStainRuleChannel(Number(event.target.value) as 0 | 1)
                    }
                  >
                    <option value={0}>Hematoxylin basis</option>
                    <option value={1}>
                      {basis === "H&E" ? "Eosin basis" : "DAB basis"}
                    </option>
                  </select>
                </label>
                <label>
                  Statistic
                  <select
                    aria-label="Stain rule statistic"
                    value={stainRuleStatistic}
                    onChange={(event) =>
                      setStainRuleStatistic(
                        event.target.value as "mean" | "sum" | "max",
                      )
                    }
                  >
                    <option value="mean">Mean</option>
                    <option value="sum">Sum</option>
                    <option value="max">Maximum</option>
                  </select>
                </label>
                <label>
                  Threshold
                  <input
                    aria-label="Stain rule threshold"
                    type="number"
                    step="any"
                    value={stainRuleThreshold}
                    onChange={(event) => setStainRuleThreshold(event.target.value)}
                  />
                </label>
                <label>
                  Control or evidence
                  <textarea
                    aria-label="Stain rule control or evidence"
                    maxLength={2000}
                    value={stainRuleControl}
                    onChange={(event) => setStainRuleControl(event.target.value)}
                  />
                </label>
                <p>
                  The rule is true only when the selected {stainRuleStatistic} value
                  is strictly greater than the declared threshold. It records a
                  measurement rule, not an inferred biological class.
                </p>
              </>
            )}
          </fieldset>
          <div className="research-actions">
            <button
              disabled={busy || (stainRuleEnabled && !stainRuleValid)}
              onClick={() =>
                onHistologyPreview(basis, component, histologyRecipe)
              }
            >
              Preview declared stain
            </button>
            <button
              className="research-primary"
              disabled={busy || (stainRuleEnabled && !stainRuleValid)}
              onClick={() => onHistologyRun(basis, component, histologyRecipe)}
            >
              Run declared stain
            </button>
          </div>
        </>
      )}
      {!isRgb && (
        <>
          <label>
            Threshold
            <input
              aria-label="Threshold"
              type="number"
              value={Number(segmentation.threshold)}
              onChange={(event) =>
                patch({ threshold: Number(event.target.value) })
              }
            />
          </label>
          <label>
            Method
            <select
              aria-label="Segmentation method"
              value={String(segmentation.method)}
              onChange={(event) => patch({ method: event.target.value })}
            >
              <option value="components">Components</option>
              <option value="watershed">Watershed</option>
            </select>
          </label>
          {segmentation.method === "watershed" && (
            <label>
              Watershed split height
              <input
                aria-label="Watershed split height"
                type="number"
                value={Number(segmentation.split_height ?? 1)}
                onChange={(event) =>
                  patch({ split_height: Number(event.target.value) })
                }
              />
            </label>
          )}
          <div className="research-grid">
            <label>Foreground<select aria-label="Object foreground" value={String(segmentation.polarity ?? "bright")} onChange={(event) => patch({ polarity: event.target.value })}>
              <option value="bright">Above threshold</option><option value="dark">Below threshold</option>
            </select></label>
            <label>Minimum object {measureLabel}<input aria-label="Minimum object measure" type="number" min={0} step="any" value={Number(segmentation.min_size ?? 0)} onChange={(event) => patch({ min_size: Number(event.target.value) })} /></label>
          </div>
          <label className="research-check" title="Exclude objects touching the declared analysis region boundary"><input type="checkbox" checked={Boolean(segmentation.exclude_border)} onChange={(event) => patch({ exclude_border: event.target.checked })} /> Exclude border objects</label>
          {!rgbIntensity && <label>
            Raw measurement channel
            <select
              aria-label="Measurement channel"
              value={recipe.measurement_channels[0]}
              onChange={(event) =>
                setRecipe((old) => ({
                  ...old,
                  measurement_channels: [Number(event.target.value)],
                }))
              }
            >
              {Array.from({ length: channelCount }, (_, index) => (
                <option key={index} value={index}>
                  Channel {index + 1}
                </option>
              ))}
            </select>
          </label>}
          <button className="research-primary" disabled={busy || (rgbIntensity && recipe.input_transform !== "rgb_intensity")} onClick={onRun}>
            <Play /> {busy ? "Running…" : "Run recipe"}
          </button>
        </>
      )}
      <ResultTable rows={rows} selected={selected} onSelect={onSelect} />
    </div>
  );
}
function ModelPanel({
  api,
  models,
  refreshModels,
  report,
  modelId,
  setModelId,
  mapping,
  setMapping,
  channelCount,
  scale,
  setScale,
  scaleY,
  setScaleY,
  scaleX,
  setScaleX,
  scaleUnit,
  setScaleUnit,
  declaration,
  setDeclaration,
  probabilityChannel,
  setProbabilityChannel,
  threshold,
  setThreshold,
  method,
  setMethod,
  minSize,
  setMinSize,
  splitHeight,
  setSplitHeight,
  measurementChannels,
  setMeasurementChannels,
  workingBytes,
  setWorkingBytes,
  pending,
  onPreview,
  onAdopt,
  busy,
}: {
  api: ResearchDesktopApi;
  models: ModelRecord[];
  refreshModels: () => Promise<void>;
  report: <T>(work: () => Promise<T>, fallback: string) => Promise<T | undefined>;
  modelId: string;
  setModelId: (v: string) => void;
  mapping: Array<{
    model_input_index: number;
    model_channel: string;
    source_channel: number;
  }>;
  setMapping: React.Dispatch<
    React.SetStateAction<
      Array<{
        model_input_index: number;
        model_channel: string;
        source_channel: number;
      }>
    >
  >;
  channelCount: number;
  source: ResearchSource;
  scale: "source" | "override";
  setScale: (v: "source" | "override") => void;
  scaleY: number;
  setScaleY: (v: number) => void;
  scaleX: number;
  setScaleX: (v: number) => void;
  scaleUnit: string;
  setScaleUnit: (v: string) => void;
  declaration: string;
  setDeclaration: (v: string) => void;
  probabilityChannel: number;
  setProbabilityChannel: (v: number) => void;
  threshold: number;
  setThreshold: (v: number) => void;
  method: "components" | "watershed";
  setMethod: (v: "components" | "watershed") => void;
  minSize: number;
  setMinSize: (v: number) => void;
  splitHeight: number;
  setSplitHeight: (v: number) => void;
  measurementChannels: number[];
  setMeasurementChannels: (v: number[]) => void;
  workingBytes: number;
  setWorkingBytes: (v: number) => void;
  pending: PendingModelPreview | null;
  onPreview: () => void;
  onAdopt: () => void;
  busy: boolean;
}) {
  const [importing, setImporting] = useState(false);
  const selected = models.find((item) => item.model_id === modelId);
  const recoverable = (selected?.availability as Record<string, unknown> | undefined)?.state === "reimport-required";
  const importPackage = async (recover = false) => {
    if (!api.importModel || importing) return;
    setImporting(true);
    try {
      await report(async () => {
        await api.importModel!(workingBytes, recover ? modelId : undefined);
        await refreshModels();
      }, "Could not import the selected model package.");
    } finally { setImporting(false); }
  };
  const selectModel = (id: string) => {
    setModelId(id);
    const item = models.find((model) => model.model_id === id);
    const channels = (
      (item?.package as Record<string, unknown> | undefined)?.input as
        Record<string, unknown> | undefined
    )?.channels;
    const declaredChannels = Array.isArray(channels)
      ? channels.map((entry) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry))
            return null;
          const record = entry as Record<string, unknown>;
          return typeof record.name === "string" && record.name.length > 0 &&
            Number.isInteger(record.source_index) && Number(record.source_index) >= 0
            ? record.name
            : null;
        })
      : [];
    setMapping(
      declaredChannels.length > 0 && declaredChannels.every((name) => name !== null)
        ? declaredChannels.map((name, index) => ({
            model_input_index: index,
            model_channel: name!,
            source_channel: 0,
          }))
        : [],
    );
  };
  return (
    <div className="research-panel">
      <h2>Managed model package</h2>
      <p>
        Technical compatibility, supplier rights, and scientific validation are
        separate records. A model preview is display-only until exact adoption.
      </p>
      <label>
        Working memory{" "}
        <select
          aria-label="Model working memory"
          value={workingBytes}
          onChange={(e) => setWorkingBytes(Number(e.target.value))}
        >
          {WORKING_BYTES.map((bytes) => (
            <option key={bytes} value={bytes}>
              {bytes / 1024 ** 3 < 1
                ? "512 MiB"
                : String(bytes / 1024 ** 3) + " GiB"}
            </option>
          ))}
        </select>
      </label>
      {api.importModel && (
        <button
          disabled={busy || importing}
          onClick={() => void importPackage()}
        >
          Import managed package
        </button>
      )}
      {recoverable && api.importModel && <button disabled={busy || importing}
        onClick={() => void importPackage(true)}>Re-import this exact model</button>}
      <label>
        Package{" "}
        <select
          aria-label="Model package"
          value={modelId}
          onChange={(event) => selectModel(event.target.value)}
        >
          <option value="">Select a package…</option>
          {models.map((item) => (
            <option key={String(item.model_id)} value={String(item.model_id)}>
              {String(
                (item.package as Record<string, unknown> | undefined)?.id ??
                  item.model_id,
              )}{" "}
              ·{" "}
              {String(
                (item.package as Record<string, unknown> | undefined)
                  ?.version ?? "",
              )}
            </option>
          ))}
        </select>
      </label>
      {selected && (
        <div className="research-model-records">
          <p>
            <strong>Technical compatibility:</strong>{" "}
            {String(selected.technical_compatibility)}
          </p>
          <p>
            <strong>Reference qualification:</strong>{" "}
            {JSON.stringify(selected.reference_qualification)}
          </p>
          <p>
            <strong>Scientific validation:</strong>{" "}
            {JSON.stringify(selected.scientific_validation)}
          </p>
          <p>
            <strong>Rights:</strong> {JSON.stringify(selected.usage_rights)}
          </p>
        </div>
      )}
      {modelId && (
        <>
          <h3>Declared source mapping</h3>
          {mapping.map((item, index) => (
            <label key={item.model_input_index}>
              Model input {item.model_input_index}: {item.model_channel}
              <select
                aria-label={
                  "Model input " + item.model_input_index + " source channel"
                }
                value={item.source_channel}
                onChange={(event) =>
                  setMapping((old) =>
                    old.map((value, i) =>
                      i === index
                        ? {
                            ...value,
                            source_channel: Number(event.target.value),
                          }
                        : value,
                    ),
                  )
                }
              >
                {Array.from({ length: channelCount }, (_, c) => (
                  <option key={c} value={c}>
                    Source scalar channel {c}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <label>
            Scale{" "}
            <select
              aria-label="Model scale mode"
              value={scale}
              onChange={(event) =>
                setScale(event.target.value as "source" | "override")
              }
            >
              <option value="source">Use declared source calibration</option>
              <option value="override">Explicit compatibility override</option>
            </select>
          </label>
          {scale === "override" && (
            <>
              <label>
                Override Y{" "}
                <input
                  aria-label="Override Y scale"
                  type="number"
                  min="0"
                  step="any"
                  value={scaleY}
                  onChange={(e) => setScaleY(Number(e.target.value))}
                />
              </label>
              <label>
                Override X{" "}
                <input
                  aria-label="Override X scale"
                  type="number"
                  min="0"
                  step="any"
                  value={scaleX}
                  onChange={(e) => setScaleX(Number(e.target.value))}
                />
              </label>
              <label>
                Override unit{" "}
                <select
                  aria-label="Override scale unit"
                  value={scaleUnit}
                  onChange={(e) => setScaleUnit(e.target.value)}
                >
                  {["pixel", "nm", "um", "mm", "m"].map((unit) => (
                    <option key={unit}>{unit}</option>
                  ))}
                </select>
              </label>
              <label>
                Override declaration{" "}
                <input
                  aria-label="Override declaration"
                  value={declaration}
                  onChange={(e) => setDeclaration(e.target.value)}
                />
              </label>
            </>
          )}
          <h3>Segmentation postprocessing</h3>
          <label>
            Probability channel{" "}
            <input
              aria-label="Probability channel"
              type="number"
              min="0"
              value={probabilityChannel}
              onChange={(e) => setProbabilityChannel(Number(e.target.value))}
            />
          </label>
          <label>
            Threshold{" "}
            <input
              aria-label="Model threshold"
              type="number"
              min="0"
              max="1"
              step="any"
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
            />
          </label>
          <label>
            Method{" "}
            <select
              aria-label="Model segmentation method"
              value={method}
              onChange={(e) =>
                setMethod(e.target.value as "components" | "watershed")
              }
            >
              <option value="components">Components</option>
              <option value="watershed">Watershed</option>
            </select>
          </label>
          <label>
            Physical minimum size{" "}
            <input
              aria-label="Physical minimum size"
              type="number"
              min="0"
              step="any"
              value={minSize}
              onChange={(e) => setMinSize(Number(e.target.value))}
            />
          </label>
          {method === "watershed" && (
            <label>
              Watershed split height{" "}
              <input
                aria-label="Model watershed split height"
                type="number"
                min="0"
                step="any"
                value={splitHeight}
                onChange={(e) => setSplitHeight(Number(e.target.value))}
              />
            </label>
          )}
          <label>
            Measurement channels{" "}
            <select
              multiple
              aria-label="Model measurement channels"
              value={measurementChannels.map(String)}
              onChange={(event) =>
                setMeasurementChannels(
                  Array.from(event.currentTarget.selectedOptions, (option) =>
                    Number(option.value),
                  ),
                )
              }
            >
              {Array.from({ length: channelCount }, (_, c) => (
                <option key={c} value={c}>
                  Source scalar channel {c}
                </option>
              ))}
            </select>
          </label>
          <div className="research-actions">
            <button disabled={busy || !mapping.length} onClick={onPreview}>
              Preview model overlay
            </button>
            <button
              className="research-primary"
              disabled={busy || !pending}
              onClick={onAdopt}
            >
              Adopt exact preview
            </button>
          </div>
          {pending && (
            <p>
              Pending preview {pending.id.slice(0, 8)}… is bound to its SHA-256
              and current source/settings.
            </p>
          )}
        </>
      )}
    </div>
  );
}

const RESEARCH_BATCH_JOB_KEY = /^loci-batch:([a-f0-9]{32}):(initial|resume|retry):[a-f0-9]{5,32}$/u;

function researchBatchId(job: ResearchJob): string | null {
  return RESEARCH_BATCH_JOB_KEY.exec(job.request_key)?.[1] ?? null;
}

function researchBatchSourceId(job: ResearchJob): string | null {
  const sourceId = job.request.source_id;
  return typeof sourceId === "string" ? sourceId : null;
}

function latestResearchBatch(jobs: readonly ResearchJob[]): {
  id: string;
  jobs: ResearchJob[];
} | null {
  const groups = new Map<string, ResearchJob[]>();
  for (const job of jobs) {
    const id = researchBatchId(job);
    if (!id) continue;
    const group = groups.get(id) ?? [];
    group.push(job);
    groups.set(id, group);
  }
  const latest = [...groups.entries()].sort((left, right) => {
    const leftCreated = left[1].at(-1)?.created_at ?? "";
    const rightCreated = right[1].at(-1)?.created_at ?? "";
    return rightCreated.localeCompare(leftCreated);
  })[0];
  return latest ? { id: latest[0], jobs: latest[1] } : null;
}

function currentResearchBatchJobs(jobs: readonly ResearchJob[]): ResearchJob[] {
  const byRequest = new Map<string, ResearchJob>();
  for (const job of jobs) byRequest.set(job.request_hash, job);
  return [...byRequest.values()].sort((left, right) =>
    left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id));
}

function StudyPanel({
  snapshot,
  api,
  source,
  selection,
  recipe,
  setRecipe,
  recipeName,
  setRecipeName,
  selectedSourceIds,
  setSelectedSourceIds,
  previewSourceId,
  setPreviewSourceId,
  batchRows,
  setBatchRows,
  batchFamily,
  cellposeBatchConfiguration,
  adaptiveBatchConfiguration,
  resultIds,
  setResultIds,
  summary,
  setSummary,
  report,
  adopt,
  onLoadResult,
  busy,
  onBusyChange,
}: {
  snapshot: ResearchSnapshot;
  api: ResearchDesktopApi;
  source: ResearchSource;
  selection: ResearchSelection;
  recipe: typeof DEFAULT_RECIPE;
  setRecipe: React.Dispatch<React.SetStateAction<typeof DEFAULT_RECIPE>>;
  recipeName: string;
  setRecipeName: (v: string) => void;
  selectedSourceIds: string[];
  setSelectedSourceIds: (v: string[]) => void;
  previewSourceId: string | null;
  setPreviewSourceId: (v: string | null) => void;
  batchRows: Array<{
    sourceId: string;
    state: string;
    resultId?: string;
    error?: string;
  }>;
  setBatchRows: React.Dispatch<
    React.SetStateAction<
      Array<{
        sourceId: string;
        state: string;
        resultId?: string;
        error?: string;
      }>
    >
  >;
  batchFamily: "classical" | "stain" | "adaptive" | "cellpose-sam" | "cellpose-sam-v2";
  cellposeBatchConfiguration: ResearchCellposeBatchConfiguration | null;
  adaptiveBatchConfiguration?: ResearchAdaptiveBatchConfiguration | null;
  resultIds: string[];
  setResultIds: (v: string[]) => void;
  summary: Array<Record<string, unknown>>;
  setSummary: (v: Array<Record<string, unknown>>) => void;
  report: <T>(
    work: () => Promise<T>,
    fallback: string,
  ) => Promise<T | undefined>;
  adopt: (v: ResearchSnapshot | null) => void;
  onLoadResult: (id: string) => Promise<void>;
  busy: boolean;
  onBusyChange: (value: boolean) => void;
}) {
  const inFlight = useRef(false);
  const stopRequested = useRef(false);
  const [runningBatchId, setRunningBatchId] = useState<string | null>(null);
  const [runningBatchJobId, setRunningBatchJobId] = useState<string | null>(null);
  const discoveredBatch = latestResearchBatch(snapshot.jobs);
  const durableBatch = runningBatchId
    ? {
        id: runningBatchId,
        jobs: snapshot.jobs.filter((job) => researchBatchId(job) === runningBatchId),
      }
    : discoveredBatch;
  const durableJobs = currentResearchBatchJobs(durableBatch?.jobs ?? []);
  const initialComparison = savedStudyComparison(snapshot);
  const [leftResultIds, setLeftResultIds] = useState<string[]>(() =>
    initialComparison?.left.bindings.map((binding) => binding.result_id) ?? [],
  );
  const [rightResultIds, setRightResultIds] = useState<string[]>(() =>
    initialComparison?.right.bindings.map((binding) => binding.result_id) ?? [],
  );
  const [comparison, setComparison] = useState<StudyComparisonReceipt | null>(
    initialComparison,
  );
  const [batchExportMode, setBatchExportMode] = useState<
    "bundles" | "bundles+summary" | "summary-only"
  >("bundles+summary");
  const perform = async (work: () => Promise<void>) => {
    if (busy || inFlight.current) return;
    inFlight.current = true;
    onBusyChange(true);
    try {
      await work();
    } finally {
      setPreviewSourceId(null);
      inFlight.current = false;
      onBusyChange(false);
    }
  };
  const saveRecipe = async () => {
    const prior = snapshot.recipes.find(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        (item as { id?: string }).id === source.id,
    ) as { revision?: number } | undefined;
    await report(
      () =>
        api.execute("recipe", {
          id: source.id,
          source_id: source.id,
          data: { name: recipeName, recipe, selection },
          expected_revision: prior?.revision ?? 0,
        }),
      "Could not save this reusable recipe.",
    );
    await report(
      () => api.getSnapshot().then(adopt),
      "Could not refresh saved recipes.",
    );
  };
  const preview = async (id: string) => {
    setPreviewSourceId(id);
    const output = await report(
      () =>
        api.execute("preview_recipe", {
          source_id: id,
          selection,
          recipe,
        }) as Promise<{ object_count?: number }>,
      "Selected source cannot use this recipe on its declared dimensions.",
    );
    if (output)
      setBatchRows((old) => [
        ...old.filter((row) => row.sourceId !== id),
        {
          sourceId: id,
          state: "previewed (" + String(output.object_count ?? 0) + " objects)",
        },
      ]);
  };
  const refreshBatchSnapshot = async (): Promise<ResearchSnapshot | null> => {
    const next = await api.getSnapshot();
    adopt(next);
    return next;
  };
  const executeQueuedBatch = async (receipt: ResearchBatchReceipt) => {
    if (!api.runBatchJob) throw new Error("This Loci build cannot run durable study batches.");
    stopRequested.current = false;
    setRunningBatchId(receipt.batch_id);
    try {
      for (const job of currentResearchBatchJobs(receipt.jobs)) {
        if (job.state !== "queued" || stopRequested.current) continue;
        const sourceId = researchBatchSourceId(job);
        if (!sourceId) throw new Error("A durable batch job lost its source binding.");
        setRunningBatchJobId(job.id);
        setBatchRows((old) => [
          ...old.filter((row) => row.sourceId !== sourceId),
          { sourceId, state: "running" },
        ]);
        await report(
          () => api.runBatchJob!(receipt.batch_id, job.id),
          "Batch source failed; its durable request is retained.",
        );
        const next = await refreshBatchSnapshot();
        const state = next?.jobs.find((item) => item.id === job.id)?.state;
        if (state === "cancelled") stopRequested.current = true;
      }
    } finally {
      setRunningBatchJobId(null);
      setRunningBatchId(null);
      await report(refreshBatchSnapshot, "Could not refresh durable batch history.");
    }
  };
  const frozenBatchTasks = (): ResearchBatchTask[] => {
    const frozenSelection = structuredClone(selection);
    const cellpose = batchFamily === "cellpose-sam" || batchFamily === "cellpose-sam-v2";
    const adaptive = batchFamily === "adaptive";
    if (cellpose &&
        (!cellposeBatchConfiguration ||
          cellposeBatchConfiguration.profileId !== batchFamily ||
          cellposeBatchConfiguration.configuredSourceId !== source.id)) {
      throw new Error(
        "Configure this Cellpose profile and its exact settings in Analyze before starting the batch.",
      );
    }
    if (adaptive &&
        (!adaptiveBatchConfiguration ||
          adaptiveBatchConfiguration.profileId !== "loci-classical" ||
          adaptiveBatchConfiguration.configuredSourceId !== source.id)) {
      throw new Error(
        "Configure Loci Adaptive Watershed and its exact settings in Analyze before starting the batch.",
      );
    }
    return selectedSourceIds.map((id) => {
      const selected = snapshot.sources.find((item) => item.id === id);
      if (!selected) throw new Error("A selected batch source is no longer open.");
      if (!cellpose && !adaptive) {
        return {
          operation: "run_recipe",
          source: { id: selected.id, sha256: selected.sha256 },
          request: {
            source_id: selected.id,
            selection: frozenSelection,
            recipe: structuredClone(recipe),
          },
        };
      }
      if (adaptive) {
        const configuration = adaptiveBatchConfiguration!;
        const { z_stop: _depth, ...plane } = frozenSelection;
        return {
          operation: "classical_run",
          source: { id: selected.id, sha256: selected.sha256 },
          request: {
            source_id: selected.id,
            selection: plane,
            profile_id: configuration.profileId,
            settings: structuredClone(configuration.settings),
            measurement_channels: [...configuration.measurementChannels],
            working_bytes: configuration.workingBytes,
          },
        };
      }
      const configuration = cellposeBatchConfiguration!;
      const { z_stop: _depth, ...plane } = frozenSelection;
      return {
        operation: "cellpose_run",
        source: { id: selected.id, sha256: selected.sha256 },
        request: {
          source_id: selected.id,
          selection: plane,
          profile_id: configuration.profileId,
          settings: structuredClone(configuration.settings),
          measurement_channels: [...configuration.measurementChannels],
          working_bytes: configuration.workingBytes,
        },
      };
    });
  };
  const run = async () => {
    if (!api.submitBatch) throw new Error("This Loci build cannot create durable study batches.");
    const receipt = await api.submitBatch(frozenBatchTasks());
    await refreshBatchSnapshot();
    await executeQueuedBatch(receipt);
  };
  const resume = async () => {
    if (!durableBatch || !api.resumeBatch) {
      throw new Error("This Loci build cannot resume durable study batches.");
    }
    const receipt = await api.resumeBatch(durableBatch.id);
    await refreshBatchSnapshot();
    await executeQueuedBatch(receipt);
  };
  const retry = async () => {
    if (!durableBatch || !api.retryBatch) {
      throw new Error("This Loci build cannot retry durable study batches.");
    }
    const receipt = await api.retryBatch(durableBatch.id);
    await refreshBatchSnapshot();
    await executeQueuedBatch(receipt);
  };
  const stop = async () => {
    stopRequested.current = true;
    if (runningBatchJobId) {
      await report(
        () => api.cancelJob(runningBatchJobId),
        "Could not stop the current batch item.",
      );
    }
  };
  const summarize = async () => {
    const output = await report(
      () =>
        api.execute("study_summary", {
          result_ids: resultIds,
          value: "measure",
        }) as Promise<{ summaries?: Array<Record<string, unknown>> }>,
      "Comparison requires exact reviewed or excluded result revisions and source metadata.",
    );
    if (output) setSummary(output.summaries ?? []);
  };
  const exportReviewed = async () => {
    if (!api.exportBatch) throw new Error("This Loci build cannot export reviewed study batches.");
    const selected = resultIds.map((id) => {
      const result = snapshot.results.find((item) => item.id === id);
      if (!result) throw new Error("A selected result is no longer part of this study.");
      if (result.review?.disposition !== "reviewed")
        throw new Error("Mark every selected result revision reviewed before batch export.");
      const selectedSource = snapshot.sources.find((item) => item.id === result.source_id);
      if (!selectedSource) throw new Error("A selected result source is no longer open.");
      return {
        source_id: selectedSource.id,
        source_sha256: selectedSource.sha256,
        result_id: result.id,
        revision_hash: result.revision_hash,
      };
    });
    const receipt = await report(
      () => api.exportBatch!(selected, { mode: batchExportMode }),
      "Could not export the exact reviewed batch.",
    );
    if (receipt) await report(refreshBatchSnapshot, "Could not refresh the study after export.");
  };
  const compare = async () => {
    const output = await report(
      () =>
        api.execute("study_compare", {
          left_result_ids: leftResultIds,
          right_result_ids: rightResultIds,
          value: "measure",
        }) as Promise<StudyComparisonReceipt>,
      "Run comparison requires two compatible reviewed result sets from the same exact sources.",
    );
    if (output) setComparison(output);
  };
  const setReview = async (
    item: ResearchResult,
    disposition: "reviewed" | "excluded",
  ) => {
    const output = await report(
      () => api.reviewResult(item.id, item.revision_hash, disposition),
      "Could not update this exact result review.",
    );
    if (!output) return;
    setComparison(null);
    await report(
      () => api.getSnapshot().then(adopt),
      "Could not refresh result review state.",
    );
  };
  const restore = async (item: unknown) => {
    const data =
      typeof item === "object" && item !== null
        ? (
            item as {
              data?: { name?: unknown; recipe?: unknown; selection?: unknown };
            }
          ).data
        : undefined;
    if (
      !data ||
      typeof data.name !== "string" ||
      !data.recipe ||
      typeof data.recipe !== "object"
    )
      return;
    const checked = await report(
      () =>
        api.execute("validate_recipe", {
          source_id: source.id,
          selection: data.selection,
          recipe: data.recipe,
        }) as Promise<{ recipe?: typeof DEFAULT_RECIPE }>,
      "Saved recipe is no longer valid for this source.",
    );
    if (checked?.recipe) {
      setRecipe(checked.recipe);
      setRecipeName(data.name);
    }
  };
  const displayedBatchRows = durableJobs.length
    ? durableJobs.flatMap((job) => {
        const sourceId = researchBatchSourceId(job);
        return sourceId ? [{
          sourceId,
          state: job.state,
          resultId: job.result_ids[0],
          error: job.error ?? undefined,
        }] : [];
      })
    : batchRows;
  const canResume = durableJobs.some((job) =>
    job.state === "queued" || job.state === "interrupted");
  const canRetry = durableJobs.some((job) =>
    job.state === "failed" || job.state === "cancelled");
  const profileBatch = batchFamily === "adaptive" ||
    batchFamily === "cellpose-sam" || batchFamily === "cellpose-sam-v2";
  const profileBatchConfigurationReady = batchFamily === "adaptive"
    ? Boolean(adaptiveBatchConfiguration)
    : Boolean(cellposeBatchConfiguration);
  return (
    <div className="research-panel">
      <h2>Reusable study recipe</h2>
      <p>
        Every selected source is validated by the engine. Dimensions or
        selections are never quietly clipped across sources.
      </p>
      <label>
        Recipe name{" "}
        <input
          aria-label="Study recipe name"
          disabled={busy}
          value={recipeName}
          onChange={(e) => setRecipeName(e.target.value)}
        />
      </label>
      <button disabled={busy} onClick={() => void perform(saveRecipe)}>
        Save validated recipe
      </button>
      {snapshot.recipes.map((item, index) => (
        <button
          key={index}
          disabled={busy}
          onClick={() => void perform(() => restore(item))}
        >
          Restore saved recipe{" "}
          {typeof item === "object" &&
          item !== null &&
          typeof (item as { data?: { name?: unknown } }).data?.name === "string"
            ? (item as { data: { name: string } }).data.name
            : ""}
        </button>
      ))}
      <h3>{profileBatch ? "Frozen profile batch" : "Preview before batch"}</h3>
      {profileBatch && (
        <p>
          The batch uses the exact {batchFamily === "adaptive" ? "Loci Adaptive Watershed" : batchFamily}
          {batchFamily === "adaptive" ? "" : " profile and requested device"}, settings,
          measurement channels and 2D selection last configured in Analyze.
          Previewing a saved recipe does not replace that configuration.
        </p>
      )}
      {snapshot.sources.map((item) => (
        <label key={item.id} className="research-check">
          <input
            type="checkbox"
            aria-label={"Include " + item.name + " in batch"}
            disabled={busy}
            checked={selectedSourceIds.includes(item.id)}
            onChange={(e) =>
              setSelectedSourceIds(
                e.target.checked
                  ? [...selectedSourceIds, item.id]
                  : selectedSourceIds.filter((id) => id !== item.id),
              )
            }
          />
          {item.name}
          <button
            disabled={busy || profileBatch}
            onClick={() => void perform(() => preview(item.id))}
          >
            {previewSourceId === item.id ? "Previewing…" : "Preview"}
          </button>
        </label>
      ))}
      <div className="study-batch-actions" role="group" aria-label="Batch actions"><button
        className="research-primary"
        disabled={busy || !selectedSourceIds.length ||
          (profileBatch && !profileBatchConfigurationReady)}
        onClick={() => void perform(run)}
      >
        Run selected sources sequentially
      </button>
      {runningBatchId && (
        <button className="study-batch-stop" onClick={() => void stop()}>Stop batch</button>
      )}
      {!runningBatchId && canResume && (
        <button disabled={busy} onClick={() => void perform(resume)}>
          Resume batch
        </button>
      )}
      {!runningBatchId && canRetry && (
        <button disabled={busy} onClick={() => void perform(retry)}>
          Retry failed or cancelled
        </button>
      )}
      </div>
      {displayedBatchRows.map((row) => (
        <p key={row.sourceId}>
          {snapshot.sources.find((item) => item.id === row.sourceId)?.name}:{" "}
          {row.state}{" "}
          {row.resultId && (
            <button
              disabled={busy}
              onClick={() => void onLoadResult(row.resultId!)}
            >
              Open result
            </button>
          )}
        </p>
      ))}
      <h3>Biological-replicate summary</h3>
      <p>
        Choose exact reviewed or explicitly excluded result revisions. This
        reports descriptive means and SD; it does not calculate p-values.
      </p>
      {snapshot.results.map((item) => (
        <label key={item.id} className="research-check">
          <input
            type="checkbox"
            aria-label={"Compare " + item.id}
            disabled={busy}
            checked={resultIds.includes(item.id)}
            onChange={(e) =>
              setResultIds(
                e.target.checked
                  ? [...resultIds, item.id]
                  : resultIds.filter((id) => id !== item.id),
              )
            }
          />
          {item.kind} · {item.review?.disposition ?? "pending"}
        </label>
      ))}
      <button
        disabled={busy || !resultIds.length}
        onClick={() => void perform(summarize)}
      >
        Summarize selected revisions
      </button>
      <label>
        Batch export contents{" "}
        <select
          aria-label="Batch export contents"
          disabled={busy}
          value={batchExportMode}
          onChange={(event) => setBatchExportMode(event.target.value as typeof batchExportMode)}
        >
          <option value="bundles+summary">Reviewed bundles and summary CSV</option>
          <option value="bundles">Reviewed bundles only</option>
          <option value="summary-only">Summary CSV only</option>
        </select>
      </label>
      <button
        className="research-primary"
        disabled={busy || !resultIds.length || resultIds.some((id) =>
          snapshot.results.find((item) => item.id === id)?.review?.disposition !== "reviewed")}
        onClick={() => void perform(exportReviewed)}
      >
        Export selected reviewed results
      </button>
      {summary.map((row, index) => (
        <div className="research-summary" key={index}>
          n objects: {String(row.n_objects)} · n images: {String(row.n_images)}{" "}
          · n biological replicates: {String(row.n_biological_replicates)} ·
          mean: {String(row.mean)} · SD: {String(row.sd)}
        </div>
      ))}
      <h3>Compare two versioned runs</h3>
      <p>
        Assign one exact result per source to run A and run B. Both groups must
        use the same sources, method, measurement units and scope. Excluded
        revisions remain in the audit receipt but do not enter replicate means.
      </p>
      {snapshot.results.map((item) => {
        const disposition = item.review?.disposition ?? "pending";
        const eligible = disposition === "reviewed" || disposition === "excluded";
        return (
          <div className="research-summary" key={`run-comparison-${item.id}`}>
            <strong>{item.kind}</strong> · {item.id} · {disposition}
            <label className="research-check">
              <input
                type="checkbox"
                aria-label={`Include ${item.id} in run A`}
                disabled={busy || !eligible}
                checked={leftResultIds.includes(item.id)}
                onChange={(event) => {
                  setComparison(null);
                  setLeftResultIds(
                    event.target.checked
                      ? [...leftResultIds, item.id]
                      : leftResultIds.filter((id) => id !== item.id),
                  );
                  if (event.target.checked)
                    setRightResultIds(
                      rightResultIds.filter((id) => id !== item.id),
                    );
                }}
              />
              Run A
            </label>
            <label className="research-check">
              <input
                type="checkbox"
                aria-label={`Include ${item.id} in run B`}
                disabled={busy || !eligible}
                checked={rightResultIds.includes(item.id)}
                onChange={(event) => {
                  setComparison(null);
                  setRightResultIds(
                    event.target.checked
                      ? [...rightResultIds, item.id]
                      : rightResultIds.filter((id) => id !== item.id),
                  );
                  if (event.target.checked)
                    setLeftResultIds(
                      leftResultIds.filter((id) => id !== item.id),
                    );
                }}
              />
              Run B
            </label>
            <button
              disabled={busy || disposition === "reviewed"}
              aria-label={`Mark ${item.id} reviewed`}
              onClick={() => void perform(() => setReview(item, "reviewed"))}
            >
              Mark reviewed
            </button>
            <button
              disabled={busy || disposition === "excluded"}
              aria-label={`Mark ${item.id} excluded`}
              onClick={() => void perform(() => setReview(item, "excluded"))}
            >
              Mark excluded
            </button>
          </div>
        );
      })}
      <button
        className="research-primary"
        disabled={busy || !leftResultIds.length || !rightResultIds.length}
        onClick={() => void perform(compare)}
      >
        Compare run A with run B
      </button>
      {comparison && (
        <section
          className="research-comparison-receipt"
          aria-label="Study run comparison receipt"
        >
          <p>
            Descriptive comparison only; no object-level p-values. Independent
            n is based on biological replicate means.
          </p>
          <div className="research-result-table">
            <table aria-label="Study run comparison">
              <thead>
                <tr>
                  <th>Condition</th>
                  <th>Run A mean</th>
                  <th>Run B mean</th>
                  <th>Difference (B − A)</th>
                  <th>Run A biological n</th>
                  <th>Run B biological n</th>
                </tr>
              </thead>
              <tbody>
                {comparison.comparisons.map((row) => (
                  <tr key={row.condition}>
                    <td>{row.condition}</td>
                    <td>{row.left_mean ?? "—"}</td>
                    <td>{row.right_mean ?? "—"}</td>
                    <td>{row.difference ?? "—"}</td>
                    <td>{row.left_n_biological_replicates}</td>
                    <td>{row.right_n_biological_replicates}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            Unit: {comparison.unit ?? "none declared"} · receipt SHA-256: {comparison.receipt_sha256}
            {comparison.comparison_document && (
              <>
                {" "}· saved comparison {comparison.comparison_document.id}, revision {comparison.comparison_document.revision}
              </>
            )}
          </p>
          {(["left", "right"] as const).map((side) => (
            <div key={side}>
              <h4>Run {side === "left" ? "A" : "B"} exact revisions</h4>
              <ul
                className="research-comparison-bindings"
                aria-label={`Run ${side === "left" ? "A" : "B"} exact revision bindings`}
              >
                {comparison[side].bindings.map((binding) => (
                  <li key={binding.result_id}>
                    Result {binding.result_id}; revision {binding.revision_hash}; source {binding.source_id}; source SHA-256 {binding.source_sha256}; {binding.review.disposition}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "NaN";
    return Number.isInteger(value) ? value.toLocaleString() : value.toFixed(3);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => (typeof v === "number" && Number.isFinite(v) ? (Number.isInteger(v) ? v : v.toFixed(2)) : String(v))).join(", ")}]`;
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

function ResultTable({
  rows,
  selected,
  onSelect,
}: {
  rows: Array<Record<string, unknown>>;
  selected: number | null;
  onSelect: (row: number) => void;
}) {
  const selectedRowRef = useRef<HTMLTableRowElement | null>(null);

  useEffect(() => {
    if (selected !== null && selectedRowRef.current) {
      const prefersReducedMotion =
        typeof window !== "undefined" &&
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      selectedRowRef.current.scrollIntoView({
        block: "nearest",
        behavior: prefersReducedMotion ? "auto" : "smooth",
      });
    }
  }, [selected]);

  if (!rows.length) return <p>No adopted object table yet.</p>;
  const fields = [
    "label",
    "measure",
    "measure_unit",
    "area",
    "volume",
    "centroid_index",
    "centroid_world_xyz",
    "intensity",
  ].filter((key) => key in rows[0]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!rows.length) return;
    const currentIdx = selected ?? -1;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const nextIdx = Math.min(rows.length - 1, currentIdx + 1);
      onSelect(nextIdx);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      const prevIdx = Math.max(0, currentIdx - 1);
      onSelect(prevIdx);
    } else if (event.key === "Home") {
      event.preventDefault();
      onSelect(0);
    } else if (event.key === "End") {
      event.preventDefault();
      onSelect(rows.length - 1);
    }
  };

  return (
    <div
      className="research-result-table"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      role="region"
      aria-label="Object measurements"
    >
      <table role="grid" aria-label="Measurements and object table" aria-rowcount={rows.length}>
        <thead>
          <tr role="row">
            {fields.map((field) => (
              <th key={field} role="columnheader">{field}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const isSelected = selected === index;
            return (
              <tr
                key={index}
                ref={isSelected ? selectedRowRef : null}
                className={isSelected ? "selected" : ""}
                role="row"
                aria-selected={isSelected}
                tabIndex={isSelected ? 0 : -1}
                onClick={() => onSelect(index)}
              >
                {fields.map((field) => (
                  <td key={field} role="gridcell">
                    {formatCellValue(row[field])}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
function Orthogonal({
  volume,
  onCrosshair,
}: {
  volume: Volume;
  onCrosshair: (value: [number, number, number]) => void;
}) {
  return (
    <div className="research-planes">
      {(["xy", "xz", "yz"] as const).map((plane) => {
        const [depth, height, width] = volume.shape;
        const planeWidth = plane === "yz" ? height : width;
        const planeHeight = plane === "xy" ? height : depth;
        return (
          <button
            key={plane}
            className="research-plane"
            aria-label={`Select ${plane.toUpperCase()} crosshair`}
            onClick={(event) => {
              const image = event.currentTarget.querySelector("img");
              if (!image) return;
              const box = image.getBoundingClientRect();
              const x = Math.min(
                planeWidth - 1,
                Math.max(
                  0,
                  Math.floor(
                    ((event.clientX - box.left) / box.width) * planeWidth,
                  ),
                ),
              );
              const y = Math.min(
                planeHeight - 1,
                Math.max(
                  0,
                  Math.floor(
                    ((event.clientY - box.top) / box.height) * planeHeight,
                  ),
                ),
              );
              if (!Number.isFinite(x) || !Number.isFinite(y)) return;
              const [z, cy, cx] = volume.crosshair;
              onCrosshair(
                plane === "xy"
                  ? [z, y, x]
                  : plane === "xz"
                    ? [y, cy, x]
                    : [y, x, cx],
              );
            }}
          >
            <span>{plane.toUpperCase()}</span>
            <img
              src={volume.planes[plane]}
              alt={`${plane.toUpperCase()} orthogonal plane`}
            />
          </button>
        );
      })}
      <small>
        Voxel z,y,x: {volume.crosshair.join(", ")} · world:{" "}
        {volume.world_xyz.join(", ")} · value: {volume.value}
      </small>
    </div>
  );
}
export function formatStatValue(v: number): string {
  if (!Number.isFinite(v)) return "–";
  if (v === 0) return "0";
  if (Number.isInteger(v)) return v.toString();
  if (Math.abs(v) < 0.0005) return v.toExponential(2);
  return v.toFixed(2);
}

export function computeResultStats(rows: Array<Record<string, unknown>>) {
  const totalCount = rows.length;
  if (!totalCount) return null;

  const firstRow = rows[0];
  let metricField: string | null = null;
  if ("measure" in firstRow) {
    metricField = "measure";
  } else if ("area" in firstRow) {
    metricField = "area";
  } else if ("volume" in firstRow) {
    metricField = "volume";
  } else {
    return null;
  }

  let metricLabel: string = metricField;
  if (typeof firstRow.measure_kind === "string") {
    const rawKind = firstRow.measure_kind.trim().toLowerCase();
    if (rawKind === "area") {
      metricLabel = "Area";
    } else if (rawKind === "volume") {
      metricLabel = "Volume";
    } else {
      metricLabel = firstRow.measure_kind;
    }
  }

  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let validCount = 0;
  let commonUnit: string | null = null;
  let mixedUnits = false;

  for (let i = 0; i < totalCount; i++) {
    const row = rows[i];
    const val = row[metricField];
    const unitRaw = typeof row.measure_unit === "string" ? row.measure_unit.trim() : "";
    const unit = unitRaw.replace(/pixel(\^2|²|2)/i, "px²").replace(/pixel(\^3|³|3)/i, "px³");

    if (i === 0) {
      commonUnit = unit;
    } else if (!mixedUnits && unit !== commonUnit) {
      mixedUnits = true;
    }

    if (typeof val === "number" && Number.isFinite(val)) {
      validCount++;
      if (val < min) min = val;
      if (val > max) max = val;
      sum += val;
    }
  }

  if (validCount === 0) return null;

  const mean = sum / validCount;
  const finalUnit = mixedUnits ? "mixed" : (commonUnit || "");

  return {
    metric: metricLabel,
    min: formatStatValue(min),
    max: formatStatValue(max),
    mean: formatStatValue(mean),
    unit: finalUnit,
    hasMixedUnits: mixedUnits,
    validCount,
    totalCount,
  };
}

function Info({
  source,
  snapshot,
  api,
  result,
  rows = [],
  selectedRow = null,
  onSelectRow,
  onSave,
  report,
  busy,
  onSnapshot,
}: {
  source: ResearchSource;
  snapshot: ResearchSnapshot;
  api: ResearchDesktopApi;
  result: ResearchSnapshot["results"][number] | null;
  rows?: Array<Record<string, unknown>>;
  selectedRow?: number | null;
  onSelectRow?: (row: number) => void;
  onSave: (value: ResearchSampleData) => Promise<void>;
  report: <T>(
    work: () => Promise<T>,
    fallback: string,
  ) => Promise<T | undefined>;
  busy: boolean;
  onSnapshot: (next: ResearchSnapshot | null) => void;
}) {
  const [reviewPending, setReviewPending] = useState(false);
  const reviewPendingRef = useRef(false);
  const [form, setForm] = useState<ResearchSampleData>({
    study: snapshot.project.title,
    sample: source.name,
    condition: "Unassigned",
  });
  useEffect(() => {
    const saved = snapshot.samples.find((item) => item.id === source.id);
    setForm(
      saved?.data ?? {
        study: snapshot.project.title,
        sample: source.name,
        condition: "Unassigned",
      },
    );
  }, [source.id, source.name, snapshot.samples, snapshot.project.title]);
  const disposition = result?.review?.disposition;
  const reviewStatus = reviewPending || disposition === "pending"
    ? "Review pending"
    : disposition === "reviewed"
      ? "Reviewed"
      : disposition === "excluded"
        ? "Excluded"
        : "Review required before export";
  const markReviewed = async () => {
    if (!result || busy || reviewPendingRef.current || disposition === "reviewed") return;
    reviewPendingRef.current = true;
    setReviewPending(true);
    try {
      await report(async () => {
        await api.reviewResult(result.id, result.revision_hash, "reviewed");
        onSnapshot(await api.getSnapshot());
      }, "Could not review result.");
    } finally {
      reviewPendingRef.current = false;
      setReviewPending(false);
    }
  };
  const stats = useMemo(() => computeResultStats(rows), [rows]);

  return (
    <div className="research-panel">
      <h2>Review & export</h2>
      {result ? (
        <>
          <p>Selected result · revision {result.revision_hash.slice(0, 12)}…</p>
          <p>{reviewStatus}</p>
          <button
            disabled={busy || reviewPending || disposition === "reviewed"}
            onClick={() => void markReviewed()}
          >
            Mark reviewed
          </button>
          <button
            disabled={busy || reviewPending || disposition !== "reviewed"}
            onClick={() =>
              void report(
                () => api.exportResult(result.id, result.revision_hash),
                "Could not export result.",
              )
            }
          >
            Export revision
          </button>
          {rows.length > 0 && (
            <div className="research-result-summary-card">
              <h3>Quantitative summary</h3>
              <div className="research-stat-grid">
                <div className="research-stat-item">
                  <span className="research-stat-label">Objects</span>
                  <span className="research-stat-value">
                    {stats && stats.validCount < stats.totalCount
                      ? `${stats.validCount} / ${stats.totalCount}`
                      : rows.length}
                  </span>
                </div>
                {stats && (
                  <>
                    <div className="research-stat-item">
                      <span className="research-stat-label">Mean {stats.metric}</span>
                      <span className="research-stat-value">
                        {stats.mean} {stats.unit && <small>{stats.unit}</small>}
                      </span>
                    </div>
                    <div className="research-stat-item">
                      <span className="research-stat-label">Range</span>
                      <span className="research-stat-value">
                        {stats.min} – {stats.max} {stats.unit && <small>{stats.unit}</small>}
                      </span>
                    </div>
                  </>
                )}
              </div>
              <ResultTable rows={rows} selected={selectedRow} onSelect={onSelectRow ?? (() => {})} />
            </div>
          )}
        </>
      ) : <p>Select a result to review and export its measurements.</p>}
      <details>
        <summary>Study metadata</summary>
      {(
        [
          "sample",
          "condition",
          "biological_replicate",
          "plate",
          "well",
        ] as const
      ).map((key) => (
        <label key={key}>
          {{ sample: "Sample", condition: "Condition", biological_replicate: "Biological replicate", plate: "Plate", well: "Well" }[key]}
          <input
            aria-label={key}
            value={form[key] ?? ""}
            onChange={(event) =>
              setForm((old) => ({ ...old, [key]: event.target.value || null }))
            }
          />
        </label>
      ))}
      <button
        onClick={() =>
          void onSave({
            ...form,
            study: snapshot.project.title,
            sample: form.sample || source.name,
            condition: form.condition || "Unassigned",
          })
        }
      >
        <Save /> Save metadata
      </button>
      </details>
    </div>
  );
}
