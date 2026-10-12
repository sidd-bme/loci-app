import {
  ArrowLeftToLine,
  ExternalLink,
  Focus,
  Maximize2,
  Minimize2,
  Pin,
  PinOff,
  RefreshCw,
  Save,
  Unplug,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ImageWindowApi,
  ImageWindowEntry,
  ImageWindowInteraction,
  ImageWindowPresentation,
  ImageWindowState,
} from "../shared/image-window-api";
import type { ImageViewTargetSnapshot } from "../shared/image-view-contracts";
import type {
  ResearchDesktopApi,
  ResearchDimensions,
  ResearchSelection,
  ResearchSnapshot,
  ResearchSource,
} from "../shared/research-contracts";
import { SourceAnnotationPanel, type AnnotationTool } from "./SourceAnnotationPanel";
import type { SourceInterpretation } from "./SourceDisplayPanel";
import type { ImageAnnotation, ImagePoint, ViewerChannel } from "./ImageViewport";
import type { UserPreferences } from "./preferences";
import { rawVolumeUnavailableReason } from "./raw-volume-eligibility";
import type { Camera } from "./viewer-camera";
import "./detached-windows.css";

type InteractionEnvelope = {
  serial: number;
  target: ImageViewTargetSnapshot;
  interaction: ImageWindowInteraction;
};

type SavedView = {
  source_id?: string;
  source_sha256?: string;
  revision?: number;
  state?: {
    channels?: unknown;
    projection?: unknown;
    selection?: unknown;
    camera?: unknown;
    interpretation?: unknown;
    volumeDisplay?: unknown;
  } | null;
};

type VolumeDisplay = NonNullable<ImageWindowPresentation["volumeDisplay"]>;

const INTERPRETATIONS: Array<{ value: SourceInterpretation; label: string }> = [
  { value: "auto", label: "Automatic" },
  { value: "generic", label: "Generic image" },
  { value: "histology", label: "Histology" },
  { value: "fluorescence", label: "Fluorescence" },
  { value: "volume", label: "Volume" },
  { value: "medical", label: "Medical research" },
];

const VOLUME_RENDER_MODES: Array<{ value: VolumeDisplay["renderMode"]; label: string }> = [
  { value: "blend", label: "Composite blend" },
  { value: "normal_shading", label: "Shaded volume" },
  { value: "mip", label: "Maximum intensity" },
  { value: "average", label: "Average intensity" },
  { value: "minip", label: "Minimum intensity" },
];

function targetKey(target: ImageViewTargetSnapshot | null): string {
  return target ? [target.viewId, target.sessionEpoch, target.generation, target.sourceId,
    target.sourceSha256, target.resultId ?? "", target.resultRevisionHash ?? ""].join(":") : "";
}

function sameTarget(left: ImageViewTargetSnapshot | null, right: ImageViewTargetSnapshot | null): boolean {
  return targetKey(left) === targetKey(right);
}

function safeMessage(error: unknown, fallback: string): string {
  const value = error instanceof Error ? error.message : typeof error === "string" ? error : fallback;
  return value.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "")
    .replace(/\/?(?:Users|Volumes)\/[^\s]+/gu, "selected source").slice(0, 1000);
}

function dimensions(source: ResearchSource): ResearchDimensions {
  if (source.metadata.dimensions) return source.metadata.dimensions;
  const shape = source.metadata.shape ?? [];
  return {
    t: 1,
    c: 1,
    z: shape.length === 3 ? shape[0] : 1,
    y: shape.at(-2) ?? 1,
    x: shape.at(-1) ?? 1,
  };
}

function defaultSelection(source: ResearchSource): ResearchSelection {
  const value = dimensions(source);
  return {
    x: 0,
    y: 0,
    width: value.x,
    height: value.y,
    t: 0,
    c: 0,
    z: Math.floor(value.z / 2),
    level: 0,
  };
}

function isRgbSource(source: ResearchSource): boolean {
  return source.metadata.sample_semantics === "RGB" || source.metadata.sample_semantics === "RGBA";
}

function validatedChannel(candidate: unknown, source: ResearchSource, seen: Set<number>): ViewerChannel {
  if (!candidate || typeof candidate !== "object") {
    throw new Error("Display settings contain an invalid channel.");
  }
  const sourceDimensions = dimensions(source);
  const channel = candidate as Partial<ViewerChannel>;
  const maximumChannel = isRgbSource(source) ? 1 : sourceDimensions.c;
  const lowIsValid = channel.low === undefined || typeof channel.low === "number" && Number.isFinite(channel.low);
  const highIsValid = channel.high === undefined || typeof channel.high === "number" && Number.isFinite(channel.high);
  if (!Number.isInteger(channel.channel) || channel.channel! < 0 || channel.channel! >= maximumChannel ||
    seen.has(channel.channel!) || !lowIsValid || !highIsValid ||
    (channel.low === undefined) !== (channel.high === undefined) ||
    (channel.low !== undefined && channel.high !== undefined && channel.high <= channel.low) ||
    typeof channel.gamma !== "number" || !Number.isFinite(channel.gamma) || channel.gamma <= 0 ||
    typeof channel.visible !== "boolean" || typeof channel.color !== "string" ||
    !/^#[0-9a-f]{6}$/iu.test(channel.color) ||
    (channel.opacity !== undefined && (typeof channel.opacity !== "number" ||
      !Number.isFinite(channel.opacity) || channel.opacity < 0 || channel.opacity > 1))) {
    throw new Error("Display settings contain an invalid channel.");
  }
  seen.add(channel.channel!);
  return {
    channel: channel.channel!,
    ...(channel.low === undefined ? {} : { low: channel.low }),
    ...(channel.high === undefined ? {} : { high: channel.high }),
    gamma: channel.gamma,
    visible: channel.visible,
    color: channel.color,
    ...(channel.opacity === undefined ? {} : { opacity: channel.opacity }),
  };
}

