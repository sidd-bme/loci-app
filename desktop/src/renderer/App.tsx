import {
  AlertTriangle,
  Ban,
  Check,
  Combine,
  ChevronDown,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  Eraser,
  FileImage,
  FileUp,
  FolderOpen,
  FolderSearch,
  Info,
  Layers3,
  LoaderCircle,
  Maximize2,
  MousePointer2,
  Minus,
  Paintbrush,
  Plus,
  PenTool,
  Redo2,
  RotateCcw,
  Save,
  Scissors,
  Settings2,
  ShieldCheck,
  Trash2,
  Undo2,
  Spline,
  Waypoints,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { isCellposeProfileId } from "../shared/contracts";
import { describeAndRecommendWorkspace } from "../shared/source-routing";
import type {
  CellposeProfileId,
  AnalysisSettings,
  AnalysisResult,
  AnalysisCorrectionReceipt,
  CellposeStatus,
  BatchExportFailure,
  DurableBatchSession,
  EditableInstanceBoundary,
  ImportedImage,
  JobSummary,
  LociDesktopApi,
  ProjectSessionReceipt,
  ProjectSummary,
  QuitProjectSaveRequest,
  RecentProjectSummary,
  ExportOptions,
  SegmentationSettings,
  SegmentationProfile,
  SegmentationSettingDefinition,
  SourceMetadata,
  SourcePoint,
  ViewerDisplaySettings,
  ViewerExportFormat,
} from "../shared/contracts";
import type {
  ProjectManifestV1,
  ProjectReviewDisposition,
  ProjectReviewRecord,
  WorkspaceKind,
  WorkspaceRecommendation,
} from "../shared/foundation-contracts";
import { MODEL_EVIDENCE_REGISTRY } from "../shared/model-registry";
import BrandMark from "./BrandMark";
import ResearchWorkbench from "./ResearchWorkbench";
import JobCenter from "./JobCenter";
import ModelTrustCard from "./ModelTrustCard";
import ReviewContactSheet from "./ReviewContactSheet";
import ReviewInspector, {
  type ReviewFilter,
  type ReviewSort,
  type ReviewSummary,
} from "./ReviewInspector";
import SettingsDialog from "./SettingsDialog";
import UserGuideDialog from "./UserGuideDialog";
import WelcomeWorkspace from "./WelcomeWorkspace";
import WorkspaceRecommendationPanel from "./WorkspaceRecommendationPanel";
import {
  loadPreferences,
  savePreferences,
  type UserPreferences,
} from "./preferences";
import {
  createProjectManifest,
  restoredDisplayRecipes,
  restoredWorkspaceOverrides,
  type ProjectManifestState,
} from "./project-manifest";
import {
  buildReviewItems,
  createReviewDecision,
  type ReviewItem,
} from "./review-state";

const DEFAULT_SETTINGS: SegmentationSettings = {
  image_mode: "auto",
  polarity: "auto",
  expected_diameter_px: 34,
  min_area_px: 80,
  sensitivity: 0,
  smoothing_px: 1.2,
  split_touching: true,
  exclude_border: false,
};

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const SOURCE_PAGE_SIZE = 200;
const MAX_CACHED_SOURCE_PREVIEWS = 12;
const MAX_CORRECTION_POINTS = 1024;
const MAX_BRUSH_RADIUS_PX = 128;

interface Point {
  x: number;
  y: number;
}

interface Notice {
  title: string;
  message: string;
}

interface SourceMenuState {
  sourceId: string;
  x: number;
  y: number;
}

type CorrectionTool =
  | "navigate"
  | "draw"
  | "delete"
  | "split"
  | "merge"
  | "reshape"
  | "paint"
  | "erase"
  | "vertices";
type WorkspaceMode = "view" | "analyze" | "review";

interface VertexEditState extends EditableInstanceBoundary {
  originalVertices: SourcePoint[];
  selectedIndex: number;
  movedIndex: number | null;
}

const CORRECTION_TOOL_GUIDANCE: Record<CorrectionTool, string> = {
  navigate: "Navigate · drag to pan when zoomed",
  draw: "Add boundary · draw a closed outline",
  delete: "Remove boundary · click one instance",
  split: "Split instance · draw a cut through one cell",
  merge: "Merge instances · click two touching cells",
  reshape: "Reshape boundary · select a cell, then draw its replacement",
  paint: "Paint mask · add foreground without crossing into another cell",
  erase: "Erase mask · remove pixels; disconnected pieces become separate instances",
  vertices: "Edit vertices · select a cell, then move one boundary handle",
};

const DEFAULT_VIEWER_DISPLAY_SETTINGS: ViewerDisplaySettings = {
  blackPoint: 0,
  whitePoint: 1,
  brightness: 0,
  contrast: 100,
  gamma: 1,
  saturation: 100,
  red: true,
  green: true,
  blue: true,
};

const HISTOGRAM_WIDTH = 256;
const HISTOGRAM_HEIGHT = 52;

interface RunProgress {
  current: number;
  total: number;
  sourceId: string;
  name: string;
  mode: "single" | "batch";
}

type BatchSourceState = "running" | "complete" | "failed";

interface RangeFieldProps {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  disabled: boolean;
  onChange: (value: number) => void;
}

export function rangeProgress(value: number, minimum: number, maximum: number): string {
  const span = maximum - minimum;
  if (!Number.isFinite(span) || span <= 0) return "0%";
  const percentage = Math.min(100, Math.max(0, ((value - minimum) / span) * 100));
  return `${percentage}%`;
}

function normalizedSettingsEntries(settings: AnalysisSettings): Array<[string, unknown]> {
  return Object.entries(settings).sort(([left], [right]) => left.localeCompare(right));
}

function analysisSettingsMatch(left: AnalysisSettings, right: AnalysisSettings): boolean {
  return JSON.stringify(normalizedSettingsEntries(left)) ===
    JSON.stringify(normalizedSettingsEntries(right));
}

function settingLabel(key: string): string {
  return key
    .replace(/_px$/u, " (px)")
    .replaceAll("_", " ")
    .replace(/^./u, (letter) => letter.toLocaleUpperCase("en-US"));
}

function settingValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "number") return Number.isInteger(value) ? value.toLocaleString() : String(value);
  return String(value);
}

function RangeField({
  id,
  label,
  value,
  min,
  max,
  step,
  suffix = "",
  disabled,
  onChange,
}: RangeFieldProps): React.JSX.Element {
  const progress = rangeProgress(value, min, max);
  const decimals = step < 1 ? 2 : 0;

  return (
    <div className="field">
      <div className="field-label-row">
        <label htmlFor={id}>{label}</label>
        <span className="field-value">
          {value.toFixed(decimals).replace(/\.00$/, "")}
          {suffix}
        </span>
      </div>
      <div className="range-row">
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          style={{ "--range-progress": progress } as CSSProperties}
          onChange={(event) => onChange(Number(event.currentTarget.value))}
        />
        <div className="number-shell">
          <input
            className="number-input"
            type="number"
            min={min}
            max={max}
            step={step}
            value={value}
            disabled={disabled}
            aria-label={`${label} numeric value`}
            onChange={(event) => {
              const parsed = Number(event.currentTarget.value);
              if (Number.isFinite(parsed)) onChange(Math.min(max, Math.max(min, parsed)));
            }}
          />
        </div>
      </div>
    </div>
  );
}

function Toggle({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}): React.JSX.Element {
  return (
    <label className="switch-row">
      <span>{label}</span>
      <span className="switch">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.checked)}
        />
        <span className="switch-track" aria-hidden="true">
          <span className="switch-thumb" />
        </span>
      </span>
    </label>
  );
}

function ContractSettingControl({
  definition,
  value,
  disabled,
  onChange,
}: {
  definition: SegmentationSettingDefinition;
  value: unknown;
  disabled: boolean;
  onChange: (value: string | number | boolean) => void;
}): React.JSX.Element {
  if (definition.valueType === "boolean") {
    return (
      <div className="contract-control" title={definition.help}>
        <Toggle
          label={definition.label}
          checked={Boolean(value)}
          disabled={disabled}
          onChange={onChange}
        />
      </div>
    );
  }
  if (definition.valueType === "choice") {
    return (
      <div className="field contract-control">
        <label className="field-label" htmlFor={`setting-${definition.key}`}>{definition.label}</label>
        <div className="select-shell">
          <select
            id={`setting-${definition.key}`}
            value={String(value)}
            disabled={disabled}
            title={definition.help}
            onChange={(event) => onChange(event.currentTarget.value)}
          >
            {definition.choices.map((choice) => (
              <option value={choice} key={choice}>
                {choice === "auto" ? "Auto" : choice.toUpperCase()}
              </option>
            ))}
          </select>
          <ChevronDown size={13} />
        </div>
        <span className="field-help">{definition.help}</span>
      </div>
    );
  }
  const numericValue = typeof value === "number" ? value : 0;
  return (
    <div className="field contract-control">
      <div className="field-label-row">
        <label htmlFor={`setting-${definition.key}`}>{definition.label}</label>
        <input
          id={`setting-${definition.key}`}
          className="contract-number-input"
          type="number"
          value={numericValue}
          min={definition.minimum ?? undefined}
          max={definition.maximum ?? undefined}
          step={definition.step ?? (definition.valueType === "integer" ? 1 : "any")}
          disabled={disabled}
          onChange={(event) => {
            const parsed = Number(event.currentTarget.value);
            if (!Number.isFinite(parsed)) return;
            const bounded = Math.min(
              definition.maximum ?? Number.POSITIVE_INFINITY,
              Math.max(definition.minimum ?? Number.NEGATIVE_INFINITY, parsed),
            );
            onChange(definition.valueType === "integer" ? Math.round(bounded) : bounded);
          }}
        />
      </div>
      <span className="field-help">{definition.help}</span>
    </div>
  );
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}

function displayLeafName(value: string, fallback: string): string {
  const leaf = value.replaceAll("\\", "/").split("/").filter(Boolean).at(-1)?.trim();
  return leaf || fallback;
}

function formatDimensions(source: ImportedImage): string {
  if (source.width === undefined || source.height === undefined) return "Ready to inspect";
  return `${source.width.toLocaleString()} × ${source.height.toLocaleString()}`;
}

function formatFormat(source: ImportedImage): string {
  if (!source.format) return "";
  const format = source.format.toUpperCase();
  if (source.accessMode === "overview") return `${format} · overview only`;
  return (source.pageCount ?? 1) > 1 ? `${format} · ${source.pageCount} pages` : format;
}

function formatScientificValues(values: readonly number[]): string {
  return values.map((value) => value.toLocaleString(undefined, { maximumSignificantDigits: 5 })).join(" × ");
}

function mergeSources(current: ImportedImage[], incoming: ImportedImage[]): ImportedImage[] {
  const byId = new Map(current.map((source) => [source.sourceId, source]));
  for (const source of incoming) byId.set(source.sourceId, source);
  return [...byId.values()];
}

export function simplifyCorrectionStroke(
  points: SourcePoint[],
  maximumPoints = MAX_CORRECTION_POINTS,
): SourcePoint[] {
  if (points.length <= maximumPoints) return points;
  if (maximumPoints < 3) throw new Error("A correction stroke requires room for three points.");
  const lastIndex = points.length - 1;
  return Array.from({ length: maximumPoints }, (_value, index) =>
    points[Math.round(index * lastIndex / (maximumPoints - 1))]);
}

export function viewerFilterParameters(settings: ViewerDisplaySettings): {
  saturation: number;
  windowSlope: number;
  windowOffset: number;
  exponent: number;
  amplitude: number;
  offset: number;
} {
  const windowSpan = Math.max(0.001, settings.whitePoint - settings.blackPoint);
  const rawWindowOffset = -settings.blackPoint / windowSpan;
  const amplitude = settings.contrast / 100;
  const rawOffset = settings.brightness / 100 + 0.5 * (1 - amplitude);
  return {
    saturation: settings.saturation / 100,
    windowSlope: 1 / windowSpan,
    windowOffset: Math.abs(rawWindowOffset) < Number.EPSILON * 16 ? 0 : rawWindowOffset,
    exponent: 1 / settings.gamma,
    amplitude,
    offset: Math.abs(rawOffset) < Number.EPSILON * 16 ? 0 : rawOffset,
  };
}

export function histogramPath(bins: number[]): string {
  if (!bins.length) return `M 0 ${HISTOGRAM_HEIGHT} L ${HISTOGRAM_WIDTH} ${HISTOGRAM_HEIGHT}`;
  const visibleCounts = bins.map((count) => Math.log1p(Number.isFinite(count) ? Math.max(0, count) : 0));
  const peak = visibleCounts.reduce((current, count) => Math.max(current, count), 1);
  const points = visibleCounts.map((count, index) => {
    const x = bins.length === 1 ? HISTOGRAM_WIDTH / 2 : index * HISTOGRAM_WIDTH / (bins.length - 1);
    const y = HISTOGRAM_HEIGHT - count / peak * (HISTOGRAM_HEIGHT - 3);
    return `${x.toFixed(2)} ${y.toFixed(2)}`;
  });
  return `M 0 ${HISTOGRAM_HEIGHT} L ${points.join(" L ")} L ${HISTOGRAM_WIDTH} ${HISTOGRAM_HEIGHT} Z`;
}

function sourceDisplayValue(
  normalized: number,
  statistics: NonNullable<ImportedImage["displayStatistics"]>,
): number {
  return statistics.displayMinimum + normalized * (statistics.displayMaximum - statistics.displayMinimum);
}

function formatDisplayPoint(
  normalized: number,
  statistics: ImportedImage["displayStatistics"] | undefined,
  unitLabel = "DN",
): string {
  if (!statistics) return `${(normalized * 100).toFixed(1).replace(/\.0$/, "")}%`;
  const value = sourceDisplayValue(normalized, statistics);
  const magnitude = Math.abs(value);
  const decimals = magnitude >= 100 || Number.isInteger(value) ? 0 : magnitude >= 10 ? 1 : 2;
  return `${value.toFixed(decimals)} ${unitLabel}`;
}

