import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ResearchChannelDeclaration,
  ResearchChannelMetadata,
  ResearchDesktopApi,
  ResearchRecipe,
  ResearchResult,
  ResearchSelection,
  ResearchSnapshot,
  ResearchSource,
} from "../shared/research-contracts";
import "./ResearchQuantificationPanel.css";

type Report = <T>(work: () => Promise<T>, fallback: string) => Promise<T | undefined>;
type PunctaPreview = {
  request: Record<string, unknown>;
  fingerprint: string;
  overlay: string;
  overlayBasis: string;
  totalPeaks: number;
  peaks: Array<Record<string, unknown>>;
  measurements: Array<Record<string, unknown>>;
};
type AssociationRow = {
  nucleus_label?: number;
  cell_label?: number | null;
  overlap_fraction?: number;
  ambiguous?: boolean;
};
type SourceAnnotation = {
  id: string;
  label: string;
  kind: string;
  z: number;
  t: number;
  points?: Array<{ x: number; y: number }>;
};

const WORKING_BYTES = 512 * 1024 ** 2;

function finite(text: string, name: string): number {
  const value = Number(text);
  if (!text.trim() || !Number.isFinite(value)) throw new Error(`${name} must be a finite number.`);
  return value;
}

function exactResult(value: unknown, sourceId?: string): ResearchResult {
  if (!value || typeof value !== "object") throw new Error("The operation returned no immutable result.");
  const result = value as ResearchResult;
  if (
    typeof result.id !== "string" ||
    typeof result.revision_hash !== "string" ||
    typeof result.source_id !== "string" ||
    (sourceId !== undefined && result.source_id !== sourceId)
  )
    throw new Error("The operation returned an invalid result binding.");
  return result;
}

function canonicalEqual(first: unknown, second: unknown): boolean {
  if (Object.is(first, second)) return true;
  if (Array.isArray(first) || Array.isArray(second))
    return (
      Array.isArray(first) &&
      Array.isArray(second) &&
      first.length === second.length &&
      first.every((item, index) => canonicalEqual(item, second[index]))
    );
  if (
    !first ||
    !second ||
    typeof first !== "object" ||
    typeof second !== "object"
  )
    return false;
  const firstRecord = first as Record<string, unknown>;
  const secondRecord = second as Record<string, unknown>;
  const firstKeys = Object.keys(firstRecord).sort();
  const secondKeys = Object.keys(secondRecord).sort();
  return (
    canonicalEqual(firstKeys, secondKeys) &&
    firstKeys.every((key) => canonicalEqual(firstRecord[key], secondRecord[key]))
  );
}

function selectionGrid(selection: ResearchResult["selection"]): unknown {
  if (!selection) return null;
  const { c: _channel, ...grid } = selection;
  return grid;
}

function compatible(first: ResearchResult, second: ResearchResult): boolean {
  const firstLabels = first.arrays?.labels;
  const secondLabels = second.arrays?.labels;
  return Boolean(
    first.id !== second.id &&
      first.source_id === second.source_id &&
      first.arrays?.image &&
      second.arrays?.image &&
      firstLabels &&
      secondLabels &&
      firstLabels.sha256 !== secondLabels.sha256 &&
      canonicalEqual(firstLabels.shape, secondLabels.shape) &&
      canonicalEqual(first.geometry, second.geometry) &&
      canonicalEqual(selectionGrid(first.selection), selectionGrid(second.selection)),
  );
}

function resultLabel(result: ResearchResult, snapshot: ResearchSnapshot): string {
  const source = snapshot.sources.find((item) => item.id === result.source_id);
  return `${source?.name ?? "Source"} · ${result.kind} · ${result.id.slice(0, 8)}…`;
}

function punctaLineage(result: ResearchResult, snapshot: ResearchSnapshot): "initial" | "corrected" | null {
  if (result.kind === "puncta-quantification") return "initial";
  let parent = snapshot.results.find((item) => item.id === result.parent_id);
  const visited = new Set<string>();
  while (parent && !visited.has(parent.id)) {
    if (parent.kind === "puncta-quantification") return "corrected";
    visited.add(parent.id);
    parent = snapshot.results.find((item) => item.id === parent?.parent_id);
  }
  return null;
}

function validateMetadata(value: unknown, source: ResearchSource): ResearchChannelMetadata {
  const record = value as ResearchChannelMetadata;
  if (
    !record ||
    record.source_id !== source.id ||
    record.source_sha256 !== source.sha256 ||
    !Number.isSafeInteger(record.revision) ||
    !Array.isArray(record.original_names) ||
    !Array.isArray(record.channels) ||
    record.original_names.length !== record.channels.length ||
    record.channels.some((item, index) => item.index !== index)
  )
    throw new Error("Channel declarations did not match this exact source revision.");
  return record;
}