function validatedChannels(value: unknown, source: ResearchSource): ViewerChannel[] {
  const expectedChannelCount = isRgbSource(source) ? 1 : dimensions(source).c;
  if (!Array.isArray(value) || value.length !== expectedChannelCount) {
    throw new Error("Display settings do not match this source's channels.");
  }
  const seen = new Set<number>();
  const channels = value.map((candidate) => validatedChannel(candidate, source, seen));
  return channels.sort((left, right) => left.channel - right.channel);
}

function validatedChannelSubset(value: unknown, source: ResearchSource): ViewerChannel[] {
  if (!Array.isArray(value)) throw new Error("Volume display channels are invalid.");
  const seen = new Set<number>();
  return value.map((candidate) => validatedChannel(candidate, source, seen));
}

function validInterpretation(value: unknown): value is SourceInterpretation {
  return INTERPRETATIONS.some((item) => item.value === value);
}

function validatedVolumeDisplay(value: unknown): VolumeDisplay {
  if (value === undefined || value === null) return { renderMode: "blend", quality: 50 };
  if (!value || typeof value !== "object") throw new Error("Saved volume display settings are invalid.");
  const display = value as Partial<VolumeDisplay>;
  if (!VOLUME_RENDER_MODES.some((item) => item.value === display.renderMode) ||
    !Number.isInteger(display.quality) || display.quality! < 10 || display.quality! > 100) {
    throw new Error("Saved volume display settings are invalid.");
  }
  return { renderMode: display.renderMode!, quality: display.quality! };
}

function NumberSetting({ label, value, onValue, minimum, maximum }: {
  label: string;
  value: number;
  onValue: (value: number) => boolean;
  minimum?: number;
  maximum?: number;
}) {
  const [text, setText] = useState(String(value));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setText(String(value));
    setInvalid(false);
  }, [value]);
  const commit = () => {
    const number = Number(text);
    if (!text.trim() || !Number.isFinite(number) || minimum !== undefined && number < minimum ||
      maximum !== undefined && number > maximum || !onValue(number)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
  };
  return <input aria-label={label} aria-invalid={invalid} inputMode="decimal" value={text}
    title={invalid ? "Enter a finite value within the displayed range" : label}
    onChange={(event) => setText(event.target.value)} onBlur={commit}
    onKeyDown={(event) => {
      if (event.key === "Enter") {
        commit();
        event.currentTarget.blur();
      }
    }} />;
}

function validatedSelection(value: unknown, source: ResearchSource): ResearchSelection {
  if (!value || typeof value !== "object") throw new Error("Saved display coordinates are invalid.");
  const selection = value as Partial<ResearchSelection>;
  const d = dimensions(source);
  const integers = [selection.x, selection.y, selection.width, selection.height, selection.t,
    selection.c, selection.z, selection.level];
  if (integers.some((item) => !Number.isInteger(item)) || selection.x! < 0 || selection.y! < 0 ||
    selection.width! < 1 || selection.height! < 1 || selection.x! + selection.width! > d.x ||
    selection.y! + selection.height! > d.y || selection.t! < 0 || selection.t! >= d.t ||
    selection.c! < 0 || selection.c! >= d.c || selection.z! < 0 || selection.z! >= d.z ||
    selection.level! < 0 || (selection.z_stop !== undefined &&
      (!Number.isInteger(selection.z_stop) || selection.z_stop <= selection.z! || selection.z_stop > d.z))) {
    throw new Error("Saved display coordinates are outside this source.");
  }
  return { ...selection } as ResearchSelection;
}

function validatedCamera(value: unknown): Camera | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object") throw new Error("Saved camera is invalid.");
  const camera = value as Partial<Camera>;
  if (![camera.x, camera.y, camera.scale].every((item) => typeof item === "number" && Number.isFinite(item)) ||
    camera.scale! <= 0) throw new Error("Saved camera is invalid.");
  return { x: camera.x!, y: camera.y!, scale: camera.scale! };
}

function validProjection(value: unknown): value is ImageWindowPresentation["projection"] {
  return value === "plane" || value === "max" || value === "mean";
}

function boundAnnotationApi(
  api: ImageWindowApi,
  researchApi: ResearchDesktopApi,
  entry: ImageWindowEntry,
): ResearchDesktopApi {
  const target = entry.target;
  const validateBinding = (binding: { source_id: string; source_sha256: string }) => {
    if (binding.source_id !== entry.source.id || binding.source_sha256 !== entry.source.sha256) {
      throw new Error("The annotation transfer does not match this view's source.");
    }
  };
  return {
    execute: (operation, request, options) => {
      if (operation !== "source_annotations" && operation !== "annotate_source") {
        return Promise.reject(new Error(`Detached controls cannot run ${operation}.`));
      }
      if (request.source_id !== entry.source.id ||
        (operation === "annotate_source" && request.source_sha256 !== entry.source.sha256)) {
        return Promise.reject(new Error("The annotation request does not match this view's source."));
      }
      return api.execute(target, operation, request, options);
    },
    ...(researchApi.exportSourceAnnotations ? {
      exportSourceAnnotations: async (binding) => {
        validateBinding(binding);
        return researchApi.exportSourceAnnotations!(binding);
      },
    } : {}),
    ...(researchApi.importSourceAnnotations ? {
      importSourceAnnotations: async (binding) => {
        validateBinding(binding);
        return researchApi.importSourceAnnotations!(binding);
      },
    } : {}),
  } as ResearchDesktopApi;
}