function PreviewHistogram({
  bins,
  blackPoint,
  whitePoint,
  basis,
}: {
  bins: number[];
  blackPoint: number;
  whitePoint: number;
  basis: "luminance" | "intensity";
}): React.JSX.Element {
  return (
    <figure className="viewer-histogram">
      <div className="viewer-histogram-plot">
        <svg
          viewBox={`0 0 ${HISTOGRAM_WIDTH} ${HISTOGRAM_HEIGHT}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`Log-scaled preview ${basis} histogram`}
        >
          <path d={histogramPath(bins)} />
        </svg>
        <span
          className="histogram-window-region"
          style={{ left: `${blackPoint * 100}%`, right: `${(1 - whitePoint) * 100}%` }}
          aria-hidden="true"
        />
        <span className="histogram-marker is-black" style={{ left: `${blackPoint * 100}%` }} aria-hidden="true" />
        <span className="histogram-marker is-white" style={{ left: `${whitePoint * 100}%` }} aria-hidden="true" />
      </div>
      <figcaption>
        <span>0</span>
        <span>Preview {basis}</span>
        <span>100%</span>
      </figcaption>
    </figure>
  );
}

export default function App(): React.JSX.Element {
  const [researchOpen, setResearchOpen] = useState(true);
  const api: LociDesktopApi | undefined = typeof window === "undefined" ? undefined : window.loci;
  const [sources, setSources] = useState<ImportedImage[]>([]);
  const [activeSourceId, setActiveSourceId] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, AnalysisResult>>({});
  const [settings, setSettings] = useState<AnalysisSettings>(DEFAULT_SETTINGS);
  const [profiles, setProfiles] = useState<SegmentationProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState("loci-classical");
  const [openModelSections, setOpenModelSections] = useState(
    () => new Set(["Input", "Mask filtering", "Dynamics"]),
  );
  const [preferences, setPreferences] = useState<UserPreferences>(() => loadPreferences());
  const [manualOpen, setManualOpen] = useState(false);
  useEffect(() => {
    const help = (event: KeyboardEvent) => { if (event.key === "F1") { event.preventDefault(); setManualOpen(true); setSettingsOpen(false); } };
    window.addEventListener("keydown", help);
    return () => window.removeEventListener("keydown", help);
  }, []);
  const [projectSummary, setProjectSummary] = useState<ProjectSummary | null>(null);
  const [projectSessionGeneration, setProjectSessionGeneration] = useState(0);
  const [recentProjects, setRecentProjects] = useState<RecentProjectSummary[]>([]);
  const [isProjectBusy, setIsProjectBusy] = useState(false);
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [recoverableBatches, setRecoverableBatches] = useState<DurableBatchSession[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sourceMenu, setSourceMenu] = useState<SourceMenuState | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isApplyingCorrection, setIsApplyingCorrection] = useState(false);
  const [isDiscardingResult, setIsDiscardingResult] = useState(false);
  const [isRemovingSource, setIsRemovingSource] = useState(false);
  const [isImportingModel, setIsImportingModel] = useState(false);
  const [cellposeStatus, setCellposeStatus] = useState<CellposeStatus | null>(null);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("view");
  const [reviews, setReviews] = useState<ProjectReviewRecord[]>([]);
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>("all");
  const [reviewSort, setReviewSort] = useState<ReviewSort>("source");
  const [workspaceOverrideBySourceId, setWorkspaceOverrideBySourceId] = useState<
    Record<string, WorkspaceKind>
  >({});
  const [persistedWorkspaceBySourceId, setPersistedWorkspaceBySourceId] = useState<
    Record<string, WorkspaceRecommendation>
  >({});
  const [displayBySourceId, setDisplayBySourceId] = useState<Record<string, ViewerDisplaySettings>>({});
  const [viewerExportFormat, setViewerExportFormat] = useState<ViewerExportFormat>("tiff");
  const [showOriginalPreview, setShowOriginalPreview] = useState(false);
  const [correctionTool, setCorrectionTool] = useState<CorrectionTool>("navigate");
  const [correctionTarget, setCorrectionTarget] = useState<SourcePoint | null>(null);
  const [drawPoints, setDrawPoints] = useState<SourcePoint[]>([]);
  const [brushRadiusPx, setBrushRadiusPx] = useState(8);
  const [vertexEdit, setVertexEdit] = useState<VertexEditState | null>(null);
  const [isLoadingBoundary, setIsLoadingBoundary] = useState(false);
  const [runProgress, setRunProgress] = useState<RunProgress | null>(null);
  const batchSourceStates = useRef(new Map<string, BatchSourceState>());
  const [, setBatchStateVersion] = useState(0);
  const [visibleSourceCount, setVisibleSourceCount] = useState(SOURCE_PAGE_SIZE);
  const [inspectingSourceIds, setInspectingSourceIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [overlayVisible, setOverlayVisible] = useState(true);
  const [overlayOpacity, setOverlayOpacity] = useState(0.72);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const dragDepth = useRef(0);
  const panOrigin = useRef<{ pointer: Point; pan: Point } | null>(null);
  const drawingPointer = useRef<number | null>(null);
  const vertexPointer = useRef<number | null>(null);
  const drawPointsRef = useRef<SourcePoint[]>([]);
  const correctionTargetRef = useRef<SourcePoint | null>(null);
  const imageElementRef = useRef<HTMLImageElement>(null);
  const inspectionInFlight = useRef(new Set<string>());
  const failedInspections = useRef(new Set<string>());
  const restorationInFlight = useRef(new Set<string>());
  const failedRestorations = useRef(new Set<string>());
  const [settledRestorationKeys, setSettledRestorationKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const previewSourceLru = useRef<string[]>([]);
  const cancelRequested = useRef(false);
  const sourceMenuRef = useRef<HTMLDivElement>(null);
  const projectManifestRef = useRef<ProjectManifestV1 | null>(null);
  const skipNextProjectAutosave = useRef(false);
  const lastSavedProjectSignature = useRef<string | null>(null);
  const failedAutosaveSignature = useRef<string | null>(null);
  const projectStateSignatureRef = useRef("");
  const projectSaveInFlight = useRef<Promise<boolean> | null>(null);
  const cancelledQuitSaveRequests = useRef(new Set<string>());
  const projectSaveStateRef = useRef<ProjectManifestState>({
    sources: [],
    displayBySourceId: {},
    workspaceOverrideBySourceId: {},
    reviews: [],
    defaultDisplay: DEFAULT_VIEWER_DISPLAY_SETTINGS,
  });

  const sourcesById = useMemo(
    () => new Map(sources.map((source) => [source.sourceId, source])),
    [sources],
  );
  const activeSource = activeSourceId ? sourcesById.get(activeSourceId) ?? null : null;
  const activeResult = activeSource ? results[activeSource.sourceId] : undefined;
  const activeSourceHasResult = activeSourceId ? Boolean(results[activeSourceId]) : false;
  const activeProjectDeclaresResult = Boolean(
    activeSourceId &&
    projectManifestRef.current?.modelResults.some(({ sourceId }) => sourceId === activeSourceId),
  );
  const activeRestorationKey = projectSummary?.projectId && activeSourceId
    ? `${projectSummary.projectId}:${activeSourceId}`
    : null;
  const isRestoringActiveResult = Boolean(
    activeRestorationKey &&
    activeProjectDeclaresResult &&
    !activeSourceHasResult &&
    !failedRestorations.current.has(activeSourceId!) &&
    !settledRestorationKeys.has(activeRestorationKey) &&
    !isRunning,
  );
  const viewerDisplay = activeSource
    ? displayBySourceId[activeSource.sourceId] ?? DEFAULT_VIEWER_DISPLAY_SETTINGS
    : DEFAULT_VIEWER_DISPLAY_SETTINGS;
  const viewerFilter = viewerFilterParameters(viewerDisplay);
  const displayStatistics = activeSource?.displayStatistics;
  const sourceHasRgbComponents = activeSource?.colorModel === "interleaved-rgb" ||
    (activeSource?.colorModel === undefined && (activeSource?.channels ?? 0) >= 3);
  const sourceIsSingleIntensityPlane = activeSource?.colorModel === "intensity" ||
    (activeSource?.colorModel === undefined && (activeSource?.channels ?? 0) === 1);
  const displayStatisticsUseCompositeUnits = activeSource?.colorModel === "channel-composite";
  const displayStatisticsUnit = displayStatisticsUseCompositeUnits ? "display units" : "DN";
  const overviewOnly = activeSource?.accessMode === "overview";
  const imsDetails = activeSource?.sourceDetails?.kind === "ims-volume"
    ? activeSource.sourceDetails
    : undefined;
  const tiffDetails = activeSource?.sourceDetails?.kind === "tiff-pyramid"
    ? activeSource.sourceDetails
    : undefined;
  const activeWorkspaceRecommendation = useMemo(() => {
    const persisted = activeSource
      ? persistedWorkspaceBySourceId[activeSource.sourceId]
      : undefined;
    const override = activeSource
      ? workspaceOverrideBySourceId[activeSource.sourceId]
      : undefined;
    if (persisted && !override) return persisted;
    if (
      !activeSource ||
      !Number.isSafeInteger(activeSource.width) ||
      !Number.isSafeInteger(activeSource.height) ||
      !Number.isSafeInteger(activeSource.channels) ||
      !Number.isSafeInteger(activeSource.pageCount) ||
      !activeSource.dtype ||
      !activeSource.format
    ) {
      if (!activeSource) return null;
      return persisted && override
        ? {
          ...persisted,
          workspace: override,
          decision: "user-override" as const,
          userOverride: override,
        }
        : persisted ?? null;
    }
    return describeAndRecommendWorkspace(activeSource as SourceMetadata, {
      userOverride: workspaceOverrideBySourceId[activeSource.sourceId] ?? null,
    }).recommendation;
  }, [activeSource, persistedWorkspaceBySourceId, workspaceOverrideBySourceId]);
  const selectedProfile = profiles.find((profile) => profile.id === selectedProfileId);
  const selectedModelManifest = selectedProfile
    ? MODEL_EVIDENCE_REGISTRY.getModel(selectedProfile.id)
    : undefined;
  const resultConfigurationMatchesControls = Boolean(
    activeResult &&
    activeResult.profile.id === selectedProfileId &&
    analysisSettingsMatch(activeResult.settings, settings),
  );
  const savedResultSettings = activeResult
    ? normalizedSettingsEntries(activeResult.settings)
    : [];
  const selectedCellposeProfileId: CellposeProfileId | null =
    isCellposeProfileId(selectedProfileId) ? selectedProfileId : null;
  const isCellposeProfile = selectedProfile?.backendKind === "cellpose" &&
    selectedCellposeProfileId !== null;
  const classicalSettings = settings as SegmentationSettings;
  const settingsBySection = useMemo(() => {
    const groups = new Map<string, SegmentationSettingDefinition[]>();
    for (const definition of selectedProfile?.settingsContract ?? []) {
      const existing = groups.get(definition.section) ?? [];
      existing.push(definition);
      groups.set(definition.section, existing);
    }
    return [...groups.entries()];
  }, [selectedProfile]);
  const profilesLoaded = profiles.length > 0 && Boolean(selectedProfile);
  const selectedProfileReady = Boolean(selectedProfile && selectedProfile.status === "ready");
  const isWorkspaceBusy =
    isImporting ||
    isRunning ||
    isExporting ||
    isApplyingCorrection ||
    isLoadingBoundary ||
    isImportingModel ||
    isDiscardingResult ||
    isRestoringActiveResult ||
    isRemovingSource ||
    inspectingSourceIds.size > 0 ||
    isProjectBusy;
  const isWorkspaceOrProjectBusy = isWorkspaceBusy;
  const controlsDisabled = !activeSource || overviewOnly || isWorkspaceBusy || !selectedProfileReady;
  const viewerControlsDisabled = !activeSource || isWorkspaceBusy;
  const viewerExportDisabled = viewerControlsDisabled || overviewOnly;
  const isDesktopAvailable = Boolean(api);
  const displayedSources = sources.slice(0, visibleSourceCount);
  const sourceMenuSource = sourceMenu ? sourcesById.get(sourceMenu.sourceId) ?? null : null;
  const reviewItems = useMemo(
    () => buildReviewItems(sources, results, reviews),
    [results, reviews, sources],
  );
  const reviewSummary = useMemo<ReviewSummary>(() => ({
    total: reviewItems.length,
    processed: reviewItems.filter(({ result }) => Boolean(result)).length,
    unreviewed: reviewItems.filter(({ result, reviewStatus }) =>
      Boolean(result) && reviewStatus === "unreviewed").length,
    flagged: reviewItems.filter(({ result, countOutlier }) =>
      Boolean(result) && (countOutlier || result!.quality.status !== "nominal")).length,
    reviewed: reviewItems.filter(({ reviewStatus }) => reviewStatus === "reviewed").length,
    excluded: reviewItems.filter(({ reviewStatus }) => reviewStatus === "excluded").length,
  }), [reviewItems]);
  const visibleReviewItems = useMemo(() => {
    const filtered = reviewItems.filter((item) => {
      if (reviewFilter === "all") return true;
      if (reviewFilter === "unreviewed") return Boolean(item.result) && item.reviewStatus === "unreviewed";
      if (reviewFilter === "reviewed") return item.reviewStatus === "reviewed";
      if (reviewFilter === "excluded") return item.reviewStatus === "excluded";
      return Boolean(item.result) && (item.countOutlier || item.result!.quality.status !== "nominal");
    });
    const sourceOrder = new Map(sources.map((source, index) => [source.sourceId, index]));
    return [...filtered].sort((left, right) => {
      if (reviewSort === "flagged") {
        const leftFlagged = Number(Boolean(left.result) && (left.countOutlier || left.result!.quality.status !== "nominal"));
        const rightFlagged = Number(Boolean(right.result) && (right.countOutlier || right.result!.quality.status !== "nominal"));
        if (leftFlagged !== rightFlagged) return rightFlagged - leftFlagged;
      }
      if (reviewSort === "count-ascending" || reviewSort === "count-descending") {
        const leftCount = left.result?.metrics.count ?? Number.POSITIVE_INFINITY;
        const rightCount = right.result?.metrics.count ?? Number.POSITIVE_INFINITY;
        if (leftCount !== rightCount) {
          return reviewSort === "count-ascending" ? leftCount - rightCount : rightCount - leftCount;
        }
      }
      return (sourceOrder.get(left.source.sourceId) ?? 0) - (sourceOrder.get(right.source.sourceId) ?? 0);
    });
  }, [reviewFilter, reviewItems, reviewSort, sources]);
  const activeReviewItem = activeSourceId
    ? reviewItems.find(({ source }) => source.sourceId === activeSourceId) ?? null
    : null;
  const exportOptions = useMemo<ExportOptions>(() => ({
    overlayPng: preferences.export.overlay,
    labelsTiff: preferences.export.labels,
    measurementsCsv: preferences.export.instanceMeasurements,
    summaryCsv: preferences.export.summary,
    analysisJson: preferences.export.analysis,
  }), [preferences.export]);
  const projectStateSignature = useMemo(() => JSON.stringify({
    sources: sources.map((source) => ({
      sourceId: source.sourceId,
      name: source.name,
      relativePath: source.relativePath,
      width: source.width ?? null,
      height: source.height ?? null,
      channels: source.channels ?? null,
      dtype: source.dtype ?? null,
      format: source.format ?? null,
      pageCount: source.pageCount ?? null,
      colorModel: source.colorModel ?? null,
      accessMode: source.accessMode ?? null,
      sourceDetails: source.sourceDetails ?? null,
    })),
    displayBySourceId,
    workspaceOverrideBySourceId,
    results: Object.fromEntries(Object.entries(results).map(([sourceId, result]) => [sourceId, {
      resultId: result.resultId,
      correctionRevision: result.corrections.revision,
    }])),
    reviews,
  }), [displayBySourceId, results, reviews, sources, workspaceOverrideBySourceId]);
  projectStateSignatureRef.current = projectStateSignature;
  projectSaveStateRef.current = {
    sources,
    displayBySourceId,
    workspaceOverrideBySourceId,
    reviews,
    defaultDisplay: DEFAULT_VIEWER_DISPLAY_SETTINGS,
  };

  const updateBatchSourceState = useCallback((sourceId: string, state: BatchSourceState) => {
    batchSourceStates.current.set(sourceId, state);
    setBatchStateVersion((current) => current + 1);
  }, []);

  const updateViewerDisplay = useCallback(
    <Key extends keyof ViewerDisplaySettings>(key: Key, value: ViewerDisplaySettings[Key]) => {
      if (!activeSource) return;
      setShowOriginalPreview(false);
      setDisplayBySourceId((current) => ({
        ...current,
        [activeSource.sourceId]: {
          ...(current[activeSource.sourceId] ?? DEFAULT_VIEWER_DISPLAY_SETTINGS),
          [key]: value,
        },
      }));
    },
    [activeSource],
  );

  const updateViewerDisplayRecipe = useCallback(
    (updates: Partial<ViewerDisplaySettings>) => {
      if (!activeSource) return;
      setShowOriginalPreview(false);
      setDisplayBySourceId((current) => ({
        ...current,
        [activeSource.sourceId]: {
          ...(current[activeSource.sourceId] ?? DEFAULT_VIEWER_DISPLAY_SETTINGS),
          ...updates,
        },
      }));
    },
    [activeSource],
  );

  const resetViewerDisplay = useCallback(() => {
    if (!activeSource) return;
    setShowOriginalPreview(false);
    setDisplayBySourceId((current) => ({
      ...current,
      [activeSource.sourceId]: { ...DEFAULT_VIEWER_DISPLAY_SETTINGS },
    }));
  }, [activeSource]);

  const autoViewerDisplayWindow = useCallback(() => {
    if (!displayStatistics) return;
    const blackPoint = Math.max(0, Math.min(0.999, displayStatistics.percentileLow));
    const whitePoint = Math.max(blackPoint + 0.001, Math.min(1, displayStatistics.percentileHigh));
    updateViewerDisplayRecipe({ blackPoint, whitePoint });
  }, [displayStatistics, updateViewerDisplayRecipe]);

  const invalidateResultsForConfigurationChange = useCallback(async (): Promise<boolean> => {
    const staleResults = Object.entries(results);
    if (!api) {
      if (!staleResults.length) return true;
      setError("Loci could not durably clear the current result.");
      return false;
    }
    setIsDiscardingResult(true);
    setError(null);
    try {
      const retired = await api.discardAllResults();
      for (const { sourceId } of retired.discarded) {
        failedRestorations.current.add(sourceId);
      }
      for (const [sourceId] of staleResults) failedRestorations.current.add(sourceId);
      if (batchSourceStates.current.size) {
        batchSourceStates.current.clear();
        setBatchStateVersion((current) => current + 1);
      }
      setResults({});
      setCorrectionTool("navigate");
      setDrawPoints([]);
      setOverlayVisible(true);
      if (staleResults.length) {
        setNotice({
          title: staleResults.length === 1 ? "Result cleared" : "Results cleared",
          message: "The model or analysis settings changed. Run segmentation to create matching results.",
        });
      }
      return true;
    } catch (caught) {
      setError(errorMessage(
        caught,
        "Loci could not save the result change. The previous result and settings remain active.",
      ));
      return false;
    } finally {
      setIsDiscardingResult(false);
    }
  }, [api, results]);

  const updateSettings = useCallback(
    <Key extends keyof SegmentationSettings>(key: Key, value: SegmentationSettings[Key]) => {
      if ((settings as SegmentationSettings)[key] === value) return;
      void (async () => {
        if (!await invalidateResultsForConfigurationChange()) return;
        setSettings((current) => ({ ...current, [key]: value }) as AnalysisSettings);
      })();
    },
    [invalidateResultsForConfigurationChange, settings],
  );

  const updateContractSetting = useCallback((key: string, value: string | number | boolean) => {
    if ((settings as unknown as Record<string, unknown>)[key] === value) return;
    void (async () => {
      if (!await invalidateResultsForConfigurationChange()) return;
      setSettings((current) => ({ ...current, [key]: value }) as AnalysisSettings);
    })();
  }, [invalidateResultsForConfigurationChange, settings]);

  const acceptImported = useCallback((imported: ImportedImage[]) => {
    if (!imported.length) return;
    const importedIds = new Set(imported.map((source) => source.sourceId));
    for (const sourceId of importedIds) failedInspections.current.delete(sourceId);
    setResults((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([sourceId]) => !importedIds.has(sourceId)),
      ),
    );
    setDisplayBySourceId((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([sourceId]) => !importedIds.has(sourceId)),
      ),
    );
    setReviews((current) => current.filter(({ sourceId }) => !importedIds.has(sourceId)));
    setSources((current) => mergeSources(current, imported));
    setVisibleSourceCount((current) => Math.max(current, Math.min(imported.length, SOURCE_PAGE_SIZE)));
    setActiveSourceId(imported[0].sourceId);
    setWorkspaceMode("view");
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setOverlayVisible(true);
    setCorrectionTool("navigate");
    setDrawPoints([]);
  }, []);

  const revealSource = useCallback(async (sourceId: string) => {
    if (!api) return;
    setSourceMenu(null);
    try {
      await api.revealSource(sourceId);
    } catch (caught) {
      setError(errorMessage(caught, "Loci could not reveal this source image."));
    }
  }, [api]);

  const clearSourceResult = useCallback(async (sourceId: string) => {
    if (!api || isWorkspaceBusy) return;
    const result = results[sourceId];
    setSourceMenu(null);
    if (!result) return;
    setIsDiscardingResult(true);
    try {
      await api.discardResult(sourceId, result.resultId);
      failedRestorations.current.add(sourceId);
      if (batchSourceStates.current.delete(sourceId)) {
        setBatchStateVersion((current) => current + 1);
      }
      setResults((current) => {
        const next = { ...current };
        delete next[sourceId];
        return next;
      });
      setNotice({ title: "Result cleared", message: "The imported source image remains unchanged." });
    } catch (caught) {
      setError(errorMessage(caught, "Loci could not clear this result."));
    } finally {
      setIsDiscardingResult(false);
    }
  }, [api, isWorkspaceBusy, results]);

  const removeSource = useCallback(async (sourceId: string) => {
    if (!api || isWorkspaceBusy) return;
    const index = sources.findIndex((source) => source.sourceId === sourceId);
    const removed = index >= 0 ? sources[index] : undefined;
    setSourceMenu(null);
    if (!removed) return;
    setIsRemovingSource(true);
    try {
      await api.removeSource(sourceId);
      const remaining = sources.filter((source) => source.sourceId !== sourceId);
      setSources(remaining);
      if (remaining.length === 0) {
        setWorkspaceMode("view");
      }
      setResults((current) => {
        const next = { ...current };
        delete next[sourceId];
        return next;
      });
      setDisplayBySourceId((current) => {
        const next = { ...current };
        delete next[sourceId];
        return next;
      });
      setReviews((current) => current.filter((review) => review.sourceId !== sourceId));
      batchSourceStates.current.delete(sourceId);
      inspectionInFlight.current.delete(sourceId);
      failedInspections.current.delete(sourceId);
      previewSourceLru.current = previewSourceLru.current.filter((candidate) => candidate !== sourceId);
      setInspectingSourceIds((current) => {
        const next = new Set(current);
        next.delete(sourceId);
        return next;
      });
      if (activeSourceId === sourceId) {
        const replacement = remaining[Math.min(index, Math.max(0, remaining.length - 1))];
        setActiveSourceId(replacement?.sourceId ?? null);
        setZoom(1);
        setPan({ x: 0, y: 0 });
        setCorrectionTool("navigate");
        setDrawPoints([]);
      }
      setNotice({
        title: "Removed from Loci",
        message: `${removed.name} was removed from this session. The source file was not deleted.`,
      });
    } catch (caught) {
      setError(errorMessage(caught, "Loci could not remove this image from the session."));
    } finally {
      setIsRemovingSource(false);
    }
  }, [activeSourceId, api, isWorkspaceBusy, sources]);

  const hydrateSource = useCallback(async (sourceId: string) => {
    if (!api || inspectionInFlight.current.has(sourceId) || failedInspections.current.has(sourceId)) return;
    inspectionInFlight.current.add(sourceId);
    setInspectingSourceIds((current) => new Set(current).add(sourceId));
    try {
      const inspected = await api.inspectSource(sourceId);
      const retainedPreviewIds = [
        sourceId,
        ...previewSourceLru.current.filter((candidate) => candidate !== sourceId),
      ].slice(0, MAX_CACHED_SOURCE_PREVIEWS);
      previewSourceLru.current = retainedPreviewIds;
      const retained = new Set(retainedPreviewIds);
      setSources((current) => current.map((source) => {
        if (source.sourceId === sourceId) {
          return { ...source, ...inspected, restoredDescriptor: undefined };
        }
        if (source.previewDataUrl && !retained.has(source.sourceId)) {
          return { ...source, previewDataUrl: undefined };
        }
        return source;
      }));
    } catch (caught) {
      failedInspections.current.add(sourceId);
      setError(errorMessage(caught, "Loci could not inspect this image."));
    } finally {
      inspectionInFlight.current.delete(sourceId);
      setInspectingSourceIds((current) => {
        const next = new Set(current);
        next.delete(sourceId);
        return next;
      });
    }
  }, [api]);

  const importImages = useCallback(async () => {
    if (isWorkspaceBusy) return;
    if (!api) {
      setError("The secure desktop bridge is unavailable. Restart Loci and try again.");
      return;
    }
    setIsImporting(true);
    setError(null);
    try {
      const imported = await api.pickImages();
      if (!imported.length) return;
      acceptImported(imported);
    } catch (caught) {
      setError(errorMessage(caught, "Loci could not import the selected images."));
    } finally {
      setIsImporting(false);
    }
  }, [acceptImported, api, isWorkspaceBusy]);

  const importFolder = useCallback(async () => {
    if (isWorkspaceBusy) return;
    if (!api) {
      setError("The secure desktop bridge is unavailable. Restart Loci and try again.");
      return;
    }
    setIsImporting(true);
    setError(null);
    try {
      const imported = await api.pickFolder();
      if (!imported.length) return;
      acceptImported(imported);
      setNotice({
        title: "Folder imported",
        message: `${imported.length.toLocaleString()} images are ready for review or batch processing.`,
      });
    } catch (caught) {
      setError(errorMessage(caught, "Loci could not import the selected folder."));
    } finally {
      setIsImporting(false);
    }
  }, [acceptImported, api, isWorkspaceBusy]);

  const refreshRecentProjects = useCallback(async () => {
    if (!api) return;
    try {
      setRecentProjects(await api.listRecentProjects());
    } catch (caught) {
      setError(errorMessage(caught, "Loci could not read recent projects."));
    }
  }, [api]);

  const applyOpenedProject = useCallback((receipt: ProjectSessionReceipt) => {
    setProjectSessionGeneration((current) => current + 1);
    projectManifestRef.current = structuredClone(receipt.manifest);
    skipNextProjectAutosave.current = true;
    lastSavedProjectSignature.current = null;
    failedAutosaveSignature.current = null;
    setProjectSummary(receipt.summary);
    if (receipt.recentProjects) setRecentProjects(receipt.recentProjects);
    setSources(receipt.sources);
    setActiveSourceId(receipt.sources[0]?.sourceId ?? null);
    setResults({});
    setReviews(receipt.manifest.reviews);
    setDisplayBySourceId(restoredDisplayRecipes(receipt.manifest));
    setWorkspaceOverrideBySourceId(restoredWorkspaceOverrides(receipt.manifest));
    setPersistedWorkspaceBySourceId(Object.fromEntries(
      receipt.manifest.sources.flatMap((source) =>
        source.inspectionStatus === "ready"
          ? [[source.sourceId, source.workspace] as const]
          : []),
    ));
    setVisibleSourceCount(SOURCE_PAGE_SIZE);
    setWorkspaceMode("view");
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setOverlayVisible(true);
    setCorrectionTool("navigate");
    setDrawPoints([]);
    batchSourceStates.current.clear();
    inspectionInFlight.current.clear();
    failedInspections.current.clear();
    restorationInFlight.current.clear();
    failedRestorations.current.clear();
    setSettledRestorationKeys(new Set());
    previewSourceLru.current = [];
  }, []);

  const saveCurrentProject = useCallback((
    quiet = false,
    allowDuringWorkspaceActivity = false,
    quitRequestId?: string,
  ): Promise<boolean> => {
    if (projectSaveInFlight.current) return projectSaveInFlight.current;
    const currentState = projectSaveStateRef.current;
    if (
      !api ||
      (!currentState.sources.length && !projectManifestRef.current) ||
      (!allowDuringWorkspaceActivity && isWorkspaceOrProjectBusy)
    ) return Promise.resolve(false);

    const operation = (async () => {
      const previous = projectManifestRef.current;
      const now = new Date().toISOString();
      const identity = previous
        ? {
          projectId: previous.projectId,
          title: previous.title,
          createdAt: previous.createdAt,
        }
        : {
          projectId: globalThis.crypto.randomUUID(),
          title: "Untitled Loci project",
          createdAt: now,
        };
      const manifest = createProjectManifest(identity, currentState, {
        appVersion: previous?.appVersion ?? "0.1.0",
        now,
        previous,
      });
      const signatureForManifest = projectStateSignatureRef.current;
      setIsProjectBusy(true);
      if (!quiet) {
        failedAutosaveSignature.current = null;
        setError(null);
      }
      try {
        const receipt = previous
          ? await api.saveProject(manifest, quitRequestId)
          : await api.createProject(manifest);
        if (!receipt) return false;
        projectManifestRef.current = structuredClone(receipt.manifest);
        lastSavedProjectSignature.current = signatureForManifest;
        failedAutosaveSignature.current = null;
        setProjectSummary(receipt.summary);
        if (receipt.recentProjects) setRecentProjects(receipt.recentProjects);
        if (!quiet) setNotice({
          title: previous ? "Project saved" : "Project created",
          message: `${receipt.summary.title} now preserves this source set, display recipe, and workspace routing.`,
        });
        return true;
      } catch (caught) {
        if (quiet) failedAutosaveSignature.current = signatureForManifest;
        setError(errorMessage(caught, quiet
          ? "Loci could not autosave this project. Use File → Save Project to retry."
          : "Loci could not save this project."));
        return false;
      } finally {
        setIsProjectBusy(false);
      }
    })();
    const tracked = operation.finally(() => {
      if (projectSaveInFlight.current === tracked) projectSaveInFlight.current = null;
    });
    projectSaveInFlight.current = tracked;
    return tracked;
  }, [api, isWorkspaceOrProjectBusy]);

  const flushDirtyProject = useCallback(async (
    allowDuringWorkspaceActivity = false,
    quitRequestId?: string,
  ) => {
    if (!projectManifestRef.current) return true;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (quitRequestId && cancelledQuitSaveRequests.current.has(quitRequestId)) return false;
      if (projectStateSignatureRef.current === lastSavedProjectSignature.current) return true;
      if (!await saveCurrentProject(true, allowDuringWorkspaceActivity, quitRequestId)) return false;
    }
    if (quitRequestId && cancelledQuitSaveRequests.current.has(quitRequestId)) return false;
    return projectStateSignatureRef.current === lastSavedProjectSignature.current;
  }, [saveCurrentProject]);

  const prepareForProjectOpen = useCallback(async () => {
    if (await flushDirtyProject()) return true;
    if (!api) return false;
    try {
      const discard = await api.confirmDiscardUnsavedProject();
      if (discard) setError(null);
      return discard;
    } catch (caught) {
      setError(errorMessage(caught, "Loci could not confirm how to handle unsaved project changes."));
      return false;
    }
  }, [api, flushDirtyProject]);

  const openProjectFile = useCallback(async () => {
    if (!api || isWorkspaceOrProjectBusy) return;
    if (!await prepareForProjectOpen()) return;
    setIsProjectBusy(true);
    setError(null);
    try {
      const receipt = await api.openProject();
      if (!receipt) return;
      applyOpenedProject(receipt);
      if (!receipt.recentProjects) await refreshRecentProjects();
      setNotice({
        title: "Project opened",
        message: `${receipt.summary.sourceCount.toLocaleString()} source${receipt.summary.sourceCount === 1 ? "" : "s"} restored. Display and workspace choices are ready.`,
      });
    } catch (caught) {
      setError(errorMessage(caught, "Loci could not open that project."));
    } finally {
      setIsProjectBusy(false);
    }
  }, [api, applyOpenedProject, isWorkspaceOrProjectBusy, prepareForProjectOpen, refreshRecentProjects]);

  const openRecentProjectFile = useCallback(async (recentId: string) => {
    if (!api || isWorkspaceOrProjectBusy) return;
    if (!await prepareForProjectOpen()) return;
    setIsProjectBusy(true);
    setError(null);
    try {
      const receipt = await api.openRecentProject(recentId);
      applyOpenedProject(receipt);
      if (!receipt.recentProjects) await refreshRecentProjects();
      setNotice({
        title: "Project opened",
        message: `${receipt.summary.title} is ready. Source images remain unchanged.`,
      });
    } catch (caught) {
      setError(errorMessage(caught, "Loci could not open that recent project."));
      await refreshRecentProjects();
    } finally {
      setIsProjectBusy(false);
    }
  }, [api, applyOpenedProject, isWorkspaceOrProjectBusy, prepareForProjectOpen, refreshRecentProjects]);

  useEffect(() => {
    if (!api) return undefined;
    let cancelled = false;
    void api.listProfiles().then(
      (availableProfiles) => {
        if (cancelled || !availableProfiles.length) return;
        setProfiles(availableProfiles);
        const websiteCompatible = availableProfiles.find(
          (profile) => profile.id === "cellpose-sam",
        );
        const preferred = websiteCompatible?.status === "ready"
          ? websiteCompatible
          : availableProfiles.find(
              (profile) => profile.id === "loci-classical" && profile.status === "ready",
            ) ?? websiteCompatible ?? availableProfiles[0];
        setSelectedProfileId(preferred.id);
        setSettings(structuredClone(preferred.recommendedSettings));
      },
      (caught) => {
        if (!cancelled) setError(errorMessage(caught, "Loci could not read its model registry."));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    if (!api || !isCellposeProfile) {
      setCellposeStatus(null);
      return undefined;
    }
    let cancelled = false;
    setCellposeStatus(null);
    void api.getCellposeStatus(selectedCellposeProfileId).then(
      (status) => {
        if (!cancelled) setCellposeStatus(status);
      },
      (caught) => {
        if (!cancelled) setError(errorMessage(caught, "Loci could not inspect the Cellpose runtime."));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, isCellposeProfile, selectedCellposeProfileId]);

  const importCellposeModel = useCallback(async () => {
    if (!api || isWorkspaceBusy || !selectedCellposeProfileId) return;
    setIsImportingModel(true);
    setError(null);
    try {
      const status = await api.importCellposeModel(selectedCellposeProfileId);
      if (!status) return;
      setCellposeStatus(status);
      const refreshed = await api.listProfiles();
      setProfiles(refreshed);
      const cellpose = refreshed.find((profile) => profile.id === selectedCellposeProfileId);
      if (cellpose) {
        setSettings(structuredClone(cellpose.recommendedSettings));
      }
      setNotice({
        title: status.model.verified ? "Checkpoint verified" : "Checkpoint not ready",
        message: status.ready
          ? `${cellpose?.name ?? "Cellpose"} is ready for local processing.`
          : status.summary,
      });
    } catch (caught) {
      setError(errorMessage(caught, "Loci could not verify and import that Cellpose checkpoint."));
    } finally {
      setIsImportingModel(false);
    }
  }, [api, isWorkspaceBusy, selectedCellposeProfileId]);

  const openCellposeModelFolder = useCallback(async () => {
    if (!api || !selectedCellposeProfileId) return;
    setError(null);
    try {
      const location = await api.openCellposeModelFolder(selectedCellposeProfileId);
      setNotice({
        title: "Download folder ready",
        message: `Save or move ${location.artifactId} into ${location.displayPath}, then choose Import checkpoint. After verification, this staging copy can be deleted.`,
      });
    } catch (caught) {
      setError(errorMessage(caught, "Loci could not open its model import folder."));
    }
  }, [api, selectedCellposeProfileId]);

  useEffect(() => {
    if (activeSource && !activeSource.previewDataUrl && !isRunning) {
      void hydrateSource(activeSource.sourceId);
    }
  }, [activeSource, hydrateSource, isRunning]);

  useEffect(() => {
    if (
      !api ||
      !projectSummary?.projectId ||
      !activeSourceId ||
      !activeProjectDeclaresResult ||
      activeSourceHasResult ||
      isRunning ||
      restorationInFlight.current.has(activeSourceId) ||
      failedRestorations.current.has(activeSourceId)
    ) return undefined;
    const sourceId = activeSourceId;
    const restorationKey = `${projectSummary.projectId}:${sourceId}`;
    let cancelled = false;
    setSettledRestorationKeys((current) => {
      if (!current.has(restorationKey)) return current;
      const next = new Set(current);
      next.delete(restorationKey);
      return next;
    });
    restorationInFlight.current.add(sourceId);
    void api.restoreProjectResult(sourceId).then(
      (result) => {
        if (cancelled) return;
        if (!result) {
          failedRestorations.current.add(sourceId);
          return;
        }
        setResults((current) => ({ ...current, [sourceId]: result }));
        setSources((current) => current.map((source) =>
          source.sourceId === sourceId ? { ...source, ...result.source } : source));
      },
      (caught) => {
        if (cancelled) return;
        failedRestorations.current.add(sourceId);
        setError(errorMessage(caught, "Loci could not restore this saved analysis result."));
      },
    ).finally(() => {
      restorationInFlight.current.delete(sourceId);
      setSettledRestorationKeys((current) => {
        if (current.has(restorationKey)) return current;
        const next = new Set(current);
        next.add(restorationKey);
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [activeProjectDeclaresResult, activeSourceHasResult, activeSourceId, api, isRunning, projectSessionGeneration, projectSummary?.projectId]);

  useEffect(() => {
    setShowOriginalPreview(false);
  }, [activeSourceId, workspaceMode]);

  useEffect(() => {
    correctionTargetRef.current = null;
    setCorrectionTarget(null);
    drawPointsRef.current = [];
    setDrawPoints([]);
  }, [activeSourceId, activeResult?.resultId, correctionTool]);

  useEffect(() => {
    if (overviewOnly && workspaceMode === "analyze") setWorkspaceMode("view");
  }, [overviewOnly, workspaceMode]);

  const runSegmentation = useCallback(async () => {
    if (!api || !activeSource || overviewOnly || isWorkspaceBusy || !selectedProfileReady) return;
    setIsRunning(true);
    cancelRequested.current = false;
    setRunProgress({ current: 1, total: 1, sourceId: activeSource.sourceId, name: activeSource.name, mode: "single" });
    setError(null);
    setNotice(null);
    try {
      const result = await api.segment({
        sourceId: activeSource.sourceId,
        settings,
        profileId: selectedProfileId,
      });
      failedRestorations.current.delete(activeSource.sourceId);
      setResults((current) => {
        return { ...current, [activeSource.sourceId]: result };
      });
      setSources((current) => current.map((source) =>
        source.sourceId === activeSource.sourceId ? { ...source, ...result.source } : source));
      setOverlayVisible(true);
      setCorrectionTool("navigate");
      setDrawPoints([]);
    } catch (caught) {
      const message = errorMessage(caught, "Segmentation did not complete.");
      if (!/cancel/i.test(message)) setError(message);
    } finally {
      setIsRunning(false);
      setIsCancelling(false);
      setRunProgress(null);
    }
  }, [activeSource, api, isWorkspaceBusy, overviewOnly, selectedProfileId, selectedProfileReady, settings]);

  const cancelSegmentation = useCallback(async () => {
    if (!api || !isRunning || isCancelling) return;
    setIsCancelling(true);
    cancelRequested.current = true;
    try {
      const cancellation = await api.cancelAnalysis();
      if (cancellation.cancelled) {
        setNotice({
          title: "Analysis stopped",
          message: "Previously verified results remain available and will be restored when needed.",
        });
      } else {
        // A completion can win the cancellation race, or the main process may
        // have no matching active job. Keep the control usable rather than
        // displaying an indefinite "Cancelling…" state.
        setIsCancelling(false);
      }
    } catch (caught) {
      setError(errorMessage(caught, "The running analysis could not be cancelled."));
      setIsCancelling(false);
    }
  }, [api, isCancelling, isRunning]);

  const exportActiveResult = useCallback(async () => {
    if (!api || !activeSource || !activeResult || isWorkspaceBusy) return;
    setIsExporting(true);
    setError(null);
    try {
      const receipt = await api.exportResult(
        activeSource.sourceId,
        activeResult.resultId,
        exportOptions,
      );
      if (receipt) setNotice({
        title: "Export complete",
        message: `${Object.values(exportOptions).filter(Boolean).length.toLocaleString()} selected artifact${Object.values(exportOptions).filter(Boolean).length === 1 ? "" : "s"} saved in ${displayLeafName(receipt.directory, "the selected folder")}.`,
      });
    } catch (caught) {
      setError(errorMessage(caught, "Loci could not export this analysis."));
    } finally {
      setIsExporting(false);
    }
  }, [activeResult, activeSource, api, exportOptions, isWorkspaceBusy]);

  const exportActiveView = useCallback(async () => {
    if (!api || !activeSource || overviewOnly || isWorkspaceBusy) return;
    setIsExporting(true);
    setError(null);
    try {
      const receipt = await api.exportView(activeSource.sourceId, {
        format: viewerExportFormat,
        settings: viewerDisplay,
      });
      if (receipt) {
        setNotice({
          title: "View exported",
          message: `${receipt.format === "tiff" ? "16-bit TIFF" : "PNG"} saved as ${displayLeafName(receipt.path, "the selected file")}.`,
        });
      }
    } catch (caught) {
      setError(errorMessage(caught, "Loci could not export this rendered view."));
    } finally {
      setIsExporting(false);
    }
  }, [activeSource, api, isWorkspaceBusy, overviewOnly, viewerDisplay, viewerExportFormat]);

  const executeDurableBatch = useCallback(async (
    durableSession: DurableBatchSession,
    sourceSnapshot: ImportedImage[],
  ) => {
    if (!api) return;
    const sourceById = new Map(sourceSnapshot.map((source) => [source.sourceId, source] as const));
    const pendingItems = durableSession.items.filter((item) => item.state === "pending");
    let durableFinalized = false;
    try {
      for (let index = 0; index < pendingItems.length; index += 1) {
        if (cancelRequested.current) break;
        const item = pendingItems[index];
        const source = sourceById.get(item.sourceId);
        if (!source) throw new Error("A source required by this durable batch is not open.");
        setActiveSourceId(source.sourceId);
        setZoom(1);
        setPan({ x: 0, y: 0 });
        setRunProgress({
          current: index + 1,
          total: pendingItems.length,
          sourceId: source.sourceId,
          name: source.name,
          mode: "batch",
        });
        updateBatchSourceState(source.sourceId, "running");

        let attemptBegan = false;
        let durableCompleted = false;
        try {
          await api.beginBatchRunItem(durableSession.batchId, source.sourceId);
          attemptBegan = true;
          const result = await api.segment({
            sourceId: source.sourceId,
            settings: durableSession.settings,
            profileId: durableSession.profileId,
          });
          if (cancelRequested.current) break;
          await api.completeBatchRunItem(
            durableSession.batchId,
            source.sourceId,
            result.resultId,
          );
          durableCompleted = true;
          failedRestorations.current.delete(source.sourceId);
          setSources((current) => current.map((candidate) =>
            candidate.sourceId === source.sourceId ? { ...candidate, ...result.source } : candidate));
          setResults((current) => ({ ...current, [source.sourceId]: result }));
          updateBatchSourceState(source.sourceId, "complete");
        } catch (caught) {
          const message = errorMessage(caught, "This image could not be processed.");
          if (cancelRequested.current || /cancel/i.test(message)) break;
          if (attemptBegan && !durableCompleted) {
            await api.failBatchRunItem(durableSession.batchId, source.sourceId, message);
          }
          updateBatchSourceState(source.sourceId, "failed");
        }
      }

      const durableReceipt = await api.finishBatchRun(
        durableSession.batchId,
        cancelRequested.current,
      );
      durableFinalized = true;
      setRecoverableBatches((current) => durableReceipt.state === "needs-attention"
        ? [...current.filter((batch) => batch.batchId !== durableReceipt.batchId), durableReceipt]
        : current.filter((batch) => batch.batchId !== durableReceipt.batchId));
      const title = durableReceipt.state === "cancelled"
        ? "Batch stopped"
        : durableReceipt.state === "needs-attention"
          ? "Batch needs attention"
          : "Batch ready for review";
      setNotice({
        title,
        message: durableReceipt.state === "needs-attention"
          ? `${durableReceipt.completed.toLocaleString()} results are ready; ${durableReceipt.retryable.toLocaleString()} need retry or review. No files were exported.`
          : durableReceipt.state === "cancelled"
            ? "Processing stopped. No batch export was started."
            : `${durableReceipt.completed.toLocaleString()} results are ready. Review boundaries and exclusions, then choose Export batch.`,
      });
      if (durableReceipt.state !== "cancelled" && durableReceipt.completed > 0) {
        setReviewFilter("all");
        setWorkspaceMode("review");
      }
    } finally {
      if (!durableFinalized) {
        await api.finishBatchRun(durableSession.batchId, true).catch(() => undefined);
      }
      setIsRunning(false);
      setIsCancelling(false);
      setRunProgress(null);
    }
  }, [api, updateBatchSourceState]);

  const inspectBatchSources = useCallback(async (sourceSnapshot: ImportedImage[]) => {
    if (!api) return sourceSnapshot;
    const inspected: ImportedImage[] = [];
    for (let index = 0; index < sourceSnapshot.length; index += 1) {
      if (cancelRequested.current) break;
      const source = sourceSnapshot[index];
      setRunProgress({
        current: index + 1,
        total: sourceSnapshot.length,
        sourceId: source.sourceId,
        name: source.name,
        mode: "batch",
      });
      const ready = await api.inspectSource(source.sourceId);
      inspected.push({ ...source, ...ready });
    }
    if (inspected.length !== sourceSnapshot.length) {
      throw new Error("Batch preparation was cancelled before every source was fingerprinted.");
    }
    const inspectedById = new Map(inspected.map((source) => [source.sourceId, source] as const));
    const nextSources = sourceSnapshot.map((source) => inspectedById.get(source.sourceId) ?? source);
    // The batch continues in this callback before React necessarily commits
    // the state update. Keep the save snapshot in lockstep so the forced
    // post-inspection checkpoint includes every newly inspected descriptor;
    // main enriches it with the verified fingerprints held by source grants.
    projectSaveStateRef.current = {
      ...projectSaveStateRef.current,
      sources: nextSources,
    };
    setSources((current) => current.map((source) => {
      const ready = inspected.find((candidate) => candidate.sourceId === source.sourceId);
      return ready ?? source;
    }));
    return nextSources;
  }, [api]);

  const runBatchSegmentation = useCallback(async () => {
    if (!api || sources.length < 2 || isWorkspaceBusy || !selectedProfileReady) return;
    if (!projectSummary || !projectManifestRef.current) {
      setError(
        "Save this complete source set as a Loci project before starting a batch so every result can be recovered after restart.",
      );
      return;
    }
    setError(null);
    setNotice(null);
    try {
      // Folder imports can make an existing project dirty just before its
      // autosave timer fires. Explicitly checkpoint the exact current source
      // set here; main-process project/source ordering safely queues this
      // behind an autosave that has already begun.
      const checkpointed = await flushDirtyProject();
      if (!checkpointed) {
        setError((current) => current ??
          "Loci could not checkpoint this complete source set. No batch was started.");
        return;
      }
      const savedSourceIds = new Set(
        projectManifestRef.current?.sources.map(({ sourceId }) => sourceId) ?? [],
      );
      if (
        projectManifestRef.current?.projectId !== projectSummary.projectId ||
        savedSourceIds.size !== sources.length ||
        sources.some(({ sourceId }) => !savedSourceIds.has(sourceId))
      ) {
        setError("Loci could not verify the saved source checkpoint. No batch was started.");
        return;
      }
      batchSourceStates.current.clear();
      setBatchStateVersion((current) => current + 1);
      setResults({});
      setIsRunning(true);
      cancelRequested.current = false;
      const sourceSnapshot = await inspectBatchSources([...sources]);
      // Inspection verifies fingerprints in main-process source grants. Force
      // a second project checkpoint so the durable project owns those exact
      // identities before the immutable batch plan is created.
      if (!await saveCurrentProject(true, true)) {
        throw new Error(
          "Loci could not checkpoint the verified source fingerprints. No batch was started.",
        );
      }
      const durableSession = await api.createBatchRun({
        sourceIds: sourceSnapshot.map((source) => source.sourceId),
        settings,
        profileId: selectedProfileId,
      });
      await executeDurableBatch(durableSession, sourceSnapshot);
    } catch (caught) {
      const message = errorMessage(caught, "Loci could not complete the batch.");
      if (!/cancel/i.test(message)) setError(message);
      setIsRunning(false);
      setIsCancelling(false);
      setRunProgress(null);
    }
  }, [api, executeDurableBatch, flushDirtyProject, inspectBatchSources, isWorkspaceBusy, projectSummary, saveCurrentProject, selectedProfileId, selectedProfileReady, settings, sources]);

  const retryDurableBatch = useCallback(async (parentJobId: string) => {
    if (!api || isWorkspaceBusy) throw new Error("Wait for the current workspace operation to finish.");
    const recoverable = recoverableBatches.find((batch) => batch.parentJobId === parentJobId);
    if (!recoverable) throw new Error("This job is not a recoverable batch.");
    setIsRunning(true);
    setError(null);
    setNotice(null);
    cancelRequested.current = false;
    try {
      const requiredIds = new Set(recoverable.items.map((item) => item.sourceId));
      const sourceSnapshot = sources.filter((source) => requiredIds.has(source.sourceId));
      if (sourceSnapshot.length !== requiredIds.size) {
        throw new Error("Reopen the original Loci project before retrying this batch.");
      }
      const inspected = await inspectBatchSources(sourceSnapshot);
      const resumed = await api.resumeBatchRun(recoverable.batchId);
      if (resumed.state === "completed") {
        for (const item of resumed.items) {
          if (item.state === "completed") updateBatchSourceState(item.sourceId, "complete");
        }
        setRecoverableBatches((current) =>
          current.filter((batch) => batch.batchId !== resumed.batchId));
        setNotice({
          title: "Batch ready for review",
          message: `${resumed.completed.toLocaleString()} results are durably saved. Review boundaries and exclusions, then choose Export batch.`,
        });
        if (resumed.completed > 0) {
          setReviewFilter("all");
          setWorkspaceMode("review");
        }
        setIsRunning(false);
        setIsCancelling(false);
        setRunProgress(null);
        return;
      }
      await executeDurableBatch(resumed, inspected);
    } catch (caught) {
      const message = errorMessage(caught, "Loci could not retry this batch.");
      setError(message);
      setIsRunning(false);
      setIsCancelling(false);
      setRunProgress(null);
      throw caught;
    }
  }, [api, executeDurableBatch, inspectBatchSources, isWorkspaceBusy, recoverableBatches, sources, updateBatchSourceState]);

  const exportReviewedBatch = useCallback(async () => {
    if (!api || isWorkspaceBusy) return;
    const processed = reviewItems.filter((item) => Boolean(item.result));
    const excluded = processed.filter((item) => item.reviewStatus === "excluded");
    const exportable = processed.flatMap((item) =>
      item.result && item.reviewStatus !== "excluded"
        ? [{
          sourceId: item.source.sourceId,
          resultId: item.result.resultId,
          correctionRevision: item.result.corrections.revision,
          reviewStatus: item.reviewStatus,
        }]
        : []);
    if (!exportable.length) {
      setError("There are no current results available for batch export. Review exclusions or process images first.");
      return;
    }
    const reviewedCount = exportable.filter(({ reviewStatus }) => reviewStatus === "reviewed").length;
    const unreviewedCount = exportable.length - reviewedCount;
    const failures: BatchExportFailure[] = [];
    let session: Awaited<ReturnType<LociDesktopApi["beginBatchExport"]>> = null;
    let finalized = false;
    setIsExporting(true);
    setError(null);
    try {
      session = await api.beginBatchExport(exportOptions);
      if (!session) return;
      for (const item of exportable) {
        try {
          await api.exportBatchResult(session.batchId, item.sourceId, item.resultId);
        } catch (caught) {
          failures.push({
            sourceId: item.sourceId,
            message: errorMessage(caught, "This current result could not be exported."),
          });
        }
      }
      const receipt = await api.finishBatchExport(session.batchId, failures, false);
      finalized = true;
      setNotice({
        title: receipt.failedCount > 0 ? "Batch export completed with issues" : "Batch export complete",
        message:
          `${receipt.exportedCount.toLocaleString()} exported: ${reviewedCount.toLocaleString()} reviewed and ` +
          `${unreviewedCount.toLocaleString()} unreviewed included; ${excluded.length.toLocaleString()} excluded. ` +
          (unreviewedCount > 0
            ? "Research use: review boundaries before using any count."
            : "The export reflects the current reviewed result revisions."),
      });
    } catch (caught) {
      setError(errorMessage(caught, "Loci could not export the reviewed batch."));
    } finally {
      if (session && !finalized) {
        await api.finishBatchExport(session.batchId, failures, true).catch(() => undefined);
      }
      setIsExporting(false);
    }
  }, [api, exportOptions, isWorkspaceBusy, reviewItems]);

  const resetView = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const adjustZoom = useCallback((nextZoom: number) => {
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom));
    setZoom(clamped);
    if (clamped === 1) setPan({ x: 0, y: 0 });
  }, []);

  const mergeCorrectionReceipt = useCallback((
    sourceId: string,
    receipt: AnalysisCorrectionReceipt,
  ) => {
    setResults((current) => {
      const existing = current[sourceId];
      if (!existing || existing.resultId !== receipt.resultId) return current;
      return {
        ...current,
        [sourceId]: {
          ...existing,
          metrics: receipt.metrics,
          quality: receipt.quality,
          measurements: receipt.measurements,
          corrections: receipt.corrections,
          overlayDataUrl: receipt.overlayDataUrl,
        },
      };
    });
    setOverlayVisible(true);
  }, []);

  const runCorrection = useCallback(async (
    action: () => Promise<AnalysisCorrectionReceipt>,
    successMessage: string,
  ) => {
    if (!activeSource || !activeResult || isWorkspaceBusy) return false;
    setIsApplyingCorrection(true);
    setError(null);
    try {
      const receipt = await action();
      mergeCorrectionReceipt(activeSource.sourceId, receipt);
      setNotice({ title: "Boundary updated", message: successMessage });
      return true;
    } catch (caught) {
      setError(errorMessage(caught, "Loci could not apply that boundary correction."));
      return false;
    } finally {
      setIsApplyingCorrection(false);
    }
  }, [activeResult, activeSource, isWorkspaceBusy, mergeCorrectionReceipt]);

  const deleteInstanceAt = useCallback((point: SourcePoint) => {
    if (!api || !activeSource || !activeResult) return;
    void runCorrection(
      () => api.deleteInstance(activeSource.sourceId, activeResult.resultId, {
        x: Math.floor(point.x),
        y: Math.floor(point.y),
      }),
      "The selected instance was removed. Undo remains available.",
    );
  }, [activeResult, activeSource, api, runCorrection]);

  const addDrawnPolygon = useCallback((points: SourcePoint[]) => {
    if (!api || !activeSource || !activeResult || points.length < 3) return;
    const simplified = simplifyCorrectionStroke(points);
    void runCorrection(
      () => api.addPolygon(activeSource.sourceId, activeResult.resultId, simplified),
      "The drawn boundary was added as one cell. Undo remains available.",
    );
  }, [activeResult, activeSource, api, runCorrection]);

  const splitDrawnInstance = useCallback((target: SourcePoint, points: SourcePoint[]) => {
    if (!api || !activeSource || !activeResult || points.length < 2) return;
    const simplified = simplifyCorrectionStroke(points);
    void runCorrection(
      () => api.splitInstance(
        activeSource.sourceId,
        activeResult.resultId,
        { x: Math.floor(target.x), y: Math.floor(target.y) },
        simplified,
      ),
      "The selected cell was split into two reviewed boundaries. Undo remains available.",
    );
  }, [activeResult, activeSource, api, runCorrection]);

  const mergeSelectedInstances = useCallback((first: SourcePoint, second: SourcePoint) => {
    if (!api || !activeSource || !activeResult) return;
    void runCorrection(
      () => api.mergeInstances(
        activeSource.sourceId,
        activeResult.resultId,
        { x: Math.floor(first.x), y: Math.floor(first.y) },
        { x: Math.floor(second.x), y: Math.floor(second.y) },
      ),
      "The two touching instances were merged. Undo remains available.",
    );
  }, [activeResult, activeSource, api, runCorrection]);

  const replaceDrawnBoundary = useCallback((target: SourcePoint, points: SourcePoint[]) => {
    if (!api || !activeSource || !activeResult || points.length < 3) return;
    const simplified = simplifyCorrectionStroke(points);
    void runCorrection(
      () => api.replaceInstanceBoundary(
        activeSource.sourceId,
        activeResult.resultId,
        { x: Math.floor(target.x), y: Math.floor(target.y) },
        simplified,
      ),
      "The selected cell boundary was replaced. Undo remains available.",
    );
  }, [activeResult, activeSource, api, runCorrection]);

  const applyBrushStroke = useCallback((points: SourcePoint[], erase: boolean) => {
    if (!api || !activeSource || !activeResult || points.length < 1) return;
    const simplified = simplifyCorrectionStroke(points);
    void runCorrection(
      () => erase
        ? api.eraseMask(activeSource.sourceId, activeResult.resultId, simplified, brushRadiusPx)
        : api.paintMask(activeSource.sourceId, activeResult.resultId, simplified, brushRadiusPx),
      erase
        ? "The stroked mask pixels were removed; any disconnected pieces were relabelled deterministically."
        : "Foreground was painted into one instance, or created as a new instance on empty background.",
    );
  }, [activeResult, activeSource, api, brushRadiusPx, runCorrection]);

  const loadEditableBoundary = useCallback(async (target: SourcePoint) => {
    if (!api || !activeSource || !activeResult || isWorkspaceBusy) return;
    const selected = { x: Math.floor(target.x), y: Math.floor(target.y) };
    setIsLoadingBoundary(true);
    setError(null);
    try {
      const boundary = await api.getInstanceBoundary(
        activeSource.sourceId,
        activeResult.resultId,
        selected,
      );
      if (boundary.resultId !== activeResult.resultId) {
        throw new Error("The editable boundary no longer matches the active result.");
      }
      setVertexEdit({
        ...boundary,
        originalVertices: boundary.vertices.map((point) => ({ ...point })),
        selectedIndex: 0,
        movedIndex: null,
      });
      setCorrectionTarget(boundary.sourceCoordinate);
    } catch (caught) {
      setError(errorMessage(caught, "Select a point inside one segmented instance."));
    } finally {
      setIsLoadingBoundary(false);
    }
  }, [activeResult, activeSource, api, isWorkspaceBusy]);

  const cancelVertexEdit = useCallback(() => {
    vertexPointer.current = null;
    setVertexEdit(null);
    correctionTargetRef.current = null;
    setCorrectionTarget(null);
  }, []);

  const commitVertexEdit = useCallback(async () => {
    if (!api || !activeSource || !activeResult || !vertexEdit || vertexEdit.movedIndex === null) return;
    const committed = await runCorrection(
      () => api.moveBoundaryVertex(
        activeSource.sourceId,
        activeResult.resultId,
        vertexEdit.sourceCoordinate,
        vertexEdit.vertices,
      ),
      "One boundary vertex was moved and the revised instance was saved. Undo remains available.",
    );
    if (committed) cancelVertexEdit();
  }, [activeResult, activeSource, api, cancelVertexEdit, runCorrection, vertexEdit]);

  const nudgeSelectedVertex = useCallback((deltaX: number, deltaY: number) => {
    if (!activeResult) return;
    setVertexEdit((current) => {
      if (!current) return current;
      const next = current.vertices.map((point) => ({ ...point }));
      const selected = next[current.selectedIndex];
      next[current.selectedIndex] = {
        x: Math.min(activeResult.source.width - 1, Math.max(0, selected.x + deltaX)),
        y: Math.min(activeResult.source.height - 1, Math.max(0, selected.y + deltaY)),
      };
      const original = current.originalVertices[current.selectedIndex];
      const moved = next[current.selectedIndex];
      return {
        ...current,
        vertices: next,
        movedIndex: moved.x === original.x && moved.y === original.y
          ? null
          : current.selectedIndex,
      };
    });
  }, [activeResult]);

  const undoCorrection = useCallback(() => {
    if (!api || !activeSource || !activeResult || !activeResult.corrections.canUndo) return;
    void runCorrection(
      () => api.undoCorrection(activeSource.sourceId, activeResult.resultId),
      "The last manual correction was undone.",
    );
  }, [activeResult, activeSource, api, runCorrection]);

  const redoCorrection = useCallback(() => {
    if (!api || !activeSource || !activeResult || !activeResult.corrections.canRedo) return;
    void runCorrection(
      () => api.redoCorrection(activeSource.sourceId, activeResult.resultId),
      "The manual correction was restored.",
    );
  }, [activeResult, activeSource, api, runCorrection]);

  const pointFromClient = useCallback((clientX: number, clientY: number): SourcePoint | null => {
    const image = imageElementRef.current;
    if (!image || !activeResult) return null;
    const rect = image.getBoundingClientRect();
    if (
      rect.width <= 0 ||
      rect.height <= 0 ||
      clientX < rect.left ||
      clientX > rect.right ||
      clientY < rect.top ||
      clientY > rect.bottom
    ) return null;
    return {
      x: Math.min(
        activeResult.source.width - 1,
        Math.max(0, (clientX - rect.left) / rect.width * activeResult.source.width),
      ),
      y: Math.min(
        activeResult.source.height - 1,
        Math.max(0, (clientY - rect.top) / rect.height * activeResult.source.height),
      ),
    };
  }, [activeResult]);

  useEffect(() => {
    drawPointsRef.current = drawPoints;
  }, [drawPoints]);

  useEffect(() => {
    correctionTargetRef.current = correctionTarget;
  }, [correctionTarget]);

  useEffect(() => {
    drawingPointer.current = null;
    vertexPointer.current = null;
    drawPointsRef.current = [];
    correctionTargetRef.current = null;
    setDrawPoints([]);
    setCorrectionTarget(null);
    setVertexEdit(null);
  }, [activeResult?.corrections.revision, activeResult?.resultId, activeSourceId]);

  useEffect(() => {
    drawingPointer.current = null;
    vertexPointer.current = null;
    drawPointsRef.current = [];
    correctionTargetRef.current = null;
    setDrawPoints([]);
    setCorrectionTarget(null);
    setVertexEdit(null);
  }, [correctionTool]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = window.setTimeout(() => setNotice(null), 6_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    document.documentElement.dataset.theme = preferences.theme;
    document.documentElement.dataset.textSize = preferences.textSize;
    document.documentElement.dataset.font = preferences.font ?? "system";
    document.documentElement.dataset.motion = preferences.motion;
    savePreferences(preferences);
  }, [preferences]);

  useEffect(() => {
    api?.updateSessionState({
      sourceCount: sources.length,
      resultCount: Object.keys(results).length,
      isRunning,
      projectDirty: Boolean(projectManifestRef.current) &&
        !skipNextProjectAutosave.current &&
        projectStateSignature !== lastSavedProjectSignature.current,
    });
  }, [api, isRunning, projectStateSignature, projectSummary, results, sources.length]);

  useEffect(() => {
    if (!api) return undefined;
    void api.getWindowPresentation().then((state) => setIsFullscreen(state.fullscreen));
    return api.onWindowPresentationChanged((state) => setIsFullscreen(state.fullscreen));
  }, [api]);

  useEffect(() => {
    if (!api) return undefined;
    let cancelled = false;
    void api.listRecoverableBatchRuns().then(
      (batches) => {
        if (!cancelled) setRecoverableBatches(batches);
      },
      (caught) => {
        if (!cancelled) setError(errorMessage(caught, "Loci could not read recoverable batch queues."));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, projectSummary?.projectId]);

  useEffect(() => {
    if (!api) return undefined;
    return api.onImportRequested(() => void importImages());
  }, [api, importImages]);

  useEffect(() => {
    if (!api) return undefined;
    return api.onFolderImportRequested(() => void importFolder());
  }, [api, importFolder]);

  useEffect(() => {
    void refreshRecentProjects();
  }, [refreshRecentProjects]);

  useEffect(() => {
    if (!api) return undefined;
    let cancelled = false;
    void api.listJobs().then(
      (availableJobs) => {
        if (!cancelled) setJobs(availableJobs);
      },
      (caught) => {
        if (!cancelled) setError(errorMessage(caught, "Loci could not read background jobs."));
      },
    );
    const unsubscribe = api.onJobsChanged((availableJobs) => setJobs(availableJobs));
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [api]);

  useEffect(() => {
    if (!api) return undefined;
    return api.onOpenProjectRequested(() => void openProjectFile());
  }, [api, openProjectFile]);

  useEffect(() => {
    if (!api) return undefined;
    return api.onSaveProjectRequested(() => void saveCurrentProject());
  }, [api, saveCurrentProject]);

  useEffect(() => {
    if (!api) return undefined;
    return api.onQuitProjectSaveRequested(async (request: QuitProjectSaveRequest) => {
      try {
        return await flushDirtyProject(true, request.requestId);
      } finally {
        cancelledQuitSaveRequests.current.delete(request.requestId);
      }
    });
  }, [api, flushDirtyProject]);

  useEffect(() => {
    if (!api) return undefined;
    return api.onQuitProjectSaveCancelled((request) => {
      cancelledQuitSaveRequests.current.add(request.requestId);
    });
  }, [api]);

  useEffect(() => {
    if (!projectManifestRef.current) return undefined;
    if (skipNextProjectAutosave.current) {
      skipNextProjectAutosave.current = false;
      lastSavedProjectSignature.current = projectStateSignature;
      return undefined;
    }
    if (
      projectStateSignature === lastSavedProjectSignature.current ||
      projectStateSignature === failedAutosaveSignature.current ||
      isWorkspaceOrProjectBusy
    ) return undefined;
    const timer = window.setTimeout(() => void saveCurrentProject(true), 1_200);
    return () => window.clearTimeout(timer);
  }, [isWorkspaceOrProjectBusy, projectStateSignature, saveCurrentProject]);

  useEffect(() => {
    if (!api) return undefined;
    return api.onSettingsRequested(() => setSettingsOpen(true));
  }, [api]);

  useEffect(() => {
    if (!api) return undefined;
    return api.onEngineInvalidated(() => {
      failedRestorations.current.clear();
      restorationInFlight.current.clear();
      setNotice({
        title: "Analysis engine restarted",
        message: "Verified results remain available and will be restored from their exact working copies when needed.",
      });
    });
  }, [api, projectSummary]);

  useEffect(() => {
    if (!sourceMenu) return undefined;
    const frame = window.requestAnimationFrame(() => {
      sourceMenuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    });
    const closeOnPointer = (event: globalThis.PointerEvent) => {
      if (!(event.target instanceof Node) || !sourceMenuRef.current?.contains(event.target)) {
        setSourceMenu(null);
      }
    };
    const closeOnResize = () => setSourceMenu(null);
    window.addEventListener("pointerdown", closeOnPointer);
    window.addEventListener("resize", closeOnResize);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("pointerdown", closeOnPointer);
      window.removeEventListener("resize", closeOnResize);
    };
  }, [sourceMenu]);

  useEffect(() => {
    if (isWorkspaceBusy) setSourceMenu(null);
  }, [isWorkspaceBusy]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (settingsOpen || manualOpen || (researchOpen && window.lociResearch)) return;
      const target = event.target;
      const isTyping = target instanceof Element && target.matches("input, select, textarea, [contenteditable='true']");
      if ((event.metaKey || event.ctrlKey) && event.key === ",") {
        event.preventDefault();
        setSettingsOpen(true);
      } else if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "o") {
        event.preventDefault();
        void importFolder();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "o") {
        event.preventDefault();
        void importImages();
      } else if (
        workspaceMode === "analyze" &&
        (event.metaKey || event.ctrlKey) &&
        event.key === "Enter" &&
        !isTyping
      ) {
        event.preventDefault();
        void runSegmentation();
      } else if (workspaceMode === "analyze" && (event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "z" && !isTyping) {
        event.preventDefault();
        redoCorrection();
      } else if (workspaceMode === "analyze" && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z" && !isTyping) {
        event.preventDefault();
        undoCorrection();
      } else if (
        workspaceMode === "analyze" &&
        correctionTool === "vertices" &&
        vertexEdit &&
        !isTyping &&
        ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
      ) {
        event.preventDefault();
        const step = event.shiftKey ? 5 : 1;
        nudgeSelectedVertex(
          event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0,
          event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0,
        );
      } else if (
        workspaceMode === "analyze" &&
        correctionTool === "vertices" &&
        vertexEdit &&
        vertexEdit.movedIndex !== null &&
        event.key === "Enter" &&
        !isTyping
      ) {
        event.preventDefault();
        void commitVertexEdit();
      } else if (
        workspaceMode === "analyze" &&
        (correctionTool === "paint" || correctionTool === "erase") &&
        !isTyping &&
        (event.key === "[" || event.key === "]")
      ) {
        event.preventDefault();
        setBrushRadiusPx((current) => Math.min(
          MAX_BRUSH_RADIUS_PX,
          Math.max(1, current + (event.key === "]" ? 1 : -1)),
        ));
      } else if (workspaceMode === "analyze" && !isTyping && !event.metaKey && !event.ctrlKey && ["v", "a", "d", "s", "m", "r", "b", "e", "p"].includes(event.key.toLowerCase())) {
        event.preventDefault();
        const shortcutTools: Record<string, CorrectionTool> = {
          v: "navigate",
          a: "draw",
          d: "delete",
          s: "split",
          m: "merge",
          r: "reshape",
          b: "paint",
          e: "erase",
          p: "vertices",
        };
        setCorrectionTool(shortcutTools[event.key.toLowerCase()]);
      } else if (event.key === "Escape" && vertexEdit) {
        event.preventDefault();
        cancelVertexEdit();
      } else if (event.key === "Escape" && (drawPoints.length > 0 || correctionTarget)) {
        event.preventDefault();
        drawingPointer.current = null;
        correctionTargetRef.current = null;
        setCorrectionTarget(null);
        setDrawPoints([]);
      } else if (event.key === "Escape" && sourceMenu) {
        event.preventDefault();
        setSourceMenu(null);
      } else if (event.key === "Escape" && isRunning) {
        event.preventDefault();
        void cancelSegmentation();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cancelSegmentation, cancelVertexEdit, commitVertexEdit, correctionTarget, correctionTool, drawPoints.length, importFolder, importImages, isRunning, nudgeSelectedVertex, redoCorrection, runSegmentation, settingsOpen, manualOpen, researchOpen, sourceMenu, undoCorrection, vertexEdit, workspaceMode]);

  const handleDragEnter = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    if (isWorkspaceBusy) return;
    if (!event.dataTransfer.types.includes("Files")) return;
    dragDepth.current += 1;
    setIsDraggingFiles(true);
  };

  const handleDragLeave = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setIsDraggingFiles(false);
  };

  const handleDrop = async (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    dragDepth.current = 0;
    setIsDraggingFiles(false);
    if (isWorkspaceBusy) return;
    if (!api) {
      setError("The secure desktop bridge is unavailable. Restart Loci and try again.");
      return;
    }

    const files = [...event.dataTransfer.files];
    if (!files.length) {
      setError("No supported microscopy images were found. Use TIFF, PNG, JPG, JPEG, or modern IMS files.");
      return;
    }

    setIsImporting(true);
    setError(null);
    try {
      const imported = await api.importDroppedFiles(files);
      if (!imported.length) {
        setError("No supported microscopy images were found in the dropped items.");
        return;
      }
      acceptImported(imported);
    } catch (caught) {
      setError(errorMessage(caught, "Loci could not inspect the dropped images."));
    } finally {
      setIsImporting(false);
    }
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!activeSource || event.button !== 0 || isWorkspaceBusy) return;
    if (workspaceMode === "analyze" && activeResult && correctionTool === "vertices") {
      const point = pointFromClient(event.clientX, event.clientY);
      if (!point) return;
      if (!vertexEdit) {
        void loadEditableBoundary(point);
        return;
      }
      const imageRect = imageElementRef.current?.getBoundingClientRect();
      if (!imageRect?.width || !imageRect.height) return;
      let nearestIndex = -1;
      let nearestDistance = Number.POSITIVE_INFINITY;
      vertexEdit.vertices.forEach((vertex, index) => {
        const distance = Math.hypot(
          (vertex.x - point.x) * imageRect.width / activeResult.source.width,
          (vertex.y - point.y) * imageRect.height / activeResult.source.height,
        );
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestIndex = index;
        }
      });
      if (nearestIndex < 0 || nearestDistance > 14) return;
      if (vertexEdit.movedIndex !== null && vertexEdit.movedIndex !== nearestIndex) {
        setNotice({
          title: "Commit this vertex first",
          message: "Each saved vertex correction moves one auditable boundary point. Commit or cancel before choosing another.",
        });
        return;
      }
      setVertexEdit((current) => current ? { ...current, selectedIndex: nearestIndex } : current);
      event.currentTarget.setPointerCapture(event.pointerId);
      vertexPointer.current = event.pointerId;
      return;
    }
    if (workspaceMode === "analyze" && activeResult && correctionTool === "delete") {
      const point = pointFromClient(event.clientX, event.clientY);
      if (point) deleteInstanceAt(point);
      return;
    }
    if (workspaceMode === "analyze" && activeResult && correctionTool === "merge") {
      const point = pointFromClient(event.clientX, event.clientY);
      if (!point) return;
      const selected = { x: Math.floor(point.x), y: Math.floor(point.y) };
      const first = correctionTargetRef.current;
      if (!first) {
        correctionTargetRef.current = selected;
        setCorrectionTarget(selected);
      } else {
        correctionTargetRef.current = null;
        setCorrectionTarget(null);
        mergeSelectedInstances(first, selected);
      }
      return;
    }
    if (workspaceMode === "analyze" && activeResult && correctionTool === "reshape" && !correctionTargetRef.current) {
      const point = pointFromClient(event.clientX, event.clientY);
      if (!point) return;
      const selected = { x: Math.floor(point.x), y: Math.floor(point.y) };
      correctionTargetRef.current = selected;
      setCorrectionTarget(selected);
      return;
    }
    if (
      workspaceMode === "analyze" &&
      activeResult &&
      (
        correctionTool === "draw" ||
        correctionTool === "split" ||
        correctionTool === "reshape" ||
        correctionTool === "paint" ||
        correctionTool === "erase"
      )
    ) {
      const point = pointFromClient(event.clientX, event.clientY);
      if (!point) return;
      if (correctionTool === "split") {
        const selected = { x: Math.floor(point.x), y: Math.floor(point.y) };
        correctionTargetRef.current = selected;
        setCorrectionTarget(selected);
      }
      event.currentTarget.setPointerCapture(event.pointerId);
      drawingPointer.current = event.pointerId;
      drawPointsRef.current = [point];
      setDrawPoints([point]);
      return;
    }
    if (zoom <= 1) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    panOrigin.current = { pointer: { x: event.clientX, y: event.clientY }, pan };
    setIsPanning(true);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (vertexPointer.current === event.pointerId) {
      const point = pointFromClient(event.clientX, event.clientY);
      if (!point) return;
      setVertexEdit((current) => {
        if (!current) return current;
        const vertices = current.vertices.map((vertex) => ({ ...vertex }));
        vertices[current.selectedIndex] = point;
        const original = current.originalVertices[current.selectedIndex];
        return {
          ...current,
          vertices,
          movedIndex: point.x === original.x && point.y === original.y
            ? null
            : current.selectedIndex,
        };
      });
      return;
    }
    if (drawingPointer.current === event.pointerId) {
      const point = pointFromClient(event.clientX, event.clientY);
      const previous = drawPointsRef.current.at(-1);
      const rect = imageElementRef.current?.getBoundingClientRect();
      if (!point || !previous || !rect?.width) return;
      const minimumDistance = Math.max(0.5, activeResult!.source.width / rect.width * 2.5);
      if (Math.hypot(point.x - previous.x, point.y - previous.y) < minimumDistance) return;
      const next = [...drawPointsRef.current, point];
      drawPointsRef.current = next;
      setDrawPoints(next);
      return;
    }
    if (!panOrigin.current) return;
    setPan({
      x: panOrigin.current.pan.x + event.clientX - panOrigin.current.pointer.x,
      y: panOrigin.current.pan.y + event.clientY - panOrigin.current.pointer.y,
    });
  };

  const finishPointerInteraction = (
    event: ReactPointerEvent<HTMLDivElement>,
    commitDrawing: boolean,
  ) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (vertexPointer.current === event.pointerId) {
      vertexPointer.current = null;
      if (!commitDrawing) {
        setVertexEdit((current) => current ? {
          ...current,
          vertices: current.originalVertices.map((point) => ({ ...point })),
          movedIndex: null,
        } : current);
      }
      return;
    }
    if (drawingPointer.current === event.pointerId) {
      const stroke = drawPointsRef.current;
      const target = correctionTargetRef.current;
      drawingPointer.current = null;
      drawPointsRef.current = [];
      setDrawPoints([]);
      if (commitDrawing) {
        if (correctionTool === "draw" && stroke.length >= 3) addDrawnPolygon(stroke);
        if (correctionTool === "split" && target && stroke.length >= 2) splitDrawnInstance(target, stroke);
        if (correctionTool === "reshape" && target && stroke.length >= 3) replaceDrawnBoundary(target, stroke);
        if (correctionTool === "paint" && stroke.length >= 1) applyBrushStroke(stroke, false);
        if (correctionTool === "erase" && stroke.length >= 1) applyBrushStroke(stroke, true);
      }
      if (correctionTool === "split" || correctionTool === "reshape") {
        correctionTargetRef.current = null;
        setCorrectionTarget(null);
      }
      return;
    }
    panOrigin.current = null;
    setIsPanning(false);
  };

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (!activeSource || isWorkspaceBusy || drawingPointer.current !== null || vertexPointer.current !== null) return;
    event.preventDefault();
    adjustZoom(zoom * (event.deltaY > 0 ? 0.9 : 1.1));
  };

  const decideActiveReview = useCallback((disposition: ProjectReviewDisposition) => {
    if (!activeSource || !activeResult || isWorkspaceBusy) return;
    try {
      const decision = createReviewDecision(activeSource.sourceId, activeResult, disposition);
      setReviews((current) => [...current, decision]);
      setNotice({
        title: disposition === "reviewed" ? "Result reviewed" : "Result excluded",
        message: disposition === "reviewed"
          ? "This decision is bound to the current result and correction revision."
          : "This result remains in project provenance but is excluded from reviewed counts.",
      });
    } catch (caught) {
      setError(errorMessage(caught, "Loci could not record that review decision."));
    }
  }, [activeResult, activeSource, isWorkspaceBusy]);

  const openReviewSource = useCallback((sourceId: string) => {
    setActiveSourceId(sourceId);
    setWorkspaceMode("analyze");
    setCorrectionTool("navigate");
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const goToNextUnreviewed = useCallback(() => {
    const candidates = reviewItems.filter(({ result, reviewStatus }) =>
      Boolean(result) && reviewStatus === "unreviewed");
    if (!candidates.length) return;
    const currentIndex = candidates.findIndex(({ source }) => source.sourceId === activeSourceId);
    const next = candidates[(currentIndex + 1 + candidates.length) % candidates.length];
    setActiveSourceId(next.source.sourceId);
  }, [activeSourceId, reviewItems]);

  const sourceImage = workspaceMode === "view"
    ? activeSource?.previewDataUrl
    : activeResult?.previewDataUrl ?? activeSource?.previewDataUrl;
  const platform = api?.platform ?? (navigator.platform.toLowerCase().includes("mac") ? "darwin" : "unknown");
  const settingsDialog = <>{settingsOpen ? (
    <SettingsDialog
      preferences={preferences}
      onChange={setPreferences}
      onClose={() => setSettingsOpen(false)}
      onQuit={() => api?.requestQuit()}
      onOpenGuide={() => { setSettingsOpen(false); setManualOpen(true); }}
    />
  ) : null}{manualOpen && <UserGuideDialog onClose={() => setManualOpen(false)} />}</>;

  if (researchOpen && window.lociResearch) {
    return (
      <>
        <ResearchWorkbench
          api={window.lociResearch}
          preferences={preferences}
          onBack={() => setResearchOpen(false)}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        {settingsDialog}
      </>
    );
  }

  return (
    <main
      className="app-shell"
      data-platform={platform}
      data-fullscreen={isFullscreen ? "true" : "false"}
      data-text-size={preferences.textSize}
      data-result-restoration-state={isRestoringActiveResult ? "pending" : "settled"}
    >
      <header className="titlebar">
        <div className="brand-lockup">
          <BrandMark />
          <span className="brand-name">Loci</span>
          <span className="brand-divider" aria-hidden="true" />
          <span className="project-name" title={projectSummary?.title}>
            {projectSummary?.title ?? "Current session"}
          </span>
        </div>
        <div className="titlebar-actions">
          {window.lociResearch && <button className="button button-quiet" type="button"
            disabled={isWorkspaceBusy} onClick={() => setResearchOpen(true)}>
            <Layers3 size={14} /> Research study
          </button>}
          <div className="titlebar-processing" aria-live="polite">
            <span className={`status-dot ${isDesktopAvailable ? "" : "is-offline"}`} aria-hidden="true" />
            <span>
              {isRestoringActiveResult
                ? "Restoring saved result"
                : isDesktopAvailable ? "Local processing" : "Desktop bridge unavailable"}
            </span>
          </div>
          <button
            className="button button-quiet titlebar-icon-button"
            type="button"
            title={projectSummary ? "Save project" : "Create project"}
            aria-label={projectSummary ? "Save project" : "Create project"}
            disabled={(!sources.length && !projectSummary) || isWorkspaceOrProjectBusy}
            onClick={() => void saveCurrentProject()}
          >
            {isProjectBusy ? <LoaderCircle className="loader" size={14} /> : <Save size={14} />}
          </button>
          <button
            className="button button-quiet titlebar-icon-button"
            type="button"
            title="Settings"
            aria-label="Open settings"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings2 size={14} />
          </button>
        </div>
      </header>

      <div className="workspace">
        <aside className="source-rail" aria-label="Imported image sources">
          <header className="panel-header section-heading">
            <h2 className="eyebrow">Sources</h2>
            <span className="count-label">{sources.length.toLocaleString()}</span>
          </header>

          {sources.length ? (
            <ul className="source-list">
              {displayedSources.map((source) => {
                const sourceResult = results[source.sourceId];
                const hasResult = Boolean(sourceResult);
                const sourceQuality = sourceResult?.quality.status;
                const batchState = batchSourceStates.current.get(source.sourceId);
                const isThisRunning = isRunning && source.sourceId === runProgress?.sourceId;
                const isInspecting = inspectingSourceIds.has(source.sourceId);
                const detailFormat = formatFormat(source);
                return (
                  <li className="source-item" key={source.sourceId}>
                    <button
                      className={`source-button ${source.sourceId === activeSourceId ? "is-active" : ""}`}
                      type="button"
                      disabled={isWorkspaceBusy}
                      onClick={() => {
                        setActiveSourceId(source.sourceId);
                        resetView();
                        if (!source.previewDataUrl) void hydrateSource(source.sourceId);
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        if (isWorkspaceBusy) return;
                        // Source actions already carry their exact target ID.
                        // Selecting an evicted result here starts restoration,
                        // which would immediately close the newly opened menu.
                        setSourceMenu({
                          sourceId: source.sourceId,
                          x: Math.max(8, Math.min(event.clientX, window.innerWidth - 224)),
                          y: Math.max(8, Math.min(event.clientY, window.innerHeight - 188)),
                        });
                      }}
                      aria-current={source.sourceId === activeSourceId ? "true" : undefined}
                      title={source.relativePath}
                    >
                      <span className="source-thumbnail">
                        {source.previewDataUrl ? (
                          <img src={source.previewDataUrl} alt="" draggable={false} />
                        ) : (
                          <FileImage className="source-placeholder-icon" size={18} aria-hidden="true" />
                        )}
                        {(hasResult || isThisRunning || batchState === "complete" || batchState === "failed") && (
                          <span
                            className={`source-status ${batchState === "failed" || sourceQuality === "invalid" ? "is-invalid" : sourceQuality === "warning" ? "is-warning" : ""}`}
                            aria-label={isThisRunning ? "Processing" : batchState === "failed" ? "Batch processing failed" : sourceQuality === "invalid" ? "Result not usable" : sourceQuality === "warning" ? "Result needs review" : "Analysis complete"}
                          >
                            {isThisRunning ? (
                              <LoaderCircle className="loader" size={9} />
                            ) : batchState === "failed" || sourceQuality === "invalid" || sourceQuality === "warning" ? (
                              <AlertTriangle size={9} strokeWidth={2.4} />
                            ) : (
                              <Check size={9} strokeWidth={2.5} />
                            )}
                          </span>
                        )}
                      </span>
                      <span className="source-copy">
                        <span className="source-name" title={source.name}>{source.name}</span>
                        <span className="source-detail">
                          {isInspecting ? "Reading image…" : formatDimensions(source)}
                          {!isInspecting && detailFormat ? ` · ${detailFormat}` : ""}
                        </span>
                      </span>
                      <ChevronDown size={12} opacity={0.35} style={{ transform: "rotate(-90deg)" }} />
                    </button>
                  </li>
                );
              })}
              {sources.length > displayedSources.length && (
                <li className="source-more-item">
                  <button
                    className="button button-quiet button-block"
                    type="button"
                    onClick={() => setVisibleSourceCount((current) => current + SOURCE_PAGE_SIZE)}
                  >
                    Show {Math.min(SOURCE_PAGE_SIZE, sources.length - displayedSources.length).toLocaleString()} more
                  </button>
                </li>
              )}
            </ul>
          ) : (
            <div className="source-list-empty">Imported images appear here. Original files remain unchanged.</div>
          )}

          <footer className="rail-footer">
            {workspaceMode === "analyze" && sources.length > 1 && (
              <button className="button button-primary button-block" type="button" onClick={() => void runBatchSegmentation()} disabled={isWorkspaceBusy || !selectedProfileReady}>
                {isRunning && runProgress?.mode === "batch" ? <LoaderCircle className="loader" size={14} /> : <Layers3 size={14} />}
                Process all {sources.length.toLocaleString()}
              </button>
            )}
            <div className="rail-import-actions">
              <button className="button button-quiet button-block" type="button" onClick={() => void importImages()} disabled={isWorkspaceBusy}>
                {isImporting ? <LoaderCircle className="loader" size={14} /> : <Plus size={14} />}
                Images
              </button>
              <button className="button button-quiet button-block" type="button" onClick={() => void importFolder()} disabled={isWorkspaceBusy}>
                <FolderOpen size={14} />
                Folder
              </button>
            </div>
          </footer>
        </aside>

        <section
          className={`canvas-region ${isDraggingFiles ? "is-dragging" : ""} ${workspaceMode === "review" ? "is-reviewing" : ""}`}
          aria-label="Biological image canvas"
          onDragEnter={handleDragEnter}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={handleDragLeave}
          onDrop={(event) => void handleDrop(event)}
        >
          {workspaceMode === "review" && (
            <section className="review-workspace" aria-labelledby="review-workspace-title">
              <header className="review-workspace-header">
                <div>
                  <span className="eyebrow">Batch review</span>
                  <h2 id="review-workspace-title">Check results before export</h2>
                  <p className="review-workspace-summary">
                    {reviewSummary.reviewed.toLocaleString()} reviewed · {reviewSummary.unreviewed.toLocaleString()} unreviewed · {reviewSummary.excluded.toLocaleString()} excluded
                  </p>
                  <p className="review-workspace-advisory">
                    Unreviewed results may be exported for research use; review boundaries before using any count.
                  </p>
                </div>
                <div className="review-workspace-actions">
                  <span>{visibleReviewItems.length.toLocaleString()} shown</span>
                  <button
                    className="button button-primary"
                    type="button"
                    disabled={isWorkspaceBusy || reviewSummary.processed - reviewSummary.excluded < 1}
                    onClick={() => void exportReviewedBatch()}
                  >
                    {isExporting ? <LoaderCircle className="loader" size={14} /> : <Download size={14} />}
                    {isExporting ? "Exporting…" : "Export batch"}
                  </button>
                </div>
              </header>
              <ReviewContactSheet
                items={visibleReviewItems}
                activeSourceId={activeSourceId}
                onSelect={setActiveSourceId}
                onOpen={openReviewSource}
              />
            </section>
          )}
          {activeSource && (
            <div className="canvas-toolbar">
              <div className="toolbar-cluster">
                <div className="canvas-file-label">
                  <div className="canvas-file-name" title={activeSource.relativePath}>{activeSource.name}</div>
                  <div className="canvas-file-meta">
                    {formatDimensions(activeSource)}
                    {activeSource.dtype ? ` · ${activeSource.dtype}` : ""}
                    {activeSource.channels !== undefined ? ` · ${activeSource.channels} ch` : ""}
                  </div>
                </div>
              </div>
              <div className="toolbar-cluster" aria-label="Canvas controls">
                {workspaceMode === "view" && (
                  <>
                    <button
                      className={`button toolbar-button toolbar-compare ${showOriginalPreview ? "is-active" : ""}`}
                      type="button"
                      title="Hold to compare with the untouched source preview"
                      aria-label="Hold to show original preview"
                      aria-pressed={showOriginalPreview}
                      disabled={!activeSource.previewDataUrl}
                      onPointerDown={() => setShowOriginalPreview(true)}
                      onPointerUp={() => setShowOriginalPreview(false)}
                      onPointerCancel={() => setShowOriginalPreview(false)}
                      onPointerLeave={() => setShowOriginalPreview(false)}
                      onKeyDown={(event) => {
                        if (!event.repeat && (event.key === " " || event.key === "Enter")) setShowOriginalPreview(true);
                      }}
                      onKeyUp={(event) => {
                        if (event.key === " " || event.key === "Enter") setShowOriginalPreview(false);
                      }}
                      onBlur={() => setShowOriginalPreview(false)}
                    >
                      <Eye size={14} />
                      <span>Original</span>
                    </button>
                    <span className="toolbar-divider" aria-hidden="true" />
                  </>
                )}
                {workspaceMode === "analyze" && (
                  <>
                    <button
                      className="button toolbar-button"
                      type="button"
                      title={overlayVisible ? "Hide overlay" : "Show overlay"}
                      aria-label={overlayVisible ? "Hide segmentation overlay" : "Show segmentation overlay"}
                      aria-pressed={overlayVisible}
                      disabled={!activeResult}
                      onClick={() => setOverlayVisible((visible) => !visible)}
                    >
                      <span className="icon-swap" aria-hidden="true">
                        <Eye size={15} className={overlayVisible ? "is-visible" : "is-hidden"} />
                        <EyeOff size={15} className={overlayVisible ? "is-hidden" : "is-visible"} />
                      </span>
                    </button>
                    <span className="toolbar-divider" aria-hidden="true" />
                  </>
                )}
                <button
                  className={`button toolbar-button ${correctionTool === "navigate" ? "is-active" : ""}`}
                  type="button"
                  title="Navigate image"
                  aria-label="Navigate image"
                  aria-pressed={correctionTool === "navigate"}
                  onClick={() => {
                    setCorrectionTool("navigate");
                    setDrawPoints([]);
                  }}
                >
                  <MousePointer2 size={14} />
                </button>
                {workspaceMode === "analyze" && (
                  <>
                    <button
                      className={`button toolbar-button ${correctionTool === "draw" ? "is-active" : ""}`}
                      type="button"
                      title="Draw one missing cell boundary"
                      aria-label="Draw cell boundary"
                      aria-pressed={correctionTool === "draw"}
                      disabled={!activeResult || isWorkspaceBusy}
                      onClick={() => {
                        setCorrectionTool("draw");
                        setDrawPoints([]);
                      }}
                    >
                      <PenTool size={14} />
                    </button>
                    <button
                      className={`button toolbar-button ${correctionTool === "delete" ? "is-active" : ""}`}
                      type="button"
                      title="Remove one segmented cell"
                      aria-label="Remove segmented cell"
                      aria-pressed={correctionTool === "delete"}
                      disabled={!activeResult || isWorkspaceBusy}
                      onClick={() => {
                        setCorrectionTool("delete");
                        setDrawPoints([]);
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                    <button
                      className={`button toolbar-button ${correctionTool === "paint" ? "is-active" : ""}`}
                      type="button"
                      title="Paint segmentation mask (B)"
                      aria-label="Paint segmentation mask"
                      aria-pressed={correctionTool === "paint"}
                      disabled={!activeResult || isWorkspaceBusy}
                      onClick={() => {
                        setCorrectionTool("paint");
                        setDrawPoints([]);
                      }}
                    >
                      <Paintbrush size={14} />
                    </button>
                    <button
                      className={`button toolbar-button ${correctionTool === "erase" ? "is-active" : ""}`}
                      type="button"
                      title="Erase segmentation mask (E)"
                      aria-label="Erase segmentation mask"
                      aria-pressed={correctionTool === "erase"}
                      disabled={!activeResult || isWorkspaceBusy}
                      onClick={() => {
                        setCorrectionTool("erase");
                        setDrawPoints([]);
                      }}
                    >
                      <Eraser size={14} />
                    </button>
                    <button
                      className={`button toolbar-button ${correctionTool === "split" ? "is-active" : ""}`}
                      type="button"
                      title="Split one segmented cell (S)"
                      aria-label="Split segmented cell"
                      aria-pressed={correctionTool === "split"}
                      disabled={!activeResult || isWorkspaceBusy}
                      onClick={() => setCorrectionTool("split")}
                    >
                      <Scissors size={14} />
                    </button>
                    <button
                      className={`button toolbar-button ${correctionTool === "merge" ? "is-active" : ""}`}
                      type="button"
                      title="Merge two touching cells (M)"
                      aria-label="Merge segmented cells"
                      aria-pressed={correctionTool === "merge"}
                      disabled={!activeResult || isWorkspaceBusy}
                      onClick={() => setCorrectionTool("merge")}
                    >
                      <Combine size={14} />
                    </button>
                    <button
                      className={`button toolbar-button ${correctionTool === "reshape" ? "is-active" : ""}`}
                      type="button"
                      title="Replace one cell boundary (R)"
                      aria-label="Reshape segmented cell boundary"
                      aria-pressed={correctionTool === "reshape"}
                      disabled={!activeResult || isWorkspaceBusy}
                      onClick={() => setCorrectionTool("reshape")}
                    >
                      <Spline size={14} />
                    </button>
                    <button
                      className={`button toolbar-button ${correctionTool === "vertices" ? "is-active" : ""}`}
                      type="button"
                      title="Edit boundary vertices (P)"
                      aria-label="Edit boundary vertices"
                      aria-pressed={correctionTool === "vertices"}
                      disabled={!activeResult || isWorkspaceBusy}
                      onClick={() => {
                        setCorrectionTool("vertices");
                        setDrawPoints([]);
                      }}
                    >
                      <Waypoints size={14} />
                    </button>
                    <button
                      className="button toolbar-button"
                      type="button"
                      title="Undo manual correction"
                      aria-label="Undo manual correction"
                      disabled={!activeResult?.corrections.canUndo || isWorkspaceBusy}
                      onClick={undoCorrection}
                    >
                      <Undo2 size={14} />
                    </button>
                    <button
                      className="button toolbar-button"
                      type="button"
                      title="Redo manual correction"
                      aria-label="Redo manual correction"
                      disabled={!activeResult?.corrections.canRedo || isWorkspaceBusy}
                      onClick={redoCorrection}
                    >
                      <Redo2 size={14} />
                    </button>
                  </>
                )}
                <span className="toolbar-divider" aria-hidden="true" />
                <button className="button toolbar-button" type="button" title="Zoom out" aria-label="Zoom out" onClick={() => adjustZoom(zoom / 1.2)} disabled={zoom <= MIN_ZOOM}>
                  <Minus size={15} />
                </button>
                <span className="zoom-readout">{Math.round(zoom * 100)}%</span>
                <button className="button toolbar-button" type="button" title="Zoom in" aria-label="Zoom in" onClick={() => adjustZoom(zoom * 1.2)} disabled={zoom >= MAX_ZOOM}>
                  <Plus size={15} />
                </button>
                <button className="button toolbar-button" type="button" title="Fit image" aria-label="Fit image to canvas" onClick={resetView}>
                  <Maximize2 size={14} />
                </button>
              </div>
            </div>
          )}

          {activeSource && activeResult && workspaceMode === "analyze" && (
            <div
              className={`correction-tool-hint ${correctionTool === "paint" || correctionTool === "erase" || correctionTool === "vertices" ? "has-controls" : ""}`}
              role="region"
              aria-label="Active correction tool"
            >
              <span aria-live="polite">
                {correctionTool === "vertices" && vertexEdit
                  ? `${vertexEdit.simplified ? "Simplified outer boundary" : "Outer boundary"} · Arrow keys nudge 1 px; Shift + arrow nudges 5 px`
                  : CORRECTION_TOOL_GUIDANCE[correctionTool]}
              </span>
              {(correctionTool === "paint" || correctionTool === "erase") && (
                <label className="brush-radius-control">
                  <span>Radius</span>
                  <input
                    aria-label="Brush radius in source pixels"
                    type="range"
                    min={1}
                    max={MAX_BRUSH_RADIUS_PX}
                    step={1}
                    value={brushRadiusPx}
                    onChange={(event) => setBrushRadiusPx(Number(event.currentTarget.value))}
                  />
                  <output>{brushRadiusPx}px</output>
                </label>
              )}
              {correctionTool === "vertices" && vertexEdit && (
                <div className="vertex-edit-controls" aria-label="Boundary vertex controls">
                  <span className="vertex-readout">
                    Vertex {vertexEdit.selectedIndex + 1}/{vertexEdit.vertices.length}
                  </span>
                  <button
                    className="button vertex-step-button"
                    type="button"
                    aria-label="Select previous boundary vertex"
                    onClick={() => setVertexEdit((current) => current ? {
                      ...current,
                      selectedIndex: current.movedIndex ??
                        (current.selectedIndex - 1 + current.vertices.length) % current.vertices.length,
                    } : current)}
                  >
                    Previous
                  </button>
                  <button
                    className="button vertex-step-button"
                    type="button"
                    aria-label="Select next boundary vertex"
                    onClick={() => setVertexEdit((current) => current ? {
                      ...current,
                      selectedIndex: current.movedIndex ??
                        (current.selectedIndex + 1) % current.vertices.length,
                    } : current)}
                  >
                    Next
                  </button>
                  <button
                    className="button vertex-cancel-button"
                    type="button"
                    onClick={cancelVertexEdit}
                  >
                    Cancel
                  </button>
                  <button
                    className="button vertex-commit-button"
                    type="button"
                    disabled={vertexEdit.movedIndex === null || isWorkspaceBusy}
                    onClick={() => void commitVertexEdit()}
                  >
                    Commit
                  </button>
                </div>
              )}
              {correctionTool !== "navigate" && correctionTool !== "vertices" && <kbd>Esc</kbd>}
              {correctionTool === "vertices" && !vertexEdit && <kbd>Select cell</kbd>}
            </div>
          )}

          <div
            className="canvas-viewport"
            style={{
              cursor: isWorkspaceBusy
                ? "wait"
                : workspaceMode === "analyze" && correctionTool !== "navigate"
                  ? "crosshair"
                  : zoom > 1
                    ? isPanning ? "grabbing" : "grab"
                    : "default",
            }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={(event) => finishPointerInteraction(event, true)}
            onPointerCancel={(event) => finishPointerInteraction(event, false)}
            onDoubleClick={workspaceMode === "view" || correctionTool === "navigate" ? resetView : undefined}
            onWheel={handleWheel}
          >
            {activeSource && sourceImage ? (
              <div
                className="image-stage"
                style={{ transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})` }}
              >
                {workspaceMode === "view" && (
                  <svg className="display-filter-defs" aria-hidden="true">
                    <filter id="loci-viewer-display-filter" x="-5%" y="-5%" width="110%" height="110%" colorInterpolationFilters="sRGB">
                      <feColorMatrix type="saturate" values={String(viewerFilter.saturation)} />
                      <feComponentTransfer>
                        <feFuncR type="table" tableValues="0 1" />
                        <feFuncG type="table" tableValues="0 1" />
                        <feFuncB type="table" tableValues="0 1" />
                        <feFuncA type="linear" slope={1} />
                      </feComponentTransfer>
                      <feComponentTransfer>
                        <feFuncR type="linear" slope={viewerFilter.windowSlope} intercept={viewerFilter.windowOffset} />
                        <feFuncG type="linear" slope={viewerFilter.windowSlope} intercept={viewerFilter.windowOffset} />
                        <feFuncB type="linear" slope={viewerFilter.windowSlope} intercept={viewerFilter.windowOffset} />
                        <feFuncA type="linear" slope={1} />
                      </feComponentTransfer>
                      <feComponentTransfer>
                        <feFuncR type="table" tableValues="0 1" />
                        <feFuncG type="table" tableValues="0 1" />
                        <feFuncB type="table" tableValues="0 1" />
                        <feFuncA type="linear" slope={1} />
                      </feComponentTransfer>
                      <feComponentTransfer>
                        <feFuncR type="gamma" amplitude={viewerFilter.amplitude} exponent={viewerFilter.exponent} offset={viewerFilter.offset} />
                        <feFuncG type="gamma" amplitude={viewerFilter.amplitude} exponent={viewerFilter.exponent} offset={viewerFilter.offset} />
                        <feFuncB type="gamma" amplitude={viewerFilter.amplitude} exponent={viewerFilter.exponent} offset={viewerFilter.offset} />
                        <feFuncA type="linear" slope={1} />
                      </feComponentTransfer>
                      <feComponentTransfer>
                        <feFuncR type="table" tableValues="0 1" />
                        <feFuncG type="table" tableValues="0 1" />
                        <feFuncB type="table" tableValues="0 1" />
                        <feFuncA type="linear" slope={1} />
                      </feComponentTransfer>
                      <feComponentTransfer>
                        <feFuncR type="linear" slope={viewerDisplay.red ? 1 : 0} />
                        <feFuncG type="linear" slope={viewerDisplay.green ? 1 : 0} />
                        <feFuncB type="linear" slope={viewerDisplay.blue ? 1 : 0} />
                        <feFuncA type="linear" slope={1} />
                      </feComponentTransfer>
                    </filter>
                  </svg>
                )}
                <img
                  ref={imageElementRef}
                  className="source-image"
                  src={sourceImage}
                  alt={`Biological image ${activeSource.name}`}
                  draggable={false}
                  style={{ filter: workspaceMode === "view" && !showOriginalPreview ? 'url("#loci-viewer-display-filter")' : undefined }}
                />
                {workspaceMode === "analyze" && activeResult && (
                  <img
                    className="overlay-image"
                    src={activeResult.overlayDataUrl}
                    alt="Segmentation boundary overlay"
                    draggable={false}
                    style={{ opacity: overlayVisible ? overlayOpacity : 0 }}
                  />
                )}
                {drawPoints.length > 0 && activeResult && (
                  <svg
                    className={`correction-drawing ${correctionTool === "paint" ? "is-brush" : correctionTool === "erase" ? "is-eraser" : ""}`}
                    viewBox={`0 0 ${activeResult.source.width} ${activeResult.source.height}`}
                    preserveAspectRatio="none"
                    aria-hidden="true"
                  >
                    <polyline
                      points={drawPoints.map((point) => `${point.x},${point.y}`).join(" ")}
                      fill="none"
                      vectorEffect={correctionTool === "paint" || correctionTool === "erase" ? undefined : "non-scaling-stroke"}
                      style={correctionTool === "paint" || correctionTool === "erase"
                        ? { strokeWidth: brushRadiusPx * 2 }
                        : undefined}
                    />
                    {drawPoints.length === 1 && (correctionTool === "paint" || correctionTool === "erase") && (
                      <circle
                        cx={drawPoints[0].x}
                        cy={drawPoints[0].y}
                        r={brushRadiusPx}
                      />
                    )}
                  </svg>
                )}
                {vertexEdit && activeResult && correctionTool === "vertices" && (
                  <svg
                    className="correction-vertices"
                    viewBox={`0 0 ${activeResult.source.width} ${activeResult.source.height}`}
                    preserveAspectRatio="none"
                    aria-hidden="true"
                  >
                    <polygon
                      points={vertexEdit.vertices.map((point) => `${point.x},${point.y}`).join(" ")}
                      vectorEffect="non-scaling-stroke"
                    />
                    {vertexEdit.vertices.map((point, index) => (
                      <circle
                        key={`${index}-${point.x}-${point.y}`}
                        data-vertex-index={index}
                        className={index === vertexEdit.selectedIndex ? "is-selected" : undefined}
                        cx={point.x}
                        cy={point.y}
                        r={Math.max(2.5, activeResult.source.width / 720)}
                        vectorEffect="non-scaling-stroke"
                      />
                    ))}
                  </svg>
                )}
                {correctionTarget && activeResult && (
                  <svg
                    className="correction-target"
                    viewBox={`0 0 ${activeResult.source.width} ${activeResult.source.height}`}
                    preserveAspectRatio="none"
                    aria-hidden="true"
                  >
                    <circle cx={correctionTarget.x} cy={correctionTarget.y} r={Math.max(3, activeResult.source.width / 450)} />
                  </svg>
                )}
              </div>
            ) : activeSource ? (
              <div className="selected-source-placeholder" aria-live="polite">
                {inspectingSourceIds.has(activeSource.sourceId) ? (
                  <LoaderCircle className="loader" size={20} />
                ) : (
                  <FileImage size={24} />
                )}
                <strong>{inspectingSourceIds.has(activeSource.sourceId) ? "Preparing preview…" : "Preview unavailable"}</strong>
                <span>You can still run segmentation; the source remains read-only.</span>
              </div>
            ) : (
              <WelcomeWorkspace
                desktopAvailable={isDesktopAvailable}
                importing={isImporting}
                busy={isWorkspaceOrProjectBusy}
                recentProjects={recentProjects}
                onOpenImages={() => void importImages()}
                onOpenFolder={() => void importFolder()}
                onOpenProject={() => void openProjectFile()}
                onOpenRecentProject={(recentId) => void openRecentProjectFile(recentId)}
              />
            )}

            {isRunning && (
              <div className="processing-scrim" aria-live="polite">
                <div className="processing-pill">
                  <LoaderCircle className="loader" size={15} />
                  <span>
                    {runProgress?.mode === "batch"
                      ? `Processing ${runProgress.current.toLocaleString()} of ${runProgress.total.toLocaleString()} · ${runProgress.name}`
                      : "Segmenting locally…"}
                  </span>
                </div>
              </div>
            )}
          </div>

          <div className="drop-target" aria-hidden={!isDraggingFiles}>
            <div className="drop-target-content">
              <FileImage size={30} strokeWidth={1.5} />
              <strong>Release to inspect</strong>
              <span>Supported images are added without modifying the originals.</span>
            </div>
          </div>

          {error && (
            <div className="error-banner" role="alert">
              <AlertTriangle size={17} />
              <div className="banner-copy">
                <strong>Action needed</strong>
                {error}
              </div>
              <button className="button button-quiet icon-button" type="button" aria-label="Dismiss error" onClick={() => setError(null)}>
                <X size={15} />
              </button>
            </div>
          )}

          {notice && (
            <div className="notice-banner" role="status">
              <Check size={17} />
              <div className="banner-copy">
                <strong>{notice.title}</strong>
                {notice.message}
              </div>
              <button className="button button-quiet icon-button" type="button" aria-label="Dismiss notification" onClick={() => setNotice(null)}>
                <X size={15} />
              </button>
            </div>
          )}
        </section>

        <aside className="inspector" aria-label="Image workspace inspector">
          <header className="panel-header section-heading">
            <h2 className="eyebrow">Workspace</h2>
            <span className="inspector-title">{activeSource ? activeSource.name : "No source selected"}</span>
          </header>

          {workspaceMode !== "review" && (
            <WorkspaceRecommendationPanel
              recommendation={activeWorkspaceRecommendation}
              disabled={isWorkspaceBusy}
              onOverride={(workspace) => {
                if (!activeSource) return;
                setWorkspaceOverrideBySourceId((current) => ({
                  ...current,
                  [activeSource.sourceId]: workspace,
                }));
                setWorkspaceMode("view");
                setCorrectionTool("navigate");
                setDrawPoints([]);
              }}
            />
          )}

          <div className="workspace-mode-tabs" role="tablist" aria-label="Workspace mode">
            <button
              id="workspace-mode-view"
              className={workspaceMode === "view" ? "is-active" : ""}
              type="button"
              role="tab"
              aria-selected={workspaceMode === "view"}
              aria-controls="workspace-inspector-panel"
              disabled={isWorkspaceBusy}
              onClick={() => {
                setWorkspaceMode("view");
                setCorrectionTool("navigate");
                setDrawPoints([]);
              }}
            >
              View
            </button>
            <button
              id="workspace-mode-analyze"
              className={workspaceMode === "analyze" ? "is-active" : ""}
              type="button"
              role="tab"
              aria-selected={workspaceMode === "analyze"}
              aria-controls="workspace-inspector-panel"
              disabled={isWorkspaceBusy || overviewOnly}
              title={overviewOnly ? activeSource?.viewOnlyReason ?? "Analysis is unavailable for this overview" : undefined}
              onClick={() => {
                setWorkspaceMode("analyze");
                setCorrectionTool("navigate");
                setDrawPoints([]);
              }}
            >
              Analyze
            </button>
            <button
              id="workspace-mode-review"
              className={workspaceMode === "review" ? "is-active" : ""}
              type="button"
              role="tab"
              aria-selected={workspaceMode === "review"}
              aria-controls="workspace-inspector-panel"
              disabled={isWorkspaceBusy || sources.length === 0}
              onClick={() => {
                setWorkspaceMode("review");
                setCorrectionTool("navigate");
                setDrawPoints([]);
              }}
            >
              Review
            </button>
          </div>

          <div
            id="workspace-inspector-panel"
            className="inspector-scroll"
            role="tabpanel"
            aria-labelledby={workspaceMode === "view"
              ? "workspace-mode-view"
              : workspaceMode === "analyze"
                ? "workspace-mode-analyze"
                : "workspace-mode-review"}
          >
            {workspaceMode === "review" ? (
              <ReviewInspector
                summary={reviewSummary}
                filter={reviewFilter}
                sort={reviewSort}
                onFilterChange={setReviewFilter}
                onSortChange={setReviewSort}
                onNextUnreviewed={goToNextUnreviewed}
                canGoToNext={reviewSummary.unreviewed > 0}
              />
            ) : workspaceMode === "view" ? (
              <>
                {overviewOnly && activeSource && (
                  <section className="inspector-section" aria-label="Overview status">
                    <div className="viewer-display-note">
                      <Layers3 size={12} />
                      <span>
                        {imsDetails
                          ? `Overview only · pyramid level ${imsDetails.selectedResolutionLevel + 1} of ${imsDetails.resolutionLevels}, central Z ${imsDetails.selectedZ + 1} of ${imsDetails.selectedLevelDepth}. Native planes and 3D navigation are not enabled yet.`
                          : tiffDetails
                            ? `Overview only · pyramid level ${tiffDetails.selectedResolutionLevel + 1} of ${tiffDetails.resolutionLevels}, ${tiffDetails.selectedLevelWidth.toLocaleString()} × ${tiffDetails.selectedLevelHeight.toLocaleString()} px from a ${tiffDetails.width.toLocaleString()} × ${tiffDetails.height.toLocaleString()} px source.`
                          : activeSource.viewOnlyReason ?? "Overview only. Native-resolution analysis and export are not enabled yet."}
                      </span>
                    </div>
                  </section>
                )}
                <section className={`inspector-section ${!activeSource ? "is-disabled" : ""}`} aria-labelledby="viewer-levels-heading">
                  <div className="section-title-row">
                    <h3 className="section-title" id="viewer-levels-heading">Levels</h3>
                    <div className="section-action-cluster">
                      <button
                        className="section-action"
                        type="button"
                        disabled={viewerControlsDisabled || !displayStatistics}
                        title={displayStatistics ? "Fit black and white points to the sampled 1st and 99th percentiles; an effectively flat interval keeps the full display range" : "Histogram statistics are unavailable"}
                        onClick={autoViewerDisplayWindow}
                      >
                        Auto
                      </button>
                      <button
                        className="section-action"
                        type="button"
                        disabled={viewerControlsDisabled}
                        onClick={resetViewerDisplay}
                      >
                        Reset
                      </button>
                    </div>
                  </div>
                  {displayStatistics ? (
                    <PreviewHistogram
                      bins={displayStatistics.histogramBins}
                      blackPoint={viewerDisplay.blackPoint}
                      whitePoint={viewerDisplay.whitePoint}
                      basis={displayStatistics.basis}
                    />
                  ) : (
                    <div className="viewer-histogram-unavailable" role="status">
                      <span aria-hidden="true" />
                      Histogram becomes available after source inspection.
                    </div>
                  )}
                  <RangeField
                    id="viewer-black-point"
                    label={`Black point${displayStatistics ? ` · ${formatDisplayPoint(viewerDisplay.blackPoint, displayStatistics, displayStatisticsUnit)}` : ""}`}
                    value={viewerDisplay.blackPoint * 100}
                    min={0}
                    max={Math.max(0, (viewerDisplay.whitePoint - 0.001) * 100)}
                    step={0.1}
                    suffix="%"
                    disabled={viewerControlsDisabled}
                    onChange={(value) => updateViewerDisplay("blackPoint", value / 100)}
                  />
                  <RangeField
                    id="viewer-white-point"
                    label={`White point${displayStatistics ? ` · ${formatDisplayPoint(viewerDisplay.whitePoint, displayStatistics, displayStatisticsUnit)}` : ""}`}
                    value={viewerDisplay.whitePoint * 100}
                    min={Math.min(100, (viewerDisplay.blackPoint + 0.001) * 100)}
                    max={100}
                    step={0.1}
                    suffix="%"
                    disabled={viewerControlsDisabled}
                    onChange={(value) => updateViewerDisplay("whitePoint", value / 100)}
                  />
                  <p className="section-footnote viewer-levels-note">
                    {displayStatistics
                      ? displayStatisticsUseCompositeUnits
                        ? `Log-scaled ${displayStatistics.basis} histogram from ${displayStatistics.sampleCount.toLocaleString()} rendered overview-composite samples. Display units describe the generated composite, not native channel intensities.`
                        : `Log-scaled ${displayStatistics.basis} histogram from ${displayStatistics.sampleCount.toLocaleString()} inspected samples. DN labels use the display basis, not raw extrema.`
                      : "Points are normalized to the display range. The source file remains unchanged."}
                  </p>
                  {activeSource && sourceIsSingleIntensityPlane && (
                    <p className="section-footnote viewer-interpretation-note">
                      Single intensity plane. No stain or fluorophore identity is inferred from the pixels.
                    </p>
                  )}
                </section>

                <section className={`inspector-section ${!activeSource ? "is-disabled" : ""}`} aria-labelledby="viewer-display-heading">
                  <div className="section-title-row">
                    <h3 className="section-title" id="viewer-display-heading">Tone</h3>
                    <span className="section-hint">Non-destructive</span>
                  </div>
                  <RangeField
                    id="viewer-brightness"
                    label="Brightness"
                    value={viewerDisplay.brightness}
                    min={-50}
                    max={50}
                    step={1}
                    suffix="%"
                    disabled={viewerControlsDisabled}
                    onChange={(value) => updateViewerDisplay("brightness", value)}
                  />
                  <RangeField
                    id="viewer-contrast"
                    label="Contrast"
                    value={viewerDisplay.contrast}
                    min={0}
                    max={200}
                    step={1}
                    suffix="%"
                    disabled={viewerControlsDisabled}
                    onChange={(value) => updateViewerDisplay("contrast", value)}
                  />
                  <RangeField
                    id="viewer-gamma"
                    label="Gamma"
                    value={viewerDisplay.gamma}
                    min={0.2}
                    max={3}
                    step={0.05}
                    disabled={viewerControlsDisabled}
                    onChange={(value) => updateViewerDisplay("gamma", value)}
                  />
                  {sourceHasRgbComponents && (
                    <RangeField
                      id="viewer-saturation"
                      label="Saturation"
                      value={viewerDisplay.saturation}
                      min={0}
                      max={200}
                      step={1}
                      suffix="%"
                      disabled={viewerControlsDisabled}
                      onChange={(value) => updateViewerDisplay("saturation", value)}
                    />
                  )}
                  <div className="viewer-display-note">
                    <ShieldCheck size={12} />
                    <span>
                      The canvas and full-resolution rendered export use the same display recipe. Hold Original in the canvas toolbar to compare against the untouched preview.
                    </span>
                  </div>
                </section>

                {sourceHasRgbComponents && (
                  <section className="inspector-section" aria-labelledby="rgb-components-heading">
                    <div className="section-title-row">
                      <h3 className="section-title" id="rgb-components-heading">RGB components</h3>
                      <span className="section-hint">Display only</span>
                    </div>
                    <div className="rgb-component-row" role="group" aria-label="Visible RGB components">
                      {(["red", "green", "blue"] as const).map((component) => (
                        <button
                          className={viewerDisplay[component] ? "is-active" : ""}
                          type="button"
                          key={component}
                          aria-pressed={viewerDisplay[component]}
                          disabled={viewerControlsDisabled}
                          onClick={() => updateViewerDisplay(component, !viewerDisplay[component])}
                        >
                          <span className={`rgb-swatch is-${component}`} aria-hidden="true" />
                          {component[0].toUpperCase()}
                        </button>
                      ))}
                    </div>
                    <p className="section-footnote">
                      Interleaved RGB colour components, typical of brightfield image exports. They are not stains, biomarkers, or biological fluorescence channels.
                    </p>
                  </section>
                )}

                <section className={`inspector-section ${!activeSource ? "is-disabled" : ""}`} aria-labelledby="metadata-heading">
                  <div className="section-title-row">
                    <h3 className="section-title" id="metadata-heading">Image information</h3>
                    <span className="section-hint">From file</span>
                  </div>
                  {activeSource ? (
                    <dl className="metadata-list">
                      <div><dt>Dimensions</dt><dd>{formatDimensions(activeSource)}</dd></div>
                      <div>
                        <dt>Samples</dt>
                        <dd>
                          {activeSource.colorModel === "channel-composite"
                            ? `${activeSource.channels ?? 0} source channels · composite`
                            : activeSource.channels === 1
                            ? "Single intensity"
                            : activeSource.channels === 4
                              ? "RGBA interleaved"
                              : activeSource.channels === 3
                                ? "RGB interleaved"
                                : activeSource.channels !== undefined
                                  ? `${activeSource.channels} channels`
                                  : "Inspecting…"}
                        </dd>
                      </div>
                      <div><dt>Data type</dt><dd>{activeSource.dtype ?? "Inspecting…"}</dd></div>
                      <div><dt>Format</dt><dd>{formatFormat(activeSource) || "Inspecting…"}</dd></div>
                      {imsDetails && (
                        <>
                          <div>
                            <dt>Source volume</dt>
                            <dd>{imsDetails.width.toLocaleString()} × {imsDetails.height.toLocaleString()} × {imsDetails.depth.toLocaleString()}</dd>
                          </div>
                          <div>
                            <dt>Acquisition</dt>
                            <dd>{imsDetails.channels} ch · {imsDetails.timepoints} timepoint{imsDetails.timepoints === 1 ? "" : "s"}</dd>
                          </div>
                          <div>
                            <dt>Pyramid</dt>
                            <dd>{imsDetails.resolutionLevels} levels · showing {imsDetails.selectedResolutionLevel + 1}</dd>
                          </div>
                          <div>
                            <dt>Overview plane</dt>
                            <dd>Z {imsDetails.selectedZ + 1}/{imsDetails.selectedLevelDepth}{imsDetails.samplingStride > 1 ? ` · ${imsDetails.samplingStride}× sampled` : ""}</dd>
                          </div>
                          <div>
                            <dt>Overview raster</dt>
                            <dd>{Math.ceil(imsDetails.selectedLevelWidth / imsDetails.samplingStride).toLocaleString()} × {Math.ceil(imsDetails.selectedLevelHeight / imsDetails.samplingStride).toLocaleString()} · {imsDetails.renderedDtype}</dd>
                          </div>
                          <div>
                            <dt>Channels</dt>
                            <dd title={imsDetails.channelNames.join(", ")}>{imsDetails.channelNames.join(", ")}</dd>
                          </div>
                          <div>
                            <dt>Composite</dt>
                            <dd>
                              {imsDetails.compositeMode === "rgb-components"
                                ? "Stored RGB components"
                                : imsDetails.compositeMode === "single-channel"
                                  ? "Single stored channel"
                                  : "Loci overview composite"}
                            </dd>
                          </div>
                          {imsDetails.compositeMode === "loci-overview-composite" && (
                            <div>
                              <dt>Composite basis</dt>
                              <dd title="The overview records whether each colour/range came from the container or a bounded Loci fallback.">
                                {imsDetails.channelColorSources.every((source) => source === "declared-base-colour")
                                  ? "Declared base colours"
                                  : "Includes Loci fallback colours"}
                                {" · "}
                                {imsDetails.channelRangeSources.every((source) => source === "stored-histogram-range")
                                  ? "stored histogram ranges"
                                  : "includes sampled display ranges"}
                              </dd>
                            </div>
                          )}
                          {imsDetails.voxelSize && (
                            <div>
                              <dt>Native voxel</dt>
                              <dd>{formatScientificValues(imsDetails.voxelSize)}{imsDetails.physicalUnit ? ` ${imsDetails.physicalUnit}` : ""}</dd>
                            </div>
                          )}
                          {imsDetails.physicalExtents && (
                            <div>
                              <dt>Physical extent</dt>
                              <dd title={imsDetails.physicalExtents.map(([minimum, maximum], axis) => `${"XYZ"[axis]} ${minimum}–${maximum}`).join(", ")}>
                                {formatScientificValues(imsDetails.physicalExtents.map(([minimum, maximum]) => maximum - minimum))}{imsDetails.physicalUnit ? ` ${imsDetails.physicalUnit}` : ""}
                              </dd>
                            </div>
                          )}
                        </>
                      )}
                      {tiffDetails && (
                        <>
                          <div>
                            <dt>Pyramid</dt>
                            <dd>{tiffDetails.resolutionLevels} levels · showing {tiffDetails.selectedResolutionLevel + 1}</dd>
                          </div>
                          <div>
                            <dt>Overview raster</dt>
                            <dd>{tiffDetails.selectedLevelWidth.toLocaleString()} × {tiffDetails.selectedLevelHeight.toLocaleString()} · {tiffDetails.dtype}</dd>
                          </div>
                          <div>
                            <dt>Storage</dt>
                            <dd>{tiffDetails.tiled ? "Tiled pyramid" : "Pyramid"}{tiffDetails.selectedLevelTiled ? " · tiled overview" : ""}</dd>
                          </div>
                        </>
                      )}
                      {displayStatistics && (
                        <>
                          <div>
                            <dt>Display basis</dt>
                            <dd>{displayStatistics.displayMinimum.toLocaleString()}–{displayStatistics.displayMaximum.toLocaleString()} {displayStatisticsUnit}</dd>
                          </div>
                          <div>
                            <dt>Sampled range</dt>
                            <dd title={displayStatisticsUseCompositeUnits
                              ? `Observed across ${displayStatistics.sampleCount.toLocaleString()} sampled pixels of the rendered overview composite; not native channel extrema.`
                              : `Observed across ${displayStatistics.sampleCount.toLocaleString()} sampled source pixels; not guaranteed raw extrema.`}>
                              {displayStatistics.sourceMinimum.toLocaleString()}–{displayStatistics.sourceMaximum.toLocaleString()} {displayStatisticsUnit}
                            </dd>
                          </div>
                        </>
                      )}
                    </dl>
                  ) : (
                    <div className="empty-result">Import an image to inspect its technical metadata.</div>
                  )}
                </section>

                <section className={`inspector-section ${!activeSource ? "is-disabled" : ""}`} aria-labelledby="viewer-output-heading">
                  <div className="section-title-row">
                    <h3 className="section-title" id="viewer-output-heading">Output</h3>
                    <span className="section-hint">{overviewOnly ? "Overview plane" : "Full resolution"}</span>
                  </div>
                  <div className="field">
                    <label className="field-label" htmlFor="viewer-export-format">Rendered image format</label>
                    <div className="select-shell">
                      <select
                        id="viewer-export-format"
                        value={viewerExportFormat}
                        disabled={viewerExportDisabled}
                        onChange={(event) => setViewerExportFormat(event.currentTarget.value as ViewerExportFormat)}
                      >
                        <option value="tiff">TIFF · 16-bit rendered view</option>
                        <option value="png">PNG · 8-bit rendered view</option>
                      </select>
                      <ChevronDown size={13} />
                    </div>
                  </div>
                  <p className="section-footnote">
                    {overviewOnly
                      ? "Export is disabled for overviews until Loci can publish a native plane or tiled source faithfully."
                      : "Renders the complete image from source pixels with the current display recipe. Segmentation is not required."}
                  </p>
                </section>
              </>
            ) : (
              <>
            <section className={`inspector-section ${!activeSource ? "is-disabled" : ""}`} aria-labelledby="display-heading">
              <div className="section-title-row">
                <h3 className="section-title" id="display-heading">Display</h3>
                <span className="section-hint">Review only</span>
              </div>
              <Toggle label="Show segmentation" checked={overlayVisible} disabled={!activeResult} onChange={setOverlayVisible} />
              <RangeField
                id="overlay-opacity"
                label="Overlay opacity"
                value={Math.round(overlayOpacity * 100)}
                min={0}
                max={100}
                step={1}
                suffix="%"
                disabled={!activeResult}
                onChange={(value) => setOverlayOpacity(value / 100)}
              />
            </section>

            <section className={`inspector-section ${!activeSource ? "is-disabled" : ""}`} aria-labelledby="segmentation-heading">
              <div className="section-title-row">
                <h3 className="section-title" id="segmentation-heading">Segmentation</h3>
                <span className="section-hint">
                  {selectedProfile ? `v${selectedProfile.version}` : "Built in"}
                </span>
              </div>

              <div className="field model-selector-field">
                <label className="field-label" htmlFor="segmentation-model">Segmentation model</label>
                <div className="select-shell">
                  <select
                    id="segmentation-model"
                    value={selectedProfileId}
                    disabled={isWorkspaceBusy || !profilesLoaded}
                    onChange={(event) => {
                      const nextProfileId = event.currentTarget.value;
                      const profile = profiles.find((candidate) => candidate.id === nextProfileId);
                      if (!profile || profile.id === selectedProfileId) return;
                      void (async () => {
                        if (!await invalidateResultsForConfigurationChange()) return;
                        setSelectedProfileId(profile.id);
                        setSettings(structuredClone(profile.recommendedSettings));
                        setOpenModelSections(new Set(["Input", "Mask filtering", "Dynamics"]));
                        setCorrectionTool("navigate");
                        setDrawPoints([]);
                      })();
                    }}
                  >
                    {profiles.length ? profiles.map((profile) => (
                      <option value={profile.id} key={profile.id}>
                        {profile.id === "cellpose-sam" ? "Cellpose-SAM" : profile.name}
                        {profile.id === "cellpose-sam" ? " · Website-compatible default" : ""}
                        {profile.status !== "ready" ? " · Setup required" : ""}
                      </option>
                    )) : (
                      <option value="loci-classical">Loci Adaptive Watershed</option>
                    )}
                  </select>
                  <ChevronDown size={13} />
                </div>
              </div>

              {selectedModelManifest && (
                <ModelTrustCard model={selectedModelManifest} />
              )}

              {selectedProfile && selectedProfile.status !== "ready" && (
                <div className="model-availability-callout" role="status">
                  <AlertTriangle size={13} />
                  <div>
                    <strong>Setup required</strong>
                    <span>{selectedProfile.availability.summary}</span>
                    {selectedCellposeProfileId && (
                      <>
                        <span className="cellpose-model-meta">
                          {selectedProfile.model.artifactId ?? "Cellpose checkpoint"} · 1.23 GB · verified by SHA-256
                          {cellposeStatus?.model.verified ? " · installed" : ""}
                        </span>
                        <span className="cellpose-model-guide">
                          Save the official file in Loci's download folder, then import it for verification. The verified model is stored separately.
                        </span>
                        <div className="model-setup-actions">
                          <button
                            className="button button-quiet"
                            type="button"
                            onClick={() => void openCellposeModelFolder()}
                          >
                            <FolderOpen size={12} />
                            Download folder
                          </button>
                          <button
                            className="button button-quiet"
                            type="button"
                            onClick={() => void api?.openCellposeModelPage(selectedCellposeProfileId)}
                          >
                            <ExternalLink size={12} />
                            Official checkpoint
                          </button>
                          <button
                            className="button"
                            type="button"
                            disabled={isWorkspaceBusy}
                            onClick={() => void importCellposeModel()}
                          >
                            {isImportingModel ? <LoaderCircle className="loader" size={12} /> : <FileUp size={12} />}
                            {isImportingModel ? "Verifying…" : cellposeStatus?.model.present ? "Replace checkpoint" : "Import checkpoint"}
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}

              {isCellposeProfile ? (
                <div className="model-settings">
                  {settingsBySection.map(([section, definitions]) => (
                    <details
                      className="model-settings-group"
                      key={section}
                      open={openModelSections.has(section)}
                      onToggle={(event) => {
                        const isOpen = event.currentTarget.open;
                        setOpenModelSections((current) => {
                          if (current.has(section) === isOpen) return current;
                          const next = new Set(current);
                          if (isOpen) next.add(section);
                          else next.delete(section);
                          return next;
                        });
                      }}
                    >
                      <summary>{section}<span>{definitions.length}</span></summary>
                      <div className="model-settings-fields">
                        {definitions.map((definition) => (
                          <ContractSettingControl
                            key={definition.key}
                            definition={definition}
                            value={(settings as unknown as Record<string, unknown>)[definition.key]}
                            disabled={controlsDisabled}
                            onChange={(value) => updateContractSetting(definition.key, value)}
                          />
                        ))}
                      </div>
                    </details>
                  ))}
                </div>
              ) : (
                <>
                  <div className="field">
                    <label className="field-label" htmlFor="image-mode">Imaging preset</label>
                    <div className="select-shell">
                      <select
                        id="image-mode"
                        value={classicalSettings.image_mode}
                        disabled={controlsDisabled}
                        onChange={(event) => updateSettings("image_mode", event.currentTarget.value as SegmentationSettings["image_mode"])}
                      >
                        <option value="auto">Auto detect</option>
                        <option value="brightfield">Brightfield</option>
                        <option value="fluorescence">Fluorescence</option>
                      </select>
                      <ChevronDown size={13} />
                    </div>
                  </div>

                  <div className="field">
                    <label className="field-label" htmlFor="polarity">Cell polarity</label>
                    <div className="select-shell">
                      <select
                        id="polarity"
                        value={classicalSettings.polarity}
                        disabled={controlsDisabled}
                        onChange={(event) => updateSettings("polarity", event.currentTarget.value as SegmentationSettings["polarity"])}
                      >
                        <option value="auto">Auto detect</option>
                        <option value="dark">Dark cells</option>
                        <option value="bright">Bright cells</option>
                      </select>
                      <ChevronDown size={13} />
                    </div>
                  </div>

                  <RangeField id="expected-diameter" label="Expected diameter" value={classicalSettings.expected_diameter_px} min={4} max={240} step={1} suffix=" px" disabled={controlsDisabled} onChange={(value) => updateSettings("expected_diameter_px", value)} />
                  <RangeField id="minimum-area" label="Minimum cell area" value={classicalSettings.min_area_px} min={1} max={1500} step={1} suffix=" px²" disabled={controlsDisabled} onChange={(value) => updateSettings("min_area_px", value)} />
                  <RangeField id="sensitivity" label="Sensitivity" value={classicalSettings.sensitivity} min={-1} max={1} step={0.05} disabled={controlsDisabled} onChange={(value) => updateSettings("sensitivity", value)} />
                  <RangeField id="smoothing" label="Edge smoothing" value={classicalSettings.smoothing_px} min={0} max={8} step={0.1} suffix=" px" disabled={controlsDisabled} onChange={(value) => updateSettings("smoothing_px", value)} />

                  <div className="field">
                    <Toggle label="Split touching cells" checked={classicalSettings.split_touching} disabled={controlsDisabled} onChange={(checked) => updateSettings("split_touching", checked)} />
                    <Toggle label="Exclude border cells" checked={classicalSettings.exclude_border} disabled={controlsDisabled} onChange={(checked) => updateSettings("exclude_border", checked)} />
                  </div>
                </>
              )}
            </section>

            <section className="results-block" aria-labelledby="results-heading">
              <div className="section-title-row">
                <h3 className="section-title" id="results-heading">Result</h3>
                {activeResult && (
                  <span
                    className={`quality-badge is-${activeResult.quality.status}`}
                    title="Automated structural sanity check only"
                  >
                    {activeResult.quality.status === "invalid"
                      ? "Not usable"
                      : activeResult.quality.status === "warning"
                        ? "Sanity warning"
                        : "No structural flags"}
                  </span>
                )}
              </div>
              {activeResult ? (
                <>
                  {activeResult.quality.status === "invalid" && (
                    <div className="quality-callout is-invalid" role="alert">
                      <AlertTriangle size={15} />
                      <div>
                        <strong>Result not usable</strong>
                        <span>The mask failed structural sanity checks. Adjust settings and run again.</span>
                      </div>
                    </div>
                  )}
                  <div
                    className={`result-provenance ${resultConfigurationMatchesControls ? "" : "is-different"}`}
                    aria-label="Result provenance"
                  >
                    <div className="result-provenance-row">
                      <span>Displayed result</span>
                      <strong title={`Profile ${activeResult.profile.id}`}>
                        {activeResult.profile.name} · v{activeResult.profile.version}
                      </strong>
                    </div>
                    <div className="result-provenance-row">
                      <span>Next run</span>
                      <strong>{selectedProfile?.name ?? selectedProfileId}</strong>
                    </div>
                    <p>
                      {resultConfigurationMatchesControls
                        ? "Current model and settings match this displayed result."
                        : "Run again uses the current model and settings above. This displayed result remains unchanged until a new run finishes."}
                    </p>
                    <details className="result-settings-disclosure">
                      <summary>
                        Saved result settings
                        <span>
                          {savedResultSettings.length.toLocaleString()}
                          <ChevronDown size={11} aria-hidden="true" />
                        </span>
                      </summary>
                      <dl>
                        {savedResultSettings.map(([key, value]) => (
                          <div key={key}>
                            <dt>{settingLabel(key)}</dt>
                            <dd>{settingValue(value)}</dd>
                          </div>
                        ))}
                      </dl>
                    </details>
                  </div>
                  <div className="metric-line">
                    <span className="metric-label">Cell count</span>
                    <span className="metric-stack">
                      <span className={`metric-value ${activeResult.quality.status === "invalid" ? "is-invalid" : ""}`}>
                        {activeResult.metrics.count.toLocaleString()}
                      </span>
                      {activeResult.quality.status === "invalid" && <span className="metric-usability">not usable</span>}
                    </span>
                  </div>
                  <div className="metric-line">
                    <span className="metric-label">Mask coverage</span>
                    <span className="metric-value is-small">{activeResult.metrics.confluencePercent.toFixed(1)}%</span>
                  </div>
                  <div className="metric-line">
                    <span className="metric-label">{activeResult.runtime ? "Compute device" : "Resolved polarity"}</span>
                    <span className="metric-value is-small">
                      {activeResult.runtime ? activeResult.runtime.resolvedDevice.toUpperCase() : activeResult.resolved.polarity}
                    </span>
                  </div>
                  {activeResult.runtime?.fallbackReason && (
                    <div className="runtime-note">
                      <Info size={11} />
                      <span>{activeResult.runtime.fallbackReason}</span>
                    </div>
                  )}
                  {activeResult.quality.flags.length > 0 && (
                    <ul className={`quality-flags is-${activeResult.quality.status}`} aria-label="Structural sanity findings">
                      {activeResult.quality.flags.map((flag) => (
                        <li key={`${flag.code}-${flag.message}`}>
                          <AlertTriangle size={11} />
                          <span>{flag.message}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="review-note">
                    <Info size={12} />
                    <span>Review boundaries before using any count.</span>
                  </div>
                </>
              ) : (
                <div className="empty-result">
                  {activeSource
                    ? "Run segmentation to create a reviewable count and boundary overlay."
                    : "Select or import an image to configure an analysis."}
                </div>
              )}
            </section>
              </>
            )}
          </div>

          <footer className="inspector-footer">
            {workspaceMode === "review" ? (
              <div className="action-row">
                <button
                  className="button button-primary button-grow"
                  type="button"
                  disabled={
                    !activeReviewItem?.result ||
                    activeReviewItem.result.quality.status === "invalid" ||
                    activeReviewItem.reviewStatus === "reviewed" ||
                    isWorkspaceBusy
                  }
                  onClick={() => decideActiveReview("reviewed")}
                >
                  <Check size={14} />
                  {activeReviewItem?.reviewStatus === "reviewed" ? "Reviewed" : "Mark reviewed"}
                </button>
                <button
                  className="button icon-button"
                  type="button"
                  title="Exclude selected result from reviewed counts"
                  aria-label="Exclude selected result"
                  disabled={!activeReviewItem?.result || activeReviewItem.reviewStatus === "excluded" || isWorkspaceBusy}
                  onClick={() => decideActiveReview("excluded")}
                >
                  <Ban size={14} />
                </button>
              </div>
            ) : workspaceMode === "view" ? (
              <div className="action-row">
                <button className="button button-primary button-grow" type="button" onClick={() => void exportActiveView()} disabled={viewerExportDisabled} title={overviewOnly ? activeSource?.viewOnlyReason : undefined}>
                  {isExporting ? <LoaderCircle className="loader" size={14} /> : <Download size={14} />}
                  {isExporting ? "Exporting…" : "Export view"}
                </button>
                <button className="button icon-button" type="button" title="Reset display" aria-label="Reset display" onClick={resetViewerDisplay} disabled={viewerControlsDisabled}>
                  <RotateCcw size={13} />
                </button>
              </div>
            ) : (
              <div className="action-row">
              {isRunning ? (
                <button className="button button-danger-quiet button-grow" type="button" onClick={() => void cancelSegmentation()} disabled={isCancelling}>
                  {isCancelling ? <LoaderCircle className="loader" size={14} /> : <X size={14} />}
                  {isCancelling ? "Cancelling…" : runProgress?.mode === "batch" ? "Stop batch" : "Cancel analysis"}
                </button>
              ) : (
                <button
                  aria-label={activeResult ? "Run again" : "Run segmentation"}
                  className="button button-primary button-grow"
                  type="button"
                  onClick={() => void runSegmentation()}
                  disabled={!activeSource || overviewOnly || !isDesktopAvailable || !selectedProfileReady || isWorkspaceBusy}
                >
                  {activeResult ? <RotateCcw size={14} /> : <Layers3 size={14} />}
                  {activeResult ? "Run again" : "Run segmentation"}
                  <span className="shortcut">⌘↵</span>
                </button>
              )}
              <button
                className="button icon-button"
                type="button"
                title="Export result"
                aria-label="Export result"
                disabled={!activeResult || isWorkspaceBusy}
                onClick={() => void exportActiveResult()}
              >
                {isExporting ? <LoaderCircle className="loader" size={15} /> : <Download size={15} />}
              </button>
              </div>
            )}
          </footer>
        </aside>
      </div>

      <footer className="statusbar">
        <JobCenter
          jobs={jobs}
          onRetry={retryDurableBatch}
          retryableJobIds={recoverableBatches.map((batch) => batch.parentJobId)}
        />
        <div className="status-cluster">
          {activeSource && (
            <>
              <span className="status-item">
                {formatDimensions(activeSource)}
                {activeSource.dtype ? ` · ${activeSource.dtype}` : ""}
              </span>
              <span className="status-separator" aria-hidden="true" />
            </>
          )}
          {activeResult && (
            <>
              <span className={`status-item ${activeResult.quality.status === "invalid" ? "status-invalid" : ""}`}>
                {activeResult.metrics.count.toLocaleString()} cells
              </span>
              <span className="status-separator" aria-hidden="true" />
            </>
          )}
          <span className="status-item"><Info size={10} style={{ verticalAlign: -1, marginRight: 4 }} />Research use</span>
        </div>
      </footer>

      {sourceMenu && sourceMenuSource && (
        <div
          ref={sourceMenuRef}
          className="source-context-menu"
          role="menu"
          aria-label={`Actions for ${sourceMenuSource.name}`}
          style={{ left: sourceMenu.x, top: sourceMenu.y }}
        >
          <div className="context-menu-heading" title={sourceMenuSource.relativePath}>
            {sourceMenuSource.name}
          </div>
          <button type="button" role="menuitem" onClick={() => void revealSource(sourceMenu.sourceId)}>
            <FolderSearch size={14} />
            Reveal in Finder
          </button>
          {results[sourceMenu.sourceId] && (
            <button type="button" role="menuitem" onClick={() => void clearSourceResult(sourceMenu.sourceId)}>
              <RotateCcw size={14} />
              Clear result
            </button>
          )}
          <div className="context-menu-separator" />
          <button
            className="is-destructive"
            type="button"
            role="menuitem"
            onClick={() => void removeSource(sourceMenu.sourceId)}
          >
            <Trash2 size={14} />
            Remove from Loci
          </button>
        </div>
      )}

      {settingsDialog}
    </main>
  );
}
