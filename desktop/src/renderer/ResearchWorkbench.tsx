import { StudyWorkspace, type StudySection } from "./StudyWorkspace";
import { ResearchWorkflowGraphPanel } from "./ResearchWorkflowGraphPanel";
import { SpatialDensityPanel } from "./SpatialDensityPanel";
import { ExperimentIntensityPanel } from "./ExperimentIntensityPanel";
import { SampleSheetPanel } from "./SampleSheetPanel";
import { resolveStudyResult, resolveStudySource } from "./study-sample-navigation";
import { ScientificDataExportPanel, type ScientificDataExportDraft, type ScientificDataExportDraftControl } from "./ScientificDataExportPanel";
import { GroupCentroidOverlay } from "./GroupCentroidOverlay";
import type { PopulationHighlight } from "./PopulationGroups";
import { CompactChannelControls } from "./CompactChannelControls";
import { GuidedExplorationPanel } from "./GuidedExplorationPanel";
import type { ImageWindowPresentation } from "../shared/image-window-api";
import { RecipeResourcePanel } from "./RecipeResourcePanel";
import { ResearchLabelsImportPanel } from "./ResearchLabelsImportPanel";
import { ResearchCorrectionEffectPanel, type CorrectionEffectSeed } from "./ResearchCorrectionEffectPanel";
import { SegmentationInputControl } from "./SegmentationInputControl";
import { ResearchAdaptivePanel, type ResearchAdaptiveBatchConfiguration } from "./ResearchAdaptivePanel";
import { WorkspaceRecordActions } from "./WorkspaceRecordActions";
import { SourceTree } from "./SourceTree";
import { BatchSourcePicker } from "./BatchSourcePicker";
import { sourceDisplayPath, sourceLabelForId } from "./source-browser";
import {
  ChevronLeft,
  FolderOpen,
  PanelsTopLeft,
  PictureInPicture2,
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
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type SetStateAction } from "react";
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
  ResearchAgentTargetReference,
  ResearchWorkspaceChange,
  ManagedSessionState,
} from "../shared/research-contracts";
import "./ResearchWorkbench.css";
import { firstStudyDisplayChannels } from "./first-study-display";
import { initialSourceDisplay, rgbChannelsForPlane, type SourceDisplayDefaults } from "./initial-source-display";
import { ResultContextPanel } from "./ResultContextPanel";
import { ResearchReviewHistory, researcherReviewed, reviewLabel } from "./ResearchReviewHistory";
import { resultTitle } from "./result-title";
import { LargeAnalysisPanel, LargeResultViewport, LargeResultInspector, isLargeResult } from "./LargeResultWorkspace";
import {
  ResearchCorrectionPanel,
  type CorrectionPreview,
  type Plane,
  type Point,
  type CorrectionObjectTarget,
} from "./ResearchCorrectionPanel";
import { ResearchRegistrationPanel } from "./ResearchRegistrationPanel";
import { ResearchPopulationExplorer } from "./ResearchPopulationExplorer";
import { ResearchWorkflowPanel } from "./ResearchWorkflowPanel";
import { ResearchQuantificationPanel } from "./ResearchQuantificationPanel";
import { SpatialSummary } from "./ResearchSpatialPanel";
import { PerinuclearResultSummary } from "./ResearchPerinuclearPanel";
import { AgentImagePanel } from "./AgentImagePanel";
import { SourceDisplayFollower } from "./source-display-follower";
import { ResearchAgentPanel } from "./ResearchAgentPanel";
import { AgentSessionIndicator } from "./AgentSessionIndicator";
import { AgentPreviewComparison, type SharedTaskPreview } from "./AgentPreviewComparison";
import { AgentResultTracker, useWorkspaceSnapshotPolling } from "./agent-session-refresh";
import { AgentSourceActivityTracker, agentResultTarget, agentSourceTarget, agentSourceView } from "./agent-navigation";
import { ResearchPortabilityPanel } from "./ResearchPortabilityPanel";
import { ResearchVendorPanel } from "./ResearchVendorPanel";
import { ResearchRemotePanel } from "./ResearchRemotePanel";
import { activeComputeRun, ResearchComputeControl, ResearchComputeJobs, useResearchCompute, type ResearchComputeController } from "./ResearchCompute";
import { ResearchSurfaceView } from "./ResearchSurfaceView";
import { ResearchTemporalPanel } from "./ResearchTemporalPanel";
import {
  clampNativeSelection,
  maxNativeViewPixels,
} from "./ResearchNativeViewport";
import { ResearchHistologyPanel } from "./ResearchHistologyPanel";
import { ImageViewport, type ImageAnnotation, type ImagePoint, type ViewerChannel } from "./ImageViewport";
import { resolveResultPlaneOverlay, resultPixelToSourcePoint, sourcePointToResultPixel } from "./result-plane-overlay";
import { SourceAnnotationPanel } from "./SourceAnnotationPanel";
import { useAnnotationDrafts } from "./annotation-draft";
import { subscribeWorkbenchCommands, type WorkbenchCommand } from "./workbench-commands";
import { ValidatedNumberInput, useNumericValidity } from "./ValidatedNumberInput";
import { ImageWelcome, WorkbenchTools, type WorkbenchTab } from "./WorkbenchChrome";
import { FirstStudyGuide } from "./FirstStudyGuide";
import { sourceRelinkKind } from "../shared/source-relink";
import { RawVolumeViewport, type RawVolumeResponse, type RawVolumeRefinementRequest } from "./RawVolumeViewport";
import BrandMark from "./BrandMark";
import { SourceDisplayPanel, type SourceInterpretation } from "./SourceDisplayPanel";
import { SourceExportPanel } from "./SourceExportPanel";
import { SourceViewStore, type SavedSourceView } from "./source-view-store";
import type { Camera } from "./viewer-camera";
import { ContextHelp, ResearchError, sanitizeRendererError } from "./ContextHelp";
import { DEFAULT_PREFERENCES, type UserPreferences } from "./preferences";
import {
  ResearchCellposePanel,
  type ResearchCellposeBatchConfiguration,
} from "./ResearchCellposePanel";