function ViewController({ api, researchApi, entry, active, interaction, cameraInteraction, volumeDisplayInteraction,
  errorInteraction, preferences }: {
  api: ImageWindowApi;
  researchApi: ResearchDesktopApi;
  entry: ImageWindowEntry;
  active: boolean;
  interaction?: InteractionEnvelope;
  cameraInteraction?: InteractionEnvelope;
  volumeDisplayInteraction?: InteractionEnvelope;
  errorInteraction?: InteractionEnvelope;
  preferences: UserPreferences;
}) {
  const sourceDimensions = useMemo(() => dimensions(entry.source), [entry.source.id, entry.source.sha256]);
  const [selection, setSelection] = useState<ResearchSelection>(() => defaultSelection(entry.source));
  const [channels, setChannels] = useState<ViewerChannel[]>([]);
  const [projection, setProjection] = useState<ImageWindowPresentation["projection"]>("plane");
  const [mode, setMode] = useState<ImageWindowPresentation["mode"]>("plane");
  const [interpretation, setInterpretation] = useState<SourceInterpretation>("auto");
  const [volumeDisplay, setVolumeDisplay] = useState<VolumeDisplay>({ renderMode: "blend", quality: 50 });
  const [tool, setTool] = useState<AnnotationTool>("navigate");
  const [draft, setDraft] = useState<ImagePoint[]>([]);
  const [annotations, setAnnotations] = useState<ImageAnnotation[]>([]);
  const [camera, setCamera] = useState<Camera | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hydrateAttempt, setHydrateAttempt] = useState(0);
  const [annotationAttempt, setAnnotationAttempt] = useState(0);
  const [annotationError, setAnnotationError] = useState<string | null>(null);
  const [annotationStatus, setAnnotationStatus] = useState("");
  const [displayValidation, setDisplayValidation] = useState<string | null>(null);
  const hydrateToken = useRef(0);
  const publishToken = useRef(0);
  const preservedDraft = useRef<ImagePoint[] | null>(null);
  const publishQueue = useRef<{
    running: boolean;
    pending: { token: number; target: ImageViewTargetSnapshot; presentation: ImageWindowPresentation } | null;
  }>({ running: false, pending: null });
  const annotationApi = useMemo(
    () => boundAnnotationApi(api, researchApi, entry),
    [api, researchApi, targetKey(entry.target)],
  );
  const reportAnnotationError = useCallback((message: string) => {
    setAnnotationError(message);
    setAnnotationStatus("");
  }, []);
  const updateDraft = useCallback((points: ImagePoint[]) => {
    if (preservedDraft.current && points.length === 0) return;
    setDraft(points);
  }, []);
  const updateAnnotations = useCallback((items: ImageAnnotation[]) => {
    setAnnotations(items);
    if (preservedDraft.current) {
      preservedDraft.current = null;
      setAnnotationStatus("Annotations reloaded. The unsaved draft was preserved; review it before saving.");
    }
    setAnnotationError(null);
  }, []);

  useEffect(() => {
    const token = ++hydrateToken.current;
    setLoading(true);
    setError(null);
    setSelection(defaultSelection(entry.source));
    setChannels([]);
    setProjection("plane");
    setMode("plane");
    setInterpretation("auto");
    setVolumeDisplay({ renderMode: "blend", quality: 50 });
    setTool("navigate");
    setDraft([]);
    setAnnotations([]);
    setCamera(null);
    void Promise.all([
      api.execute(entry.target, "viewer_defaults", {
        source_id: entry.source.id,
        t: 0,
        z: 0,
        auto: false,
      }),
      api.execute(entry.target, "source_view", { source_id: entry.source.id }),
    ]).then(([defaultsValue, savedValue]) => {
      if (hydrateToken.current !== token) return;
      const defaults = defaultsValue as { source_id?: string; source_sha256?: string; channels?: unknown };
      const saved = savedValue as SavedView;
      if (defaults.source_id !== entry.source.id || defaults.source_sha256 !== entry.source.sha256) {
        throw new Error("Display defaults do not match this view's source.");
      }
      if (saved.source_id !== entry.source.id || saved.source_sha256 !== entry.source.sha256 ||
        !Number.isInteger(saved.revision) || saved.revision! < 0) {
        throw new Error("Saved display settings do not match this view's source.");
      }
      const restored = entry.initialPresentation;
      const nextChannels = validatedChannels(restored?.channels ?? saved.state?.channels ?? defaults.channels, entry.source);
      const nextSelectionValue = restored?.selection ?? saved.state?.selection;
      const nextSelection = nextSelectionValue === undefined
        ? defaultSelection(entry.source)
        : validatedSelection(nextSelectionValue, entry.source);
      const nextProjection = restored?.projection ?? saved.state?.projection ?? "plane";
      if (!validProjection(nextProjection)) throw new Error("Saved projection is invalid.");
      const nextInterpretation = restored?.interpretation ?? saved.state?.interpretation ?? "auto";
      if (!validInterpretation(nextInterpretation)) throw new Error("Saved image interpretation is invalid.");
      const nextVolumeDisplay = validatedVolumeDisplay(restored?.volumeDisplay ?? saved.state?.volumeDisplay);
      const volumeAvailable = rawVolumeUnavailableReason(entry.source) === null;
      setChannels(nextChannels);
      setSelection(nextSelection);
      setProjection(nextProjection);
      setCamera(validatedCamera(restored?.camera !== undefined ? restored.camera : saved.state?.camera));
      setInterpretation(nextInterpretation);
      setVolumeDisplay(nextVolumeDisplay);
      setMode((restored?.mode ?? (saved.state?.interpretation === "volume" ? "volume" : "plane")) === "volume" && volumeAvailable
        ? "volume" : "plane");
      setLoading(false);
    }).catch((caught) => {
      if (hydrateToken.current !== token) return;
      setLoading(false);
      setError(safeMessage(caught, "Could not prepare this view's controls."));
    });
    return () => { if (hydrateToken.current === token) hydrateToken.current += 1; };
  }, [api, targetKey(entry.target), entry.source.id, entry.source.sha256, hydrateAttempt]);

  useEffect(() => {
    if (errorInteraction && sameTarget(errorInteraction.target, entry.target) && errorInteraction.interaction.kind === "error")
      setError(safeMessage(errorInteraction.interaction.message, "The image window reported an error."));
  }, [errorInteraction?.serial, targetKey(entry.target)]);

  useEffect(() => {
    if (!cameraInteraction || !sameTarget(cameraInteraction.target, entry.target) || cameraInteraction.interaction.kind !== "camera") return;
    const value = cameraInteraction.interaction.camera;
    if (![value.x, value.y, value.scale].every(Number.isFinite) || value.scale <= 0) {
      setError("The image window reported an invalid camera.");
      return;
    }
    setCamera((previous) => previous?.x === value.x && previous.y === value.y && previous.scale === value.scale ? previous : value);
  }, [cameraInteraction?.serial, targetKey(entry.target)]);

  useEffect(() => {
    if (!interaction || !sameTarget(interaction.target, entry.target) || interaction.interaction.kind !== "draft") return;
    if (interaction.interaction.plane.t !== selection.t || interaction.interaction.plane.z !== selection.z) {
      setAnnotationStatus("A draft from the previous plane was discarded. Draw on the current plane.");
      return;
    }
    const points = interaction.interaction.points;
    if (points.length > 2048 || points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y) ||
      point.x < 0 || point.y < 0 || point.x > sourceDimensions.x || point.y > sourceDimensions.y)) {
      setError("The image window reported invalid draft coordinates.");
      return;
    }
    setDraft(points);
  }, [interaction?.serial, targetKey(entry.target), sourceDimensions.x, sourceDimensions.y]);

  useEffect(() => {
    if (!volumeDisplayInteraction || !sameTarget(volumeDisplayInteraction.target, entry.target) ||
      volumeDisplayInteraction.interaction.kind !== "volume-display") return;
    try {
      const incoming = volumeDisplayInteraction.interaction;
      const subset = validatedChannelSubset(incoming.channels, entry.source);
      const nextDisplay = validatedVolumeDisplay({ renderMode: incoming.renderMode, quality: incoming.quality });
      setChannels((current) => current.map((channel) =>
        subset.find((candidate) => candidate.channel === channel.channel) ?? channel));
      setVolumeDisplay(nextDisplay);
    } catch (caught) {
      setError(safeMessage(caught, "The image window reported invalid volume display settings."));
    }
  }, [volumeDisplayInteraction?.serial, targetKey(entry.target), entry.source.id, entry.source.sha256]);

  const drainPublication = useCallback(async () => {
    const queue = publishQueue.current;
    if (queue.running) return;
    queue.running = true;
    try {
      while (queue.pending) {
        const item = queue.pending;
        queue.pending = null;
        try {
          await api.publish(item.target, item.presentation);
        } catch (caught) {
          if (publishToken.current === item.token) {
            setError(safeMessage(caught, "Could not update the image window."));
          }
        }
      }
    } finally {
      queue.running = false;
      if (queue.pending) void drainPublication();
    }
  }, [api]);

  useEffect(() => {
    if (loading || error || channels.length === 0 || entry.status !== "ready") return;
    const token = ++publishToken.current;
    publishQueue.current.pending = {
      token,
      target: entry.target,
      presentation: structuredClone({
        mode,
        interpretation,
        volumeDisplay,
        selection,
        channels,
        projection,
        tool,
        draft,
        annotations,
        camera,
        showScaleBar: preferences.viewer.showScaleBar,
        showNavigator: preferences.viewer.showNavigator,
      }),
    };
    void drainPublication();
  }, [loading, error, entry.status, targetKey(entry.target), mode, interpretation, volumeDisplay, selection, channels,
    projection, tool, draft, annotations, camera, preferences.viewer.showScaleBar,
    preferences.viewer.showNavigator, drainPublication]);

  const changeTool = useCallback((next: AnnotationTool) => {
    setTool(next);
    setDraft([]);
    if (next !== "navigate") {
      setMode("plane");
      setProjection("plane");
      setSelection((previous) => {
        const { z_stop: _zStop, ...plane } = previous;
        return plane;
      });
    }
  }, []);

  const updateChannel = (index: number, change: Partial<ViewerChannel>) => {
    setChannels((current) => {
      const selected = current.find((channel) => channel.channel === index);
      if (!selected) return current;
      const next = { ...selected, ...change };
      if (next.low !== undefined && next.high !== undefined && next.high <= next.low) {
        setDisplayValidation("Channel high must be greater than channel low. The previous valid range is still active.");
        return current;
      }
      if (!Number.isFinite(next.gamma) || next.gamma <= 0) {
        setDisplayValidation("Gamma must be a finite number greater than zero. The previous value is still active.");
        return current;
      }
      if (next.opacity !== undefined && (!Number.isFinite(next.opacity) || next.opacity < 0 || next.opacity > 1)) {
        setDisplayValidation("Opacity must be between zero and one. The previous value is still active.");
        return current;
      }
      setDisplayValidation(null);
      return current.map((channel) => channel.channel === index ? next : channel);
    });
  };
  const setAxis = (axis: "t" | "z", oneBased: number) => {
    const maximum = axis === "t" ? sourceDimensions.t : sourceDimensions.z;
    const value = Math.min(maximum - 1, Math.max(0, Math.round(oneBased) - 1));
    setSelection((previous) => ({
      ...previous,
      [axis]: value,
      ...(axis === "z" && previous.z_stop !== undefined ? { z_stop: sourceDimensions.z } : {}),
    }));
  };
  const volumeUnavailable = rawVolumeUnavailableReason(entry.source);
  const rgb = isRgbSource(entry.source);
  const rgbMaximum = entry.source.metadata.channel_dtypes?.[0] === "uint16" ? 65535 : 255;
  const medical = entry.source.source_kind === "medical" || interpretation === "medical";
  const showVolumeMode = !rgb && sourceDimensions.z > 1 && volumeUnavailable === null;
  const geometry = entry.source.metadata.geometry;
  const affine = geometry?.affine;
  const geometrySpacing = affine?.length === 4 && affine.every((row) => row.length === 4 && row.every(Number.isFinite))
    ? [0, 1, 2].map((column) => Math.hypot(affine[0][column], affine[1][column], affine[2][column])) : null;
  const calibration = geometrySpacing && geometrySpacing.every((value) => value > 0)
    ? { spacing: geometry?.axes === "YX" ? geometrySpacing.slice(0, 2) : geometrySpacing, unit: geometry?.unit }
    : entry.source.metadata.physical_calibration;
  const axes = entry.source.metadata.axes ?? entry.source.metadata.geometry?.axes ?? "Source grid";
  const modalityGuidance: Record<SourceInterpretation, string> = {
    auto: rgb
      ? `${entry.source.metadata.sample_semantics} is declared by the source. One display curve controls all colour samples.`
      : "Uses recorded source structure only; no stain, marker, or biological channel is inferred.",
    generic: "General display settings preserve the recorded source values and axes.",
    histology: "Presentation label only. No stain, tissue class, or diagnosis is inferred.",
    fluorescence: "Channel colours are display choices, not marker or fluorophore declarations.",
    volume: "Three-dimensional rendering uses the recorded scalar depth and source calibration.",
    medical: entry.source.metadata.geometry?.frame
      ? `${entry.source.metadata.geometry.frame} · recorded source coordinate frame. Research display only.`
      : "No patient coordinate frame is recorded; research display uses the source grid.",
  };

  return <section
    className="detached-view-controller"
    aria-label={`Controls for ${entry.label}`}
    data-view-id={entry.target.viewId}
    hidden={!active}
  >
    <header className="detached-controller-header">
      <div>
        <h2>{entry.label}</h2>
        <p>{entry.source.name}</p>
      </div>
      <span className={`detached-view-status is-${entry.status}`}>{entry.status}</span>
    </header>

    {loading && <div className="detached-controller-state" role="status">Loading source-bound display settings…</div>}
    {error && <div className="detached-controller-error" role="alert">
      <p>{error}</p>
      <button onClick={() => {
        setError(null);
        setLoading(true);
        setHydrateAttempt((attempt) => attempt + 1);
      }}><RefreshCw aria-hidden="true" /> Retry controls</button>
    </div>}

    {!loading && !error && channels.length > 0 && <div className="detached-controller-body">
      <section className="detached-settings" aria-labelledby={`display-${entry.target.viewId}`}>
        <div className="detached-section-heading">
          <div><h3 id={`display-${entry.target.viewId}`}>Display</h3><p>Source-bound settings for this view only.</p></div>
          {showVolumeMode && <div className="detached-mode-switch" aria-label={`${entry.label} image display mode`}>
            <button aria-pressed={mode === "plane"} onClick={() => setMode("plane")}>2D</button>
            <button aria-pressed={mode === "volume"} title="Show source-bound raw volume"
              onClick={() => setMode("volume")}>3D</button>
          </div>}
        </div>

        <div className="detached-source-summary">
          <dl>
            <div><dt>Grid</dt><dd>{sourceDimensions.x.toLocaleString()} × {sourceDimensions.y.toLocaleString()}
              {sourceDimensions.z > 1 ? ` × ${sourceDimensions.z.toLocaleString()} Z` : ""}
              {sourceDimensions.t > 1 ? ` · ${sourceDimensions.t.toLocaleString()} T` : ""}</dd></div>
            <div><dt>Axes</dt><dd>{axes}</dd></div>
            <div><dt>Samples</dt><dd>{rgb
              ? `${entry.source.metadata.sample_semantics} · one tone curve`
              : `${sourceDimensions.c} scalar ${sourceDimensions.c === 1 ? "channel" : "channels"}`}</dd></div>
            <div><dt>{geometrySpacing ? "Spacing (XYZ)" : "Calibration"}</dt><dd>{calibration?.spacing?.length
              ? `${calibration.spacing.map((value) => value.toLocaleString(undefined, { maximumSignificantDigits: 6 })).join(" × ")} ${calibration.unit ?? ""}`.trim()
              : "Not recorded"}</dd></div>
            {entry.source.metadata.geometry?.frame && <div><dt>Frame</dt><dd>{entry.source.metadata.geometry.frame}</dd></div>}
          </dl>
          <label>Open as
            <select aria-label={`${entry.label} Open as`} value={interpretation} onChange={(event) => {
              const next = event.target.value as SourceInterpretation;
              setInterpretation(next);
              if (next === "volume" && showVolumeMode) setMode("volume");
              else if (next !== "volume") setMode("plane");
            }}>
              {INTERPRETATIONS.map((item) => <option key={item.value} value={item.value}
                disabled={item.value === "volume" && !showVolumeMode}>{item.label}</option>)}
            </select>
          </label>
        </div>
        <p className="detached-modality-guidance">{modalityGuidance[interpretation]}</p>
        {!rgb && sourceDimensions.z > 1 && volumeUnavailable &&
          <p className="detached-field-note">3D display is unavailable: {volumeUnavailable}</p>}
        {displayValidation && <p className="detached-field-error" role="alert">{displayValidation}</p>}

        <div className="detached-axis-grid">
          {sourceDimensions.t > 1 && <label>Time
            <span><input aria-label={`${entry.label} time`} type="number" min={1} max={sourceDimensions.t}
              value={selection.t + 1} onChange={(event) => setAxis("t", Number(event.target.value))} /> / {sourceDimensions.t}</span>
          </label>}
          {mode === "plane" && sourceDimensions.z > 1 && <label>Z plane
            <span><input aria-label={`${entry.label} Z`} type="number" min={1} max={sourceDimensions.z}
              value={selection.z + 1} onChange={(event) => setAxis("z", Number(event.target.value))} /> / {sourceDimensions.z}</span>
          </label>}
          {mode === "plane" && sourceDimensions.z > 1 && <label>Projection
            <select aria-label={`${entry.label} projection`} value={projection} onChange={(event) => {
              const next = event.target.value as ImageWindowPresentation["projection"];
              setProjection(next);
              setSelection((previous) => {
                if (next === "plane") {
                  const { z_stop: _zStop, ...plane } = previous;
                  return plane;
                }
                return { ...previous, z_stop: sourceDimensions.z };
              });
            }}>
              <option value="plane">Single plane</option>
              <option value="max">Maximum</option>
              <option value="mean">Mean</option>
            </select>
          </label>}
        </div>

        {mode === "volume" && <div className="detached-volume-display" aria-label={`${entry.label} volume display`}>
          <label>Rendering
            <select aria-label={`${entry.label} volume mode`} value={volumeDisplay.renderMode}
              onChange={(event) => setVolumeDisplay((current) => ({
                ...current,
                renderMode: event.target.value as VolumeDisplay["renderMode"],
              }))}>
              {VOLUME_RENDER_MODES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </label>
          <label>Quality <output>{volumeDisplay.quality}%</output>
            <input aria-label={`${entry.label} volume quality`} type="range" min={10} max={100} step={1}
              value={volumeDisplay.quality} onChange={(event) => setVolumeDisplay((current) => ({
                ...current,
                quality: Number(event.target.value),
              }))} />
          </label>
        </div>}

        {rgb ? <details className="detached-advanced-display" open>
          <summary>Image tone</summary>
          <p>One curve controls all recorded {entry.source.metadata.sample_semantics} components.</p>
          <div className="detached-tone-grid">
            <label>Black point<NumberSetting label="RGB black point" value={channels[0].low ?? 0}
              minimum={0} maximum={rgbMaximum}
              onValue={(low) => {
                if (low >= (channels[0].high ?? rgbMaximum)) return false;
                updateChannel(0, { low });
                return true;
              }} /></label>
            <label>White point<NumberSetting label="RGB white point" value={channels[0].high ?? rgbMaximum}
              minimum={0} maximum={rgbMaximum}
              onValue={(high) => {
                if (high <= (channels[0].low ?? 0)) return false;
                updateChannel(0, { high });
                return true;
              }} /></label>
            <label>Gamma<NumberSetting label="RGB gamma" value={channels[0].gamma} minimum={0.1} maximum={10}
              onValue={(gamma) => {
                updateChannel(0, { gamma });
                return true;
              }} /></label>
          </div>
        </details> : <>
          {medical && <div className="detached-medical-windows" aria-label={`${entry.label} window and level`}>
            {channels.map((channel) => {
              const low = channel.low ?? 0;
              const high = channel.high ?? 1;
              const channelLabel = entry.source.metadata.channel_names?.[channel.channel] ?? `Channel ${channel.channel + 1}`;
              return <div key={channel.channel}>
                {channels.length > 1 && <strong>{channelLabel}</strong>}
                <label>Window<NumberSetting label={`${entry.label} channel ${channel.channel + 1} window`}
                  value={high - low} minimum={Number.MIN_VALUE} onValue={(width) => {
                    const level = (high + low) / 2;
                    const nextLow = level - width / 2;
                    const nextHigh = level + width / 2;
                    if (!Number.isFinite(nextLow) || !Number.isFinite(nextHigh) || nextLow >= nextHigh) return false;
                    updateChannel(channel.channel, { low: nextLow, high: nextHigh });
                    return true;
                  }} /></label>
                <label>Level<NumberSetting label={`${entry.label} channel ${channel.channel + 1} level`}
                  value={(high + low) / 2} onValue={(level) => {
                    const half = (high - low) / 2;
                    const nextLow = level - half;
                    const nextHigh = level + half;
                    if (!Number.isFinite(nextLow) || !Number.isFinite(nextHigh) || nextLow >= nextHigh) return false;
                    updateChannel(channel.channel, { low: nextLow, high: nextHigh });
                    return true;
                  }} /></label>
              </div>;
            })}
          </div>}

          <details className="detached-advanced-display" open={mode === "volume" || !medical || undefined}>
            <summary>{medical ? "Scalar details" : "Channel display"}</summary>
            <p>{mode === "volume"
              ? "These transfer settings are shared with the detached 3D view."
              : "Display colours and ranges do not declare biological channel identity."}</p>
            <div className="detached-channel-list" aria-label={`${entry.label} channels`}>
              {channels.map((channel) => <details className="detached-channel" key={channel.channel}
                open={channels.length === 1 ? true : undefined}>
                <summary>
                  <input type="checkbox" checked={channel.visible}
                    aria-label={`${entry.label} channel ${channel.channel + 1} visible`}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => updateChannel(channel.channel, { visible: event.target.checked })} />
                  <i style={{ background: channel.color }} />
                  <span>{entry.source.metadata.channel_names?.[channel.channel] ?? `Channel ${channel.channel + 1}`}</span>
                  <output>{channel.opacity ?? 1}</output>
                </summary>
                <div className="detached-channel-settings">
                  <label>Color<input aria-label={`${entry.label} channel ${channel.channel + 1} color`} type="color"
                    value={channel.color} onChange={(event) => updateChannel(channel.channel, { color: event.target.value })} /></label>
                  <label>Low<NumberSetting label={`${entry.label} channel ${channel.channel + 1} low`}
                    value={channel.low ?? 0} onValue={(low) => {
                      if (low >= (channel.high ?? 1)) return false;
                      updateChannel(channel.channel, { low });
                      return true;
                    }} /></label>
                  <label>High<NumberSetting label={`${entry.label} channel ${channel.channel + 1} high`}
                    value={channel.high ?? 1} onValue={(high) => {
                      if (high <= (channel.low ?? 0)) return false;
                      updateChannel(channel.channel, { high });
                      return true;
                    }} /></label>
                  <label>Gamma<NumberSetting label={`${entry.label} channel ${channel.channel + 1} gamma`}
                    value={channel.gamma} minimum={0.1} maximum={10} onValue={(gamma) => {
                      updateChannel(channel.channel, { gamma });
                      return true;
                    }} /></label>
                  <label className="detached-opacity">Opacity <output aria-label={`${entry.label} channel ${channel.channel + 1} opacity value`}>{channel.opacity ?? 1}</output>
                    <input aria-label={`${entry.label} channel ${channel.channel + 1} opacity`} type="range"
                      min={0} max={1} step={0.01} value={channel.opacity ?? 1}
                      onChange={(event) => updateChannel(channel.channel, { opacity: Number(event.target.value) })} />
                  </label>
                </div>
              </details>)}
            </div>
          </details>
        </>}
      </section>

      <section className="detached-annotation-section" aria-label={`Annotations for ${entry.label}`}>
        {(annotationError || annotationStatus) && <div
          className={annotationError ? "detached-annotation-feedback is-error" : "detached-annotation-feedback"}
          role={annotationError ? "alert" : "status"}>
          <p>{annotationError ?? annotationStatus}</p>
          {annotationError && <button onClick={() => {
            preservedDraft.current = draft.length ? structuredClone(draft) : null;
            setAnnotationError(null);
            setAnnotationStatus(draft.length
              ? "Reloading annotations. Your unsaved draft will be preserved."
              : "Reloading annotations…");
            setAnnotationAttempt((attempt) => attempt + 1);
          }}><RefreshCw aria-hidden="true" /> Reload annotations</button>}
        </div>}
        <SourceAnnotationPanel
          key={`${targetKey(entry.target)}:${annotationAttempt}`}
          api={annotationApi}
          source={entry.source}
          selection={selection}
          tool={tool}
          onTool={changeTool}
          points={draft}
          onPoints={updateDraft}
          onAnnotations={updateAnnotations}
          onError={reportAnnotationError}
        />
      </section>
    </div>}
  </section>;
}