function CompactTable({ rows }: { rows: Array<Record<string, unknown>> }): React.JSX.Element | null {
  if (!rows.length) return null;
  const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(row)))).slice(0, 6);
  return (
    <div className="research-result-table">
      <table>
        <thead><tr>{columns.map((column) => <th key={column}>{column.replaceAll("_", " ")}</th>)}</tr></thead>
        <tbody>
          {rows.slice(0, 100).map((row, index) => (
            <tr key={index}>{columns.map((column) => <td key={column}>{typeof row[column] === "object" ? JSON.stringify(row[column]) : String(row[column] ?? "—")}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ResearchQuantificationPanel({
  api,
  snapshot,
  source,
  selection,
  recipe,
  setRecipe,
  report,
  busy,
  onBusyChange,
  onPreview,
  onPublished,
}: {
  api: ResearchDesktopApi;
  snapshot: ResearchSnapshot;
  source: ResearchSource;
  selection: ResearchSelection;
  recipe: ResearchRecipe;
  setRecipe: React.Dispatch<React.SetStateAction<ResearchRecipe>>;
  report: Report;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onPreview: (image: string, measurements: Array<Record<string, unknown>>) => void;
  onPublished: (result: ResearchResult) => Promise<void>;
}): React.JSX.Element {
  const isRgb = source.metadata.sample_semantics === "RGB";
  const [mode, setMode] = useState<"channels" | "recipe" | "puncta" | "colocalisation" | "association" | "field-assay">("channels");
  const [sourceAnnotations, setSourceAnnotations] = useState<SourceAnnotation[]>([]);
  const [sourceAnnotationRevision, setSourceAnnotationRevision] = useState<number | null>(null);
  const [fieldAssayAnnotationError, setFieldAssayAnnotationError] = useState<string | null>(null);
  const [fieldAssayNucleiChannel, setFieldAssayNucleiChannel] = useState("0");
  const [fieldAssaySignalChannel, setFieldAssaySignalChannel] = useState("1");
  const [fieldAssayFocusMode, setFieldAssayFocusMode] = useState<"all" | "annotation">("annotation");
  const [fieldAssayFocusAnnotationId, setFieldAssayFocusAnnotationId] = useState("");
  const [fieldAssayBackgroundMode, setFieldAssayBackgroundMode] = useState<"value" | "annotation">("annotation");
  const [fieldAssayBackgroundValue, setFieldAssayBackgroundValue] = useState("0");
  const [fieldAssayBackgroundAnnotationId, setFieldAssayBackgroundAnnotationId] = useState("");
  const [fieldAssaySegmentationMethod, setFieldAssaySegmentationMethod] = useState("manual");
  const [fieldAssayThresholdManual, setFieldAssayThresholdManual] = useState("100");
  const [fieldAssayMinArea, setFieldAssayMinArea] = useState("10");
  const [fieldAssayMaxArea, setFieldAssayMaxArea] = useState("5000");
  const [fieldAssayWatershedMinDist, setFieldAssayWatershedMinDist] = useState("5");
  const [fieldAssayExcludeBoundary, setFieldAssayExcludeBoundary] = useState(false);
  const [fieldAssayBackgroundEstimator, setFieldAssayBackgroundEstimator] = useState<"median" | "mean">("median");
  const [fieldAssayManualCountMode, setFieldAssayManualCountMode] = useState<"none" | "override" | "points">("none");
  const [fieldAssayManualCountOverride, setFieldAssayManualCountOverride] = useState("");
  const [fieldAssayManualPointsAnnotationId, setFieldAssayManualPointsAnnotationId] = useState("");
  const [fieldAssayReviewer, setFieldAssayReviewer] = useState("");
  const [fieldAssayNotes, setFieldAssayNotes] = useState("");
  const [fieldAssayConfirmChannel, setFieldAssayConfirmChannel] = useState(false);
  const [fieldAssayConfirmAcq, setFieldAssayConfirmAcq] = useState(false);
  const [fieldAssayConfirmFocus, setFieldAssayConfirmFocus] = useState(false);
  const [fieldAssayConfirmNuclei, setFieldAssayConfirmNuclei] = useState(false);
  const [fieldAssayConfirmBackground, setFieldAssayConfirmBackground] = useState(false);
  const [fieldAssayConfirmSaturation, setFieldAssayConfirmSaturation] = useState(false);
  const [fieldAssayPreviewFingerprint, setFieldAssayPreviewFingerprint] = useState<string | null>(null);

  const [fieldAssayPreview, setFieldAssayPreview] = useState<{
    summary: Record<string, unknown>;
    warnings: string[];
    qc_overlay: string;
    nuclei_count: number;
    reviewed_count: number;
    count_mode: string;
    saturation: { nuclei: number; signal: number; background: number };
    field_ratio: number | null | string;
    integrated_signal_minus_background: number;
    raw_signal_sum: number;
    focus_mask_pixels: number;
  } | null>(null);
  const [metadata, setMetadata] = useState<ResearchChannelMetadata | null>(null);
  const [channelDraft, setChannelDraft] = useState<ResearchChannelDeclaration[]>([]);
  const [channelError, setChannelError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [localBusy, setLocalBusy] = useState(false);
  const metadataToken = useRef(0);
  const previewToken = useRef(0);
  const annotationToken = useRef(0);
  const fieldAssayPreviewToken = useRef(0);
  const fieldAssayConfigRef = useRef("");

  const [background, setBackground] = useState("10");
  const [backgroundClip, setBackgroundClip] = useState(true);
  const [flatSource, setFlatSource] = useState("");
  const [flatChannel, setFlatChannel] = useState("0");
  const [darkSource, setDarkSource] = useState("");
  const [darkChannel, setDarkChannel] = useState("0");

  const [punctaSigma, setPunctaSigma] = useState("1");
  const [punctaResponse, setPunctaResponse] = useState("0");
  const [punctaRaw, setPunctaRaw] = useState("0");
  const [punctaDistance, setPunctaDistance] = useState("1");
  const [punctaAperture, setPunctaAperture] = useState("2");
  const [punctaBorder, setPunctaBorder] = useState(true);
  const [punctaControl, setPunctaControl] = useState("");
  const [punctaPreview, setPunctaPreview] = useState<PunctaPreview | null>(null);

  const [firstChannel, setFirstChannel] = useState("0");
  const [secondChannel, setSecondChannel] = useState("1");
  const [firstThreshold, setFirstThreshold] = useState("0");
  const [secondThreshold, setSecondThreshold] = useState("0");
  const [colocalisationControl, setColocalisationControl] = useState("");
  const [metrics, setMetrics] = useState<Record<string, unknown> | null>(null);

  const labelResults = useMemo(
    () => snapshot.results.filter((result) => Boolean(result.arrays?.image && result.arrays?.labels)),
    [snapshot.results],
  );
  const [nucleiId, setNucleiId] = useState("");
  const nucleus = labelResults.find((result) => result.id === nucleiId) ?? null;
  const compatibleCells = nucleus ? labelResults.filter((result) => compatible(nucleus, result)) : [];
  const [cellsId, setCellsId] = useState("");
  const [nucleusRole, setNucleusRole] = useState("nucleus label field");
  const [cellRole, setCellRole] = useState("cell boundary label field");
  const [associationControl, setAssociationControl] = useState("");
  const [associations, setAssociations] = useState<AssociationRow[]>([]);
  const [associationTotal, setAssociationTotal] = useState(0);

  useEffect(() => {
    const token = ++metadataToken.current;
    setMetadata(null);
    setChannelDraft([]);
    setChannelError(null);
    setPunctaPreview(null);
    setMetrics(null);
    void api.execute("channel_metadata", { source_id: source.id }).then((value) => {
      if (token !== metadataToken.current) return;
      const next = validateMetadata(value, source);
      setMetadata(next);
      setChannelDraft(next.channels.map((item) => ({ ...item })));
    }).catch((error) => {
      if (token === metadataToken.current)
        setChannelError(error instanceof Error ? error.message : "Could not load channel declarations.");
    });
    return () => { metadataToken.current += 1; };
  }, [api, source.id, source.sha256]);

  useEffect(() => {
    const token = ++annotationToken.current;
    fieldAssayPreviewToken.current += 1;
    setFieldAssayPreview(null);
    setFieldAssayPreviewFingerprint(null);
    setSourceAnnotations([]);
    setSourceAnnotationRevision(null);
    setFieldAssayAnnotationError(null);
    setFieldAssayFocusAnnotationId("");
    setFieldAssayBackgroundAnnotationId("");
    setFieldAssayManualPointsAnnotationId("");
    void api.execute("source_annotations", { source_id: source.id }).then((value) => {
      if (token !== annotationToken.current) return;
      const receipt = value as {
        source_id?: unknown;
        source_sha256?: unknown;
        revision?: unknown;
        annotations?: unknown;
      };
      if (
        receipt?.source_id !== source.id ||
        receipt.source_sha256 !== source.sha256 ||
        !Number.isSafeInteger(receipt.revision) ||
        !Array.isArray(receipt.annotations) ||
        receipt.annotations.some((annotation) => {
          if (!annotation || typeof annotation !== "object") return true;
          const item = annotation as Partial<SourceAnnotation>;
          return typeof item.id !== "string" || typeof item.label !== "string" ||
            typeof item.kind !== "string" || !Number.isSafeInteger(item.z) ||
            !Number.isSafeInteger(item.t);
        })
      ) throw new Error("Source annotations did not match this exact source revision.");
      setSourceAnnotations(receipt.annotations as SourceAnnotation[]);
      setSourceAnnotationRevision(receipt.revision as number);
    }).catch((error) => {
      if (token !== annotationToken.current) return;
      setSourceAnnotations([]);
      setSourceAnnotationRevision(null);
      setFieldAssayAnnotationError(
        error instanceof Error && error.message
          ? error.message
          : "Could not load source annotations.",
      );
    });
    return () => { annotationToken.current += 1; };
  }, [api, source.id, source.sha256]);

  const planeAnnotations = sourceAnnotations.filter(
    (annotation) => annotation.z === selection.z && annotation.t === selection.t,
  );
  const planeRegionAnnotations = planeAnnotations.filter(
    (annotation) => annotation.kind === "polygon" || annotation.kind === "rectangle",
  );
  const planePointAnnotations = planeAnnotations.filter((annotation) => annotation.kind === "point");

  useEffect(() => {
    const focus = planeRegionAnnotations.find(
      (annotation) => annotation.label.toLowerCase() === "focus",
    ) ?? planeRegionAnnotations[0];
    const background = planeRegionAnnotations.find(
      (annotation) => annotation.label.toLowerCase() === "background",
    );
    const points = planePointAnnotations.find(
      (annotation) => ["count", "nucleus", "nuclei"].includes(annotation.label.toLowerCase()),
    ) ?? planePointAnnotations[0];
    setFieldAssayFocusAnnotationId((current) =>
      planeRegionAnnotations.some((annotation) => annotation.id === current)
        ? current
        : focus?.id ?? "",
    );
    setFieldAssayBackgroundAnnotationId((current) =>
      planeRegionAnnotations.some((annotation) => annotation.id === current)
        ? current
        : background?.id ?? "",
    );
    setFieldAssayManualPointsAnnotationId((current) =>
      current === "all_points" || planePointAnnotations.some((annotation) => annotation.id === current)
        ? current
        : points?.id ?? "",
    );
  }, [sourceAnnotationRevision, selection.z, selection.t]);

  useEffect(() => {
    if (!nucleus || !compatibleCells.some((item) => item.id === cellsId))
      setCellsId(compatibleCells[0]?.id ?? "");
  }, [nucleus?.id, compatibleCells.map((item) => item.id).join("|"), cellsId]);

  const punctaFingerprint = JSON.stringify([
    source.id, source.sha256, selection, punctaSigma, punctaResponse, punctaRaw,
    punctaDistance, punctaAperture, punctaBorder, punctaControl, metadata?.revision,
  ]);
  useEffect(() => {
    previewToken.current += 1;
    setPunctaPreview((current) => current?.fingerprint === punctaFingerprint ? current : null);
  }, [punctaFingerprint]);

  const locked = busy || localBusy;
  const run = async <T,>(fallback: string, work: () => Promise<T>): Promise<T | undefined> => {
    setLocalBusy(true);
    onBusyChange(true);
    setActionError(null);
    try {
      return await report(work, fallback);
    } catch (error) {
      setActionError(error instanceof Error && error.message ? error.message : fallback);
      return undefined;
    } finally {
      setLocalBusy(false);
      onBusyChange(false);
    }
  };

  const saveChannels = async () => {
    if (!metadata || isRgb) return;
    const revision = metadata.revision;
    const output = await run("Could not save channel declarations.", async () =>
      validateMetadata(await api.execute("channels", {
        source_id: source.id,
        channels: channelDraft,
        expected_revision: revision,
      }), source));
    if (output) {
      setMetadata(output);
      setChannelDraft(output.channels.map((item) => ({ ...item })));
    }
  };

  const updateBackground = (enabled: boolean) => {
    setRecipe((old) => ({
      ...old,
      steps: enabled
        ? [...old.steps.filter((step) => step.op !== "subtract_background"), {
            op: "subtract_background", sigma: finite(background, "Background sigma"), clip_negative: backgroundClip,
          }]
        : old.steps.filter((step) => step.op !== "subtract_background"),
    }));
  };

  const refSelection = (channel: string): ResearchSelection => ({ ...selection, c: finite(channel, "Reference channel") });
  const updateFlatfield = (enabled: boolean) => {
    setRecipe((old) => {
      const steps = old.steps.filter((step) => step.op !== "flatfield");
      if (!enabled) return { ...old, steps, references: undefined };
      if (!flatSource) throw new Error("Choose an exact flat-field source.");
      const references: NonNullable<ResearchRecipe["references"]> = {
        flatfield: { source_id: flatSource, selection: refSelection(flatChannel) },
      };
      if (darkSource) references.darkfield = { source_id: darkSource, selection: refSelection(darkChannel) };
      return { ...old, steps: [...steps, { op: "flatfield", clip_negative: true }], references };
    });
  };

  const addGate = () => {
    const channel = metadata?.channels[recipe.measurement_channels[0] ?? 0];
    if (!channel) return;
    setRecipe((old) => ({ ...old, gates: [...old.gates, {
      name: `gate-${old.gates.length + 1}`,
      channel: `${channel.index + 1}: ${channel.name}`,
      statistic: "mean", threshold: 0, control: "",
    }] }));
  };

  const punctaRequest = (): Record<string, unknown> => ({
    source_id: source.id,
    selection,
    sigma: finite(punctaSigma, "Puncta sigma"),
    response_threshold: finite(punctaResponse, "LoG response threshold"),
    raw_threshold: finite(punctaRaw, "Raw intensity threshold"),
    minimum_distance: finite(punctaDistance, "Minimum peak distance"),
    aperture_radius: finite(punctaAperture, "Aperture radius"),
    exclude_border: punctaBorder,
    control: punctaControl.trim() || (() => { throw new Error("Declare the puncta control and assumptions."); })(),
    working_bytes: WORKING_BYTES,
  });

  const previewPuncta = async () => {
    const token = ++previewToken.current;
    const fingerprint = punctaFingerprint;
    const preview = await run("Could not preview puncta candidates.", async () => {
      const request = punctaRequest();
      const output = (await api.execute("puncta_preview", request)) as {
        preview?: boolean; adopted?: boolean; overlay?: string; overlay_basis?: string;
        total_peaks?: number; peaks?: Array<Record<string, unknown>>; measurements?: Array<Record<string, unknown>>;
      };
      if (output.preview !== true || output.adopted !== false || typeof output.overlay !== "string")
        throw new Error("The engine did not return a display-only puncta preview.");
      return {
        request, fingerprint, overlay: output.overlay, overlayBasis: String(output.overlay_basis ?? ""),
        totalPeaks: Number(output.total_peaks ?? 0), peaks: output.peaks ?? [], measurements: output.measurements ?? [],
      };
    });
    if (!preview || token !== previewToken.current || fingerprint !== punctaFingerprint) return;
    setPunctaPreview(preview);
    onPreview(preview.overlay, preview.measurements);
  };

  const adoptPuncta = async () => {
    const pending = punctaPreview;
    if (!pending || pending.fingerprint !== punctaFingerprint) return;
    const result = await run("Could not adopt puncta quantification.", async () => {
      const output = (await api.execute("puncta_run", pending.request)) as {
        adopted?: boolean; result?: unknown; measurements?: Array<Record<string, unknown>>;
      };
      if (output.adopted !== true) throw new Error("Puncta quantification was not adopted.");
      const exact = exactResult(output.result, source.id);
      await onPublished(exact);
      return exact;
    });
    if (result) setPunctaPreview(null);
  };

  const runColocalisation = async () => {
    const output = await run("Could not run colocalisation.", async () => {
      const first = finite(firstChannel, "First channel");
      const second = finite(secondChannel, "Second channel");
      if (first === second) throw new Error("Choose two distinct acquisition channels.");
      const value = (await api.execute("colocalisation_run", {
        source_id: source.id, selection, first_channel: first, second_channel: second,
        threshold_first: finite(firstThreshold, "First threshold"),
        threshold_second: finite(secondThreshold, "Second threshold"),
        control: colocalisationControl.trim() || (() => { throw new Error("Declare the colocalisation controls and assumptions."); })(),
        working_bytes: WORKING_BYTES,
      })) as { adopted?: boolean; result?: unknown; metrics?: Record<string, unknown> };
      if (value.adopted !== true) throw new Error("Colocalisation was not adopted.");
      const result = exactResult(value.result, source.id);
      await onPublished(result);
      return { metrics: value.metrics ?? null };
    });
    if (output) setMetrics(output.metrics);
  };

  const runAssociation = async () => {
    const output = await run("Could not associate nucleus and cell labels.", async () => {
      const cells = compatibleCells.find((item) => item.id === cellsId);
      if (!nucleus || !cells) throw new Error("Choose two compatible exact label revisions.");
      const value = (await api.execute("associate_results", {
        nuclei: { result_id: nucleus.id, revision_hash: nucleus.revision_hash },
        cells: { result_id: cells.id, revision_hash: cells.revision_hash },
        roles: { nuclei: nucleusRole, cells: cellRole },
        control: associationControl.trim() || (() => { throw new Error("Declare the association controls and assumptions."); })(),
        working_bytes: WORKING_BYTES,
      })) as { adopted?: boolean; result?: unknown; associations?: AssociationRow[]; total_associations?: number };
      if (value.adopted !== true) throw new Error("Association was not adopted.");
      const result = exactResult(value.result, cells.source_id);
      await onPublished(result);
      return value;
    });
    if (!output) return;
    setAssociations(output.associations ?? []);
    setAssociationTotal(Number(output.total_associations ?? 0));
  };

  const currentAssayConfigFingerprint = JSON.stringify({
    sourceId: source.id,
    sourceSha256: source.sha256,
    annotationRevision: sourceAnnotationRevision,
    nuclei: fieldAssayNucleiChannel,
    signal: fieldAssaySignalChannel,
    focusMode: fieldAssayFocusMode,
    focusAnnId: fieldAssayFocusAnnotationId,
    bgMode: fieldAssayBackgroundMode,
    bgVal: fieldAssayBackgroundValue,
    bgAnnId: fieldAssayBackgroundAnnotationId,
    bgEstimator: fieldAssayBackgroundEstimator,
    segMethod: fieldAssaySegmentationMethod,
    threshManual: fieldAssayThresholdManual,
    minArea: fieldAssayMinArea,
    maxArea: fieldAssayMaxArea,
    watershedDist: fieldAssayWatershedMinDist,
    excludeBoundary: fieldAssayExcludeBoundary,
    countMode: fieldAssayManualCountMode,
    countOverride: fieldAssayManualCountOverride,
    pointsAnnId: fieldAssayManualPointsAnnotationId,
    z: selection.z,
    t: selection.t,
  });
  fieldAssayConfigRef.current = currentAssayConfigFingerprint;
  const isAssayConfigStale = Boolean(fieldAssayPreview && fieldAssayPreviewFingerprint !== currentAssayConfigFingerprint);

  const previewFieldAssay = async () => {
    const token = ++fieldAssayPreviewToken.current;
    const fingerprint = currentAssayConfigFingerprint;
    const output = await run("Could not preview field assay.", async () => {
      const nuclei = finite(fieldAssayNucleiChannel, "Nuclei channel");
      const signal = finite(fieldAssaySignalChannel, "Signal channel");
      if (nuclei === signal) throw new Error("Choose two distinct channels for nuclei and signal.");

      const manualThresh = fieldAssaySegmentationMethod === "manual" ? finite(fieldAssayThresholdManual, "Manual threshold") : undefined;
      const request: Record<string, unknown> = {
        source_id: source.id,
        nuclei_channel: nuclei,
        signal_channel: signal,
        z: selection.z,
        t: selection.t,
        segmentation_method: fieldAssaySegmentationMethod,
        threshold_manual: manualThresh,
        background_estimator: fieldAssayBackgroundEstimator,
        exclude_boundary_nuclei: fieldAssayExcludeBoundary,
        config: {
          nuclear_threshold: manualThresh,
          segmentation_method: fieldAssaySegmentationMethod,
          background_estimator: fieldAssayBackgroundEstimator,
          exclude_boundary_nuclei: fieldAssayExcludeBoundary,
          min_nucleus_area_px: finite(fieldAssayMinArea, "Min nucleus area"),
          max_nucleus_area_px: finite(fieldAssayMaxArea, "Max nucleus area"),
          watershed_min_distance_px: finite(fieldAssayWatershedMinDist, "Watershed distance"),
          endpoint_status: "exploratory",
        },
      };

      if (fieldAssayFocusMode === "all") {
        request.focus_all = true;
      } else {
        if (!fieldAssayFocusAnnotationId) throw new Error("Select a focus annotation ROI.");
        request.focus_annotation_id = fieldAssayFocusAnnotationId;
      }

      if (fieldAssayBackgroundMode === "value") {
        request.background_value = finite(fieldAssayBackgroundValue, "Background ADU value");
      } else {
        if (!fieldAssayBackgroundAnnotationId) throw new Error("Select a background annotation ROI.");
        request.background_annotation_id = fieldAssayBackgroundAnnotationId;
      }

      if (fieldAssayManualCountMode === "override" && fieldAssayManualCountOverride.trim()) {
        request.manual_count = finite(fieldAssayManualCountOverride, "Manual count override");
      } else if (fieldAssayManualCountMode === "points" && fieldAssayManualPointsAnnotationId) {
        request.manual_points_annotation_id = fieldAssayManualPointsAnnotationId;
      }

      const res = (await api.execute("field_assay_preview", request)) as {
        preview?: boolean;
        overlay?: string;
        qc_overlay?: string;
        summary?: Record<string, unknown>;
        warnings?: string[];
        nuclei_count?: number;
        reviewed_count?: number;
        count_mode?: string;
        saturation?: { nuclei: number; signal: number; background: number };
        field_ratio?: number | null | string;
        integrated_signal_minus_background?: number;
        raw_signal_sum?: number;
        focus_mask_pixels?: number;
        measurements?: Array<Record<string, unknown>>;
      };

      if (!res.preview || !res.qc_overlay) throw new Error("The engine did not return a field assay preview.");
      if (res.overlay && res.measurements) {
        onPreview(res.overlay, res.measurements);
      }
      return {
        summary: res.summary ?? {},
        warnings: res.warnings ?? [],
        qc_overlay: res.qc_overlay,
        nuclei_count: Number(res.nuclei_count ?? 0),
        reviewed_count: Number(res.reviewed_count ?? 0),
        count_mode: String(res.count_mode ?? "algorithmic"),
        saturation: res.saturation ?? { nuclei: 0, signal: 0, background: 0 },
        field_ratio: res.field_ratio ?? null,
        integrated_signal_minus_background: Number(res.integrated_signal_minus_background ?? 0),
        raw_signal_sum: Number(res.raw_signal_sum ?? 0),
        focus_mask_pixels: Number(res.focus_mask_pixels ?? 0),
      };
    });
    if (
      output &&
      token === fieldAssayPreviewToken.current &&
      fingerprint === fieldAssayConfigRef.current
    ) {
      setFieldAssayPreview(output);
      setFieldAssayPreviewFingerprint(fingerprint);
    }
  };

  const adoptFieldAssay = async () => {
    await run("Could not adopt field assay.", async () => {
      const nuclei = finite(fieldAssayNucleiChannel, "Nuclei channel");
      const signal = finite(fieldAssaySignalChannel, "Signal channel");
      if (nuclei === signal) throw new Error("Choose two distinct channels for nuclei and signal.");

      if (isAssayConfigStale) {
        throw new Error("Configuration has changed since preview. Please re-run preview before adopting.");
      }

      const isReviewed =
        fieldAssayConfirmChannel &&
        fieldAssayConfirmAcq &&
        fieldAssayConfirmFocus &&
        fieldAssayConfirmNuclei &&
        fieldAssayConfirmBackground;

      if (isReviewed) {
        if (!fieldAssayReviewer.trim()) {
          throw new Error("Reviewer name is required for reviewed field assay publication.");
        }
        if ((fieldAssaySegmentationMethod === "otsu" || fieldAssaySegmentationMethod === "yen") && fieldAssayManualCountMode === "none") {
          throw new Error("Dynamic Otsu/Yen thresholding cannot be published as reviewed without a fixed calibrated threshold or manual count.");
        }
        if (fieldAssayFocusMode === "all") {
          throw new Error("Reviewed publication requires a human-reviewed focus ROI (whole-field measurement is not permitted).");
        }
        if (fieldAssayBackgroundMode === "value" && (Number(fieldAssayBackgroundValue) === 0 || !fieldAssayBackgroundValue.trim())) {
          throw new Error("Reviewed publication requires a cell-free background measurement, not unmeasured zero background.");
        }
      }

      const manualThresh = fieldAssaySegmentationMethod === "manual" ? finite(fieldAssayThresholdManual, "Manual threshold") : undefined;
      const request: Record<string, unknown> = {
        source_id: source.id,
        nuclei_channel: nuclei,
        signal_channel: signal,
        z: selection.z,
        t: selection.t,
        segmentation_method: fieldAssaySegmentationMethod,
        threshold_manual: manualThresh,
        background_estimator: fieldAssayBackgroundEstimator,
        exclude_boundary_nuclei: fieldAssayExcludeBoundary,
        reviewer: fieldAssayReviewer.trim() || undefined,
        assay_notes: fieldAssayNotes.trim() || undefined,
        endpoint_status: isReviewed ? "reviewed" : "exploratory",
        channel_identity_confirmed: fieldAssayConfirmChannel,
        acquisition_comparable: fieldAssayConfirmAcq,
        focus_reviewed: fieldAssayConfirmFocus,
        nuclei_reviewed: fieldAssayConfirmNuclei,
        background_reviewed: fieldAssayConfirmBackground,
        saturation_reviewed: fieldAssayConfirmSaturation,
        config: {
          nuclear_threshold: manualThresh,
          segmentation_method: fieldAssaySegmentationMethod,
          background_estimator: fieldAssayBackgroundEstimator,
          exclude_boundary_nuclei: fieldAssayExcludeBoundary,
          min_nucleus_area_px: finite(fieldAssayMinArea, "Min nucleus area"),
          max_nucleus_area_px: finite(fieldAssayMaxArea, "Max nucleus area"),
          watershed_min_distance_px: finite(fieldAssayWatershedMinDist, "Watershed distance"),
          endpoint_status: isReviewed ? "reviewed" : "exploratory",
          channel_identity_confirmed: fieldAssayConfirmChannel,
          acquisition_comparable: fieldAssayConfirmAcq,
          focus_reviewed: fieldAssayConfirmFocus,
          nuclei_reviewed: fieldAssayConfirmNuclei,
          background_reviewed: fieldAssayConfirmBackground,
          saturation_reviewed: fieldAssayConfirmSaturation,
          reviewer: fieldAssayReviewer.trim() || undefined,
          assay_notes: fieldAssayNotes.trim() || undefined,
        },
      };

      if (fieldAssayFocusMode === "all") {
        request.focus_all = true;
      } else {
        if (!fieldAssayFocusAnnotationId) throw new Error("Select a focus annotation ROI.");
        request.focus_annotation_id = fieldAssayFocusAnnotationId;
      }

      if (fieldAssayBackgroundMode === "value") {
        request.background_value = finite(fieldAssayBackgroundValue, "Background ADU value");
      } else {
        if (!fieldAssayBackgroundAnnotationId) throw new Error("Select a background annotation ROI.");
        request.background_annotation_id = fieldAssayBackgroundAnnotationId;
      }

      if (fieldAssayManualCountMode === "override" && fieldAssayManualCountOverride.trim()) {
        request.manual_count = finite(fieldAssayManualCountOverride, "Manual count override");
      } else if (fieldAssayManualCountMode === "points" && fieldAssayManualPointsAnnotationId) {
        request.manual_points_annotation_id = fieldAssayManualPointsAnnotationId;
      }

      const res = (await api.execute("field_assay_run", request)) as {
        adopted?: boolean;
        result?: unknown;
      };
      if (res.adopted !== true) throw new Error("Field assay was not adopted.");
      const exact = exactResult(res.result, source.id);
      await onPublished(exact);
      return exact;
    });
  };

  const channelOptions = metadata?.channels ?? [];
  const fieldAssayUnsupported = isRgb || (metadata !== null && channelOptions.length < 2);
  const selectedNucleiChannel = channelOptions.find(
    (channel) => channel.index === Number(fieldAssayNucleiChannel),
  );
  const selectedSignalChannel = channelOptions.find(
    (channel) => channel.index === Number(fieldAssaySignalChannel),
  );
  const focusReadiness = fieldAssayFocusMode === "all"
    ? "whole field (exploratory)"
    : planeRegionAnnotations.some((annotation) => annotation.id === fieldAssayFocusAnnotationId)
    ? "current-plane ROI selected"
    : "current-plane ROI required";
  const backgroundReadiness = fieldAssayBackgroundMode === "value"
    ? `explicit ${fieldAssayBackgroundValue || "unset"} ADU`
    : planeRegionAnnotations.some((annotation) => annotation.id === fieldAssayBackgroundAnnotationId)
    ? "current-plane ROI selected"
    : "current-plane ROI required";
  const countReadiness = fieldAssayManualCountMode === "override"
    ? `manual override ${fieldAssayManualCountOverride || "unset"}`
    : fieldAssayManualCountMode === "points"
    ? fieldAssayManualPointsAnnotationId === "all_points"
      ? `${planePointAnnotations.length} current-plane point annotation(s)`
      : planePointAnnotations.some((annotation) => annotation.id === fieldAssayManualPointsAnnotationId)
      ? "current-plane point marks selected"
      : "current-plane point marks required"
    : "algorithmic segmentation";
  const fieldAssayPreviewState = fieldAssayPreview
    ? isAssayConfigStale ? "stale; preview again" : "current display-only preview"
    : "not run";
  const fieldAssayInputsReady = Boolean(
    metadata &&
    !fieldAssayUnsupported &&
    selectedNucleiChannel &&
    selectedSignalChannel &&
    selectedNucleiChannel.index !== selectedSignalChannel.index &&
    (fieldAssayFocusMode === "all" || fieldAssayFocusAnnotationId) &&
    (fieldAssayBackgroundMode === "value" || fieldAssayBackgroundAnnotationId) &&
    (fieldAssayManualCountMode !== "points" || fieldAssayManualPointsAnnotationId) &&
    (fieldAssayManualCountMode !== "override" || fieldAssayManualCountOverride.trim()),
  );
  return (
    <div className="research-panel research-quantification">
      <div className="research-mode-tabs research-quantification-tabs">
        {(["channels", "recipe", "puncta", "colocalisation", "association", "field-assay"] as const).map((item) => (
          <button key={item} className={mode === item ? "active" : ""} onClick={() => setMode(item)}>{item === "field-assay" ? "Field assay" : item}</button>
        ))}
      </div>
      {actionError && <p role="alert">{actionError}</p>}

      {mode === "channels" && <>
        <h2>Biological channel declarations</h2>
        <p>Acquisition names remain immutable. Marker and fluorophore identities are explicit user declarations; none are inferred from appearance.</p>
        {isRgb ? <p role="alert">RGB samples are colour components and cannot be declared as independent biological channels.</p> : channelError ? <p role="alert">{channelError}</p> : !metadata ? <p role="status">Loading exact channel metadata…</p> : <>
          {channelDraft.map((channel, index) => <fieldset key={channel.index}>
            <legend>Acquisition channel {index + 1} · original: {metadata.original_names[index]}</legend>
            {(["name", "marker", "fluorophore", "declaration"] as const).map((field) => <label key={field}>{field}
              <input aria-label={`Channel ${index + 1} ${field}`} value={channel[field]} onChange={(event) => setChannelDraft((old) => old.map((item) => item.index === channel.index ? { ...item, [field]: event.target.value } : item))} />
            </label>)}
          </fieldset>)}
          <button className="research-primary" disabled={locked} onClick={() => void saveChannels()}>Save declarations at revision {metadata.revision}</button>
          <p className="research-summary">Basis: {metadata.basis}</p>
        </>}
      </>}

      {mode === "recipe" && <>
        <h2>Quantitative recipe inputs</h2>
        <p>These controls update the existing non-destructive recipe. Every spatial value uses the selected source geometry unit.</p>
        <fieldset><legend>Background subtraction</legend>
          <label>Gaussian background sigma<input aria-label="Background sigma" type="number" step="any" value={background} onChange={(event) => setBackground(event.target.value)} /></label>
          <label className="research-check"><input type="checkbox" checked={backgroundClip} onChange={(event) => setBackgroundClip(event.target.checked)} /> Clip negative values</label>
          <button onClick={() => updateBackground(!recipe.steps.some((step) => step.op === "subtract_background"))}>{recipe.steps.some((step) => step.op === "subtract_background") ? "Remove background step" : "Add background step"}</button>
        </fieldset>
        <fieldset><legend>Flat-field reference</legend>
          <label>Flat source<select aria-label="Flat-field source" value={flatSource} onChange={(event) => setFlatSource(event.target.value)}><option value="">Choose exact source…</option>{snapshot.sources.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.id.slice(0, 8)}…</option>)}</select></label>
          <label>Flat scalar channel<input aria-label="Flat-field channel" type="number" min="0" step="1" value={flatChannel} onChange={(event) => setFlatChannel(event.target.value)} /></label>
          <label>Optional dark source<select aria-label="Dark-field source" value={darkSource} onChange={(event) => setDarkSource(event.target.value)}><option value="">No dark reference</option>{snapshot.sources.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.id.slice(0, 8)}…</option>)}</select></label>
          {darkSource && <label>Dark scalar channel<input aria-label="Dark-field channel" type="number" min="0" step="1" value={darkChannel} onChange={(event) => setDarkChannel(event.target.value)} /></label>}
          <button onClick={() => updateFlatfield(!recipe.steps.some((step) => step.op === "flatfield"))}>{recipe.steps.some((step) => step.op === "flatfield") ? "Remove flat-field step" : "Bind flat-field step"}</button>
          <p>References must match the selected crop, shape, and physical grid exactly; the engine rejects mismatches.</p>
        </fieldset>
        <fieldset><legend>Raw measurement channels</legend>{channelOptions.map((channel) => <label className="research-check" key={channel.index}><input type="checkbox" checked={recipe.measurement_channels.includes(channel.index)} onChange={(event) => setRecipe((old) => ({ ...old, measurement_channels: event.target.checked ? [...old.measurement_channels, channel.index].sort((a, b) => a - b) : old.measurement_channels.filter((item) => item !== channel.index) }))} /> {channel.index + 1}: {channel.name}</label>)}</fieldset>
        <fieldset><legend>Marker gates</legend><button onClick={addGate} disabled={!channelOptions.length}>Add explicit gate</button>
          {recipe.gates.map((gate, index) => <div className="research-gate" key={index}>
            <label>Gate name<input aria-label={`Gate ${index + 1} name`} value={gate.name} onChange={(event) => setRecipe((old) => ({ ...old, gates: old.gates.map((item, i) => i === index ? { ...item, name: event.target.value } : item) }))} /></label>
            <label>Raw channel<select aria-label={`Gate ${index + 1} channel`} value={gate.channel} onChange={(event) => setRecipe((old) => ({ ...old, gates: old.gates.map((item, i) => i === index ? { ...item, channel: event.target.value } : item) }))}>{channelOptions.filter((item) => recipe.measurement_channels.includes(item.index)).map((item) => <option key={item.index}>{item.index + 1}: {item.name}</option>)}</select></label>
            <label>Statistic<select aria-label={`Gate ${index + 1} statistic`} value={gate.statistic} onChange={(event) => setRecipe((old) => ({ ...old, gates: old.gates.map((item, i) => i === index ? { ...item, statistic: event.target.value as "mean" | "sum" | "max" } : item) }))}><option>mean</option><option>sum</option><option>max</option></select></label>
            <label>Threshold<input aria-label={`Gate ${index + 1} threshold`} type="number" step="any" value={gate.threshold} onChange={(event) => setRecipe((old) => ({ ...old, gates: old.gates.map((item, i) => i === index ? { ...item, threshold: Number(event.target.value) } : item) }))} /></label>
            <label>Control / assumption<textarea aria-label={`Gate ${index + 1} control`} value={gate.control} onChange={(event) => setRecipe((old) => ({ ...old, gates: old.gates.map((item, i) => i === index ? { ...item, control: event.target.value } : item) }))} /></label>
            <button onClick={() => setRecipe((old) => ({ ...old, gates: old.gates.filter((_, i) => i !== index) }))}>Remove gate</button>
          </div>)}
        </fieldset>
      </>}

      {mode === "puncta" && <>
        <h2>Puncta candidates</h2><p>All LoG scales, thresholds, distances, borders, and assumptions are explicit. Preview is display-only; adoption reruns the unchanged request.</p>
        <div className="research-grid">
          {[ ["Physical LoG sigma", punctaSigma, setPunctaSigma], ["LoG response threshold", punctaResponse, setPunctaResponse], ["Raw intensity threshold", punctaRaw, setPunctaRaw], ["Physical minimum distance", punctaDistance, setPunctaDistance], ["Physical aperture radius", punctaAperture, setPunctaAperture] ].map(([label, value, setter]) => <label key={label as string}>{label as string}<input aria-label={label as string} type="number" step="any" value={value as string} onChange={(event) => (setter as (v: string) => void)(event.target.value)} /></label>)}
        </div>
        <label className="research-check"><input type="checkbox" checked={punctaBorder} onChange={(event) => setPunctaBorder(event.target.checked)} /> Exclude peaks whose aperture touches the crop border</label>
        <label>Control / assumptions<textarea aria-label="Puncta control and assumptions" value={punctaControl} onChange={(event) => setPunctaControl(event.target.value)} /></label>
        <div className="research-actions"><button disabled={locked || isRgb} onClick={() => void previewPuncta()}>Preview puncta candidates</button><button className="research-primary" disabled={locked || !punctaPreview} onClick={() => void adoptPuncta()}>Adopt unchanged puncta request</button></div>
        {punctaPreview && <><p className="research-summary">Display-only {punctaPreview.overlayBasis}; {punctaPreview.totalPeaks} initial peaks before correction. Manual label edits may change regions later, while this peak receipt remains the initial-peaks-before-correction record.</p><CompactTable rows={punctaPreview.peaks} /></>}
      </>}

      {mode === "colocalisation" && <>
        <h2>Descriptive colocalisation</h2><p>Choose two exact acquisition channels and declare both raw thresholds and controls. Metrics describe spatial association; they do not establish molecular interaction or independent samples.</p>
        {isRgb && <p role="alert">RGB colour components are not biological channels; colocalisation is unavailable.</p>}
        <label>First declared channel<select aria-label="First colocalisation channel" value={firstChannel} onChange={(event) => setFirstChannel(event.target.value)}>{channelOptions.map((item) => <option key={item.index} value={item.index}>{item.index + 1}: {item.name}</option>)}</select></label>
        <label>First raw threshold<input aria-label="First colocalisation threshold" type="number" step="any" value={firstThreshold} onChange={(event) => setFirstThreshold(event.target.value)} /></label>
        <label>Second declared channel<select aria-label="Second colocalisation channel" value={secondChannel} onChange={(event) => setSecondChannel(event.target.value)}>{channelOptions.map((item) => <option key={item.index} value={item.index}>{item.index + 1}: {item.name}</option>)}</select></label>
        <label>Second raw threshold<input aria-label="Second colocalisation threshold" type="number" step="any" value={secondThreshold} onChange={(event) => setSecondThreshold(event.target.value)} /></label>
        <label>Controls / assumptions<textarea aria-label="Colocalisation controls and assumptions" value={colocalisationControl} onChange={(event) => setColocalisationControl(event.target.value)} /></label>
        <button className="research-primary" disabled={locked || isRgb || channelOptions.length < 2} onClick={() => void runColocalisation()}>Run and adopt colocalisation</button>
        {metrics && <dl className="research-kv">{Object.entries(metrics).map(([key, value]) => <div key={key}><dt>{key.replaceAll("_", " ")}</dt><dd>{String(value ?? "not defined")}</dd></div>)}</dl>}
      </>}

      {mode === "association" && <>
        <h2>Nucleus–cell association</h2><p>Bind two distinct immutable label revisions on the same exact source, crop, array grid, and physical geometry. Declare which result is nuclei and which is cells.</p>
        <label>Nuclei result<select aria-label="Nuclei result" value={nucleiId} onChange={(event) => setNucleiId(event.target.value)}><option value="">Choose exact revision…</option>{labelResults.map((item) => <option key={item.id} value={item.id}>{resultLabel(item, snapshot)}</option>)}</select></label>
        {nucleus && punctaLineage(nucleus, snapshot) && <p className="research-summary">{punctaLineage(nucleus, snapshot) === "initial" ? "Initial puncta labels; peaks are the initial-peaks-before-correction record." : "Manual label revision selected; its puncta peak receipt still describes initial peaks before correction."}</p>}
        <label>Nuclei role declaration<input aria-label="Nuclei role declaration" value={nucleusRole} onChange={(event) => setNucleusRole(event.target.value)} /></label>
        <label>Cells result<select aria-label="Cells result" value={cellsId} onChange={(event) => setCellsId(event.target.value)} disabled={!nucleus}><option value="">No compatible exact revision</option>{compatibleCells.map((item) => <option key={item.id} value={item.id}>{resultLabel(item, snapshot)}</option>)}</select></label>
        <label>Cells role declaration<input aria-label="Cells role declaration" value={cellRole} onChange={(event) => setCellRole(event.target.value)} /></label>
        <label>Controls / assumptions<textarea aria-label="Association controls and assumptions" value={associationControl} onChange={(event) => setAssociationControl(event.target.value)} /></label>
        <button className="research-primary" disabled={locked || !nucleus || !cellsId || nucleusRole.trim() === cellRole.trim()} onClick={() => void runAssociation()}>Associate exact revisions</button>
        {associationTotal > 0 && <><p className="research-summary">{associationTotal} nucleus association records. Association results cannot be edited directly. Open the exact cell or nucleus parent, create a corrected child, then rerun association.</p><CompactTable rows={associations as Array<Record<string, unknown>>} /></>}
      </>}

      {mode === "field-assay" && <>
        <h2>Fluorescence per nucleus</h2>
        <p>Measure signal in a region, subtract background, and divide by the reviewed nucleus count.</p>
        <dl className="research-kv" aria-label="Field assay readiness">
          <div><dt>Exact source</dt><dd>{source.name} · {source.sha256.slice(0, 12)}…</dd></div>
          <div><dt>Plane</dt><dd>T {selection.t}, Z {selection.z}</dd></div>
          <div><dt>Nuclear channel</dt><dd>{selectedNucleiChannel ? `${selectedNucleiChannel.index + 1}: ${selectedNucleiChannel.name}` : "select a declared channel"}</dd></div>
          <div><dt>Signal channel</dt><dd>{selectedSignalChannel ? `${selectedSignalChannel.index + 1}: ${selectedSignalChannel.name}` : "select a declared channel"}</dd></div>
          <div><dt>Focus</dt><dd>{focusReadiness}</dd></div>
          <div><dt>Background</dt><dd>{backgroundReadiness}</dd></div>
          <div><dt>Count basis</dt><dd>{countReadiness}</dd></div>
          <div><dt>Preview</dt><dd>{fieldAssayPreviewState}</dd></div>
        </dl>
        {fieldAssayAnnotationError && <p role="alert">{fieldAssayAnnotationError}</p>}
        {isRgb ? <p role="alert">Interleaved histology RGB/RGBA sources do not support scalar fluorescence field assay.</p> : metadata !== null && channelOptions.length < 2 ? <p role="alert">Field assay requires at least two independently addressable scalar channels.</p> : <>
          <fieldset><legend>Channel roles</legend>
            <label>Nuclear channel<select aria-label="Nuclear channel" value={fieldAssayNucleiChannel} onChange={(event) => setFieldAssayNucleiChannel(event.target.value)}>
              {channelOptions.map((item) => <option key={item.index} value={item.index}>{item.index + 1}: {item.name}</option>)}
            </select></label>
            <label>Signal channel<select aria-label="Signal channel" value={fieldAssaySignalChannel} onChange={(event) => setFieldAssaySignalChannel(event.target.value)}>
              {channelOptions.map((item) => <option key={item.index} value={item.index}>{item.index + 1}: {item.name}</option>)}
            </select></label>
          </fieldset>

          <fieldset><legend>Regions on T {selection.t}, Z {selection.z}</legend>
            <label>Focus region<select aria-label="Focus region selection" value={fieldAssayFocusMode === "all" ? "all" : fieldAssayFocusAnnotationId} onChange={(event) => {
              if (event.target.value === "all") {
                setFieldAssayFocusMode("all");
              } else {
                setFieldAssayFocusMode("annotation");
                setFieldAssayFocusAnnotationId(event.target.value);
              }
            }}>
              <option value="">Select focus ROI…</option>
              {planeRegionAnnotations.map((a) => (
                <option key={a.id} value={a.id}>ROI: {a.label || a.id.slice(0, 8)} · T {a.t}, Z {a.z}</option>
              ))}
              <option value="all">Measure whole field (exploratory only)</option>
            </select></label>
            {fieldAssayFocusMode === "all" && (
              <p className="research-callout" style={{ fontSize: "12px", color: "#b86200", margin: "4px 0" }}>
                Whole-field measurement is exploratory only. Reviewed publication requires a human-approved focus ROI.
              </p>
            )}

            <label>Background estimation<select aria-label="Background mode selection" value={fieldAssayBackgroundMode} onChange={(event) => setFieldAssayBackgroundMode(event.target.value as "value" | "annotation")}>
              <option value="annotation">Cell-free background ROI annotation</option>
              <option value="value">Explicit background ADU value</option>
            </select></label>

            {fieldAssayBackgroundMode === "value" ? (
              <>
                <label>Background ADU value<input aria-label="Background ADU value" type="number" step="any" value={fieldAssayBackgroundValue} onChange={(event) => setFieldAssayBackgroundValue(event.target.value)} /></label>
                {(Number(fieldAssayBackgroundValue) === 0 || !fieldAssayBackgroundValue.trim()) && (
                  <p className="research-callout" style={{ fontSize: "12px", color: "#b86200", margin: "4px 0" }}>
                    Unmeasured zero background is exploratory only. Reviewed publication requires a cell-free background measurement.
                  </p>
                )}
              </>
            ) : (
              <label>Background ROI<select aria-label="Background annotation selection" value={fieldAssayBackgroundAnnotationId} onChange={(event) => setFieldAssayBackgroundAnnotationId(event.target.value)}>
                <option value="">Select background ROI…</option>
                {planeRegionAnnotations.map((a) => (
                  <option key={a.id} value={a.id}>ROI: {a.label || a.id.slice(0, 8)} · T {a.t}, Z {a.z}</option>
                ))}
              </select></label>
            )}

            <label>Background statistic<select aria-label="Background estimator" value={fieldAssayBackgroundEstimator} onChange={(event) => setFieldAssayBackgroundEstimator(event.target.value as "median" | "mean")}>
              <option value="median">Median (robust estimator)</option>
              <option value="mean">Mean (ImageJ legacy parity)</option>
            </select></label>
          </fieldset>

          <fieldset><legend>Nucleus segmentation & counting</legend>
            <label>Method<select aria-label="Segmentation method" value={fieldAssaySegmentationMethod} onChange={(event) => setFieldAssaySegmentationMethod(event.target.value)}>
              <option value="manual">Manual threshold</option>
              <option value="otsu">Otsu automatic threshold</option>
              <option value="yen">Yen automatic threshold</option>
            </select></label>
            {(fieldAssaySegmentationMethod === "otsu" || fieldAssaySegmentationMethod === "yen") && (
              <p className="research-callout" style={{ fontSize: "12px", color: "#b86200", margin: "4px 0" }}>
                Notice: {fieldAssaySegmentationMethod.toUpperCase()} calculates an image-dependent threshold that varies across fields. It is suitable for exploratory preview, but reviewed publication requires a fixed calibrated threshold across treatments or an authoritative manual count.
              </p>
            )}
            {fieldAssaySegmentationMethod === "manual" && (
              <label>Threshold ADU<input aria-label="Manual threshold" type="number" step="any" value={fieldAssayThresholdManual} onChange={(event) => setFieldAssayThresholdManual(event.target.value)} /></label>
            )}
            <label>Min nucleus area (px)<input aria-label="Min nucleus area" type="number" min="1" value={fieldAssayMinArea} onChange={(event) => setFieldAssayMinArea(event.target.value)} /></label>
            <label>Max nucleus area (px)<input aria-label="Max nucleus area" type="number" min="1" value={fieldAssayMaxArea} onChange={(event) => setFieldAssayMaxArea(event.target.value)} /></label>
            <label>Watershed min peak distance (px)<input aria-label="Watershed distance" type="number" min="1" value={fieldAssayWatershedMinDist} onChange={(event) => setFieldAssayWatershedMinDist(event.target.value)} /></label>
            <label className="research-check"><input type="checkbox" checked={fieldAssayExcludeBoundary} onChange={(event) => setFieldAssayExcludeBoundary(event.target.checked)} /> Exclude boundary-touching nuclei</label>

            <label>Count mode<select aria-label="Count mode" value={fieldAssayManualCountMode} onChange={(event) => setFieldAssayManualCountMode(event.target.value as "none" | "override" | "points")}>
              <option value="none">Algorithmic segmentation count</option>
              <option value="points">Count marks from point annotations</option>
              <option value="override">Manual count override</option>
            </select></label>

            {fieldAssayManualCountMode === "override" && (
              <label>Manual count<input aria-label="Manual count override value" type="number" min="0" value={fieldAssayManualCountOverride} onChange={(event) => setFieldAssayManualCountOverride(event.target.value)} /></label>
            )}
            {fieldAssayManualCountMode === "points" && (
              <label>Point marks annotation<select aria-label="Manual points annotation" value={fieldAssayManualPointsAnnotationId} onChange={(event) => setFieldAssayManualPointsAnnotationId(event.target.value)}>
                <option value="">Select point annotation…</option>
                <option value="all_points" disabled={!planePointAnnotations.length}>All point markers on T {selection.t}, Z {selection.z}</option>
                {planePointAnnotations.map((a) => {
                  const count = a.points?.length ?? 1;
                  return (
                    <option key={a.id} value={a.id}>
                      Marks: {a.label || a.id.slice(0, 8)} ({count} {count === 1 ? "point" : "points"})
                    </option>
                  );
                })}
              </select></label>
            )}
          </fieldset>

          <button className="research-primary" disabled={locked || !fieldAssayInputsReady} onClick={() => void previewFieldAssay()}>Preview field assay</button>

          {isAssayConfigStale && (
            <p className="research-callout" role="alert" style={{ fontSize: "12px", color: "#c02020", margin: "8px 0" }}>
              Configuration changed since preview. Please click "Preview field assay" to update preview before adopting.
            </p>
          )}

          {fieldAssayPreview && <div className="field-assay-preview-results" style={{ marginTop: "12px" }}>
            <h3>Assay quantification preview</h3>
            <img
              className="research-preview"
              src={fieldAssayPreview.qc_overlay}
              alt={`Field assay QC overlay for ${source.name}, T ${selection.t}, Z ${selection.z}`}
            />
            <p className="research-summary">Display-only QC overlay. Inspect the focus boundary, provisional nuclei outlines, rejected objects, and background region before adoption.</p>
            <dl className="research-kv">
              <div><dt>Focus area</dt><dd>{fieldAssayPreview.focus_mask_pixels.toLocaleString()} px</dd></div>
              <div><dt>Raw signal sum</dt><dd>{fieldAssayPreview.raw_signal_sum.toLocaleString()} ADU</dd></div>
              <div><dt>Background ADU</dt><dd>{String(fieldAssayPreview.summary.background_value_adu ?? "—")}</dd></div>
              <div><dt>Signed corrected total</dt><dd style={{ color: fieldAssayPreview.integrated_signal_minus_background < 0 ? "#f47d7d" : undefined }}>{fieldAssayPreview.integrated_signal_minus_background.toLocaleString()} ADU</dd></div>
              <div><dt>Reviewed nuclei count</dt><dd>{fieldAssayPreview.reviewed_count} ({fieldAssayPreview.count_mode})</dd></div>
              <div><dt>Signal per nucleus</dt><dd>{fieldAssayPreview.field_ratio !== null ? `${fieldAssayPreview.field_ratio} ADU` : "Undefined (0 nuclei)"}</dd></div>
              <div><dt>Saturation</dt><dd>Nuclei: {fieldAssayPreview.saturation.nuclei}, Signal: {fieldAssayPreview.saturation.signal}, BG: {fieldAssayPreview.saturation.background}</dd></div>
            </dl>

            {fieldAssayPreview.warnings.length > 0 && <div className="research-warnings" role="alert">
              <strong>Warnings:</strong>
              <ul>{fieldAssayPreview.warnings.map((w, idx) => <li key={idx}>{w}</li>)}</ul>
            </div>}

            <fieldset><legend>Human scientific review & adoption</legend>
              <label className="research-check"><input type="checkbox" aria-label="Confirm channel identity" checked={fieldAssayConfirmChannel} onChange={(event) => setFieldAssayConfirmChannel(event.target.checked)} /> Channel identity confirmed</label>
              <label className="research-check"><input type="checkbox" aria-label="Confirm acquisition comparable" checked={fieldAssayConfirmAcq} onChange={(event) => setFieldAssayConfirmAcq(event.target.checked)} /> Acquisition settings matched within experiment</label>
              <label className="research-check"><input type="checkbox" aria-label="Confirm focus reviewed" checked={fieldAssayConfirmFocus} onChange={(event) => setFieldAssayConfirmFocus(event.target.checked)} /> Focus region inspected and approved</label>
              <label className="research-check"><input type="checkbox" aria-label="Confirm nuclei reviewed" checked={fieldAssayConfirmNuclei} onChange={(event) => setFieldAssayConfirmNuclei(event.target.checked)} /> Nuclei count and segmentation reviewed</label>
              <label className="research-check"><input type="checkbox" aria-label="Confirm background reviewed" checked={fieldAssayConfirmBackground} onChange={(event) => setFieldAssayConfirmBackground(event.target.checked)} /> Background selection reviewed (cell-free)</label>
              {(fieldAssayPreview.saturation.nuclei > 0 || fieldAssayPreview.saturation.signal > 0 || fieldAssayPreview.saturation.background > 0) && (
                <label className="research-check"><input type="checkbox" aria-label="Confirm saturation reviewed" checked={fieldAssayConfirmSaturation} onChange={(event) => setFieldAssayConfirmSaturation(event.target.checked)} /> Saturated pixels inspected and accepted</label>
              )}
              <label>Reviewer name<input aria-label="Reviewer name" value={fieldAssayReviewer} onChange={(event) => setFieldAssayReviewer(event.target.value)} placeholder="Required for reviewed publication" /></label>
              <label>Assay notes<textarea aria-label="Assay notes" value={fieldAssayNotes} onChange={(event) => setFieldAssayNotes(event.target.value)} placeholder="Field observations, focal quality, exclusions..." /></label>

              {(() => {
                const isReviewCandidate =
                  fieldAssayConfirmChannel &&
                  fieldAssayConfirmAcq &&
                  fieldAssayConfirmFocus &&
                  fieldAssayConfirmNuclei &&
                  fieldAssayConfirmBackground;

                const dynamicWithoutManual =
                  (fieldAssaySegmentationMethod === "otsu" || fieldAssaySegmentationMethod === "yen") &&
                  fieldAssayManualCountMode === "none";
                const invalidReviewedRegion =
                  fieldAssayFocusMode === "all" ||
                  (fieldAssayBackgroundMode === "value" &&
                    (Number(fieldAssayBackgroundValue) === 0 || !fieldAssayBackgroundValue.trim()));
                const reviewerMissing = isReviewCandidate && !fieldAssayReviewer.trim();

                const cannotAdoptReviewedReason = !isReviewCandidate
                  ? null
                  : reviewerMissing
                  ? "Reviewer name is required for reviewed adoption."
                  : dynamicWithoutManual
                  ? "Fixed calibrated threshold or manual count required for reviewed adoption (Otsu/Yen varies per image)."
                  : invalidReviewedRegion
                  ? "Human-reviewed focus ROI and cell-free background measurement required for reviewed adoption."
                  : null;

                return (
                  <>
                    {cannotAdoptReviewedReason && (
                      <p className="research-callout" role="alert" style={{ fontSize: "12px", color: "#c02020", margin: "6px 0" }}>
                        {cannotAdoptReviewedReason}
                      </p>
                    )}

                    <button
                      className="research-primary"
                      disabled={locked || isAssayConfigStale || Boolean(cannotAdoptReviewedReason)}
                      onClick={() => void adoptFieldAssay()}
                    >
                      {isReviewCandidate ? "Adopt reviewed field assay" : "Adopt exploratory field assay"}
                    </button>
                  </>
                );
              })()}
            </fieldset>
          </div>}
        </>}
      </>}

      {mode === "channels" && <details><summary>About derived channels</summary><p>Registered channels retain their registration record and fixed-grid geometry. They remain derived data.</p></details>}
    </div>
  );
}