type Props = {
  initialSourceId?: string | null;
  preferences?: UserPreferences;
  api: ResearchDesktopApi;
  onBack: () => void;
  onOpenSettings?: () => void;
  onOpenCompute?: () => void;
  onSourcesReorder?: (sources: ResearchSource[]) => void;
};
type Tab = WorkbenchTab;
function resultReviewState(result: ResearchResult): "pending" | "reviewed" | "excluded" {
  // The engine binds summary review state to this exact result. If a full receipt
  // is supplied, reject contradictory identities rather than displaying approval.
  const review = result.review as (NonNullable<ResearchResult["review"]> & { result_id?: string; revision_hash?: string }) | null | undefined;
  if (!review || (review.result_id !== undefined && review.result_id !== result.id)
    || (review.revision_hash !== undefined && review.revision_hash !== result.revision_hash)) return "pending";
  return review.disposition === "reviewed" || review.disposition === "excluded" ? review.disposition : "pending";
}
// Human labels only: selection and loading continue to use exact result identities.
function resultRowDiscriminators(results: ResearchResult[]): Map<string, string> {
  const groups = new Map<string, ResearchResult[]>();
  for (const result of results) {
    const key = JSON.stringify([resultTitle(result), result.object_count, resultReviewState(result)]);
    const group = groups.get(key) ?? [];
    group.push(result);
    groups.set(key, group);
  }
  const labels = new Map<string, string>();
  const formatter = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "medium" });
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const byTime = new Map<string, ResearchResult[]>();
    for (const result of group) {
      const date = new Date(result.created_at);
      const time = Number.isFinite(date.getTime()) ? formatter.format(date) : "";
      const peers = byTime.get(time) ?? [];
      peers.push(result);
      byTime.set(time, peers);
    }
    for (const [time, peers] of byTime) {
      // A deterministic ordinal also covers missing timestamps and equal displayed seconds.
      peers.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
      peers.forEach((result, index) => labels.set(result.id,
        peers.length > 1 || !time ? `Result ${index + 1}${time ? ` · ${time}` : ""}` : `Created ${time}`));
    }
  }
  return labels;
}
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
  labelImage?: string | null;
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
  working_bytes: 512 * 1024 ** 2,
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
  const documents = [...(snapshot.comparisons ?? [])].filter(document =>
    (document.data.receipt as { schema?: unknown } | null)?.schema === "loci.study-run-comparison/v1").sort((left, right) =>
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
  return sanitizeRendererError(value);
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
    ]).then(async ([defaultsValue, savedValue]) => {
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
      const initial = await initialSourceDisplay(api, source, defaultsValue as SourceDisplayDefaults, Boolean(saved.state), comparisonSelection(source).z);
      if (token.current !== currentToken) return;
      const channels = comparisonChannels(saved.state?.channels ?? initial.channels, source);
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
      ? { ...previous, selection: clamp(selection, dimensions),
        channels: rgbChannelsForPlane(previous.channels, ["RGB", "RGBA"].includes(source.metadata.sample_semantics ?? ""), selection.c) }
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
  const rgb = ["RGB", "RGBA"].includes(source.metadata.sample_semantics ?? "");
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
          <ValidatedNumberInput key={`${source.id}:${source.sha256}`} label={`Pane ${label} time`} integer minimum={1} maximum={dimensions.t}
            value={pane.selection.t + 1} disabled={dimensions.t <= 1 || !pane.ready}
            onValue={(value) => { pane.setSelection({ ...pane.selection, t: value - 1 }); return true; }} />
        </label>}
        {dimensions.z > 1 && <label>
          Z
          <ValidatedNumberInput key={`${source.id}:${source.sha256}`} label={`Pane ${label} Z`} integer minimum={1} maximum={dimensions.z}
            value={pane.selection.z + 1} disabled={dimensions.z <= 1 || !pane.ready}
            onValue={(value) => { pane.setSelection({ ...pane.selection, z: value - 1 }); return true; }} />
        </label>}
        <label>
          View
          <select aria-label={`Pane ${label} channel view`} value={channelMode} disabled={!pane.ready}
            onChange={(event) => {
              if (rgb) { pane.setSelection({ ...pane.selection, c: Number(event.target.value) }); return; }
              if (event.target.value === "all") {
                pane.setChannels(pane.channels.map((item) => ({ ...item, visible: true })));
                return;
              }
              const selected = Number(event.target.value);
              pane.setChannels(pane.channels.map((item) => ({ ...item, visible: item.channel === selected })));
              pane.setSelection({ ...pane.selection, c: selected });
            }}>
            {channelMode === "custom" && <option value="custom" disabled>Custom</option>}
            {!rgb && <option value="all">All visible</option>}
            {(rgb ? Array.from({ length: dimensions.c }, (_, channel) => ({ channel })) : pane.channels).map((item) => <option key={item.channel} value={item.channel}>
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
    label_image?: unknown;
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
    labelImage: typeof view.label_image === "string" && view.label_image.startsWith("data:image/png;base64,") ? view.label_image : null,
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

export default function ResearchWorkbench({
  initialSourceId,
  api: desktopApi,
  onBack,
  onOpenSettings,
  onOpenCompute,
  onSourcesReorder,
  preferences = DEFAULT_PREFERENCES,
}: Props): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<ResearchSnapshot | null>(null);
  const initialSource = useRef(initialSourceId);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("Display");
  const [workflowOpened, setWorkflowOpened] = useState(false);
  const [graphOpened, setGraphOpened] = useState(false);
  const [quantificationOpened, setQuantificationOpened] = useState(false);
  const [densityOpened, setDensityOpened] = useState(false);
  const [quantificationEntryKey, setQuantificationEntryKey] = useState(0);
  const [quantificationEntry, setQuantificationEntry] = useState<"channels" | "association">("channels");
  const [populationOpened, setPopulationOpened] = useState(false);
  const [statisticsFocused, setStatisticsFocused] = useState(false);
  const [focusedPanel, setFocusedPanel] = useState<Tab | null>(null);
  const toolHeaderRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setFocusedPanel(null); }, [tab]);
  const [resultSection, setResultSection] = useState<"review" | "export">("review");
  const [studySection, setStudySection] = useState<StudySection>("samples");
  const [studyFocused, setStudyFocused] = useState(false);
  const [studyOpened, setStudyOpened] = useState(false);
  const [selection, setSelection] = useState(DEFAULT_SELECTION);
  const [channelSettings, setChannelSettings] = useState<Channel[]>([]);
  const [image, setImage] = useState<string | null>(null);
  const [volume, setVolume] = useState<Volume | null>(null);
  const [projection, setProjection] = useState<"plane" | "max" | "mean">(
    "plane",
  );
  const [recipe, setRecipe] = useState(DEFAULT_RECIPE);
  const [segmentationFamily, setSegmentationFamily] = useState<"classical" | "stain" | "adaptive" | "cellpose-sam" | "cellpose-sam-v2" | "large-components">("classical");
  const [adaptiveBatchConfiguration, setAdaptiveBatchConfiguration] = useState<ResearchAdaptiveBatchConfiguration | null>(null);
  const [resultId, setResultId] = useState<string | null>(null);
  const [correctionEffectSeed, setCorrectionEffectSeed] = useState<CorrectionEffectSeed | null>(null);
  useEffect(() => { if (tab !== "Study") setCorrectionEffectSeed(null); }, [tab]);
  const [resultView, setResultView] = useState<ResultView | null>(null);
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
  const [selectedRow, setSelectedRow] = useState<number | null>(null);
  const [populationHighlight, setPopulationHighlight] = useState<PopulationHighlight | null>(null);
  const [populationObject, setPopulationObject] = useState<Record<string, unknown> | null>(null);
  const [correctionObjectTarget, setCorrectionObjectTarget] = useState<CorrectionObjectTarget | null>(null);
  const [largeObject, setLargeObject] = useState<Record<string, unknown> | null>(null);
  const [largeFocus, setLargeFocus] = useState<{ point_index: [number, number] } | null>(null);
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
  const [sourceViewportSize, setSourceViewportSize] = useState<{ scope: string; width: number; height: number } | null>(null);
  const pendingResultSection = useRef<"review" | "export">("review");
  const [pendingResultNavigation, setPendingResultNavigation] =
    useState<ResearchResult | null>(null);
  const pendingStudyNavigation = useRef<{ target: ResearchResult; scope: string; intent: number; isCurrent?: () => boolean } | null>(null);
  const [surfaceOpen, setSurfaceOpen] = useState(false);
  const [rawVolumeOpen, setRawVolumeOpen] = useState(false);
  const [volumeDisplay, setVolumeDisplay] = useState<NonNullable<ImageWindowPresentation["volumeDisplay"]>>({ renderMode: "blend", quality: 50 });
  const [rawVolume, setRawVolume] = useState<RawVolumeResponse | null>(null);
  const [rawVolumeLoading, setRawVolumeLoading] = useState(false);
  const [rawVolumeError, setRawVolumeError] = useState<string | null>(null);
  const rawVolumeToken = useRef(0);
  const [session, setSession] = useState<ManagedSessionState>({ status: "empty" });
  const [jobsOpen, setJobsOpen] = useState(false);
  const [sourceAnnotations, setSourceAnnotations] = useState<ImageAnnotation[]>([]);
  const [invalidNumberForms, setInvalidNumberForms] = useState<Record<string, true>>({});
  const [numberResetEpoch, setNumberResetEpoch] = useState(0);
  const annotationViewportReady = useRef(false);
  const annotationViewReady = useCallback((key: string) => {
    annotationViewportReady.current = Boolean(key);
    setViewReadyKey(key);
  }, []);
  const [sourceDefaultChannels, setDefaultChannels] = useState<Channel[]>([]);
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
  const viewStoreFailure = useRef<{ store: SourceViewStore; error: unknown } | null>(null);
  const [assistantFollowing, setAssistantFollowing] = useState(false);
  const [assistantFollowBusy, setAssistantFollowBusy] = useState(false);
  const assistantFollower = useRef<SourceDisplayFollower | null>(null);
  const assistantFollowGeneration = useRef(0);
  const [followAgent, setFollowAgent] = useState(false);
  const agentResultTracker = useRef(new AgentResultTracker());
  const agentSourceTracker = useRef(new AgentSourceActivityTracker());
  const [pendingAgentSource, setPendingAgentSource] = useState<{
    target: ResearchAgentTargetReference; isCurrent: () => boolean;
  } | null>(null);
  const [sharedPreview, setSharedPreview] = useState<{ preview: SharedTaskPreview; study: string } | null>(null);
  const previewReturnFocus = useRef<HTMLElement | null>(null);
  const previewReadToken = useRef(0);
  const [agentRefreshError, setAgentRefreshError] = useState<string | null>(null);
  const agentInteraction = useRef({ pointers: new Set<number>(), lastInput: 0, generation: 0 });
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
  // A completed large job remains durable, but only the interaction which
  // started it may replace the user's current source/result presentation.
  const largeNavigationIntent = useRef(0);
  const largeSelectionIntent = useRef(0);
  const recipePresetToken = useRef(0);
  const emptyDropDepth = useRef(0);
  const imageFrameRef = useRef<HTMLDivElement | null>(null);
  const previewScope = useRef<string | null>(null);
  const projectionSourceId = useRef<string | null>(null);
  const projectionSourceSha256 = useRef<string | null>(null);
  const projectionSourceLocatorState = useRef<string | null>(null);
  const [documentEpoch, setDocumentEpoch] = useState(0);
  const [studyEpoch, setStudyEpoch] = useState(0);
  const [scientificExportDraft, setScientificExportDraft] = useState<{ study: string; draft: ScientificDataExportDraft } | null>(null);
  const exportDraftStudy = JSON.stringify([snapshot?.project.project_id ?? null, studyEpoch]);
  const currentStudyScope = useRef(exportDraftStudy);
  currentStudyScope.current = exportDraftStudy;
  const [intensitySeed, setIntensitySeed] = useState<{ study: string; result: ResearchResult; serial: number } | null>(null);
  const scientificExportDraftControl: ScientificDataExportDraftControl = {
    draft: scientificExportDraft?.study === exportDraftStudy ? scientificExportDraft.draft : null,
    onDraftChange: (draft) => setScientificExportDraft({ study: exportDraftStudy, draft }),
  };
  useEffect(() => { setCorrectionEffectSeed(null); setStudySection("samples"); setStudyFocused(false); }, [studyEpoch]);
  const [documentSwitching, setDocumentSwitching] = useState(false);
  const initialStudyRestore = useRef<Promise<unknown>>(Promise.resolve());
  const nativeCommandPending = useRef(false);
  const documentSwitch = useRef(false);
  const switchDocument = useCallback(async <T,>(action: () => Promise<T>, resetDisplay = true,
    { preserveNavigationIntent = false }: { preserveNavigationIntent?: boolean } = {}): Promise<T> => {
    if (documentSwitch.current) throw new Error("Wait for the study to finish opening.");
    if (!preserveNavigationIntent) {
      largeNavigationIntent.current++;
      largeSelectionIntent.current++;
    }
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
      if (store && !await store.flush()) {
        const failure = viewStoreFailure.current;
        throw new Error(message(failure?.store === store ? failure.error : null,
          "Display settings could not be saved. Resolve the displayed error before switching studies."));
      }
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
    ...(desktopApi.tryExample ? { tryExample: () => switchDocument(() => desktopApi.tryExample!()) } : {}),
    ...(desktopApi.relinkSource ? { relinkSource: (id, kind) => switchDocument(() => desktopApi.relinkSource!(id, kind), false) } : {}),
    // This same-study picker takes the main-process document lock, but its
    // caller has already captured the source/plane and navigation intent.
    ...(desktopApi.labelsImportPreview ? { labelsImportPreview: (request) =>
      switchDocument(() => desktopApi.labelsImportPreview!(request), false, { preserveNavigationIntent: true }) } : {}),
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
    ...(desktopApi.planDataExport ? { planDataExport: (request, key) => desktopApi.planDataExport!(request, key) } : {}),
    ...(desktopApi.exportDataPackage ? { exportDataPackage: (planJson, key) => desktopApi.exportDataPackage!(planJson, key) } : {}),
    ...(desktopApi.cancelDataExport ? { cancelDataExport: (key) => desktopApi.cancelDataExport!(key) } : {}),
    exportResult: (id, revisionHash, runId) =>
      switchDocument(() => desktopApi.exportResult(id, revisionHash, runId), false),
    ...(desktopApi.exportBatch ? { exportBatch: (bindings, options) =>
      switchDocument(() => desktopApi.exportBatch!(bindings, options), false) } : {}),
    ...(desktopApi.exportReviewPackage ? { exportReviewPackage: (bindings, options) =>
      switchDocument(() => desktopApi.exportReviewPackage!(bindings, options), false) } : {}),
    ...(desktopApi.inspectVendor ? { inspectVendor: () =>
      switchDocument(() => desktopApi.inspectVendor!(), false) } : {}),
    ...(desktopApi.convertVendor ? { convertVendor: (request) =>
      switchDocument(() => desktopApi.convertVendor!(request), false) } : {}),
  }), [desktopApi, switchDocument]);
  const source =
    snapshot?.sources.find((entry) => entry.id === sourceId) ?? null;
  const sourceResults = useMemo(() => snapshot?.results.filter((item) => item.source_id === sourceId) ?? [], [snapshot?.results, sourceId]);
  useLayoutEffect(() => {
    const header = toolHeaderRef.current;
    if (!header) return;
    const update = () => {
      const height = header.getBoundingClientRect().height;
      if (height > 0) header.parentElement?.style.setProperty("--research-tool-header-height", `${height}px`);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(header);
    return () => observer.disconnect();
  }, [source?.id, tab, preferences.textSize, preferences.font]);
  const resultDiscriminators = useMemo(() => resultRowDiscriminators(sourceResults), [sourceResults]);
  const numberScope = `${documentEpoch}:${source?.id}:${source?.sha256}`;
  const reportSourceViewportSize = useCallback((size: { width: number; height: number }) => {
    setSourceViewportSize((previous) => previous?.scope === numberScope && previous.width === size.width && previous.height === size.height
      ? previous : { scope: numberScope, ...size });
  }, [numberScope]);
  const numberKey = `${numberScope}:${numberResetEpoch}`;
  const configurationValid = !Object.keys(invalidNumberForms).some((key) => key.startsWith(`${numberScope}:`));
  const reportNumberValidity = useCallback((form: string, valid: boolean) => {
    const key = `${numberScope}:${form}`;
    setInvalidNumberForms((previous) => {
      if (!valid) return previous[key] ? previous : { ...previous, [key]: true };
      if (!previous[key]) return previous;
      const { [key]: _restored, ...next } = previous;
      return next;
    });
  }, [numberScope]);
  const restoreAppliedNumbers = () => {
    setInvalidNumberForms((previous) => Object.fromEntries(Object.entries(previous).filter(([key]) => !key.startsWith(`${numberScope}:`))));
    setNumberResetEpoch((value) => value + 1);
  };
  const sourceIsChanging = Boolean(source && (projectionSourceId.current !== source.id || projectionSourceSha256.current !== source.sha256));
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
      const preferred = preferredId ?? (!previousSnapshot ? initialSource.current : undefined);
      const targetId = preferred
        ? (next.sources.find((s) => s.id === preferred)?.id ?? null)
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

  const compute = useResearchCompute({ api, projectId: snapshot?.project.project_id, scope: studyEpoch,
    enabled: Boolean(snapshot?.operations.remote_analysis_plan), suspended: documentSwitching,
    onAttached: async () => {
      const expectedProject = snapshot?.project.project_id;
      const next = await api.getSnapshot();
      if (!documentSwitch.current && next?.project.project_id === expectedProject) adopt(next);
    } });
  const remoteJobCount = compute.runs.filter(activeComputeRun).length;
  const localJobCount = snapshot?.jobs.filter(job => ["running", "queued"].includes(job.state)).length ?? 0;

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
    (item: ResearchSource, event: React.MouseEvent, visibleSourceIds?: string[]) => {
      if (!snapshot) return;
      const allIds = visibleSourceIds ?? snapshot.sources.map((s) => s.id);
      const clickedId = item.id;
      const clickedIndex = allIds.indexOf(clickedId);
      const anchorIndex = selectionAnchorId ? allIds.indexOf(selectionAnchorId) : -1;
      if (event.metaKey || event.ctrlKey) {
        const next = selectedSourceIds.includes(clickedId)
          ? selectedSourceIds.filter((id) => id !== clickedId)
          : [...selectedSourceIds, clickedId];
        if (!next.length) next.push(clickedId);
        setSelectedSourceIds(next);
        setSelectionAnchorId(clickedId);
        setSelectionPivotIds(next);
      } else if (event.shiftKey && anchorIndex >= 0 && clickedIndex >= 0) {
        const rangeIds = allIds.slice(Math.min(anchorIndex, clickedIndex), Math.max(anchorIndex, clickedIndex) + 1);
        setSelectedSourceIds(Array.from(new Set([...selectionPivotIds, ...rangeIds])));
      } else {
        setSelectedSourceIds([clickedId]);
        setSelectionAnchorId(clickedId);
        setSelectionPivotIds([clickedId]);
      }
      if (clickedId !== sourceId) {
        largeNavigationIntent.current++;
        largeSelectionIntent.current++;
        setProjection("plane");
        setSourceId(clickedId);
      }
    },
    [snapshot, selectedSourceIds, selectionAnchorId, selectionPivotIds, sourceId],
  );

  const toggleSourceSelection = useCallback((item: ResearchSource) => {
    const next = selectedSourceIds.includes(item.id) ? selectedSourceIds.filter(id => id !== item.id) : [...selectedSourceIds, item.id];
    if (!next.length) next.push(item.id);
    setSelectedSourceIds(next); setSelectionAnchorId(item.id); setSelectionPivotIds(next);
  }, [selectedSourceIds]);

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
    largeNavigationIntent.current++;
    largeSelectionIntent.current++;

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
      // updateWorkspace has paused and flushed the current store before the
      // workspace boundary. Retire it only after the close is acknowledged;
      // dropping it earlier leaves its debounce timer free to race an undo.
      if (sourcesToClose.some(item => item.id === sourceId)) {
        viewStore.current?.discard();
        viewStore.current = null;
        projectionSourceId.current = null;
        projectionSourceLocatorState.current = null;
        setViewSettingsReady(false);
        displayToken.current++;
        resultLoadToken.current++;
        void api.cancelView?.();
        rawVolumeToken.current++;
        setRawVolume(null);
        setRawVolumeOpen(false);
        setSurfaceOpen(false);
        if (next.sources.length === 0) {
          setImage(null); setVolume(null); setResultId(null); setResultView(null);
          setRows([]); setSelectedRow(null); setCorrectionPoints([]); setRedoStack([]);
        }
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
      isCurrent: () => boolean = () => true,
    ): Promise<T | undefined> => {
      try {
        return await work();
      } catch (caught) {
        if (isCurrent()) setError(message(caught, fallback));
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
  const channels = useMemo(() => rgbChannelsForPlane(channelSettings, isRgb, shownSelection.c),
    [channelSettings, isRgb, shownSelection.c]);
  const defaultChannels = useMemo(() => rgbChannelsForPlane(sourceDefaultChannels, isRgb, shownSelection.c),
    [sourceDefaultChannels, isRgb, shownSelection.c]);
  const setChannels = useCallback((update: SetStateAction<Channel[]>) => {
    setChannelSettings((previous) => typeof update === "function"
      ? update(rgbChannelsForPlane(previous, isRgb, shownSelection.c)) : update);
  }, [isRgb, shownSelection.c]);
  const selectSourcePlane = (next: ResearchSelection) => {
    if (!viewSettingsReady || sourceIsChanging || documentSwitching) return;
    if (isRgb && next.c !== shownSelection.c) {
      setResultId(null); setResultView(null); setImage(null); setVolume(null);
    }
    setSelection(next);
  };
  const labelImportScope = JSON.stringify([documentEpoch, source?.id, source?.sha256, shownSelection]);
  const liveLabelImportScope = useRef(labelImportScope);
  const labelImportBusyOwner = useRef<{ owner: string; message: string } | null>(null);
  liveLabelImportScope.current = labelImportScope;
  const annotationState = useAnnotationDrafts(documentEpoch, snapshot?.sources ?? [], source, shownSelection,
    tab === "Epidermis" ? "epidermis" : "general");
  const { tool: annotationTool, setTool: setAnnotationTool, points: annotationDraft, setPoints: setAnnotationDraft } = annotationState;
  const updateViewportDraft = useCallback((points: ImagePoint[]) => {
    // A viewport abort reports its old gesture after announcing that the new plane
    // is not ready. Never write those old coordinates into the new plane's slot.
    if (annotationViewportReady.current) setAnnotationDraft(points);
  }, [setAnnotationDraft]);
  const autoPlaneKey = `${source?.id}:${source?.sha256}:${shownSelection.t}:${shownSelection.z}:${shownSelection.c}`;
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
    let active = true;
    initialStudyRestore.current = report(
      async () => { const next = await api.getSnapshot(); if (active) adopt(next); },
      "Could not restore this study.",
    );
    return () => { active = false; };
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
  const nativeCommandState = useRef({ busy, documentSwitching, openImages, api, report, adopt });
  nativeCommandState.current = { busy, documentSwitching, openImages, api, report, adopt };
  useEffect(() => {
    let active = true;
    const unsubscribe = subscribeWorkbenchCommands((command: WorkbenchCommand) => {
      const state = nativeCommandState.current;
      if (nativeCommandPending.current || state.busy || state.documentSwitching || documentSwitch.current) return;
      nativeCommandPending.current = true;
      void (async () => {
        await initialStudyRestore.current;
        if (!active) return;
        const current = nativeCommandState.current;
        if (current.busy || current.documentSwitching || documentSwitch.current) return;
        if (command === "open-images" || command === "open-folder") await current.openImages(command === "open-folder" ? "folder" : "files");
        else if (command === "open-study") await current.report(() => current.api.openStudy().then(current.adopt), "Could not open this study.");
        else if (current.api.saveAs) await current.report(() => current.api.saveAs!().then(current.adopt), "Could not save this study.");
      })().finally(() => { nativeCommandPending.current = false; });
    });
    return () => { active = false; unsubscribe(); };
  }, []);
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
      projectionSourceSha256.current = source.sha256;
      projectionSourceLocatorState.current = "relink-required";
      const previousStore = viewStore.current;
      previousStore?.discard();
      viewStore.current = null;
      setSourceAnnotations([]);
      setRawVolumeOpen(false); setRawVolume(null); setVolumeDisplay({ renderMode: "blend", quality: 50 }); rawVolumeToken.current++;
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
    if (projectionSourceId.current === source.id && projectionSourceSha256.current === source.sha256 && projectionSourceLocatorState.current === currentLocatorState) {
      setSelection((old) => clamp(old, dimensions));
      return;
    }
    // A Z extent belongs to the prior source grid.  Carrying it into a newly
    // selected RGB plane would turn an explicit single-plane histology request
    // into an invalid volume request.
    projectionSourceId.current = source.id;
    projectionSourceSha256.current = source.sha256;
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
    setSourceAnnotations([]);
    setRawVolumeOpen(false); setRawVolume(null); setVolumeDisplay({ renderMode: "blend", quality: 50 }); rawVolumeToken.current++;
    const token = ++displayToken.current;
    void viewDrain.current.then(() => Promise.all([api.execute("viewer_defaults", { source_id: source.id, t: 0, z: 0, auto: false }),
      api.execute("source_view", { source_id: source.id })])).then(async ([value, saved]) => {
      if (displayToken.current !== token) return;
      let defaults = value as SourceDisplayDefaults;
      if (defaults.source_id !== source.id || defaults.source_sha256 !== source.sha256 || !Array.isArray(defaults.channels))
        throw new Error("Display defaults do not match this source.");
      const view = saved as SavedSourceView;
      if (view.source_id !== source.id || view.source_sha256 !== source.sha256 || !Number.isInteger(view.revision))
        throw new Error("Saved display settings do not match this source.");
      defaults = await initialSourceDisplay(api, source, defaults, Boolean(view.state), Math.floor(dimensions.z / 2));
      if (displayToken.current !== token) return;
      const exampleChannels = snapshot ? firstStudyDisplayChannels(snapshot.project, source, defaults.channels) : null;
      const initialChannels = exampleChannels ?? defaults.channels;
      setChannels(view.state?.channels ?? initialChannels); setDefaultChannels(initialChannels);
      if (view.state) {
        setInterpretation(view.state.interpretation); setProjection(view.state.projection);
        if (view.state.interpretation === "volume" && dimensions.z > 1 && !rawVolumeUnavailable) setRawVolumeOpen(true);
        if (view.state.interpretation === "histology" && isRgb) setSegmentationFamily("stain");
        setRgbMapping(view.state.rgb_mapping ?? null);
        setSelection(view.state.selection); setSavedCamera(view.state.camera); setViewCamera(view.state.camera);
      }
      const store = new SourceViewStore(api, source.id, source.sha256, view.revision, (caught) => {
        viewStoreFailure.current = { store, error: caught };
        setError(message(caught, "Could not save display settings."));
      });
      viewStore.current = store;
      setViewSettingsReady(true);
      setDisplayBasis(exampleChannels ? "Authored example display" : typeof defaults.basis === "string" ? defaults.basis : "Source defaults");
    }).catch((caught) => { if (displayToken.current === token) setError(message(caught, "Could not prepare source display settings.")); });
    setImage(null);
    setVolume(null);
    setResultId(null);
    setResultView(null);
    setRows([]);
    setSelectedRow(null);
    setPopulationObject(null);
    objectPickToken.current++;
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
    source?.sha256,
    source?.locator_state,
    dimensions?.c,
    dimensions?.x,
    dimensions?.y,
    dimensions?.z,
    dimensions?.t,
  ]);
  useEffect(() => {
    assistantFollowGeneration.current++;
    const follower = assistantFollower.current;
    assistantFollower.current = null;
    void follower?.stop();
    setAssistantFollowing(false); setAssistantFollowBusy(false);
    return () => {
      assistantFollowGeneration.current++;
      const active = assistantFollower.current;
      assistantFollower.current = null;
      void active?.stop();
    };
  }, [api, source?.id, source?.sha256, documentEpoch, resultId]);
  const followAssistantDisplay = async (active: boolean) => {
    const generation = ++assistantFollowGeneration.current;
    setAssistantFollowBusy(true);
    autoRequestToken.current++;
    try {
      await assistantFollower.current?.stop();
      assistantFollower.current = null;
      if (generation !== assistantFollowGeneration.current) return;
      if (!active) { setAssistantFollowing(false); return; }
      const store = viewStore.current;
      if (!source || !store || !viewSettingsReady) throw new Error("Wait for source display settings to load.");
      setAssistantFollowing(true);
      const follower = new SourceDisplayFollower(api, source.id, source.sha256, store, (nextChannels) => {
        if (generation !== assistantFollowGeneration.current) return;
        setChannels(nextChannels);
      }, (caught) => {
        if (generation !== assistantFollowGeneration.current) return;
        setError(message(caught, "Could not follow assistant display settings."));
        setAssistantFollowing(false);
        void assistantFollower.current?.stop();
      });
      assistantFollower.current = follower;
      await follower.start();
    } catch (caught) {
      if (generation === assistantFollowGeneration.current) {
        setAssistantFollowing(false);
        setError(message(caught, "Could not follow assistant display settings."));
      }
    } finally { if (generation === assistantFollowGeneration.current) setAssistantFollowBusy(false); }
  };
  useEffect(() => {
    if (assistantFollowing || assistantFollowBusy) return;
    if (viewSettingsReady && channels.length && source && projectionSourceId.current === source.id) {
      const adopted = batchViewAdoption.current;
      if (adopted?.sourceId === source.id && adopted.sourceSha256 === source.sha256 && adopted.channels === channels) {
        batchViewAdoption.current = null;
        return;
      }
      viewStore.current?.save({ interpretation, channels, projection, selection: shownSelection, camera: viewCamera, rgb_mapping: rgbMapping });
    }
  }, [viewSettingsReady, interpretation, channels, projection, shownSelection, viewCamera, rgbMapping, source?.id, assistantFollowing, assistantFollowBusy]);
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
    if (!configurationValid) return;
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
    if (!pendingModel || !configurationValid) return;
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
    if (!source || !configurationValid) return;
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
    if (!source || !configurationValid) return;
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
  const hasPendingJobs = Boolean(
    busy === "run" || busy === "Large image segmentation" || busy === "Removing object" ||
    busy === "Importing remote result" || busy === "Export" ||
    snapshot?.jobs.some((job) => job.state === "queued" || job.state === "running"),
  );
  const hasActiveAgentActivity = Boolean(
    snapshot?.agent_sessions &&
      (snapshot.agent_sessions.connected_count > 0 ||
        snapshot.agent_sessions.pending_approval_count > 0 ||
        snapshot.agent_sessions.policies.some((policy) => !policy.revoked)),
  );
  useWorkspaceSnapshotPolling({
    snapshot, scope: exportDraftStudy,
    enabled: hasPendingJobs || hasActiveAgentActivity,
    suspended: documentSwitching,
    interval: hasPendingJobs ? 1000 : 2000,
    getSnapshot: api.getSnapshot,
    setSnapshot,
    onError: (caught) => {
      if (hasActiveAgentActivity) setAgentRefreshError(caught === null ? null :
        message(caught, "Agent status could not be refreshed. Retrying automatically."));
      else if (caught !== null) setError(message(caught, "Could not refresh durable job status."));
    },
  });
  useEffect(() => { setAgentRefreshError(null); }, [exportDraftStudy]);
  useEffect(() => {
    const state = agentInteraction.current;
    const touched = () => { state.lastInput = Date.now(); state.generation++; };
    const down = (event: PointerEvent) => { state.pointers.add(event.pointerId); touched(); };
    const up = (event: PointerEvent) => { state.pointers.delete(event.pointerId); touched(); };
    const blur = () => { state.pointers.clear(); touched(); };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    window.addEventListener("keydown", touched, true);
    window.addEventListener("wheel", touched, { passive: true, capture: true });
    window.addEventListener("input", touched, true);
    window.addEventListener("blur", blur);
    return () => {
      state.pointers.clear();
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      window.removeEventListener("keydown", touched, true);
      window.removeEventListener("wheel", touched, true);
      window.removeEventListener("input", touched, true);
      window.removeEventListener("blur", blur);
    };
  }, []);
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
  const loadResult = async (id: string, knownResult?: ResearchResult, isCurrent: () => boolean = () => true, manageBusy = true, nextSection: "review" | "export" = "review") => {
    if (!isCurrent() || documentSwitch.current) return;
    const exactResult =
      knownResult ?? snapshot?.results.find((item) => item.id === id);
    if (!exactResult) {
      setError(
        "The selected result is absent from the current immutable history.",
      );
      return;
    }
    largeSelectionIntent.current++;
    objectPickToken.current++;
    setPopulationObject(null);
    const loadToken = ++resultLoadToken.current;
    // The correction effect owns its exact plane request. A second request here
    // could supersede it while source tiles are being decoded.
    const correctionOwnsPlane = tab === "Correction" || isLargeResult(exactResult);
    if (isLargeResult(exactResult)) { setResultView(null); setRawVolumeOpen(false); setLargeObject(null); setLargeFocus(null); }
    const planeToken = correctionOwnsPlane ? resultViewToken.current : ++resultViewToken.current;
    const requestedPlane = tab === "Correction" ? correctionView.plane : "XY";
    const requestedAxis = planeAxis(requestedPlane);
    const requestedIndex =
      tab === "Correction" ? correctionView.index : undefined;
    setResultId(id);
    setResultSection(nextSection);
    // The previous revision's preview rows must never appear under this identity.
    setRows([]);
    setSelectedRow(null);
    if (manageBusy) setBusy("result");
    const output = await report(async () => {
      const [record, rendered] = await Promise.all([
        api.execute("result", { result_id: id, offset: 0, limit: 200 }),
        correctionOwnsPlane ? Promise.resolve(null) : api.execute("result_view", {
          result_id: id,
          axis: requestedAxis,
          ...(requestedIndex === undefined ? {} : { index: requestedIndex }),
          labels: true,
        }).catch((caught) => {
          // A newer plane owner may supersede this queued history view while
          // its immutable measurements are still being loaded.
          if (planeToken !== resultViewToken.current) return null;
          throw caught;
        }),
      ]);
      const page = record as { result?: ResearchResult; measurements?: Array<Record<string, unknown>> };
      if (page.result?.id !== exactResult.id || page.result?.revision_hash !== exactResult.revision_hash ||
          page.result?.source_id !== exactResult.source_id || page.result?.source_sha256 !== exactResult.source_sha256)
        throw new Error("Object measurements do not match the selected result revision.");
      return {
        record: page,
        rendered: rendered === null ? null : exactResultView(
          rendered,
          exactResult,
          requestedAxis,
          requestedIndex,
        ),
      };
    }, "Could not read the exact selected result.", () => isCurrent() && !documentSwitch.current && loadToken === resultLoadToken.current);
    if (output && isCurrent() && !documentSwitch.current && loadToken === resultLoadToken.current) {
      setRows(output.record.measurements ?? []);
      if (output.rendered && planeToken === resultViewToken.current)
        setResultView(output.rendered);
    }
    if (manageBusy && loadToken === resultLoadToken.current)
      setBusy((current) => (current === "result" ? null : current));
  };
  const navigateExactResult = async (target: ResearchResult, studyScope?: string, nextSection: "review" | "export" = "review", isCurrent?: () => boolean) => {
    if (isCurrent && !isCurrent()) return;
    largeNavigationIntent.current++;
    largeSelectionIntent.current++;
    // Every explicit navigation replaces any earlier Samples-only guard.
    pendingStudyNavigation.current = null;
    pendingResultSection.current = nextSection;
    if (target.source_id !== sourceId) {
      if (studyScope) pendingStudyNavigation.current = { target, scope: studyScope, intent: largeNavigationIntent.current, isCurrent };
      setPendingResultNavigation(target);
      setProjection("plane");
      setSourceId(target.source_id);
      return;
    }
    setPendingResultNavigation(null);
    await loadResult(target.id, target, isCurrent, isCurrent === undefined, nextSection);
  };
  const agentTargetNavigationReady = !busy && !documentSwitching && !sourceIsChanging && viewSettingsReady &&
    !pendingResultNavigation && !pendingAgentSource && !pendingModel && !correctionPreview && !drawingAnalysisRegion &&
    correctionPoints.length === 0 && annotationDraft.length === 0;
  const agentFollowContext = useRef({ followAgent, canNavigate: false, navigateExactResult });
  agentFollowContext.current = {
    followAgent, navigateExactResult,
    canNavigate: agentTargetNavigationReady && !sharedPreview &&
      (tab === "Display" || tab === "Agent" || (tab === "Info" && resultSection === "review")),
  };
  const openAgentSource = (target: ResearchAgentTargetReference, automatic = false) => {
    if (!snapshot || !agentTargetNavigationReady || documentSwitch.current) {
      if (!automatic) setError("Finish the current edit or operation before opening an agent target.");
      return;
    }
    try {
      const exact = agentSourceTarget(snapshot, target);
      // Validate the recorded grid before changing the selected source.
      agentSourceView(snapshot, target, sourceViewportSize ?? { width: 1, height: 1 });
      const generation = agentInteraction.current.generation, scope = exportDraftStudy;
      const isCurrent = () => agentInteraction.current.generation === generation &&
        currentStudyScope.current === scope && !documentSwitch.current &&
        (!automatic || agentFollowContext.current.followAgent);
      resultLoadToken.current++; resultViewToken.current++; largeNavigationIntent.current++;
      pendingStudyNavigation.current = null; setPendingResultNavigation(null);
      setSharedPreview(null);
      setPendingAgentSource({ target, isCurrent });
      setResultId(null); setResultView(null); setRows([]); setSelectedRow(null);
      setRawVolumeOpen(false); setAbCompareMode(false); setSourceId(exact.id); setTab("Display");
    } catch (caught) { if (!automatic) setError(message(caught, "The recorded agent target is unavailable.")); }
  };
  const closeSharedPreview = () => {
    previewReadToken.current++;
    setSharedPreview(null);
    if (previewReturnFocus.current?.isConnected) previewReturnFocus.current.focus();
  };
  useEffect(() => {
    if (sharedPreview && (sharedPreview.study !== exportDraftStudy ||
      sharedPreview.preview.source_id !== source?.id || sharedPreview.preview.source_sha256 !== source?.sha256)) {
      previewReadToken.current++;
      setSharedPreview(null);
    }
  }, [source?.id, source?.sha256, exportDraftStudy, sharedPreview]);
  const inspectAgentPreview = async (target: ResearchAgentTargetReference) => {
    if (!snapshot || !agentTargetNavigationReady || documentSwitch.current) {
      setError("Finish the current edit or operation before inspecting a preview."); return;
    }
    const job = snapshot.jobs.find((item) => item.id === target.id && item.state === "succeeded");
    if (!job || !["workflow_preview", "exploration_preview", "exploration_compare"].includes(job.operation)) {
      setError("The recorded preview task is unavailable."); return;
    }
    const token = ++previewReadToken.current;
    const generation = agentInteraction.current.generation, study = exportDraftStudy;
    const isCurrent = () => token === previewReadToken.current && currentStudyScope.current === study &&
      generation === agentInteraction.current.generation && !documentSwitch.current;
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const output = await report(() => api.execute("task_preview_get", { job_id: job.id }) as Promise<{ preview: SharedTaskPreview }>,
      "The recorded preview is unavailable. It has not been rerun.", isCurrent);
    if (!output || !isCurrent()) return;
    const preview = output.preview;
    try {
      if (preview.job_id !== job.id || preview.operation !== job.operation) throw new Error("The preview does not match its task.");
      const exact = agentSourceTarget(snapshot, { kind: "source", id: preview.source_id, sha256: preview.source_sha256 });
      previewReturnFocus.current = returnFocus;
      resultLoadToken.current++; resultViewToken.current++; largeNavigationIntent.current++;
      pendingStudyNavigation.current = null; setPendingResultNavigation(null); setPendingAgentSource(null);
      setResultId(null); setResultView(null); setRows([]); setSelectedRow(null);
      setSourceId(exact.id); setTab("Display"); setFocusedPanel(null); setRawVolumeOpen(false);
      setSharedPreview({ preview, study });
    } catch (caught) { if (isCurrent()) setError(message(caught, "The exact preview source is unavailable.")); }
  };
  const openAgentSourceRef = useRef(openAgentSource); openAgentSourceRef.current = openAgentSource;
  useEffect(() => {
    const target = agentResultTracker.current.observe(snapshot, exportDraftStudy);
    const sourceTarget = agentSourceTracker.current.observe(snapshot, exportDraftStudy);
    const context = agentFollowContext.current;
    const interaction = agentInteraction.current;
    const editing = document.activeElement?.matches("input, textarea, select, [contenteditable=true]");
    if ((!target && !sourceTarget) || !context.followAgent || !context.canNavigate || documentSwitch.current || editing ||
      interaction.pointers.size > 0 || Date.now() - interaction.lastInput < 1500) return;
    if (!target && sourceTarget) { openAgentSourceRef.current(sourceTarget, true); return; }
    // Observed results are never queued to interrupt a later human action or draft.
    const generation = interaction.generation;
    const scope = exportDraftStudy;
    const isCurrent = () => agentFollowContext.current.followAgent &&
      agentInteraction.current.generation === generation && currentStudyScope.current === scope &&
      !documentSwitch.current;
    void context.navigateExactResult(target!, scope, "review", isCurrent);
  }, [snapshot, exportDraftStudy]);
  useEffect(() => {
    if (!pendingAgentSource) return;
    if (!pendingAgentSource.isCurrent()) { setPendingAgentSource(null); return; }
    if (!snapshot || sourceId !== pendingAgentSource.target.id || sourceIsChanging || !viewSettingsReady) return;
    if (sourceViewportSize?.scope !== numberScope || sourceViewportSize.width <= 0 || sourceViewportSize.height <= 0) return;
    try {
      const view = agentSourceView(snapshot, pendingAgentSource.target, sourceViewportSize);
      if (view && pendingAgentSource.isCurrent()) {
        setProjection("plane");
        setSelection((current) => ({ ...current, ...view.selection }));
        // Scalar source navigation makes the recorded channel visible without
        // replacing local colors/contrast. RGB samples retain their component mix.
        if (!isRgb) setChannels((current) => current.map((channel) => ({ ...channel, visible: channel.channel === view.selection.c })));
        setControlledViewCamera(view.camera); setViewCamera(view.camera);
      }
    } catch (caught) { if (pendingAgentSource.isCurrent()) setError(message(caught, "The recorded agent view is unavailable.")); }
    setPendingAgentSource(null);
  }, [pendingAgentSource, snapshot, sourceId, sourceIsChanging, viewSettingsReady, sourceViewportSize, numberScope, isRgb]);
  useEffect(() => {
    const guard = pendingStudyNavigation.current;
    if (guard) {
      if (guard.target !== pendingResultNavigation) pendingStudyNavigation.current = null;
      else if (guard.scope !== exportDraftStudy || guard.intent !== largeNavigationIntent.current ||
        (guard.isCurrent && !guard.isCurrent())) {
        pendingStudyNavigation.current = null; setPendingResultNavigation(null); return;
      } else {
        try { resolveStudyResult(snapshot, guard.target); }
        catch (caught) {
          pendingStudyNavigation.current = null; setPendingResultNavigation(null);
          setError(message(caught, "The exact selected study revision changed.")); return;
        }
      }
    }
    if (
      !pendingResultNavigation ||
      sourceId !== pendingResultNavigation.source_id ||
      sourceIsChanging ||
      (guard?.target === pendingResultNavigation && !viewSettingsReady)
    )
      return;
    const target = pendingResultNavigation;
    pendingStudyNavigation.current = null;
    setPendingResultNavigation(null);
    void loadResult(target.id, target, guard?.isCurrent, guard?.isCurrent === undefined, pendingResultSection.current);
  }, [
    pendingResultNavigation?.id,
    pendingResultNavigation?.revision_hash,
    sourceId,
    sourceIsChanging,
    viewSettingsReady,
    snapshot?.sources,
    snapshot?.results,
    exportDraftStudy,
    tab,
  ]);
  const publishGeneratedResult = async (target: ResearchResult) => {
    const next = await report(
      () => api.getSnapshot(),
      "Could not refresh immutable result history.",
    );
    if (next) adopt(next);
    await navigateExactResult(target);
  };
  const refreshLargeHistory = async () => {
    if (documentSwitch.current) return;
    const intent = largeNavigationIntent.current;
    const next = await api.getSnapshot();
    if (intent === largeNavigationIntent.current && !documentSwitch.current) adopt(next);
  };
  const persistRevision = async (
    target: ResearchResult,
    measurements?: Array<Record<string, unknown>>,
    largeIntent?: number,
    isCurrent: () => boolean = () => true,
    preserveBusy = false,
  ): Promise<boolean> => {
    if (!snapshot || !sourceId || !isCurrent()) return false;
    if (largeIntent !== undefined && largeIntent !== largeNavigationIntent.current) {
      await refreshLargeHistory();
      return false;
    }
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
    if (!isCurrent() || documentSwitch.current) return false;
    if (largeIntent !== undefined && largeIntent !== largeNavigationIntent.current) {
      await refreshLargeHistory();
      return false;
    }
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
    await loadResult(target.id, target, isCurrent, !preserveBusy);
    if (!isCurrent() || documentSwitch.current) return false;
    if (measurements) setRows(measurements);
    const next = await report(
      () => api.getSnapshot(),
      "Could not refresh immutable result history.",
    );
    if (next && isCurrent() && !documentSwitch.current && (largeIntent === undefined || largeIntent === largeNavigationIntent.current)) adopt(next);
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
    if (!source || !configurationValid || busy || documentSwitching || documentSwitch.current || sourceIsChanging || !viewSettingsReady || source.locator_state === "relink-required") return;
    setError(null);
    setBusy("run");
    if (compute.target) {
      await report(() => compute.target!.start([{ operation: "run_recipe", source: { id: source.id, sha256: source.sha256 },
        request: { source_id: source.id, selection: shownSelection, recipe } }]), "Could not start the remote analysis. Check Job Center for saved progress.");
      setBusy(null); setJobsOpen(true);
      return;
    }
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
    if (!source || !configurationValid) return;
    setError(null);
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
        api.execute("recipe_preflight", {
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
    if (tab !== "Correction" || !selectedResult || isLargeResult(selectedResult)) {
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
    return () => {
      if (token === resultViewToken.current) resultViewToken.current++;
    };
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
    populationObject?.centroid_index ?? (selectedRow === null ? null : rows[selectedRow]?.centroid_index),
    displayedResultView,
  );
  const exactGroupHighlight = populationHighlight && selectedResult && populationHighlight.result_id === selectedResult.id &&
    populationHighlight.revision_hash === selectedResult.revision_hash && populationHighlight.source_id === selectedResult.source_id &&
    populationHighlight.source_sha256 === selectedResult.source_sha256 ? populationHighlight : null;
  const groupCentroids = useMemo(() => exactGroupHighlight?.centroids.flatMap((row) => {
    const point = centroidOnView(row.centroid_index, displayedResultView); return point ? [point] : [];
  }) ?? [], [exactGroupHighlight, displayedResultView]);
  const sourceResultOverlay = useMemo(() => {
    if (!source || !selectedResult || !displayedResultView) return null;
    const resolved = resolveResultPlaneOverlay(source, selectedResult, { ...displayedResultView, image: displayedResultView.labelImage ?? displayedResultView.image }, 1);
    return resolved.ok ? resolved.overlay : null;
  }, [source, selectedResult, displayedResultView]);
  const sourceResultSelection = useMemo(() => {
    const persisted = selectedResult?.selection;
    if (!persisted) return null;
    // Channel-mapped results retain their grid; c belongs to the source display.
    return persisted.c === undefined ? { ...persisted, c: shownSelection.c } : persisted;
  }, [selectedResult?.selection, shownSelection.c]);
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
      setPopulationObject(row);
    },
    [rows, resultId, snapshot?.results, report, api, sourceResultOverlay, displayedResultView, viewCamera, selectedResult],
  );

  const locatePopulationObject = async (row: Record<string, unknown>) => {
    if (!selectedResult || !Number.isSafeInteger(row.label) || Number(row.label) < 1) return;
    const exact = selectedResult;
    const token = ++objectPickToken.current;
    const navigation = largeNavigationIntent.current;
    const current = () => token === objectPickToken.current && navigation === largeNavigationIntent.current;
    try {
      const located = await api.execute("population_locate", {
        result_id: exact.id, revision_hash: exact.revision_hash, label: row.label,
      }) as { result_id: string; revision_hash: string; label: number; point_index: number[] };
      if (!current()) return;
      const shape = exact.arrays?.labels?.shape ?? exact.arrays?.image?.shape;
      const point = located.point_index;
      if (located.result_id !== exact.id || located.revision_hash !== exact.revision_hash || located.label !== row.label ||
          !shape || !Array.isArray(point) || point.length !== shape.length ||
          point.some((value, index) => !Number.isSafeInteger(value) || value < 0 || value >= shape[index]))
        throw new Error("Object location does not match this result revision.");
      if (isLargeResult(exact)) { setLargeObject(row); setLargeFocus({ point_index: [point[0], point[1]] }); return; }
      const index = point.length === 3 ? point[0] : 0;
      const planeToken = ++resultViewToken.current;
      const view = exactResultView(await api.execute("result_view", {
        result_id: exact.id, axis: "z", index, labels: true,
      }), exact, "z", index);
      if (!current() || planeToken !== resultViewToken.current) return;
      setResultView(view);
      setPopulationObject(row);
      const loadedIndex = rows.findIndex((item) => item.label === row.label);
      setSelectedRow(loadedIndex < 0 ? null : loadedIndex);
      if (source && point.length === 2) {
        const resolved = resolveResultPlaneOverlay(source, exact, view, 1);
        if (resolved.ok) {
          const target = resultPixelToSourcePoint(resolved.overlay, { u: point[1], v: point[0] });
          if (target) setControlledViewCamera({ x: target.x, y: target.y, scale: Math.max(viewCamera?.scale ?? 1, 1.5) });
        }
      }
    } catch (caught) { if (current()) setError(message(caught, "Could not locate this object.")); }
  };

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
        if (!response || response.result_id !== resultId || response.revision_hash !== displayedResultView.revisionHash) return;
        if (response.label === 0) {
          setPopulationObject(null);
          setSelectedRow(null);
          return;
        }

        const label = response.label;
        const targetIndex = rows.findIndex((r) => r.label === label);
        if (targetIndex >= 0) {
          void selectObject(targetIndex, { changeSlice: false, preserveZoom: true });
        } else {
          const population = await api.execute("population_query", { result_id: resultId, revision_hash: displayedResultView.revisionHash, selected_label: label, limit: 1 }) as { result_id: string; revision_hash: string; source_id: string; source_sha256: string; selected: { row: Record<string, unknown> } | null };
          if (token !== objectPickToken.current || population.result_id !== resultId || population.revision_hash !== displayedResultView.revisionHash || population.source_id !== selectedResult?.source_id || population.source_sha256 !== selectedResult?.source_sha256) return;
          setPopulationObject(population.selected?.row ?? null);
          setSelectedRow(null);
        }
      } catch {
        // Ignore pick errors or revision race
      }
    },
    [drawingAnalysisRegion, displayedResultView, resultId, sourceResultOverlay, rows, api, selectObject, selectedResult],
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
    largeNavigationIntent.current++;
    largeSelectionIntent.current++;
    setTab(next);
    if (next === "Workflow") {
      setWorkflowOpened(true);
      setRawVolumeOpen(false); setSurfaceOpen(false); setAbCompareMode(false);
    }
    if (next === "Quantify") setQuantificationOpened(true);
    if (next === "Density") setDensityOpened(true);
    if (next !== "Population") setStatisticsFocused(false);
    if (next === "Study") setStudyOpened(true);
    else setStudyFocused(false);
    if (next === "Population") { setPopulationOpened(true); setRawVolumeOpen(false); setSurfaceOpen(false); setAbCompareMode(false); }
    if (next === "Annotate" || next === "Epidermis") {
      setRawVolumeOpen(false); setSurfaceOpen(false); setAbCompareMode(false);
      setProjection("plane");
      setSelection((previous) => { const { z_stop: _stop, ...plane } = previous; return plane; });
      if (next === "Epidermis") {
        setResultId(null); setResultView(null); setImage(null); setVolume(null);
      }
    }
  };
  const studyNavigation = useRef({ snapshot, busy: busy !== null || documentSwitching, scope: exportDraftStudy, navigateExactResult, openWorkbenchTab });
  studyNavigation.current = { snapshot, busy: busy !== null || documentSwitching, scope: exportDraftStudy, navigateExactResult, openWorkbenchTab };
  const studyNavigationContext = () => {
    const current = studyNavigation.current;
    if (documentSwitch.current || current.busy) throw new Error("Wait for the current operation before opening another study record.");
    if (current.scope !== exportDraftStudy) throw new Error("The open study changed. Return to Samples and choose the record again.");
    return current;
  };
  const inspectStudyResult = async (target: ResearchResult) => {
    const current = studyNavigationContext();
    const exact = resolveStudyResult(current.snapshot, target);
    const navigation = current.navigateExactResult(exact, current.scope);
    const intent = largeNavigationIntent.current;
    await navigation;
    const latest = studyNavigation.current;
    if (documentSwitch.current || latest.scope !== current.scope) throw new Error("The open study changed. Choose the result again in Samples.");
    resolveStudyResult(latest.snapshot, exact);
    if (intent !== largeNavigationIntent.current) throw new Error("The selected image or task changed. Choose the result again in Samples.");
    if (pendingStudyNavigation.current?.target === exact) pendingStudyNavigation.current.intent = largeNavigationIntent.current + 1;
    latest.openWorkbenchTab("Info");
  };
  const editStudyMetadata = (target: ResearchSource) => {
    const current = studyNavigationContext();
    const exact = resolveStudySource(current.snapshot, target);
    largeNavigationIntent.current++; largeSelectionIntent.current++; objectPickToken.current++;
    resultLoadToken.current++; resultViewToken.current++;
    pendingStudyNavigation.current = null;
    setPendingResultNavigation(null); setResultId(null); setResultView(null); setRows([]); setSelectedRow(null);
    setPopulationObject(null); setLargeObject(null); setCorrectionObjectTarget(null); setImage(null); setVolume(null);
    setRawVolumeOpen(false); setSurfaceOpen(false); setAbCompareMode(false); setProjection("plane");
    setSelectedSourceIds([exact.id]); setSelectionAnchorId(exact.id); setSelectionPivotIds([exact.id]);
    setSourceId(exact.id);
    current.openWorkbenchTab("Info");
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
          onExample={api.tryExample ? () => { resetEmptyDrop(); void report(() => api.tryExample!().then(adopt), "Could not create the offline example."); } : undefined}
          onStudy={() => { resetEmptyDrop(); void report(() => api.openStudy().then(adopt), "Could not open this study."); }}
          onEmptyStudy={() => { resetEmptyDrop(); void report(() => api.createStudy().then(adopt), "Could not create this study."); }}
          onLegacy={() => void openLegacy()} state={session} onRecovery={adopt} onError={setError}
          dragActive={emptyDropActive} busy={busy !== null || documentSwitching} />
        {(busy || documentSwitching) && <div className="welcome-progress" role="status">{documentSwitching ? "Updating workspace…" : "Opening images…"}</div>}
        {error && <ResearchError error={error} onDismiss={() => setError(null)} />}
        <ContextHelp enabled={preferences.viewer.contextualHelp && !error} />
      </main>
    );
  const changeSegmentationChannel = (channel: number) => {
    if (!source || !dimensions || busy || documentSwitching || documentSwitch.current || sourceIsChanging || !viewSettingsReady || source.locator_state === "relink-required" ||
        !Number.isInteger(channel) || channel < 0 || channel >= dimensions.c) return;
    setSelection((old) => ({ ...old, c: channel }));
  };
  const declaredChannels = snapshot.channels?.find((record) => record.id === source?.id && record.data.source_sha256 === source?.sha256)?.data.channels;
  const segmentationChannelNames = Array.from({ length: dimensions?.c ?? 0 }, (_, index) =>
    declaredChannels?.find((channel) => channel.index === index)?.name.trim() || source?.metadata.channel_names?.[index]?.trim() || `Channel ${index + 1}`);
  const is3D = Boolean(rawVolumeOpen || (dimensions && dimensions.z > 1));
  const canFocusPanel = Boolean(source && (["Analyze", "Workflow", "Model", "Agent", "Density"].includes(tab) || (tab === "Info" && !isLargeResult(selectedResult))));
  const panelFocused = canFocusPanel && focusedPanel === tab;
  return (
    <main className={`research-workbench image-first-workbench ${is3D ? "is-3d-active" : ""} ${panelFocused ? "is-panel-focused" : ""} ${tab === "Workflow" ? "is-workflow-workspace" : ""} ${tab === "Population" ? `is-statistics-workspace${statisticsFocused ? " is-statistics-focused" : ""}` : ""} ${tab === "Study" ? `is-study-workspace${studyFocused ? " is-study-focused" : ""}` : ""}`} aria-label="Research workspace"
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
        <button title="Open images without changing the active study's existing sources" onClick={() => void openImages()}><ImagePlus /> Add images…</button>
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
      <ContextHelp enabled={preferences.viewer.contextualHelp && !error} />
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
          <SourceTree key={`source-browser:${studyEpoch}`} sources={snapshot.sources} activeSourceId={sourceId}
            selectedSourceIds={selectedSourceIds} onActivate={handleSourceClick}
            onToggleSelection={toggleSourceSelection}
            onReorder={persistSourceOrder} reorderDisabled={busy !== null || documentSwitching}
            dimensions={(item) => meta(item).dimensions} />
          <div className="research-layers-heading"><h2>Layers & results</h2>
          {source && window.lociImageWindows && <div className="research-window-actions"><button aria-label="Restore image windows" title="Restore image windows" disabled={Boolean(busy) || documentSwitching}
            onClick={() => void report(async () => {
              await viewStore.current?.flush();
              await window.lociImageWindows!.restore();
            }, "Could not restore the image-window layout.")}><PanelsTopLeft /></button>
          <button aria-label="Detach image"
            disabled={Boolean(busy) || documentSwitching || !viewSettingsReady || source.locator_state === "relink-required" || annotationDraft.length > 0 || correctionPoints.length > 0}
            title={annotationDraft.length || correctionPoints.length ? "Finish or discard the current draft before detaching" : "Open this image in its own window; this window becomes the control panel"}
            onClick={() => void report(async () => {
              // Capture current React state before awaiting the serial persistence queue.
              const presentation: ImageWindowPresentation = {
                interpretation, mode: rawVolumeOpen ? "volume" : "plane", volumeDisplay,
                channels, selection: shownSelection, projection: resolvedProjection,
                camera: viewCamera, tool: "navigate", draft: [], annotations: [],
                showScaleBar: preferences.viewer.showScaleBar,
                showNavigator: preferences.viewer.showNavigator,
              };
              if (!await viewStore.current?.flush()) throw new Error("Save the display settings before detaching this image.");
              await window.lociImageWindows!.open(source.id, { sourceSha256: source.sha256, presentation });
            }, "Could not open the image window.")}><PictureInPicture2 /></button></div>}
          </div>
          {source && <button className={!resultId ? "selected" : ""} aria-pressed={!resultId}
            onClick={() => { largeNavigationIntent.current++; largeSelectionIntent.current++; objectPickToken.current++; setPopulationObject(null); setSelectedRow(null); setResultId(null); setResultView(null); setImage(null); }}>Original image</button>}
          {sourceResults.map((item) => {
              const discriminator = resultDiscriminators.get(item.id);
              const isSavedSelection = snapshot.selections.some(
                (sel) => sel.id === sourceId && sel.data?.result_id === item.id && sel.data?.revision_hash === item.revision_hash,
              );
              const parentResult = item.parent_id && !item.label_import
                ? snapshot.results.find((candidate) => candidate.id === item.parent_id)
                : null;
              return (
              <button
                key={item.id}
                disabled={sourceIsChanging}
                data-result-id={item.id}
                data-review-state={resultReviewState(item)}
                title={`${resultTitle(item)} · ${new Date(item.created_at).toLocaleString()}`}
                aria-label={`${resultTitle(item)}, ${discriminator ? `${discriminator}, ` : ""}${item.object_count} ${item.object_count === 1 ? "object" : "objects"}, ${resultReviewState(item)} review`}
                className={item.id === resultId ? "selected" : ""}
                aria-pressed={item.id === resultId}
                onClick={() => {
                  largeNavigationIntent.current++;
                  largeSelectionIntent.current++;
                  setRedoStack([]);
                  void loadResult(item.id, item);
                }}
              >
                <span className="research-result-kind">{resultTitle(item)}</span>
                {discriminator && <small className="research-result-meta">{discriminator}</small>}
                <small className="research-result-meta">{item.object_count.toLocaleString()} {item.object_count === 1 ? "object" : "objects"} · {reviewLabel(item.review)}{isSavedSelection ? " · Saved selection" : ""}</small>
                {parentResult && <small className="research-result-meta">Edited from {resultTitle(parentResult)}{resultDiscriminators.has(parentResult.id) ? ` · ${resultDiscriminators.get(parentResult.id)}` : ""} ({parentResult.object_count.toLocaleString()} {parentResult.object_count === 1 ? "object" : "objects"})</small>}
                {item.label_import && <small className="research-result-meta">{item.parent_id ? "Corrected from " : "Imported "}{item.label_import.file_name} · {item.label_import.producer?.name ?? "Unknown producer"}</small>}
              </button>
              );
            })}
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
      <section id="research-image-stage" className="research-canvas" hidden={panelFocused || (tab === "Population" && statisticsFocused) || (tab === "Study" && studyFocused)}>
        <AgentPreviewComparison key={exportDraftStudy}
          preview={sharedPreview?.study === exportDraftStudy && sharedPreview.preview.source_id === source?.id &&
            sharedPreview.preview.source_sha256 === source?.sha256 ? sharedPreview.preview : null}
          sourceLabel={source ? sourceLabelForId(snapshot.sources, source.id) : "Source"} onClose={closeSharedPreview} />
        <div className="research-view-toolbar">
        {tab !== "Display" && source && channels.length > 0 && viewSettingsReady && !sourceIsChanging && !abCompareMode && (!selectedResult || sourceResultOverlay || rawVolumeOpen) && <CompactChannelControls
          source={source} channels={channels} onChannels={setChannels}
          onSourceChannel={(c) => selectSourcePlane({ ...shownSelection, c })}
          disabled={documentSwitching || assistantFollowing || assistantFollowBusy}
          onOpenDisplay={() => openWorkbenchTab("Display")} />}
        {(source?.browser_location || resultId || (dimensions && dimensions.z > 1) || snapshot.sources.length >= 2) && <div className="research-canvas-toolbar">
          {source?.browser_location && <span className="source-browser-breadcrumb" aria-label="Current image path"
            title={sourceDisplayPath(source, snapshot.sources)}>{sourceDisplayPath(source, snapshot.sources)}</span>}
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
              {selectedResult && <span className="result-source-count">{selectedResult.object_count.toLocaleString()} {selectedResult.object_count === 1 ? "object" : "objects"}</span>}
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
                largeNavigationIntent.current++;
                largeSelectionIntent.current++;
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
        </div>
        {selectedResult && isLargeResult(selectedResult) ? (
          <LargeResultViewport key={selectedResult.revision_hash} api={api} result={selectedResult} focus={largeFocus} groupCentroids={exactGroupHighlight?.centroids.map((row) => ({ u: row.centroid_index[1], v: row.centroid_index[0] }))}
            onPickStart={() => ++largeSelectionIntent.current}
            onPick={(row, intent) => { if (intent === largeSelectionIntent.current) { setLargeObject(row); if (tab !== "Population") setTab("Info"); } }} />
        ) : source && rawVolumeOpen ? (
          <RawVolumeViewport volume={rawVolume} loading={rawVolumeLoading} error={rawVolumeError}
            onRequestRefinement={requestRawVolume} onExportFigure={api.exportVolumeFigure}
            externalDisplay={{ ...volumeDisplay, channels }}
            onDisplayChange={(display) => {
              setVolumeDisplay({ renderMode: display.renderMode, quality: display.quality });
              setChannels((current) => current.map((channel) =>
                display.channels.find((next) => next.channel === channel.channel) ?? channel));
            }} />
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
              <GroupCentroidOverlay points={groupCentroids} width={displayedPlaneDimensions.width} height={displayedPlaneDimensions.height} />
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
            key={`${documentEpoch}:${source.id}:${source.sha256}:${annotationTool}`}
            api={api}
            source={source}
            relinkBusy={busy !== null}
            onRelinkSource={api.relinkSource ? () => {
              void report(async () => {
                setBusy("Relinking source");
                try {
                  const next = await api.relinkSource!(source.id, sourceRelinkKind(source));
                  if (next) adopt(next, source.id);
                } finally { setBusy(null); }
              }, "The selected source did not match the archived fingerprint and size.");
            } : undefined}
            selection={sourceResultOverlay && sourceResultSelection ? sourceResultSelection : shownSelection}
            channels={compareDefault ? defaultChannels : channels}
            projection={sourceResultOverlay ? "plane" : resolvedProjection}
            initialCamera={viewCamera ?? savedCamera}
            controlledCamera={controlledViewCamera}
            onViewportSize={reportSourceViewportSize}
            onCamera={(camera) => {
              setViewCamera(camera);
              if (controlledViewCamera) {
                setControlledViewCamera(null);
              }
            }}
            onObjectClick={drawingAnalysisRegion ? undefined : handleObjectClick}
            onViewReady={annotationViewReady}
            overrideImage={sourceResultOverlay || pendingSourceResultCanvas ? null : image}
            resultOverlay={sourceResultOverlay}
            resultDrawing={sourceResultOverlay && !busy ? resultDrawing : null}
            resultCentroid={sourceResultOverlay ? displayedCentroid : null}
            resultGroupCentroids={sourceResultOverlay ? groupCentroids : []}
            onResultPoint={sourceResultOverlay && tab === "Correction" && correctionViewReady && !busy && correctionPreview?.kind !== "vertices"
              ? (point) => setCorrectionPoints((old) => [...old, point]) : undefined}
            showRegion={!sourceResultOverlay && ["Process", "Analyze", "Quantify", "Model"].includes(tab)}
            onRegion={drawingAnalysisRegion ? (region) => {
              setSelection((old) => ({ ...old, ...region, level: 0 })); setDrawingAnalysisRegion(false);
            } : undefined}
            annotations={sourceAnnotations}
            draft={tab === "Annotate" || tab === "Epidermis" ? annotationDraft : []}
            drawingMode={tab === "Annotate" || tab === "Epidermis" ? annotationTool : "navigate"}
            onDraftChange={updateViewportDraft}
            onPoint={(tab === "Annotate" || tab === "Epidermis") && annotationTool !== "navigate" ? (point) => setAnnotationDraft((old) => {
              const maximum = annotationTool === "point" ? 1 : ["polygon", "freehand"].includes(annotationTool) ? 2048 : 2;
              return old.length >= maximum ? [point] : [...old, point];
            }) : undefined}
            overlayRight={0}
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
      {!panelFocused && tab !== "Workflow" && tab !== "Population" && tab !== "Study" && <InspectorResizeHandle width={inspectorWidth} onChange={setInspectorWidth} />}
      <aside className="research-inspector">
        <div ref={toolHeaderRef} className={`research-tool-header${canFocusPanel ? " has-layout-tools" : ""}`}>
          <WorkbenchTools tab={tab} onTab={openWorkbenchTab} source={source} hasResult={Boolean(selectedResult)} hasStudyResults={snapshot.results.length > 0} />
          {canFocusPanel && <div className="research-panel-layout-tools" role="group" aria-label="Panel layout">
            <span title={source?.name}>{source?.name}</span>
            <button type="button" aria-pressed={panelFocused} aria-controls="research-image-stage"
              onClick={() => setFocusedPanel((current) => current === tab ? null : tab)}>
              {panelFocused ? "Show image" : tab === "Workflow" ? "Focus workflow" : tab === "Model" || tab === "Agent" ? "Focus setup" : "Focus panel"}
            </button>
          </div>}
        </div>
        {workflowOpened && source && dimensions && <div className="workflow-workspace-host" hidden={tab !== "Workflow"}>
          <ResearchWorkflowPanel key={documentEpoch}
            api={api} source={source} sources={snapshot.sources}
            selectedSourceIds={selectedSourceIds}
            onSelectedSourceIdsChange={setSelectedSourceIds}
            selection={shownSelection} recipe={recipe} configurationValid={configurationValid} jobs={snapshot.jobs}
            displayedResult={selectedResult && resultView?.resultId === selectedResult.id &&
              resultView.revisionHash === selectedResult.revision_hash ? selectedResult : null} active={tab === "Workflow"}
            busy={busy !== null}
            onBusyChange={(value) => setBusy((current) => value ? (current ?? "workflow") : current === "workflow" ? null : current)}
            onPreview={(previewImage) => {
              if (tab !== "Workflow") return;
              resultLoadToken.current++; resultViewToken.current++; objectPickToken.current++;
              setResultId(null); setResultView(null); setPopulationObject(null);
              setSelectedRow(null); setImage(previewImage); setRawVolumeOpen(false);
            }}
            onResult={async (result) => {
              await api.getSnapshot().then(adopt);
              if (result.source_id === source.id && result.source_sha256 === source.sha256) {
                await loadResult(result.id, result);
              }
            }}
            onReview={async (result) => {
              if (result.source_id !== source.id || result.source_sha256 !== source.sha256) {
                throw new Error("Select this workflow result's source image before reviewing it.");
              }
              await loadResult(result.id, result);
            }}
            onExport={async (result, runId) => { await api.exportResult(result.id, result.revision_hash, runId); }}
            onRefresh={async () => { await api.getSnapshot().then(adopt); }}
          />
          <details className="composed-workflows" onToggle={(event) => setGraphOpened(event.currentTarget.open)}><summary>Composed workflows</summary>
            {graphOpened && <ResearchWorkflowGraphPanel key={`graph-${documentEpoch}`} api={api} snapshot={snapshot}
              sourceId={source.id} selection={shownSelection} active={tab === "Workflow"} busy={busy !== null}
              onBusyChange={(value) => setBusy((current) => value ? (current ?? "composed-workflow") : current === "composed-workflow" ? null : current)}
              onOpenResult={async (result) => { await navigateExactResult(result); }}
              onRefresh={async () => { await api.getSnapshot().then(adopt); }} />}
          </details>
        </div>}
        {source && snapshot.project.first_study?.example_id === "synthetic-shapes-v1" &&
          snapshot.project.first_study.source_id === source.id && snapshot.project.first_study.source_sha256 === source.sha256 && tab !== "Workflow" && <FirstStudyGuide onNavigate={openWorkbenchTab} hasResult={Boolean(selectedResult)} />}
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
        </div>}
        {source && dimensions && (tab === "Annotate" || tab === "Epidermis") &&
          (dimensions.z > 1 || dimensions.t > 1) && <div className="research-panel source-axes" aria-label="Annotation plane">
            {dimensions.z > 1 && <label><span>Z <output>{shownSelection.z + 1} / {dimensions.z}</output></span>
              <input aria-label="Z plane" type="range" min={0} max={dimensions.z - 1} value={shownSelection.z}
                onChange={(event) => { const z = Number(event.target.value); setProjection("plane");
                  setResultId(null); setResultView(null); setImage(null); setVolume(null); setRawVolumeOpen(false);
                  setSelection((old) => { const { z_stop: _stop, ...plane } = old; return { ...plane, z }; }); }} /></label>}
            {dimensions.t > 1 && <label><span>Time <output>{shownSelection.t + 1} / {dimensions.t}</output></span>
              <input aria-label="Time frame" type="range" min={0} max={dimensions.t - 1} value={shownSelection.t}
                onChange={(event) => { const t = Number(event.target.value); setProjection("plane");
                  setResultId(null); setResultView(null); setImage(null); setVolume(null); setRawVolumeOpen(false);
                  setSelection((old) => { const { z_stop: _stop, ...plane } = old; return { ...plane, t }; }); }} /></label>}
          </div>}
        {source && source.locator_state !== "relink-required" && <div hidden={tab !== "Annotate" && tab !== "Epidermis"}><SourceAnnotationPanel key={`${documentEpoch}:${source.id}:${source.sha256}`} api={api} source={source}
          measurementMode={tab === "Epidermis" ? "epidermis" : "general"}
          selection={shownSelection} tool={annotationTool} onTool={(tool) => {
            setAnnotationTool(tool);
            if (tool !== "navigate") {
              setResultId(null); setResultView(null); setImage(null); setVolume(null);
              setProjection("plane");
              setSelection((previous) => { const { z_stop: _stop, ...plane } = previous; return plane; });
            }
          }}
          draftControl={annotationState.control}
          points={annotationDraft} onPoints={setAnnotationDraft} onAnnotations={setSourceAnnotations} onError={setError} /></div>}
        {source && dimensions && tab === "Display" && rawVolumeOpen && <section className="volume-inspector" aria-label="Volume workspace information">
          <h2>Volume</h2>
          <dl><dt>Source grid</dt><dd>{dimensions.x} × {dimensions.y} × {dimensions.z}</dd>
            <dt>Coordinates</dt><dd>{rawVolume?.context.frame === "image" ? "Source image axes" : rawVolume?.context.frame ?? "Loading…"}</dd>
            <dt>Units</dt><dd>{rawVolume?.context.unit ?? "Loading…"}</dd></dl>
          {dimensions.t > 1 && <label>Time <output>{shownSelection.t + 1} / {dimensions.t}</output>
            <input aria-label="Volume time frame" type="range" min={0} max={dimensions.t - 1} value={shownSelection.t}
              onChange={(event) => setSelection((previous) => ({ ...previous, t: Number(event.target.value) }))} /></label>}
          <details><summary>Navigation</summary><p>Drag a slice crosshair to update all planes. Scroll or use ↑/↓ to step through that slice.</p>
            <p>In 3D, drag to rotate, right-drag or Shift-drag to pan, and scroll to zoom. R resets the camera.</p></details>
          <details><summary>Display details</summary><p className="volume-inspector-note">Slices use the displayed grid with linear resampling. PNG export captures the 3D pane and records its display settings.</p></details>
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
          <>{assistantFollowing && <div className="assistant-display-status" role="status"><span>Assistant display is active</span>
            <button disabled={assistantFollowBusy} onClick={() => void followAssistantDisplay(false)}>Take control</button></div>}
          <fieldset className="source-display-local" disabled={assistantFollowing || assistantFollowBusy || !viewSettingsReady || sourceIsChanging || documentSwitching}
            aria-busy={!viewSettingsReady || sourceIsChanging}><SourceDisplayPanel
            api={api}
            source={source}
            sources={snapshot.sources}
            selectedSourceIds={selectedSourceIds.length ? selectedSourceIds : [source.id]}
            viewReady={viewReadyKey === `${source.id}:${source.sha256}:${shownSelection.t}:${shownSelection.z}`}
            projection={resolvedProjection}
            onProjection={setProjection}
            selection={shownSelection}
            channels={channels}
            onSelection={selectSourcePlane}
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
                const output = await api.execute("viewer_defaults", { source_id: currentSource, t: shownSelection.t, z: shownSelection.z,
                  ...(isRgb ? { c: shownSelection.c } : {}), auto: true }) as { source_id: string; source_sha256: string; channels: Channel[] };
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
          /></fieldset><SourceExportPanel api={api} source={source} selection={shownSelection} channels={channels} defaultDpi={preferences.figureDpi}
            projection={resolvedProjection} onError={setError} /></>
        )}
        {source && !configurationValid && <div role="status" className="research-number-status">
          <p>Finish numeric fields before running analysis or saving a recipe.</p>
          <button disabled={busy !== null} onClick={restoreAppliedNumbers}>Restore applied numbers</button>
        </div>}
        {source && (tab === "Process" || (tab === "Analyze" && segmentationFamily === "classical")) &&
          <RecipeResourcePanel api={api} source={source} selection={shownSelection} recipe={recipe}
            busy={busy !== null} onBudget={(bytes) => setRecipe((old) => ({ ...old, working_bytes: bytes }))} />}
        {tab === "Process" && (
          <Process
            key={numberScope} numberKey={numberKey} configurationValid={configurationValid} onNumberValidity={(valid) => reportNumberValidity("process", valid)}
            recipe={recipe}
            setRecipe={setRecipe}
            onPreview={() => void preview()}
            busy={busy !== null}
          />
        )}
        {source && dimensions && tab === "Analyze" && (
          <>
          <label className="segmentation-family">Segment with<select aria-label="Segmentation model" value={segmentationFamily} onChange={(event) => setSegmentationFamily(event.target.value as typeof segmentationFamily)}>
            <option value="classical">Classical methods</option><option value="large-components">Large image · threshold components</option><option value="adaptive">Loci Adaptive Watershed</option>{isRgb && <option value="stain">Declared stain separation</option>}<option value="cellpose-sam">Cellpose-SAM</option><option value="cellpose-sam-v2">Cellpose-SAM v2</option>
          </select></label>
          <ResearchComputeControl compute={compute} sources={[source]} learned={segmentationFamily.startsWith("cellpose")}
            supported={segmentationFamily === "classical" || segmentationFamily.startsWith("cellpose")}
            busy={busy !== null || documentSwitching} onSetup={onOpenCompute ?? (() => openWorkbenchTab("Remote"))} />
          {segmentationFamily === "large-components" ? <LargeAnalysisPanel api={api} source={source} selection={shownSelection}
            busy={busy !== null} onBusy={setBusy} onError={setError}
            onRunStart={() => largeNavigationIntent.current}
            onResult={async (result, intent) => {
              if (intent !== largeNavigationIntent.current) {
                await refreshLargeHistory();
                return;
              }
              if (await persistRevision(result, undefined, intent) && intent === largeNavigationIntent.current) setTab("Info");
            }} /> : ["classical", "stain"].includes(segmentationFamily) ? <Analyze
            key={numberScope} numberKey={numberKey} configurationValid={configurationValid} onNumberValidity={(valid) => reportNumberValidity("analyze", valid)}
            recipe={recipe}
            channelCount={dimensions.c}
            channelNames={segmentationChannelNames}
            selection={shownSelection}
            onSegmentationChannel={changeSegmentationChannel}
            setRecipe={setRecipe}
            onRun={() => void run()}
            busy={busy !== null}
            inputUnavailable={documentSwitching || sourceIsChanging || !viewSettingsReady || source.locator_state === "relink-required"}
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
            activeResult={selectedResult && selectedResult.source_id === source.id ? selectedResult : null}
            onOpenPopulation={() => openWorkbenchTab("Population")}
            onOpenReviewExport={() => { setResultSection("review"); openWorkbenchTab("Info"); }}
          /> : segmentationFamily === "adaptive" ? <ResearchAdaptivePanel api={api} source={source} selection={shownSelection}
            onSegmentationChannel={changeSegmentationChannel} channelNames={segmentationChannelNames}
            inputUnavailable={documentSwitching || sourceIsChanging || !viewSettingsReady || source.locator_state === "relink-required"}
            busy={busy !== null} onBusy={(message) => { if (message) setError(null); setBusy(message); }} onError={setError} onBatchConfiguration={setAdaptiveBatchConfiguration}
            workingBytes={recipe.working_bytes}
            onWorkingBytesChange={(bytes) => setRecipe((old) => ({ ...old, working_bytes: bytes }))}
            onResult={async (result) => { await loadResult(result.id, result); await api.getSnapshot().then(adopt); }} /> : <ResearchCellposePanel api={api} source={source} selection={shownSelection} profileId={segmentationFamily as "cellpose-sam" | "cellpose-sam-v2"}
            busy={busy !== null} onBusy={(message) => { if (message) setError(null); setBusy(message); }} onError={setError}
            workingBytes={recipe.working_bytes}
            onWorkingBytesChange={(bytes) => setRecipe((old) => ({ ...old, working_bytes: bytes }))}
            onBatchConfiguration={setCellposeBatchConfiguration}
            remoteTarget={compute.target ? { ...compute.target, start: async tasks => { try { await compute.target!.start(tasks); } finally { setJobsOpen(true); } } } : undefined}
            onResult={async (result) => { await loadResult(result.id, result); await api.getSnapshot().then(adopt); }} />}
          {!["classical", "stain", "large-components"].includes(segmentationFamily) && rows.length > 0 && (
            <div className="research-panel-section" style={{ marginTop: 12 }}>
              <h3>Segmented objects ({selectedResult?.object_count ?? rows.length})</h3>
              {selectedResult && selectedResult.source_id === source.id && (
                <div className="research-result-workflow-bar" role="group" aria-label="Selected result workflow">
                  <div className="research-result-workflow-summary">
                    <strong>{resultTitle(selectedResult)}</strong>
                    <span>{selectedResult.object_count.toLocaleString()} {selectedResult.object_count === 1 ? "object" : "objects"} · {reviewLabel(selectedResult.review)} · rev {selectedResult.revision_hash.slice(0, 8)}</span>
                  </div>
                  <div className="research-actions">
                    <button type="button" onClick={() => openWorkbenchTab("Population")}>Inspect in Statistics &amp; objects</button>
                    <button type="button" onClick={() => openWorkbenchTab("Info")}>Proceed to Review &amp; export</button>
                  </div>
                </div>
              )}
              {selectedResult && selectedResult.object_count > rows.length && <p>Showing the first {rows.length} objects. Statistics & objects shows the full population.</p>}
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
          {segmentationFamily === "classical" && <details className="segmentation-comparison-disclosure"><summary>Compare settings on regions</summary>
          <GuidedExplorationPanel api={api} source={source} selection={shownSelection}
            busy={busy !== null || documentSwitching || sourceIsChanging} onBusy={setBusy} onSelection={setSelection}
            onDrawRegion={() => { setDrawingAnalysisRegion(true); setResultId(null); setResultView(null); setImage(null); }}
            onUse={(next, region) => { setRecipe(next); setSelection(region); }}
            onResult={async (target, measurements) => { await persistRevision(target, measurements); await api.getSnapshot().then(adopt); }} /></details>}
          <details className="external-labels-disclosure"><summary>Import existing labels</summary>
          <ResearchLabelsImportPanel api={api} source={source} selection={shownSelection} workingBytes={recipe.working_bytes}
            navigationIntent={() => largeNavigationIntent.current}
            scope={labelImportScope} busy={busy !== null || documentSwitching || sourceIsChanging || !viewSettingsReady} onBusy={(message, owner) => {
              if (message) { labelImportBusyOwner.current = { owner, message }; setBusy(message); }
              else if (labelImportBusyOwner.current?.owner === owner) {
                const ownMessage = labelImportBusyOwner.current.message;
                labelImportBusyOwner.current = null;
                setBusy((current) => current === ownMessage ? null : current);
              }
            }}
            onResult={async (target, measurements, isCurrent) => {
              const capturedScope = labelImportScope;
              const current = () => isCurrent() && liveLabelImportScope.current === capturedScope && !documentSwitch.current;
              if (await persistRevision(target, measurements, undefined, current, true) && current()) {
                setRedoStack([]); setCorrectionObjectTarget(null); openWorkbenchTab("Population");
              }
            }} /></details>

          </>
        )}
        {populationOpened && selectedResult && (<div className="population-workspace-host" hidden={tab !== "Population"}>
          <ResearchPopulationExplorer key={`${selectedResult.id}:${selectedResult.revision_hash}`} api={api} result={selectedResult}
            onMeasureCompartments={source && !isRgb ? () => { setQuantificationEntry("association"); setQuantificationEntryKey((key) => key + 1); openWorkbenchTab("Quantify"); } : undefined}
            onOpenReviewExport={() => openWorkbenchTab("Info")}
            onHighlight={setPopulationHighlight}
            active={tab === "Population"} focused={statisticsFocused} onToggleFocus={() => setStatisticsFocused((value) => !value)}
            selectedLabel={Number((isLargeResult(selectedResult) ? largeObject : populationObject)?.label) || null}
            onSelect={(row) => {
              objectPickToken.current++; largeSelectionIntent.current++;
              if (isLargeResult(selectedResult)) setLargeObject(row);
              else { setPopulationObject(row); const index = rows.findIndex((item) => item.label === row.label); setSelectedRow(index < 0 ? null : index); }
            }}
            onLocate={(row) => { setStatisticsFocused(false); void locatePopulationObject(row); }}
            onEdit={isLargeResult(selectedResult) || !selectedResult.arrays?.labels ? undefined : (target) => {
              if (busy !== null || documentSwitching || target.result_id !== selectedResult.id || target.revision_hash !== selectedResult.revision_hash) return;
              setCorrectionObjectTarget(target); setStatisticsFocused(false); openWorkbenchTab("Correction");
            }} />
        </div>)}
        {tab === "Population" && !selectedResult && <section className="research-panel population-empty-workspace"><h2>Statistics &amp; objects</h2><p>Select a saved segmentation result to explore object measurements alongside the image.</p><p>For this source image, pixel-value distributions are available under Histogram &amp; levels in Image &amp; channels.</p><button type="button" onClick={() => openWorkbenchTab("Display")}>Open image &amp; channels</button><button type="button" onClick={() => openWorkbenchTab("Analyze")}>Segment &amp; measure</button></section>}
        {source && tab === "Quantify" && isRgb && <section className="research-prerequisite"><p>These methods require scalar acquisition channels. This source contains RGB components.</p><button onClick={() => openWorkbenchTab("Display")}>Open Image &amp; channels</button></section>}
        {source && dimensions && !isRgb && quantificationOpened && (
          <div hidden={tab !== "Quantify"}>
          <ResearchQuantificationPanel key={numberScope} active={tab === "Quantify"}
            numberKey={numberKey} onNumberValidity={(valid) => reportNumberValidity("quantify", valid)}
            initialMode={quantificationEntry} entryKey={quantificationEntryKey}
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
          </div>
        )}
        {selectedResult?.kind === "corrected-labels" && selectedResult.parent_id && ["Correction", "Info", "Population"].includes(tab) && (
          <div className="research-panel"><button disabled={busy !== null || documentSwitching} onClick={() => {
            setCorrectionEffectSeed({ beforeId: selectedResult.parent_id!, afterId: selectedResult.id });
            setStudySection("corrections");
            openWorkbenchTab("Study");
          }}>Show experiment effect</button></div>
        )}
        {tab === "Correction" && !selectedResult && <section className="research-prerequisite">
          <p>Select a segmentation result to edit its labels or ROIs.</p>
          <div className="research-actions">{snapshot.results.filter((item) => item.source_id === source?.id && !isLargeResult(item) && item.arrays?.labels).map((item) =>
            <button key={item.id} onClick={() => void loadResult(item.id, item)}>{resultTitle(item)} · {item.object_count} objects</button>)}
            <button onClick={() => openWorkbenchTab("Analyze")}>Open Segment &amp; measure</button></div>
        </section>}
        {tab === "Correction" && selectedResult && !isLargeResult(selectedResult) && (
          <ResearchCorrectionPanel
            api={api}
            selectedObject={correctionObjectTarget?.result_id === resultId ? correctionObjectTarget : null}
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
          <><AgentImagePanel api={api} source={source} selection={shownSelection} channels={channels}
            projection={resolvedProjection} following={assistantFollowing} followBusy={assistantFollowBusy || !viewSettingsReady}
            onFollowing={(value) => void followAssistantDisplay(value)} onError={setError} />
          {!configurationValid && <p role="status">Finish numeric fields before connecting with this recipe. {invalidNumberForms[`${numberScope}:quantify`] && <button onClick={() => openWorkbenchTab("Quantify")}>Review marker gates</button>}</p>}
          <ResearchAgentPanel
            api={api}
            source={source}
            studySources={[...snapshot.sources, ...(snapshot.workspace?.closed_sources ?? [])]}
            operations={snapshot.operations}
            agentSessions={snapshot.agent_sessions}
            selection={shownSelection}
            recipe={recipe}
            report={report}
            configurationValid={configurationValid}
            busy={busy !== null}
            onCreated={() => {
              void api.getSnapshot().then((next) => {
                if (next && !documentSwitch.current && currentStudyScope.current === exportDraftStudy &&
                  next.project.project_id === snapshot.project.project_id) setSnapshot(next);
              }).catch((caught) => {
                if (currentStudyScope.current === exportDraftStudy)
                  setAgentRefreshError(message(caught, "Could not refresh the new agent access bundle."));
              });
            }}
            onBusyChange={(value) =>
              setBusy((current) =>
                value
                  ? (current ?? "agent policy")
                  : current === "agent policy"
                    ? null
                    : current,
              )
            }
          /></>
        )}
        {tab === "Remote" && (
          <ResearchRemotePanel
            api={api}
            sources={snapshot.sources}
            selection={shownSelection}
            recipe={recipe}
            configurationValid={configurationValid}
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
            key={numberScope} numberKey={numberKey} configurationValid={configurationValid} onNumberValidity={(valid) => reportNumberValidity("model", valid)}
            api={api}
            models={models}
            onOpenMethods={() => openWorkbenchTab("Analyze")}
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
        {densityOpened && <div hidden={tab !== "Density"}>
          <SpatialDensityPanel key={`density:${exportDraftStudy}`} api={api} snapshot={snapshot} active={tab === "Density"}
            busy={busy !== null || documentSwitching} onSnapshot={adopt}
            onInspect={(target) => { void navigateExactResult(target); openWorkbenchTab("Info"); }} />
        </div>}
        <StudyWorkspace active={tab === "Study"} section={studySection} onSection={setStudySection}
          focused={studyFocused} onToggleFocus={() => setStudyFocused((value) => !value)} sourceName={source?.name}
          samples={
            <SampleSheetPanel key={`samples:${exportDraftStudy}`} api={api} snapshot={snapshot} busy={busy !== null || documentSwitching} onSnapshot={adopt}
              onInspectResult={inspectStudyResult} onEditMetadata={editStudyMetadata} onAddImages={() => void openImages()} />
          }
          intensity={
            <ExperimentIntensityPanel key={`intensity:${exportDraftStudy}`} api={api} snapshot={snapshot} active={tab === "Study" && studySection === "intensity"}
              busy={busy !== null || documentSwitching} seed={intensitySeed?.study === exportDraftStudy ? intensitySeed : null}
              onSnapshot={adopt} onInspect={(target) => { void navigateExactResult(target); openWorkbenchTab("Info"); }} />
          }
          corrections={source && dimensions && (correctionEffectSeed || snapshot.results.some((result) => ["corrected-labels", "large-corrected-labels"].includes(result.kind))) ? <>
            {tab === "Study" && (
              <ResearchCorrectionEffectPanel key={`correction-effect:${studyEpoch}`}
                api={api} snapshot={snapshot} seed={correctionEffectSeed}
                contextKey={`${studyEpoch}:${documentSwitching}:${source.id}:${resultId ?? ""}`}
                busy={busy !== null || documentSwitching} adopt={adopt} onOpenResult={async (id) => {
                  const exact = snapshot.results.find(result => result.id === id);
                  if (!exact) throw new Error("The bound revision is no longer in this study.");
                  await navigateExactResult(exact); openWorkbenchTab("Info");
                }} />
            )}
          </> : undefined}
          batch={studyOpened && source && dimensions ? (
            <StudyPanel key={`batch:${exportDraftStudy}`}
              compute={compute}
              onComputeSetup={onOpenCompute ?? (() => openWorkbenchTab("Remote"))}
              onRemoteStarted={() => setJobsOpen(true)}
              configurationValid={configurationValid}
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
          ) : <div className="research-panel"><p>Select an image to configure a batch.</p></div>}
        />
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
            onOpenMethods={() => openWorkbenchTab("Analyze")} onOpenDrawings={() => openWorkbenchTab("Annotate")}
            onChooseResult={(target) => void navigateExactResult(target)}
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
        {selectedResult && isLargeResult(selectedResult) && ["Info", "Correction"].includes(tab) && (
          <LargeResultInspector key={selectedResult.revision_hash} api={api} result={selectedResult} selected={largeObject}
            onSelect={(row) => { largeSelectionIntent.current++; setLargeObject(row); }} onLocate={async (row) => {
              const selectionIntent = ++largeSelectionIntent.current;
              const navigationIntent = largeNavigationIntent.current;
              const label = row.label;
              const current = () => selectionIntent === largeSelectionIntent.current && navigationIntent === largeNavigationIntent.current;
              try {
                if (!Number.isInteger(label) || Number(label) < 1) throw new Error("Choose a valid object label.");
                const located = await api.execute("large_result_locate", { result_id: selectedResult.id, revision_hash: selectedResult.revision_hash, label }) as {
                  result_id: string; revision_hash: string; label: number; point_index: number[];
                };
                if (!current()) return;
                const [height, width] = selectedResult.arrays!.image.shape!;
                const point = located.point_index;
                if (located.result_id !== selectedResult.id || located.revision_hash !== selectedResult.revision_hash || located.label !== label ||
                    !Array.isArray(point) || point.length !== 2 || !Number.isInteger(point[0]) || !Number.isInteger(point[1]) ||
                    point[0] < 0 || point[0] >= height || point[1] < 0 || point[1] >= width)
                  throw new Error("Object location returned a stale or invalid result pixel.");
                setLargeFocus({ point_index: [point[0], point[1]] });
              } catch (error) { if (current()) setError(error instanceof Error ? error.message : "Could not locate this object."); }
            }} busy={busy !== null}
            onBusy={setBusy} onError={setError} onActionStart={() => largeNavigationIntent.current}
            onResult={async (child, intent) => {
              if (intent !== largeNavigationIntent.current) {
                await refreshLargeHistory();
                return;
              }
              if (await persistRevision(child, undefined, intent)) { setRedoStack([]); setLargeObject(null); }
            }}
            onRefresh={async () => adopt(await api.getSnapshot())}
            onUndo={() => void moveRevision("undo")} onRedo={() => void moveRevision("redo")} canRedo={Boolean(redoTargetId)} />
        )}
        {selectedResult && isLargeResult(selectedResult) && tab === "Info" && <button type="button" disabled={busy !== null || documentSwitching}
          onClick={() => { setIntensitySeed((old) => ({ study: exportDraftStudy, result: selectedResult, serial: (old?.serial ?? 0) + 1 })); setStudySection("intensity"); openWorkbenchTab("Study"); }}>Compare intensity in Study &amp; batch</button>}
        {selectedResult && isLargeResult(selectedResult) && tab === "Info" && api.planDataExport && (
          <ScientificDataExportPanel key={exportDraftStudy} api={api} snapshot={snapshot} result={selectedResult} draftControl={scientificExportDraftControl}
            busy={busy !== null} onSnapshot={adopt}
            onSelectResult={(target) => void navigateExactResult(target)}
            onOpenPopulation={() => openWorkbenchTab("Population")} />
        )}
        {source && tab === "Info" && !isLargeResult(selectedResult) && (
          <Info key={exportDraftStudy}
            section={resultSection} onSectionChange={setResultSection}
            scientificExportDraftControl={scientificExportDraftControl}
            onCompareIntensity={() => {
              if (!selectedResult) return;
              setIntensitySeed((old) => ({ study: exportDraftStudy, result: selectedResult, serial: (old?.serial ?? 0) + 1 })); setStudySection("intensity"); openWorkbenchTab("Study");
            }}
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
            onSelectResult={(target) => void navigateExactResult(target, undefined, resultSection)}
            onOpenPopulation={() => openWorkbenchTab("Population")}
          />
        )}
      </aside>
      </div>
      <footer className="workbench-status">
        <button className={`workbench-jobs__trigger ${jobsOpen ? "active" : ""}`} title="View running and completed jobs" onClick={() => setJobsOpen((open) => !open)}><Activity size={14} aria-hidden="true" /> Jobs{localJobCount + remoteJobCount > 0 ? <span className="workbench-jobs__badge">{localJobCount + remoteJobCount}</span> : null}</button>
        <span role="status">{documentSwitching ? "Updating workspace…" : busy ? `Working: ${busy}` : remoteJobCount ? `${remoteJobCount} remote ${remoteJobCount === 1 ? "job" : "jobs"}` : "Local"}</span>
        <span>{source ? `${meta(source).dimensions.x.toLocaleString()} × ${meta(source).dimensions.y.toLocaleString()}` : ""}</span>
        <AgentSessionIndicator
          key={exportDraftStudy}
          api={api}
          snapshot={snapshot}
          refreshError={agentRefreshError}
          followAgent={followAgent}
          onFollowAgentChange={setFollowAgent}
          onSnapshot={(next) => {
            if (!documentSwitch.current && currentStudyScope.current === exportDraftStudy &&
              next.project.project_id === snapshot.project.project_id) setSnapshot(next);
          }}
          onError={setError}
          inspectablePreviewJobIds={snapshot.jobs.filter((job) => job.state === "succeeded" &&
            ["workflow_preview", "exploration_preview", "exploration_compare"].includes(job.operation)).map((job) => job.id)}
          onInspectPreview={(target) => void inspectAgentPreview(target)}
          onOpenSource={openAgentSource}
          onOpenResult={(target) => {
            if (!agentTargetNavigationReady || documentSwitch.current) {
              setError("Finish the current edit or operation before opening an agent result."); return;
            }
            try {
              const exact = agentResultTarget(snapshot, target);
              setSharedPreview(null);
              setTab("Display");
              void navigateExactResult(exact, exportDraftStudy);
            }
            catch (caught) { setError(message(caught, "The recorded agent result is unavailable.")); }
          }}
          onOpenJob={(target) => {
            if (!snapshot.jobs.some((job) => job.id === target.id)) {
              setError("The recorded agent job is no longer available in this study."); return;
            }
            setJobsOpen(true);
          }}
        />
      </footer>
      {jobsOpen && <section className="workbench-jobs" aria-label="Job center">
        <header className="workbench-jobs__header">
          <h2>Job Center</h2>
          <button className="workbench-jobs__close" aria-label="Close Job Center" onClick={() => setJobsOpen(false)}><X size={16} aria-hidden="true" /></button>
        </header>
        <div className="workbench-jobs__content">
          <ResearchComputeJobs compute={compute} onResult={loadResult} onError={setError} />
          {!snapshot.jobs.length ? (compute.runs.length || compute.starting ? null : <p className="workbench-jobs__empty">Completed and running jobs appear here.</p>) : (
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

const processLabels: Record<string, string> = { gaussian: "Gaussian blur", subtract_background: "Background subtraction", subtract_constant: "Subtract constant", median: "Median filter", opening: "Morphological opening", closing: "Morphological closing" };

type NumericFormProps = { numberKey: string; onNumberValidity: (valid: boolean) => void; configurationValid: boolean };

function Process({
  recipe,
  setRecipe,
  onPreview,
  busy,
  numberKey, onNumberValidity, configurationValid,
}: NumericFormProps & {
  recipe: typeof DEFAULT_RECIPE;
  setRecipe: React.Dispatch<React.SetStateAction<typeof DEFAULT_RECIPE>>;
  onPreview: () => void;
  busy: boolean;
}) {
  const numbers = useNumericValidity(onNumberValidity);
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
      <h2>Preprocess</h2>
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
            <Plus size={12} /> {processLabels[op]}
          </button>
        ))}
      </div>
      <ol>
        {recipe.steps.map((step, index) => {
          const parameter =
            "sigma" in step ? "sigma" : "radius" in step ? "radius" : "value";
          return (
            <li key={index}>
              <strong>{processLabels[String(step.op)] ?? String(step.op)}</strong>
              <label>
                {parameter}
                <ValidatedNumberInput key={`${numberKey}:${index}:${parameter}`}
                  label={`Step ${index + 1} ${parameter}`} value={Number(step[parameter])}
                  minimum={parameter === "value" ? -1e15 : 0} maximum={parameter === "value" ? 1e15 : 1e6}
                  commitOnChange onValidity={(valid) => numbers.setValidity(`step-${index}-${parameter}`, valid)}
                  onValue={(value) => { patch(index, { [parameter]: value }); return true; }} />
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
      <button disabled={busy || !numbers.valid || !configurationValid} onClick={onPreview}>
        Preview selected crop
      </button>
    </div>
  );
}
function Analyze({
  recipe,
  channelCount,
  channelNames,
  selection,
  onSegmentationChannel,
  setRecipe,
  onRun,
  busy,
  inputUnavailable,
  numberKey, onNumberValidity, configurationValid,
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
  activeResult,
  onOpenPopulation,
  onOpenReviewExport,
}: NumericFormProps & {
  recipe: typeof DEFAULT_RECIPE;
  channelCount: number;
  channelNames?: string[];
  selection: ResearchSelection;
  onSegmentationChannel: (channel: number) => void;
  setRecipe: React.Dispatch<React.SetStateAction<typeof DEFAULT_RECIPE>>;
  onRun: () => void;
  busy: boolean;
  inputUnavailable: boolean;
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
  activeResult?: ResearchResult | null;
  onOpenPopulation?: () => void;
  onOpenReviewExport?: () => void;
}) {
  const numbers = useNumericValidity(onNumberValidity);
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
      <small>Derived intensity · 0–1</small></label>}
      {isRgb && (
        <>
          <h3>Stain separation</h3>
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
            <ValidatedNumberInput key={`${numberKey}:Stain-coordinate threshold`} label="Stain-coordinate threshold" value={histologySegmentation.threshold}
                  commitOnChange onValidity={(valid) => numbers.setValidity("Stain-coordinate threshold", valid)}
                  onValue={(value) => { setHistologySegmentation((old) => ({ ...old, threshold: value })); return true; }} />
          </label>
          <label>
            Stain minimum object area ({stainAreaUnit})
            <ValidatedNumberInput key={`${numberKey}:Stain minimum object size`} label="Stain minimum object size" value={histologySegmentation.min_size} minimum={0} maximum={1e20}
                  commitOnChange onValidity={(valid) => numbers.setValidity("Stain minimum object size", valid)}
                  onValue={(value) => { setHistologySegmentation((old) => ({ ...old, min_size: value })); return true; }} />
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
              <ValidatedNumberInput key={`${numberKey}:Stain watershed split height`} label="Stain watershed split height" value={histologySegmentation.split_height ?? 1} minimum={1e-9} maximum={1e9}
                  commitOnChange onValidity={(valid) => numbers.setValidity("Stain watershed split height", valid)}
                  onValue={(value) => { setHistologySegmentation((old) => ({ ...old, split_height: value })); return true; }} />
            </label>
          )}
          <fieldset>
            <legend>Stain measurement rule</legend>
            <label className="research-check">
              <input
                aria-label="Enable stain measurement rule"
                type="checkbox"
                checked={stainRuleEnabled}
                onChange={(event) => setStainRuleEnabled(event.target.checked)}
              />
              Classify objects by stain threshold
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
                <small>{stainRuleStatistic === "max" ? "Maximum" : stainRuleStatistic === "mean" ? "Mean" : "Sum"} stain coordinate &gt; threshold</small>
              </>
            )}
          </fieldset>
          <div className="research-actions">
            <button
              disabled={busy || inputUnavailable || !numbers.valid || !configurationValid || (stainRuleEnabled && !stainRuleValid)}
              onClick={() =>
                onHistologyPreview(basis, component, histologyRecipe)
              }
            >
              Preview declared stain
            </button>
            <button
              className="research-primary"
              disabled={busy || inputUnavailable || !numbers.valid || !configurationValid || (stainRuleEnabled && !stainRuleValid)}
              onClick={() => onHistologyRun(basis, component, histologyRecipe)}
            >
              Run declared stain
            </button>
          </div>
        </>
      )}
      {!isRgb && (
        <>
          {!rgbIntensity && <SegmentationInputControl channelCount={channelCount} channelNames={channelNames}
            selection={selection} disabled={busy || inputUnavailable} onChange={onSegmentationChannel} />}
          <label>
            Threshold
            <ValidatedNumberInput key={`${numberKey}:Threshold`} label="Threshold" value={Number(segmentation.threshold)}
                  commitOnChange onValidity={(valid) => numbers.setValidity("Threshold", valid)}
                  onValue={(value) => { patch({ threshold: value }); return true; }} />
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
              <ValidatedNumberInput key={`${numberKey}:Watershed split height`} label="Watershed split height" value={Number(segmentation.split_height ?? 1)} minimum={1e-9} maximum={1e9}
                  commitOnChange onValidity={(valid) => numbers.setValidity("Watershed split height", valid)}
                  onValue={(value) => { patch({ split_height: value }); return true; }} />
            </label>
          )}
          <div className="research-grid">
            <label>Foreground<select aria-label="Object foreground" value={String(segmentation.polarity ?? "bright")} onChange={(event) => patch({ polarity: event.target.value })}>
              <option value="bright">Above threshold</option><option value="dark">Below threshold</option>
            </select></label>
            <label>Minimum object {measureLabel}<ValidatedNumberInput key={`${numberKey}:Minimum object measure`} label="Minimum object measure" value={Number(segmentation.min_size ?? 0)} minimum={0} maximum={1e20}
                  commitOnChange onValidity={(valid) => numbers.setValidity("Minimum object measure", valid)}
                  onValue={(value) => { patch({ min_size: value }); return true; }} /></label>
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
                  {index + 1}: {channelNames?.[index]?.trim() || `Channel ${index + 1}`}
                </option>
              ))}
            </select>
          </label>}
          <button className="research-primary" disabled={busy || inputUnavailable || !numbers.valid || !configurationValid || (rgbIntensity && recipe.input_transform !== "rgb_intensity")} onClick={onRun}>
            <Play /> {busy ? "Running…" : "Run recipe"}
          </button>
        </>
      )}
      {activeResult && (
        <div className="research-result-workflow-bar" role="group" aria-label="Selected result workflow">
          <div className="research-result-workflow-summary">
            <strong>{resultTitle(activeResult)}</strong>
            <span>{activeResult.object_count.toLocaleString()} {activeResult.object_count === 1 ? "object" : "objects"} · {reviewLabel(activeResult.review)} · rev {activeResult.revision_hash.slice(0, 8)}</span>
          </div>
          <div className="research-actions">
            {onOpenPopulation && <button type="button" onClick={onOpenPopulation}>Inspect in Statistics &amp; objects</button>}
            {onOpenReviewExport && <button type="button" onClick={onOpenReviewExport}>Proceed to Review &amp; export</button>}
          </div>
        </div>
      )}
      <ResultTable rows={rows} selected={selected} onSelect={onSelect} />
    </div>
  );
}
function ModelPanel({
  api,
  source,
  onOpenMethods,
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
  numberKey, onNumberValidity, configurationValid,
}: NumericFormProps & {
  api: ResearchDesktopApi;
  onOpenMethods: () => void;
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
  const numbers = useNumericValidity(onNumberValidity);
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
  const requirements = <details className="model-package-requirements"><summary>Package requirements</summary>
    <p>Model files and reference tensors must be supplied locally.</p>
    <p>Choose a directory with a loci-model.json or BioImage.IO 0.5 rdf.yaml description, ONNX weights and hashed .npy reference tensors. The supported profile uses one static float32 input and output, BCYX axes, batch size one and a 2D probability output on the input grid.</p>
    <p>Channels, physical scale and units must be declared. Loci checks the package against its supported CPU runtime and reference tensors before import. This check does not establish biological accuracy or usage rights.</p>
  </details>;
  const resources = <details className="research-model-resources"><summary>Resources · {workingBytes / 1024 ** 3 < 1 ? "512 MiB" : `${workingBytes / 1024 ** 3} GiB`} working memory</summary>
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
          </details>;
  if (!models.length) return <section className="research-panel research-prerequisite">
    <h2>No model packages in this study.</h2>
    <p>Import a local Loci-compatible ONNX package to use this tool.</p>
    <div className="research-actions">
      {api.importModel && <button className="research-primary" disabled={busy || importing} onClick={() => void importPackage()}>Import model package…</button>}
      <button onClick={onOpenMethods}>Open Segment &amp; measure</button>
    </div>{resources}{requirements}
  </section>;
  return (
    <div className="research-panel">
      <h2>Use a model</h2>
      {api.importModel && (
        <button
          disabled={busy || importing}
          onClick={() => void importPackage()}
        >
          Import model package…
        </button>
      )}
      {recoverable && <section className="research-prerequisite"><p>This model’s files are unavailable. Re-import the same package to restore it.</p>
        {api.importModel && <button disabled={busy || importing} onClick={() => void importPackage(true)}>Re-import model package…</button>}</section>}
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
      {!selected && <p>Choose a model package to configure its channels and scale.</p>}
      {requirements}
      {resources}
      {selected && (
        <div className="research-model-records">
          <p>{recoverable ? "Re-import this package to run it." : "Reference check passed."}</p>
          <dl className="research-kv">
            <div><dt>Scientific validation</dt><dd>{JSON.stringify(selected.scientific_validation)}</dd></div>
            <div><dt>Usage rights</dt><dd>{JSON.stringify(selected.usage_rights)}</dd></div>
          </dl>
          <details className="research-technical-record">
            <summary>Technical record</summary>
            <dl className="research-kv">
              <div><dt>Compatibility</dt><dd>{String(selected.technical_compatibility)}</dd></div>
              <div><dt>Reference check</dt><dd>{JSON.stringify(selected.reference_qualification)}</dd></div>
            </dl>
          </details>
        </div>
      )}
      {selected && !recoverable && (
        <>
          <h3>Source channels &amp; scale</h3>
          {mapping.map((item, index) => (
            <label key={item.model_input_index}>
              Model input {item.model_input_index + 1}: {item.model_channel}
              <select
                aria-label={
                  "Model input " + (item.model_input_index + 1) + " source channel"
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
                    {source.metadata.channel_names?.[c] || `Channel ${c + 1}`}
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
                <ValidatedNumberInput key={`${numberKey}:Override Y scale`} label="Override Y scale" value={scaleY} minimum={Number.MIN_VALUE}
                  commitOnChange onValidity={(valid) => numbers.setValidity("Override Y scale", valid)}
                  onValue={(value) => { setScaleY(value); return true; }} />
              </label>
              <label>
                Override X{" "}
                <ValidatedNumberInput key={`${numberKey}:Override X scale`} label="Override X scale" value={scaleX} minimum={Number.MIN_VALUE}
                  commitOnChange onValidity={(valid) => numbers.setValidity("Override X scale", valid)}
                  onValue={(value) => { setScaleX(value); return true; }} />
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
          <h3>Create objects</h3>
          <label>
            Probability output channel (zero-based){" "}
            <ValidatedNumberInput key={`${numberKey}:Probability channel`} label="Probability channel" value={probabilityChannel} integer minimum={0}
                  commitOnChange onValidity={(valid) => numbers.setValidity("Probability channel", valid)}
                  onValue={(value) => { setProbabilityChannel(value); return true; }} />
          </label>
          <label>
            Threshold{" "}
            <ValidatedNumberInput key={`${numberKey}:Model threshold`} label="Model threshold" value={threshold} minimum={0} maximum={1}
                  commitOnChange onValidity={(valid) => numbers.setValidity("Model threshold", valid)}
                  onValue={(value) => { setThreshold(value); return true; }} />
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
            <ValidatedNumberInput key={`${numberKey}:Physical minimum size`} label="Physical minimum size" value={minSize} minimum={0}
                  commitOnChange onValidity={(valid) => numbers.setValidity("Physical minimum size", valid)}
                  onValue={(value) => { setMinSize(value); return true; }} />
          </label>
          {method === "watershed" && (
            <label>
              Watershed split height{" "}
              <ValidatedNumberInput key={`${numberKey}:Model watershed split height`} label="Model watershed split height" value={splitHeight} minimum={1e-9} maximum={1e9}
                  commitOnChange onValidity={(valid) => numbers.setValidity("Model watershed split height", valid)}
                  onValue={(value) => { setSplitHeight(value); return true; }} />
            </label>
          )}
          <h3>Measurements</h3>
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
                  {source.metadata.channel_names?.[c] || `Channel ${c + 1}`}
                </option>
              ))}
            </select>
          </label>
          <div className="research-actions">
            <button disabled={busy || !numbers.valid || !configurationValid || !mapping.length} onClick={onPreview}>
              Preview model overlay
            </button>
            <button
              className="research-primary"
              disabled={busy || !numbers.valid || !configurationValid || !pending}
              onClick={onAdopt}
            >
              Save preview as result
            </button>
          </div>
          {pending && (
            <p data-model-preview-id={pending.id} data-model-preview-sha256={pending.sha256}>
              Preview ready to save as a result.
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
  compute,
  onComputeSetup,
  onRemoteStarted,
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
  configurationValid,
}: {
  compute: ResearchComputeController;
  onComputeSetup: () => void;
  onRemoteStarted: () => void;
  configurationValid: boolean;
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
  batchFamily: "classical" | "stain" | "adaptive" | "cellpose-sam" | "cellpose-sam-v2" | "large-components";
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
  const [reviewPackageLabel, setReviewPackageLabel] = useState("");
  const [reviewPackageReceipt, setReviewPackageReceipt] = useState("");
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
    if (!configurationValid) return;
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
    if (!configurationValid) return;
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
    if (batchFamily === "large-components") throw new Error("Large image analysis currently runs one explicit image scope at a time. Use Analyze.");
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
    if (!configurationValid) return;
    if (compute.target && (batchFamily === "classical" || batchFamily.startsWith("cellpose"))) {
      await report(() => compute.target!.start(frozenBatchTasks()), "Could not start the remote batch. Check Job Center for saved progress.");
      onRemoteStarted();
      return;
    }
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
  const exportForReview = async () => {
    if (!api.exportReviewPackage) throw new Error("This Loci build cannot export review packages.");
    const bindings = resultIds.map((id) => {
      const result = snapshot.results.find((item) => item.id === id);
      const selectedSource = snapshot.sources.find((item) => item.id === result?.source_id);
      if (!result || !selectedSource) throw new Error("A selected review result is unavailable.");
      return {
        source_id: selectedSource.id, source_sha256: selectedSource.sha256,
        result_id: result.id, revision_hash: result.revision_hash,
      };
    });
    setReviewPackageReceipt("");
    const receipt = await report(
      () => api.exportReviewPackage!(bindings, { rootLabel: reviewPackageLabel }),
      "Could not export the exact review package.",
    );
    if (receipt) setReviewPackageReceipt(`Saved ${receipt.image_count} images and counts.csv in ${receipt.basename}.`);
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
        api.execute("recipe_preflight", {
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
      <label>
        Recipe name{" "}
        <input
          aria-label="Study recipe name"
          disabled={busy}
          value={recipeName}
          onChange={(e) => setRecipeName(e.target.value)}
        />
      </label>
      <button disabled={busy || !configurationValid} onClick={() => void perform(saveRecipe)}>
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
      {batchFamily === "large-components" && <p>Large image analysis runs one explicit image scope at a time in Analyze. Saved recipes and previews below apply to the classical recipe.</p>}
      {profileBatch && (
        <p>
          The batch uses the exact {batchFamily === "adaptive" ? "Loci Adaptive Watershed" : batchFamily}
          {batchFamily === "adaptive" ? "" : " profile and requested device"}, settings,
          measurement channels and 2D selection last configured in Analyze.
          Previewing a saved recipe does not replace that configuration.
        </p>
      )}
      <BatchSourcePicker sources={snapshot.sources} selectedSourceIds={selectedSourceIds}
        onSelection={setSelectedSourceIds} busy={busy} previewSourceId={previewSourceId}
        previewDisabled={!configurationValid || profileBatch}
        onPreview={(id) => void perform(() => preview(id))} />
      <ResearchComputeControl compute={compute} sources={snapshot.sources.filter(item => selectedSourceIds.includes(item.id))}
        learned={batchFamily.startsWith("cellpose")} supported={batchFamily === "classical" || batchFamily.startsWith("cellpose")}
        busy={busy} onSetup={onComputeSetup} />
      <div className="study-batch-actions" role="group" aria-label="Batch actions"><button
        className="research-primary"
        disabled={busy || !configurationValid || batchFamily === "large-components" || !selectedSourceIds.length ||
          (profileBatch && !profileBatchConfigurationReady)}
        onClick={() => void perform(run)}
      >
        {compute.target && (batchFamily === "classical" || batchFamily.startsWith("cellpose")) ? `Run selected sources on ${compute.target.alias}` : "Run selected sources sequentially"}
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
          {sourceLabelForId(snapshot.sources, row.sourceId)}:{" "}
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
      <details className="study-analysis-section"><summary>Summary & export</summary>
      <p>Descriptive means and SD across biological replicates.</p>
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
          <span>{sourceLabelForId(snapshot.sources, item.source_id)}<small>{resultTitle(item)} · {reviewLabel(item.review)}</small></span>
        </label>
      ))}
      <button
        disabled={busy || !resultIds.length}
        onClick={() => void perform(summarize)}
      >
        Summarize selected revisions
      </button>
      {api.exportReviewPackage && <div className="study-review-package">
        <label>Review package name<input aria-label="Review package name" value={reviewPackageLabel}
          disabled={busy} onChange={(event) => { setReviewPackageLabel(event.target.value); setReviewPackageReceipt(""); }} /></label>
        <p>Counts and full-resolution RGB outlines for inspection. Current review states are retained.</p>
        <button disabled={busy || !resultIds.length || !reviewPackageLabel.trim()}
          onClick={() => void perform(exportForReview)}>Export review package</button>
        {reviewPackageReceipt && <p role="status">{reviewPackageReceipt}</p>}
      </div>}
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
      </details>
      <details className="study-analysis-section"><summary>Compare runs</summary>
      <p>Assign one reviewed or excluded result per source to each run.</p>
      {snapshot.results.map((item) => {
        const disposition = item.review?.disposition ?? "pending";
        const eligible = disposition === "reviewed" || disposition === "excluded";
        return (
          <div className="research-summary" key={`run-comparison-${item.id}`}>
            <strong>{resultTitle(item)}</strong><p>{sourceLabelForId(snapshot.sources, item.source_id)} · {disposition}</p>
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
              disabled={busy || researcherReviewed(item)}
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
          <p>Independent n: biological replicates.</p>
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
            Unit: {comparison.unit ?? "none declared"}
          </p>
          <details><summary>Technical record</summary><p>Receipt: {comparison.receipt_sha256}
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
          </details>
        </section>
      )}
      </details>
    </div>
  );
}

function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return String(value);
    if (value !== 0 && Math.abs(value) < 0.001) return value.toExponential(2);
    return Number.isInteger(value) ? value.toLocaleString() : value.toFixed(3);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => (typeof v === "number" && Number.isFinite(v) ? formatStatValue(v) : String(v))).join(", ")}]`;
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

const measurementHeadings: Record<string, string> = {
  label: "Object", measure: "Measure", measure_unit: "Unit", measure_kind: "Quantity",
  area: "Area", volume: "Volume", centroid_index: "Centroid (index)",
  centroid_world_xyz: "Centroid (x, y, z)", intensity: "Channel intensity",
};
const intensityHeadings: Record<string, string> = {
  mean: "Mean", sum: "Sum", min: "Minimum", max: "Maximum", std_population: "Population SD",
};

function MeasurementCell({ field, value }: { field: string; value: unknown }): React.JSX.Element {
  if (field === "intensity" && value && typeof value === "object" && !Array.isArray(value)) {
    const channels = Object.entries(value);
    return <details className="research-intensity-values" onClick={(event) => event.stopPropagation()}>
      <summary>{channels.length} {channels.length === 1 ? "channel" : "channels"}</summary>
      {channels.map(([name, statistics]) => <section key={name} aria-label={name}>
        <strong>{name}</strong>
        {statistics && typeof statistics === "object" && !Array.isArray(statistics)
          ? <dl>{Object.entries(statistics).map(([statistic, number]) => <div key={statistic}>
            <dt>{intensityHeadings[statistic] ?? statistic.replaceAll("_", " ")}</dt>
            <dd title={typeof number === "number" ? String(number) : undefined}>{formatCellValue(number)}</dd>
          </div>)}</dl> : <span>{formatCellValue(statistics)}</span>}
      </section>)}
    </details>;
  }
  return <span title={typeof value === "number" ? String(value) : undefined}>{formatCellValue(value)}</span>;
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

  if (!rows.length) return <p>No measurements yet.</p>;
  const fields = [
    "label",
    "measure",
    "measure_unit",
    "measure_kind",
    "area",
    "volume",
    "centroid_index",
    "centroid_world_xyz",
    "intensity",
  ].filter((key) => rows.some((row) => key in row));

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
      aria-label="Result measurements"
    >
      <table role="grid" aria-label="Measurements and object table" aria-rowcount={rows.length}>
        <thead>
          <tr role="row">
            {fields.map((field) => (
              <th key={field} role="columnheader" data-field={field}>{measurementHeadings[field]}</th>
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
                  <td key={field} role="gridcell" data-field={field}>
                    <MeasurementCell field={field} value={row[field]} />
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
  const abs = Math.abs(v);
  if (abs < 0.01 || abs >= 1e21) return v.toExponential(2);
  return v.toFixed(2);
}

export interface ResultStats {
  metric: string | null;
  min: string | null;
  max: string | null;
  mean: string | null;
  unit: string;
  hasMixedUnits: boolean;
  hasMixedKinds: boolean;
  validCount: number;
  totalCount: number;
  incompatibleReason: string | null;
  excludedCount: number;
  exclusionReason: string | null;
}

export function computeResultStats(rows: Array<Record<string, unknown>>): ResultStats | null {
  const totalCount = rows.length;
  if (!totalCount) return null;

  const fieldSet = new Set<string>();
  const kindSet = new Set<string>();
  const unitSet = new Set<string>();

  for (let i = 0; i < totalCount; i++) {
    const row = rows[i];
    let rowField: "measure" | "area" | "volume" | null = null;
    if ("measure" in row) {
      rowField = "measure";
    } else if ("area" in row) {
      rowField = "area";
    } else if ("volume" in row) {
      rowField = "volume";
    }
    if (rowField !== null) {
      fieldSet.add(rowField);
    }

    let rowKind: string | null = null;
    if (typeof row.measure_kind === "string" && row.measure_kind.trim().length > 0) {
      const rawKind = row.measure_kind.trim();
      const lower = rawKind.toLowerCase();
      if (lower === "area") rowKind = "Area";
      else if (lower === "volume") rowKind = "Volume";
      else rowKind = rawKind;
    } else if (rowField === "area") {
      rowKind = "Area";
    } else if (rowField === "volume") {
      rowKind = "Volume";
    }
    if (rowKind !== null) {
      kindSet.add(rowKind);
    }

    if (typeof row.measure_unit === "string" && row.measure_unit.trim().length > 0) {
      const normalizedUnit = row.measure_unit
        .trim()
        .replace(/^pixel(\^2|²|2)$/i, "px²")
        .replace(/^pixel(\^3|³|3)$/i, "px³");
      unitSet.add(normalizedUnit);
    }
  }

  if (fieldSet.size === 0) {
    return {
      metric: null,
      min: null,
      max: null,
      mean: null,
      unit: "",
      hasMixedUnits: false,
      hasMixedKinds: false,
      validCount: 0,
      totalCount,
      incompatibleReason: "No summary metric available (measure, area or volume).",
      excludedCount: totalCount,
      exclusionReason: "missing measurement field",
    };
  }

  let incompatibleReason: string | null = null;
  let hasMixedUnits = false;
  let hasMixedKinds = false;

  if (fieldSet.size > 1) {
    incompatibleReason = `Cannot pool measurements: incompatible metric fields (${Array.from(fieldSet).sort().join(", ")}).`;
    hasMixedKinds = true;
  } else if (kindSet.size > 1) {
    incompatibleReason = `Cannot pool measurements: mixed measurement kinds (${Array.from(kindSet).sort().join(", ")}).`;
    hasMixedKinds = true;
  } else if (unitSet.size > 1) {
    incompatibleReason = `Cannot pool measurements: mixed units (${Array.from(unitSet).sort().join(", ")}).`;
    hasMixedUnits = true;
  }

  const primaryField = Array.from(fieldSet)[0];
  let metricLabel: string = primaryField;
  if (kindSet.size === 1) {
    metricLabel = Array.from(kindSet)[0];
  } else if (kindSet.size > 1) {
    metricLabel = "mixed";
  }

  let finalUnit = "";
  if (hasMixedUnits) {
    finalUnit = "mixed";
  } else if (unitSet.size === 1) {
    finalUnit = Array.from(unitSet)[0];
  } else {
    finalUnit = "unspecified";
  }

  let validCount = 0;
  let measurementRows = 0;
  let declaredUnits = 0;
  let declaredKinds = 0;

  for (const row of rows) {
    // Count each row's own metric, even when the result cannot be pooled.
    const field = "measure" in row ? "measure" : "area" in row ? "area" : "volume" in row ? "volume" : null;
    if (field === null) continue;
    measurementRows++;
    const value = row[field];
    if (typeof value === "number" && Number.isFinite(value)) validCount++;
    if (typeof row.measure_unit === "string" && row.measure_unit.trim()) declaredUnits++;
    if ((typeof row.measure_kind === "string" && row.measure_kind.trim()) || field === "area" || field === "volume") declaredKinds++;
  }

  if (!incompatibleReason) {
    if (declaredUnits > 0 && declaredUnits < measurementRows) {
      incompatibleReason = "Cannot pool measurements: some records declare units while others are unspecified.";
      hasMixedUnits = true;
      finalUnit = "mixed";
    } else if (declaredKinds > 0 && declaredKinds < measurementRows) {
      incompatibleReason = "Cannot pool measurements: some records declare a measurement kind while others are unspecified.";
      hasMixedKinds = true;
    }
  }

  const excludedCount = totalCount - validCount;
  const exclusionReason = excludedCount > 0 ? "non-finite or missing values" : null;

  if (incompatibleReason) {
    return {
      metric: metricLabel,
      min: null,
      max: null,
      mean: null,
      unit: finalUnit,
      hasMixedUnits,
      hasMixedKinds,
      validCount,
      totalCount,
      incompatibleReason,
      excludedCount,
      exclusionReason,
    };
  }

  if (validCount === 0) {
    return {
      metric: metricLabel,
      min: null,
      max: null,
      mean: null,
      unit: finalUnit,
      hasMixedUnits: false,
      hasMixedKinds: false,
      validCount: 0,
      totalCount,
      incompatibleReason: `All ${totalCount} records excluded: no usable finite numeric values.`,
      excludedCount: totalCount,
      exclusionReason: "non-finite or missing values",
    };
  }

  let min = Infinity;
  let max = -Infinity;

  for (let i = 0; i < totalCount; i++) {
    const row = rows[i];
    const val = row[primaryField];
    if (typeof val === "number" && Number.isFinite(val)) {
      if (val < min) min = val;
      if (val > max) max = val;
    }
  }

  // Normalize before compensated summation: neither repeated large values nor
  // cancellation of signed measurements should corrupt an otherwise finite mean.
  const scale = Math.max(Math.abs(min), Math.abs(max));
  let sum = 0;
  let compensation = 0;
  if (scale > 0) {
    for (const row of rows) {
      const value = row[primaryField];
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      const normalized = value / scale;
      const next = sum + normalized;
      compensation += Math.abs(sum) >= Math.abs(normalized)
        ? (sum - next) + normalized
        : (normalized - next) + sum;
      sum = next;
    }
  }
  const mean = ((sum + compensation) / validCount) * scale;

  let formattedMean: string | null = null;
  let meanIncompatibleReason: string | null = null;
  if (Number.isFinite(mean)) {
    formattedMean = formatStatValue(mean);
  } else {
    meanIncompatibleReason = "Mean calculation exceeded finite numerical bounds.";
  }

  return {
    metric: metricLabel,
    min: formatStatValue(min),
    max: formatStatValue(max),
    mean: formattedMean,
    unit: finalUnit,
    hasMixedUnits: false,
    hasMixedKinds: false,
    validCount,
    totalCount,
    incompatibleReason: meanIncompatibleReason,
    excludedCount,
    exclusionReason,
  };
}

export function Info({
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
  onSelectResult,
  onOpenPopulation,
  scientificExportDraftControl,
  onCompareIntensity,
  section: controlledSection,
  onSectionChange,
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
  onSelectResult?: (result: ResearchResult) => void;
  onOpenPopulation?: () => void;
  scientificExportDraftControl?: ScientificDataExportDraftControl;
  onCompareIntensity?: () => void;
  section?: "review" | "export";
  onSectionChange?: (section: "review" | "export") => void;
}) {
  const [localSection, setLocalSection] = useState<"review" | "export">("review");
  const section = controlledSection ?? localSection;
  const [localExportDraft, setLocalExportDraft] = useState<ScientificDataExportDraft | null>(null);
  const exportDraftControl = scientificExportDraftControl ?? { draft: localExportDraft, onDraftChange: setLocalExportDraft };
  const changeSection = (next: "review" | "export") => { setLocalSection(next); onSectionChange?.(next); };
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
    : result?.review ? reviewLabel(result.review) : "Review required before export";
  const markReviewed = async () => {
    if (!result || busy || reviewPendingRef.current || researcherReviewed(result)) return;
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
  const sourceResults = snapshot.results.filter((item) => item.source_id === source.id);

  return (
    <div className="research-panel">
      <h2>Review & export</h2>
      {!result && onSelectResult && sourceResults.length > 0 && (
        <div className="research-result-recovery-card" role="group" aria-label="Results on this image">
          <h3>Results on this image ({sourceResults.length})</h3>
          <p>Select a saved revision on {source.name} to inspect its measurements, review status, or export:</p>
          <div className="research-result-recovery-list">
            {sourceResults.map((item) => {
              const isSavedSelection = snapshot.selections.some(
                (sel) => sel.id === source.id && sel.data?.result_id === item.id && sel.data?.revision_hash === item.revision_hash,
              );
              return (
                <div key={`${item.id}:${item.revision_hash}`} className="research-result-recovery-row">
                  <div>
                    <strong>{resultTitle(item)}</strong>
                    <small>{item.object_count.toLocaleString()} {item.object_count === 1 ? "object" : "objects"} · {reviewLabel(item.review)}{isSavedSelection ? " · Saved selection" : ""}</small>
                  </div>
                  <button type="button" disabled={busy || reviewPending} onClick={() => onSelectResult(item)}>
                    Select rev {item.revision_hash.slice(0, 8)}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {!result && api.planDataExport && <ScientificDataExportPanel draftControl={exportDraftControl} api={api} snapshot={snapshot} result={null} busy={busy || reviewPending} onSnapshot={onSnapshot} onSelectResult={onSelectResult} onOpenPopulation={onOpenPopulation} />}
      {result ? (
        <>
          <h3 className="research-result-title">{resultTitle(result)}</h3>
          <p className="research-result-source">{source.name}</p>
          <p>{result.object_count?.toLocaleString()} {result.object_count === 1 ? "object" : "objects"} · <span role="status">{reviewStatus}</span></p>
          <div className="research-result-sections" role="group" aria-label="Result sections">
            <button type="button" aria-pressed={section === "review"} onClick={() => changeSection("review")}>Review</button>
            <button type="button" aria-pressed={section === "export"} onClick={() => changeSection("export")}>Export</button>
          </div>
          {section === "review" && <section aria-label="Review result">
            {result.kind === "spatial-distance-bands" && <SpatialSummary value={result.spatial} api={api} result={result} />}
            {result.kind === "perinuclear-enrichment" && <PerinuclearResultSummary api={api} result={result} rows={rows} />}
            {rows.length > 0 && (
              <div className="research-result-summary-card">
                <div className="research-result-summary-header">
                  <h3>Quantitative summary</h3>
                  {onOpenPopulation && (
                    <button type="button" disabled={busy || reviewPending} onClick={onOpenPopulation}>
                      Explore in Statistics &amp; objects
                    </button>
                  )}
                </div>
                {result && result.object_count > rows.length && <p>Summary of the first {rows.length} of {result.object_count} objects. Use Statistics & objects for the full population.</p>}
                <div className="research-stat-grid">
                  <div className="research-stat-item">
                    <span className="research-stat-label">
                      Rows
                    </span>
                    <span className="research-stat-value">
                      {rows.length}
                    </span>
                  </div>
                  {stats && stats.mean !== null && stats.min !== null && stats.max !== null && (
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
                {stats?.incompatibleReason && (
                  <p className="research-stat-notice" role="status">
                    {stats.incompatibleReason}
                  </p>
                )}
                {stats && stats.excludedCount > 0 && (
                  <p className="research-stat-exclusion-note" role="status">
                    {stats.validCount} of {stats.totalCount} rows have finite numeric values; {stats.excludedCount} excluded from statistics ({stats.exclusionReason || "non-finite or missing values"}).
                  </p>
                )}
                <details className="research-preview-rows"><summary>Inspect preview rows ({rows.length})</summary>
                  <ResultTable rows={rows} selected={selectedRow} onSelect={onSelectRow ?? (() => {})} />
                </details>
              </div>
            )}
            {rows.length === 0 && <p>No preview measurements are available for this revision.</p>}
            {rows.length === 0 && onOpenPopulation && <button type="button" disabled={busy || reviewPending} onClick={onOpenPopulation}>Explore in Statistics &amp; objects</button>}

            <div className="research-actions">
            <button
              disabled={busy || reviewPending || researcherReviewed(result)}
              onClick={() => void markReviewed()}
            >
              Mark reviewed
            </button>
            {onCompareIntensity && <button type="button" disabled={busy || reviewPending} onClick={onCompareIntensity}>Compare intensity in Study &amp; batch</button>}
            </div>
            <details className="research-result-details"><summary>Technical identity</summary>
              <dl className="research-label-import-metadata">
                <div><dt>Source</dt><dd>{source.name}</dd></div>
                <div><dt>Result ID</dt><dd>{result.id}</dd></div>
                <div><dt>Revision SHA-256</dt><dd>{result.revision_hash}</dd></div>
              </dl>
            {result.label_import && <details><summary>Imported label details</summary><dl className="research-label-import-metadata" aria-label="Label import identity">
              <div><dt>Label file</dt><dd>{result.label_import.file_name}</dd></div>
              <div><dt>Producer</dt><dd>{result.label_import.producer ? `${result.label_import.producer.name}${result.label_import.producer.version ? ` · ${result.label_import.producer.version}` : " · version unknown"} (declared)` : "Unknown"}</dd></div>
              <div><dt>Import profile</dt><dd>{result.label_import.profile} · {result.label_import.original_dtype} · {result.label_import.shape.join(" × ")} YX</dd></div>
              <div><dt>Input SHA-256</dt><dd>{result.label_import.file_sha256}</dd></div>
              <div><dt>Upstream settings</dt><dd>Unknown</dd></div>
              {result.parent_id && <div><dt>Correction parent</dt><dd>{result.parent_id}</dd></div>}
            </dl></details>}
            </details>
            <ResultContextPanel api={api} result={result} />
            <ResearchReviewHistory api={api} result={result} />
          </section>}
          {section === "export" && <section aria-label="Export result data">
            <h3>Export</h3>
          <button
            disabled={busy || reviewPending || disposition !== "reviewed"}
            onClick={() =>
              void report(
                () => api.exportResult(result.id, result.revision_hash),
                "Could not export result.",
              )
            }
          >
            Export result
          </button>
            {api.planDataExport && <ScientificDataExportPanel draftControl={exportDraftControl} api={api} snapshot={snapshot} result={result} busy={busy || reviewPending} onSnapshot={onSnapshot} onSelectResult={onSelectResult} onOpenPopulation={onOpenPopulation} />}
          </section>}
        </>
      ) : <p>Select a result to review and export its measurements.</p>}
      <details open={!result || undefined}>
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