export function DetachedControlPanel({ api, researchApi, preferences, onReturn }: {
  api: ImageWindowApi;
  researchApi: ResearchDesktopApi;
  preferences: UserPreferences;
  onReturn: () => void;
}) {
  const [windowState, setWindowState] = useState<ImageWindowState | null>(null);
  const [snapshot, setSnapshot] = useState<ResearchSnapshot | null>(null);
  const [selectedSourceId, setSelectedSourceId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [interactions, setInteractions] = useState<Record<string, InteractionEnvelope>>({});
  const interactionSerial = useRef(0);
  const stateRef = useRef<ImageWindowState | null>(null);

  useEffect(() => {
    document.documentElement.classList.add("detached-window-root");
    return () => document.documentElement.classList.remove("detached-window-root");
  }, []);

  useEffect(() => {
    let active = true;
    let receivedState = false;
    const adopt = (value: ImageWindowState) => {
      if (!active) return;
      stateRef.current = value;
      setWindowState(value);
    };
    const removeState = api.onState((value) => { receivedState = true; adopt(value); });
    const removeInteraction = api.onInteraction((event) => {
      if (!active) return;
      const current = stateRef.current?.views.find((entry) => entry.target.viewId === event.target.viewId);
      if (!current || !sameTarget(current.target, event.target)) return;
      setInteractions((previous) => ({
        ...previous,
        [`${event.target.viewId}:${event.interaction.kind}`]: {
          serial: ++interactionSerial.current,
          target: event.target,
          interaction: event.interaction,
        },
      }));
    });
    void api.state().then((value) => { if (!receivedState) adopt(value); }).catch((caught) => {
      if (active) setError(safeMessage(caught, "Could not load detached-window state."));
    });
    void researchApi.getSnapshot().then((value) => {
      if (!active) return;
      setSnapshot(value);
      setSelectedSourceId((previous) => previous || value?.sources[0]?.id || "");
    }).catch((caught) => {
      if (active) setError(safeMessage(caught, "Could not load the study sources."));
    });
    return () => {
      active = false;
      removeState();
      removeInteraction();
    };
  }, [api, researchApi]);

  const run = useCallback(async (action: () => Promise<unknown>, fallback: string) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(safeMessage(caught, fallback));
    } finally {
      setBusy(false);
    }
  }, []);

  const activeEntry = windowState?.target
    ? windowState.views.find((entry) => sameTarget(entry.target, windowState.target)) ?? null
    : null;
  const openSlots = Math.max(0, 2 - (windowState?.views.length ?? 0));

  const saveStudy = () => run(async () => {
    if (!researchApi.saveAs) throw new Error("Save as is unavailable in this build.");
    const saved = await researchApi.saveAs();
    if (saved) {
      setSnapshot(saved);
      setStatus("Study saved.");
    } else {
      setStatus("Save canceled.");
    }
  }, "Could not save this study.");

  const returnToWorkspace = () => run(async () => {
    await api.closeAll();
    onReturn();
  }, "Could not close the detached image windows.");

  return <main className="detached-control-panel">
    <header className="detached-control-header">
      <div className="detached-control-title">
        <h1>Image controls</h1>
        <p>{snapshot?.project.title ?? "Current study"}</p>
      </div>
      <div className="detached-header-actions">
        <button disabled={busy || !researchApi.saveAs} onClick={() => void saveStudy()}>
          <Save aria-hidden="true" /> Save study…
        </button>
        <button className="is-primary" disabled={busy} onClick={() => void returnToWorkspace()}>
          <ArrowLeftToLine aria-hidden="true" /> Return to workspace
        </button>
      </div>
    </header>

    <section className="detached-target-strip" aria-label="Control target">
      <div>
        <span className={`detached-target-state${windowState?.pinned ? " is-pinned" : ""}`}>
          {windowState?.pinned ? <Pin aria-hidden="true" /> : <Focus aria-hidden="true" />}
          {windowState?.pinned ? "Pinned target" : "Following focus"}
        </span>
        <strong>{activeEntry?.label ?? "No image window selected"}</strong>
        <span>{activeEntry ? `${activeEntry.source.name} · ${activeEntry.source.metadata.format ?? "image"}` : "Open or focus a view to show its controls."}</span>
      </div>
      <button disabled={busy || !windowState?.target} onClick={() => void run(
        () => windowState?.pinned ? api.pin(null) : api.pin(windowState!.target),
        "Could not change the control target.",
      )}>
        {windowState?.pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
        {windowState?.pinned ? "Follow focused view" : "Pin this target"}
      </button>
    </section>

    <div className="detached-control-layout">
      <aside className="detached-view-rail" aria-label="Detached image windows">
        <div className="detached-open-source">
          <label htmlFor="detached-source">Open source in a new view</label>
          <div>
            <select id="detached-source" value={selectedSourceId}
              disabled={busy || !snapshot?.sources.length || openSlots === 0}
              onChange={(event) => setSelectedSourceId(event.target.value)}>
              {snapshot?.sources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}
            </select>
            <button aria-label="Open selected source" title="Open selected source"
              disabled={busy || !selectedSourceId || openSlots === 0}
              onClick={() => void run(() => api.open(selectedSourceId), "Could not open the image window.")}>
              <ExternalLink aria-hidden="true" />
            </button>
          </div>
          <small>{openSlots > 0 ? `${openSlots} view ${openSlots === 1 ? "slot" : "slots"} available` : "Two image views are open"}</small>
        </div>

        <div className="detached-view-list">
          {windowState?.views.map((entry) => {
            const isActive = sameTarget(entry.target, windowState.target);
            const isFullscreen = Boolean(entry.fullscreen);
            return <article key={entry.target.viewId} className={isActive ? "is-active" : ""}>
              <button className="detached-view-summary" aria-pressed={isActive}
                onClick={() => void run(() => api.focus(entry.target), "Could not focus the image window.")}>
                <span><strong>{entry.label}</strong><small>{entry.source.name}</small></span>
                <span className={`detached-view-status is-${entry.status}`}>{entry.status}</span>
              </button>
              <div className="detached-view-actions">
                {entry.status === "crashed" ? <button onClick={() => void run(
                  () => api.reopen(entry.target), "Could not reopen the image window.",
                )}><RefreshCw aria-hidden="true" /> Reopen</button> : <button onClick={() => void run(
                  () => api.focus(entry.target), "Could not show the image window.",
                )}><Focus aria-hidden="true" /> Show</button>}
                <button disabled={entry.status !== "ready"} onClick={() => void run(async () => {
                  await api.fullscreen(entry.target, !isFullscreen);
                }, "Could not change native full screen.")}>
                  {isFullscreen ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
                  {isFullscreen ? "Exit full screen" : "Full screen"}
                </button>
                <button onClick={() => void run(() => api.close(entry.target), "Could not close the image window.")}>
                  <X aria-hidden="true" /> Close
                </button>
              </div>
            </article>;
          })}
          {windowState && windowState.views.length === 0 && <div className="detached-view-empty">
            <Unplug aria-hidden="true" />
            <strong>No detached image windows</strong>
            <p>Choose a study source above. Opening the same source twice keeps two independent display states.</p>
          </div>}
        </div>
      </aside>

      <section className="detached-controller-stack" aria-live="polite">
        {windowState?.views.map((entry) => <ViewController
          key={entry.target.viewId}
          api={api}
          researchApi={researchApi}
          entry={entry}
          active={sameTarget(entry.target, windowState.target)}
          interaction={interactions[`${entry.target.viewId}:draft`]}
          cameraInteraction={interactions[`${entry.target.viewId}:camera`]}
          volumeDisplayInteraction={interactions[`${entry.target.viewId}:volume-display`]}
          errorInteraction={interactions[`${entry.target.viewId}:error`]}
          preferences={preferences}
        />)}
        {windowState && windowState.views.length > 0 && !activeEntry && <div className="detached-controller-placeholder">
          <Focus aria-hidden="true" /><h2>Select an image window</h2><p>Choose a view from the left to inspect its display and annotations.</p>
        </div>}
        {windowState && windowState.views.length === 0 && <div className="detached-controller-placeholder">
          <ExternalLink aria-hidden="true" /><h2>Open a source view</h2><p>The main workbench remains the study authority while detached windows show source-bound views.</p>
        </div>}
      </section>
    </div>

    {(error || windowState?.layoutError || status) && <footer
      className={error || windowState?.layoutError ? "detached-control-feedback is-error" : "detached-control-feedback"}
      role={error || windowState?.layoutError ? "alert" : "status"}>
      {error ?? windowState?.layoutError ?? status}
    </footer>}
  </main>;
}

export default DetachedControlPanel;
