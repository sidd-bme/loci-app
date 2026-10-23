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
import { ResearchPerinuclearPanel } from "./ResearchPerinuclearPanel";
import { resultTitle } from "./result-title";
import { punctaDistanceUnit, UNVERIFIED_DISTANCE_UNIT } from "./puncta-distance-unit";

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
type CompartmentStats = { count: number; sum: number; mean: number | null; min: number | null; max: number | null; std_population: number | null };
type CompartmentRecord = { voxel_count: number; measure: number; measure_kind: "area" | "volume"; measure_unit: string; intensity: Record<string, CompartmentStats> };
type CompartmentRow = { label: number; compartments: Record<"cell" | "nuclear" | "cytoplasm", CompartmentRecord> };

function compartmentRows(value: unknown, channelNames: string[], geometry: ResearchResult["geometry"]): CompartmentRow[] {
  if (!Array.isArray(value) || value.length > 1000) throw new Error("Invalid compartment measurement records.");
  const labels = new Set<number>();
  for (const item of value) {
    const row = item as CompartmentRow;
    if (!row || !Number.isSafeInteger(row.label) || row.label <= 0 || row.label > 0xFFFFFFFF || labels.has(row.label))
      throw new Error("Invalid compartment cell identity.");
    labels.add(row.label);
    for (const name of ["cell", "nuclear", "cytoplasm"] as const) {
      const record = row.compartments?.[name];
      if (!record || !Number.isSafeInteger(record.voxel_count) || record.voxel_count < 0 ||
          !Number.isFinite(record.measure) || record.measure < 0 || (record.voxel_count === 0 && record.measure !== 0) ||
          !["area", "volume"].includes(record.measure_kind) || typeof record.measure_unit !== "string" ||
          !record.intensity || Object.keys(record.intensity).length !== channelNames.length ||
          record.measure_kind !== (geometry?.axes === "YX" ? "area" : "volume") ||
          record.measure_unit !== `${geometry?.unit}^${geometry?.axes === "YX" ? 2 : 3}`)
        throw new Error("Invalid compartment geometry or channel records.");
      for (const channelName of channelNames) {
        const entries = Object.entries(record.intensity).filter(([key]) => key === channelName);
        if (entries.length !== 1) throw new Error("Compartment channels did not match the request.");
        const stats = entries[0][1];
        if (!stats || stats.count !== record.voxel_count || !Number.isFinite(stats.sum) ||
            (stats.count === 0 && stats.sum !== 0) ||
            [stats.mean, stats.min, stats.max, stats.std_population].some((value) =>
              stats.count === 0 ? value !== null : typeof value !== "number" || !Number.isFinite(value)) ||
            (stats.std_population !== null && stats.std_population < 0) ||
            (stats.count > 0 && (stats.mean! < stats.min! - 1e-12 * Math.max(1, Math.abs(stats.min!)) ||
              stats.mean! > stats.max! + 1e-12 * Math.max(1, Math.abs(stats.max!)))))
          throw new Error("Invalid compartment intensity statistics.");
      }
    }
    if (row.compartments.cell.voxel_count !== row.compartments.nuclear.voxel_count + row.compartments.cytoplasm.voxel_count)
      throw new Error("Compartment counts do not conserve the cell whole.");
    const whole = row.compartments.cell;
    const nuclear = row.compartments.nuclear;
    const cytoplasm = row.compartments.cytoplasm;
    if (whole.measure_kind !== nuclear.measure_kind || whole.measure_kind !== cytoplasm.measure_kind ||
        whole.measure_unit !== nuclear.measure_unit || whole.measure_unit !== cytoplasm.measure_unit ||
        Math.abs(whole.measure - nuclear.measure - cytoplasm.measure) > 1e-12 * whole.measure)
      throw new Error("Compartment physical measures do not conserve the cell whole.");
  }
  return value as CompartmentRow[];
}

function CompartmentTable({ rows, total }: { rows: CompartmentRow[]; total: number }): React.JSX.Element {
  const [channel, setChannel] = useState("");
  const [page, setPage] = useState(0);
  const channels = Object.keys(rows[0]?.compartments.cell.intensity ?? {});
  const selected = channels.includes(channel) ? channel : channels[0];
  const pages = Math.max(1, Math.ceil(rows.length / 25));
  const currentPage = Math.min(page, pages - 1);
  return <section className="research-compartment-table" aria-label="Compartment measurements">
    <label>Measured channel<select aria-label="Compartment table channel" value={selected ?? ""} onChange={(event) => setChannel(event.target.value)}>{channels.map((item) => <option key={item}>{item}</option>)}</select></label>
    <p>{total} measured cells{total > rows.length ? `; ${rows.length} shown here. Open Statistics for the full result.` : "."}</p>
    <div className="research-result-table"><table><thead><tr>{["Cell", "Compartment", "Count", "Area / volume", "Sum", "Mean", "Min", "Max", "Population SD"].map((heading) => <th key={heading}>{heading}</th>)}</tr></thead>
      <tbody>{rows.slice(currentPage * 25, (currentPage + 1) * 25).flatMap((row) => (["cell", "nuclear", "cytoplasm"] as const).map((name) => {
        const record = row.compartments[name]; const stats = record.intensity[selected];
        return <tr key={`${row.label}:${name}`}><td>{row.label}</td><td>{name === "nuclear" ? "Nuclear intersection" : name === "cell" ? "Cell whole" : "Cell minus nuclei"}</td><td>{record.voxel_count}</td><td><MeasurementValue value={record.measure} /> {record.measure_unit}</td>{[stats.sum, stats.mean, stats.min, stats.max, stats.std_population].map((value, index) => <td key={index}>{value === null ? "—" : <MeasurementValue value={value} />}</td>)}</tr>;
      }))}</tbody></table></div>
    {pages > 1 && <div className="research-compartment-pages"><button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous cells</button><span>{currentPage + 1} / {pages}</span><button disabled={currentPage + 1 === pages} onClick={() => setPage(currentPage + 1)}>Next cells</button></div>}
  </section>;
}

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
  const ordinal = snapshot.results.findIndex((item) => item.id === result.id) + 1;
  return `${source?.name ?? "Image unavailable"} · ${resultTitle(result)} · ${result.object_count} objects · Run ${ordinal}`;
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

function exactValue(value: unknown): string {
  if (value === null) return "null";
  if (Object.is(value, -0)) return "-0";
  return typeof value === "object" ? JSON.stringify(value) ?? "—" : String(value ?? "—");
}

function measurementText(value: unknown): string {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(number)) return String(value ?? "not defined");
  if (Object.is(number, -0)) return "-0";
  if (Number.isInteger(number)) return String(number);
  const rounded = Number(number.toPrecision(6));
  return Math.abs(rounded) >= 1e6 || Math.abs(rounded) < 1e-4
    ? number.toExponential(5).replace(/0+e/, "e").replace(/\.e/, "e") : String(rounded);
}

function MeasurementValue({ value }: { value: unknown }): React.JSX.Element {
  return <span data-exact-value={exactValue(value)} title={exactValue(value)}>{measurementText(value)}</span>;
}

function TechnicalValues({ values }: { values: Record<string, unknown> }): React.JSX.Element {
  return <details className="quantification-technical"><summary>Technical record</summary>
    <dl className="research-kv">{Object.entries(values).map(([key, value]) => <div key={key}>
      <dt>{key.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase())}</dt><dd>{exactValue(value)}</dd>
    </div>)}</dl>
  </details>;
}

function sourceLabel(item: ResearchSource, sources: ResearchSource[]): string {
  const duplicates = sources.filter((source) => source.name === item.name);
  return duplicates.length > 1 ? `${item.name} · Image ${duplicates.findIndex((source) => source.id === item.id) + 1}` : item.name;
}

function annotationLabel(item: SourceAnnotation, peers: SourceAnnotation[], all: SourceAnnotation[]): string {
  const label = item.label.trim();
  const duplicates = peers.filter((peer) => peer.label.trim() === label);
  const ordinal = all.findIndex((annotation) => annotation.id === item.id) + 1;
  return !label ? `${item.kind === "point" ? "Count marks" : "Region"} ${ordinal}`
    : duplicates.length > 1 ? `${label} · ${item.kind === "point" ? "Marks" : "ROI"} ${ordinal}` : label;
}

const metricLabels: Record<string, string> = {
  pearson_r: "Pearson r", manders_first: "Manders, first channel", manders_second: "Manders, second channel",
  threshold_first: "First raw threshold", threshold_second: "Second raw threshold", voxel_pairs: "Paired pixels / voxels",
};

function CompactTable({ rows, kind, note }: { rows: Array<Record<string, unknown>>; kind: "peaks" | "associations"; note?: string }): React.JSX.Element | null {
  if (!rows.length) return null;
  const columns = kind === "peaks" ? ["Peak", "Position XYZ", "LoG response", "Raw intensity"] : ["Nucleus", "Cell", "Overlap fraction", "Assignment"];
  const technicalColumns = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  const shown = rows.slice(0, 100);
  return <>
    <div className="research-result-table quantification-compact-table"><table><thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
      <tbody>{shown.map((row, index) => <tr key={index}>{kind === "peaks" ? <>
        <td><MeasurementValue value={row.label} /></td>
        <td className="quantification-position">{Array.isArray(row.world_xyz) ? <>{row.world_xyz.map(measurementText).join(", ")} {String(row.distance_unit ?? "")}</> : "—"}</td>
        <td><MeasurementValue value={row.response} /></td><td><MeasurementValue value={row.raw} /></td>
      </> : <>
        <td><MeasurementValue value={row.nucleus_label} /></td><td>{row.cell_label == null ? "Unassigned" : <MeasurementValue value={row.cell_label} />}</td>
        <td><MeasurementValue value={row.overlap_fraction} /></td><td>{row.ambiguous ? "Ambiguous" : row.cell_label == null ? "Unassigned" : "Assigned"}</td>
      </>}</tr>)}</tbody></table></div>
    <details className="quantification-technical"><summary>Technical record</summary>{note && <p>{note}</p>}<div className="research-result-table"><table>
      <caption>Full precision · {shown.length} {kind === "peaks" ? "peaks" : "assignments"}{rows.length > shown.length ? ` of ${rows.length}` : ""}</caption>
      <thead><tr>{technicalColumns.map((column) => <th key={column}>{column.replaceAll("_", " ")}</th>)}</tr></thead>
      <tbody>{shown.map((row, index) => <tr key={index}>{technicalColumns.map((column) => <td key={column}>{exactValue(row[column])}</td>)}</tr>)}</tbody>
    </table></div></details>
  </>;
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
  initialMode = "channels",
}: {
  initialMode?: "channels" | "association";
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
  const distanceUnit = punctaDistanceUnit(source, selection);
  const [mode, setMode] = useState<"channels" | "recipe" | "puncta" | "colocalisation" | "association" | "perinuclear" | "field-assay">(initialMode);
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
    () => snapshot.results.filter((result) => result.source_id === source.id && Boolean(result.arrays?.image && result.arrays?.labels)),
    [snapshot.results, source.id],
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
  const [associationCounts, setAssociationCounts] = useState<{ ambiguous_count: number; unassigned_count: number } | null>(null);
  const [compartmentChannels, setCompartmentChannels] = useState<number[]>([]);
  const [compartmentMeasurements, setCompartmentMeasurements] = useState<CompartmentRow[]>([]);
  const [compartmentTotal, setCompartmentTotal] = useState<number | null>(null);
  const associationToken = useRef(0);
  useEffect(() => {
    associationToken.current += 1;
    setAssociations([]);
    setAssociationTotal(0);
    setAssociationCounts(null);
    setCompartmentMeasurements([]);
    setCompartmentTotal(null);
  }, [nucleus?.id, nucleus?.revision_hash, cellsId, source.id, source.sha256, metadata?.revision, JSON.stringify(compartmentChannels), nucleusRole, cellRole, associationControl]);
  useEffect(() => { setCompartmentChannels([]); }, [source.id]);

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
    return () => { annotationToken.current += 1; fieldAssayPreviewToken.current += 1; };
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
      const token = associationToken.current;
      const requestedChannels = [...compartmentChannels];
      const value = (await api.execute("associate_results", {
        nuclei: { result_id: nucleus.id, revision_hash: nucleus.revision_hash },
        cells: { result_id: cells.id, revision_hash: cells.revision_hash },
        roles: { nuclei: nucleusRole, cells: cellRole },
        ...(requestedChannels.length ? { measurement_channels: requestedChannels } : {}),
        control: associationControl.trim() || (() => { throw new Error("Declare the association controls and assumptions."); })(),
        working_bytes: WORKING_BYTES,
      })) as { adopted?: boolean; result?: unknown; associations?: AssociationRow[]; total_associations?: number; association_summary?: { nucleus_count: number; ambiguous_count: number; unassigned_count: number }; measurements?: unknown; total_measurements?: number; association_inputs?: Record<string, { result_id: string; revision_hash: string }>; compartment_measurement?: { channels?: Array<{ index: number; name: string; source_id: string; source_sha256: string; selection: ResearchResult["selection"]; geometry: ResearchResult["geometry"] }>; channel_metadata?: unknown } };
      if (value.adopted !== true) throw new Error("Association was not adopted.");
      const result = exactResult(value.result, cells.source_id);
      if (token !== associationToken.current) throw new Error("The selected compartment inputs changed during measurement.");
      if (result.kind !== "nucleus-cell-association" || result.parent_id !== cells.id ||
          result.source_sha256 !== cells.source_sha256 ||
          !canonicalEqual(result.geometry, cells.geometry) || !canonicalEqual(result.selection, cells.selection) ||
          result.arrays?.labels?.sha256 !== cells.arrays?.labels?.sha256 ||
          result.arrays?.nuclei_labels?.sha256 !== nucleus.arrays?.labels?.sha256 ||
          value.association_inputs?.nuclei?.result_id !== nucleus.id || value.association_inputs?.nuclei?.revision_hash !== nucleus.revision_hash ||
          value.association_inputs?.cells?.result_id !== cells.id || value.association_inputs?.cells?.revision_hash !== cells.revision_hash ||
          !Array.isArray(value.associations) || !Number.isSafeInteger(value.total_associations) ||
          (value.total_associations ?? -1) < 0 || value.associations.length !== Math.min(value.total_associations ?? -1, 1000) ||
          value.associations.some((row) => !Number.isSafeInteger(row.nucleus_label) || (row.nucleus_label ?? 0) <= 0 ||
            (row.cell_label !== null && (!Number.isSafeInteger(row.cell_label) || (row.cell_label ?? 0) <= 0)) ||
            typeof row.ambiguous !== "boolean" || !Number.isFinite(row.overlap_fraction) ||
            (row.overlap_fraction ?? -1) < 0 || (row.overlap_fraction ?? 2) > 1))
        throw new Error("Association response did not match the selected immutable inputs.");
      if (!value.association_summary || value.association_summary.nucleus_count !== value.total_associations ||
          [value.association_summary.ambiguous_count, value.association_summary.unassigned_count].some((count) =>
            !Number.isSafeInteger(count) || count < 0 || count > (value.total_associations ?? -1)))
        throw new Error("Invalid nucleus assignment accounting.");
      const channelNames = requestedChannels.map((index) => `${index + 1}: ${metadata?.channels[index]?.name}`);
      const measured = requestedChannels.length ? compartmentRows(value.measurements, channelNames, cells.geometry) : [];
      if (requestedChannels.length && (!Number.isSafeInteger(value.total_measurements) ||
          value.total_measurements !== result.object_count ||
          measured.length !== Math.min(value.total_measurements ?? -1, 1000) ||
          !canonicalEqual(value.compartment_measurement?.channels?.map((item) => item.index), requestedChannels) ||
          !canonicalEqual(value.compartment_measurement?.channel_metadata, metadata) ||
          value.compartment_measurement?.channels?.some((item, index) => item.name !== channelNames[index] ||
            item.source_id !== cells.source_id || item.source_sha256 !== cells.source_sha256 ||
            !canonicalEqual(item.geometry, cells.geometry) ||
            !canonicalEqual(item.selection, { ...cells.selection, c: requestedChannels[index] }))))
        throw new Error("Compartment response did not match the selected raw channels.");
      await onPublished(result);
      return { ...value, measured, token };
    });
    if (!output || output.token !== associationToken.current) return;
    setAssociations(output.associations ?? []);
    setAssociationCounts(output.association_summary ?? null);
    setAssociationTotal(Number(output.total_associations));
    setCompartmentMeasurements(output.measured);
    setCompartmentTotal(compartmentChannels.length ? Number(output.total_measurements) : null);
  };

  const currentAssayConfigFingerprint = JSON.stringify({
    sourceId: source.id,
    sourceSha256: source.sha256,
    channelMetadataRevision: metadata?.revision,
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
      return {
        overlay: res.overlay,
        measurements: res.measurements,
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
      const { overlay, measurements, ...preview } = output;
      if (overlay && measurements) onPreview(overlay, measurements);
      setFieldAssayPreview(preview);
      setFieldAssayPreviewFingerprint(fingerprint);
    }
  };

  const adoptFieldAssay = async (isReviewed: boolean) => {
    await run("Could not adopt field assay.", async () => {
      const nuclei = finite(fieldAssayNucleiChannel, "Nuclei channel");
      const signal = finite(fieldAssaySignalChannel, "Signal channel");
      if (nuclei === signal) throw new Error("Choose two distinct channels for nuclei and signal.");

      if (isAssayConfigStale) {
        throw new Error("Configuration has changed since preview. Please re-run preview before adopting.");
      }


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
        channel_identity_confirmed: isReviewed,
        acquisition_comparable: isReviewed,
        focus_reviewed: isReviewed,
        nuclei_reviewed: isReviewed,
        background_reviewed: isReviewed,
        saturation_reviewed: isReviewed,
        config: {
          nuclear_threshold: manualThresh,
          segmentation_method: fieldAssaySegmentationMethod,
          background_estimator: fieldAssayBackgroundEstimator,
          exclude_boundary_nuclei: fieldAssayExcludeBoundary,
          min_nucleus_area_px: finite(fieldAssayMinArea, "Min nucleus area"),
          max_nucleus_area_px: finite(fieldAssayMaxArea, "Max nucleus area"),
          watershed_min_distance_px: finite(fieldAssayWatershedMinDist, "Watershed distance"),
          endpoint_status: isReviewed ? "reviewed" : "exploratory",
          channel_identity_confirmed: isReviewed,
          acquisition_comparable: isReviewed,
          focus_reviewed: isReviewed,
          nuclei_reviewed: isReviewed,
          background_reviewed: isReviewed,
          saturation_reviewed: isReviewed,
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
        {(["channels", "recipe", "puncta", "colocalisation", "association", "perinuclear", "field-assay"] as const).map((item) => (
          <button key={item} className={mode === item ? "active" : ""} onClick={() => setMode(item)}>{({ channels: "Channels", recipe: "Recipe", puncta: "Puncta", colocalisation: "Colocalisation", association: "Compartments", perinuclear: "Perinuclear", "field-assay": "Field assay" })[item]}</button>
        ))}
      </div>
      {actionError && <p role="alert">{actionError}</p>}

      {mode === "channels" && <>
        <h2>Channel identities</h2>
        <p>Name each channel and record its marker and fluorophore.</p>
        {isRgb ? <p role="alert">RGB samples are colour components and cannot be declared as independent biological channels.</p> : channelError ? <p role="alert">{channelError}</p> : !metadata ? <p role="status">Loading exact channel metadata…</p> : <>
          {channelDraft.map((channel, index) => <fieldset key={channel.index}>
            <legend>Acquisition channel {index + 1} · original: {metadata.original_names[index]}</legend>
            {(["name", "marker", "fluorophore", "declaration"] as const).map((field) => <label key={field}>{field}
              <input aria-label={`Channel ${index + 1} ${field}`} value={channel[field]} onChange={(event) => setChannelDraft((old) => old.map((item) => item.index === channel.index ? { ...item, [field]: event.target.value } : item))} />
            </label>)}
          </fieldset>)}
          <button className="research-primary" disabled={locked} onClick={() => void saveChannels()}>Save declarations at revision {metadata.revision}</button>
          <details><summary>Acquisition metadata</summary><p>{metadata.basis}</p></details>
        </>}
      </>}

      {mode === "recipe" && <>
        <h2>Quantitative recipe inputs</h2>
        <p>Spatial values use the source geometry unit.</p>
        <fieldset><legend>Background subtraction</legend>
          <label>Gaussian background sigma<input aria-label="Background sigma" type="number" step="any" value={background} onChange={(event) => setBackground(event.target.value)} /></label>
          <label className="research-check"><input type="checkbox" checked={backgroundClip} onChange={(event) => setBackgroundClip(event.target.checked)} /> Clip negative values</label>
          <button onClick={() => updateBackground(!recipe.steps.some((step) => step.op === "subtract_background"))}>{recipe.steps.some((step) => step.op === "subtract_background") ? "Remove background step" : "Add background step"}</button>
        </fieldset>
        <fieldset><legend>Flat-field reference</legend>
          <label>Flat source<select aria-label="Flat-field source" value={flatSource} onChange={(event) => setFlatSource(event.target.value)}><option value="">Choose exact source…</option>{snapshot.sources.map((item) => <option key={item.id} value={item.id}>{sourceLabel(item, snapshot.sources)}</option>)}</select></label>
          <label>Flat scalar channel<input aria-label="Flat-field channel" type="number" min="0" step="1" value={flatChannel} onChange={(event) => setFlatChannel(event.target.value)} /></label>
          <label>Optional dark source<select aria-label="Dark-field source" value={darkSource} onChange={(event) => setDarkSource(event.target.value)}><option value="">No dark reference</option>{snapshot.sources.map((item) => <option key={item.id} value={item.id}>{sourceLabel(item, snapshot.sources)}</option>)}</select></label>
          {darkSource && <label>Dark scalar channel<input aria-label="Dark-field channel" type="number" min="0" step="1" value={darkChannel} onChange={(event) => setDarkChannel(event.target.value)} /></label>}
          <button onClick={() => updateFlatfield(!recipe.steps.some((step) => step.op === "flatfield"))}>{recipe.steps.some((step) => step.op === "flatfield") ? "Remove flat-field step" : "Bind flat-field step"}</button>
          <p>Use references on the same crop and physical grid.</p>
          {(flatSource || darkSource) && <TechnicalValues values={{
            flat_source_id: flatSource || null,
            flat_source_sha256: snapshot.sources.find((item) => item.id === flatSource)?.sha256 ?? null,
            dark_source_id: darkSource || null,
            dark_source_sha256: snapshot.sources.find((item) => item.id === darkSource)?.sha256 ?? null,
          }} />}
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
        <h2>Puncta candidates</h2><p>Preview candidates before adoption.</p>
        <div className="research-grid">
          {[ [`LoG sigma (${distanceUnit})`, punctaSigma, setPunctaSigma], ["LoG response threshold", punctaResponse, setPunctaResponse], ["Raw intensity threshold (source values)", punctaRaw, setPunctaRaw], [`Minimum peak separation (${distanceUnit})`, punctaDistance, setPunctaDistance], [`Aperture radius (${distanceUnit})`, punctaAperture, setPunctaAperture] ].map(([label, value, setter]) => <label key={label as string}>{label as string}<input aria-label={label as string} type="number" step="any" value={value as string} onChange={(event) => (setter as (v: string) => void)(event.target.value)} /></label>)}
        </div>
        {distanceUnit === UNVERIFIED_DISTANCE_UNIT && <p className="quantification-guidance">Length units are unverified for this source and level. Check source calibration before interpreting these lengths.</p>}
        <label className="research-check"><input type="checkbox" checked={punctaBorder} onChange={(event) => setPunctaBorder(event.target.checked)} /> Exclude peaks whose aperture touches the crop border</label>
        <label>Control / assumptions<textarea aria-label="Puncta control and assumptions" value={punctaControl} onChange={(event) => setPunctaControl(event.target.value)} /></label>
        <div className="research-actions"><button disabled={locked || isRgb} onClick={() => void previewPuncta()}>Preview puncta candidates</button><button className="research-primary" disabled={locked || !punctaPreview} onClick={() => void adoptPuncta()}>Adopt unchanged puncta request</button></div>
        {punctaPreview && <section aria-label="Puncta preview" data-request-fingerprint={punctaPreview.fingerprint}><p className="research-summary">{punctaPreview.totalPeaks} initial peaks before correction.</p><CompactTable rows={punctaPreview.peaks} kind="peaks" note={`Display: ${punctaPreview.overlayBasis}. Peak records describe the initial detection before label correction.`} /></section>}
      </>}

      {mode === "colocalisation" && <>
        <h2>Colocalisation measurements</h2><p>Compare two raw acquisition channels.</p>
        {isRgb && <p role="alert">Colocalisation requires scalar acquisition channels; RGB is not supported.</p>}
        <label>First declared channel<select aria-label="First colocalisation channel" value={firstChannel} onChange={(event) => setFirstChannel(event.target.value)}>{channelOptions.map((item) => <option key={item.index} value={item.index}>{item.index + 1}: {item.name}</option>)}</select></label>
        <label>First raw threshold<input aria-label="First colocalisation threshold" type="number" step="any" value={firstThreshold} onChange={(event) => setFirstThreshold(event.target.value)} /></label>
        <label>Second declared channel<select aria-label="Second colocalisation channel" value={secondChannel} onChange={(event) => setSecondChannel(event.target.value)}>{channelOptions.map((item) => <option key={item.index} value={item.index}>{item.index + 1}: {item.name}</option>)}</select></label>
        <label>Second raw threshold<input aria-label="Second colocalisation threshold" type="number" step="any" value={secondThreshold} onChange={(event) => setSecondThreshold(event.target.value)} /></label>
        <label>Controls / assumptions<textarea aria-label="Colocalisation controls and assumptions" value={colocalisationControl} onChange={(event) => setColocalisationControl(event.target.value)} /></label>
        <button className="research-primary" disabled={locked || isRgb || channelOptions.length < 2} onClick={() => void runColocalisation()}>Run and adopt colocalisation</button>
        {metrics && <><dl className="research-kv" aria-label="Colocalisation measurements">{Object.entries(metricLabels).filter(([key]) => key in metrics).map(([key, label]) => <div key={key}><dt>{label}</dt><dd><MeasurementValue value={metrics[key]} /></dd></div>)}</dl><TechnicalValues values={metrics} /></>}
      </>}

      {mode === "association" && <>
        <h2>Cell compartments</h2><p>Choose nuclei and cell labels, then measure raw channels inside each cell, its nuclear intersection, and its remaining area or volume.</p>
        <label>Nuclei result<select aria-label="Nuclei result" value={nucleiId} onChange={(event) => setNucleiId(event.target.value)}><option value="">Choose exact revision…</option>{labelResults.map((item) => <option key={item.id} value={item.id}>{resultLabel(item, snapshot)}</option>)}</select></label>
        {nucleus && punctaLineage(nucleus, snapshot) && <p className="research-summary">{punctaLineage(nucleus, snapshot) === "initial" ? "Initial puncta labels." : "Corrected puncta labels; peak counts describe the initial detection."}</p>}
        <label>Nuclei role declaration<input aria-label="Nuclei role declaration" value={nucleusRole} onChange={(event) => setNucleusRole(event.target.value)} /></label>
        <label>Cells result<select aria-label="Cells result" value={cellsId} onChange={(event) => setCellsId(event.target.value)} disabled={!nucleus}><option value="">No compatible exact revision</option>{compatibleCells.map((item) => <option key={item.id} value={item.id}>{resultLabel(item, snapshot)}</option>)}</select></label>
        <label>Cells role declaration<input aria-label="Cells role declaration" value={cellRole} onChange={(event) => setCellRole(event.target.value)} /></label>
        <label>Controls / assumptions<textarea aria-label="Association controls and assumptions" value={associationControl} onChange={(event) => setAssociationControl(event.target.value)} /></label>
        <fieldset><legend>Raw compartment channels</legend>{channelOptions.map((channel) => <label className="research-check" key={channel.index}><input type="checkbox" aria-label={`Measure compartment channel ${channel.index + 1}: ${channel.name}`} disabled={isRgb || locked} checked={compartmentChannels.includes(channel.index)} onChange={(event) => setCompartmentChannels((old) => event.target.checked ? [...old, channel.index].sort((a, b) => a - b) : old.filter((item) => item !== channel.index))} /> {channel.index + 1}: {channel.name}</label>)}</fieldset>
        <button className="research-primary" disabled={locked || !nucleus || !cellsId || nucleusRole.trim() === cellRole.trim()} onClick={() => void runAssociation()}>{compartmentChannels.length ? "Measure compartments" : "Associate exact revisions"}</button>
        {compartmentMeasurements.length > 0 && <CompartmentTable rows={compartmentMeasurements} total={compartmentTotal ?? 0} />}
        {compartmentTotal === 0 && <p>No measured cells in this result.</p>}
        {associationTotal > 0 && <details><summary>{associationTotal} nucleus assignments{associationCounts ? ` · ${associationCounts.ambiguous_count} ambiguous · ${associationCounts.unassigned_count} unassigned` : ""}</summary><p className="research-summary">Association results cannot be edited directly. Correct a parent label result and rerun.</p><CompactTable rows={associations as Array<Record<string, unknown>>} kind="associations" /></details>}
      </>}

      {mode === "perinuclear" && <ResearchPerinuclearPanel key={`${source.id}:${source.sha256}`}
        api={api} snapshot={snapshot} source={source} channels={channelOptions} workingBytes={recipe.working_bytes}
        busy={locked} report={report} onBusyChange={onBusyChange} onPublished={onPublished} />}

      {mode === "field-assay" && <>
        <h2>Fluorescence per nucleus</h2>
        <p>Measure signal in a region, subtract background, and divide by the reviewed nucleus count.</p>
        <dl className="research-kv" aria-label="Field assay readiness" data-source-id={source.id} data-source-sha256={source.sha256}>
          <div><dt>Image</dt><dd>{source.name}</dd></div>
          <div><dt>Plane</dt><dd>T {selection.t + 1}, Z {selection.z + 1}</dd></div>
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

          <fieldset><legend>Regions on T {selection.t + 1}, Z {selection.z + 1}</legend>
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
                <option key={a.id} value={a.id}>ROI: {annotationLabel(a, planeRegionAnnotations, sourceAnnotations)} · T {a.t + 1}, Z {a.z + 1}</option>
              ))}
              <option value="all">Measure whole field (exploratory only)</option>
            </select></label>
            {fieldAssayFocusMode === "all" && (
              <p className="quantification-guidance">
                Choose a focus ROI to approve this assay.
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
                  <p className="quantification-guidance">
                    Measure background before approving this assay.
                  </p>
                )}
              </>
            ) : (
              <label>Background ROI<select aria-label="Background annotation selection" value={fieldAssayBackgroundAnnotationId} onChange={(event) => setFieldAssayBackgroundAnnotationId(event.target.value)}>
                <option value="">Select background ROI…</option>
                {planeRegionAnnotations.map((a) => (
                  <option key={a.id} value={a.id}>ROI: {annotationLabel(a, planeRegionAnnotations, sourceAnnotations)} · T {a.t + 1}, Z {a.z + 1}</option>
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
            {(fieldAssaySegmentationMethod === "otsu" || fieldAssaySegmentationMethod === "yen") && fieldAssayManualCountMode === "none" && (
              <p className="quantification-guidance">
                Approval needs a fixed threshold or manual count.
              </p>
            )}
            {fieldAssaySegmentationMethod === "manual" && (
              <label>Threshold ADU<input aria-label="Manual threshold" type="number" step="any" value={fieldAssayThresholdManual} onChange={(event) => setFieldAssayThresholdManual(event.target.value)} /></label>
            )}
            <label>Minimum nucleus area (pixels)<input aria-label="Minimum nucleus area (pixels)" type="number" min="1" value={fieldAssayMinArea} onChange={(event) => setFieldAssayMinArea(event.target.value)} /></label>
            <label>Maximum nucleus area (pixels)<input aria-label="Maximum nucleus area (pixels)" type="number" min="1" value={fieldAssayMaxArea} onChange={(event) => setFieldAssayMaxArea(event.target.value)} /></label>
            <label>Watershed minimum peak distance (px)<input aria-label="Watershed minimum peak distance (px)" type="number" min="1" value={fieldAssayWatershedMinDist} onChange={(event) => setFieldAssayWatershedMinDist(event.target.value)} /></label>
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
                <option value="all_points" disabled={!planePointAnnotations.length}>All point markers on T {selection.t + 1}, Z {selection.z + 1}</option>
                {planePointAnnotations.map((a) => {
                  const count = a.points?.length ?? 1;
                  return (
                    <option key={a.id} value={a.id}>
                      Marks: {annotationLabel(a, planePointAnnotations, sourceAnnotations)} ({count} {count === 1 ? "point" : "points"})
                    </option>
                  );
                })}
              </select></label>
            )}
          </fieldset>

          <button className="research-primary" disabled={locked || !fieldAssayInputsReady} onClick={() => void previewFieldAssay()}>Preview field assay</button>

          {isAssayConfigStale && (
            <p className="research-callout" role="alert" >
              Settings changed. Preview again before saving.
            </p>
          )}

          {fieldAssayPreview && <div className="field-assay-preview-results">
            <h3>Assay quantification preview</h3>
            <img
              className="research-preview"
              src={fieldAssayPreview.qc_overlay}
              alt={`Field assay QC overlay for ${source.name}, T ${selection.t + 1}, Z ${selection.z + 1}`}
            />
            <p className="research-summary">Inspect the focus, nuclei and background before saving.</p>
            <dl className="research-kv">
              <div><dt>Focus area</dt><dd>{fieldAssayPreview.focus_mask_pixels} px</dd></div>
              <div><dt>Raw signal sum</dt><dd><MeasurementValue value={fieldAssayPreview.raw_signal_sum} /> ADU</dd></div>
              <div><dt>Background ADU</dt><dd><MeasurementValue value={fieldAssayPreview.summary.background_value_adu} /></dd></div>
              <div><dt>Signed corrected total</dt><dd className={fieldAssayPreview.integrated_signal_minus_background < 0 ? "quantification-negative" : undefined}><MeasurementValue value={fieldAssayPreview.integrated_signal_minus_background} /> ADU</dd></div>
              <div><dt>Nucleus count</dt><dd>{fieldAssayPreview.reviewed_count} ({({ algorithmic: "algorithmic", manual_override: "manual count", manual_points: "count marks" } as Record<string, string>)[fieldAssayPreview.count_mode] ?? "count basis unavailable"})</dd></div>
              <div><dt>Signal per nucleus</dt><dd>{fieldAssayPreview.field_ratio !== null && fieldAssayPreview.field_ratio !== "" ? <><MeasurementValue value={fieldAssayPreview.field_ratio} /> ADU</> : fieldAssayPreview.reviewed_count === 0 ? "Undefined (0 nuclei)" : "Not defined"}</dd></div>
              <div><dt>Saturation</dt><dd>Nuclei: {fieldAssayPreview.saturation.nuclei}, Signal: {fieldAssayPreview.saturation.signal}, BG: {fieldAssayPreview.saturation.background}</dd></div>
            </dl>

            <TechnicalValues values={{ ...fieldAssayPreview.summary, count_mode: fieldAssayPreview.count_mode, field_ratio: fieldAssayPreview.field_ratio }} />
            {fieldAssayPreview.warnings.length > 0 && <div className="research-warnings" role="alert">
              <strong>Warnings:</strong>
              <ul>{fieldAssayPreview.warnings.map((w, idx) => <li key={idx}>{w}</li>)}</ul>
            </div>}

            <fieldset className="field-assay-adoption"><legend>Save field assay</legend>
              <label>Reviewer name<input aria-label="Reviewer name" value={fieldAssayReviewer} onChange={(event) => setFieldAssayReviewer(event.target.value)} placeholder="Required to approve" /></label>
              <label>Assay notes<textarea aria-label="Assay notes" value={fieldAssayNotes} onChange={(event) => setFieldAssayNotes(event.target.value)} placeholder="Observations or exclusions" /></label>
              <p id="field-review-scope">Approval records review of channels, acquisition, focus, nuclei and background{(fieldAssayPreview.saturation.nuclei > 0 || fieldAssayPreview.saturation.signal > 0 || fieldAssayPreview.saturation.background > 0) ? ", including saturated pixels" : ""}.</p>
              {(() => {
                const dynamicWithoutManual =
                  (fieldAssaySegmentationMethod === "otsu" || fieldAssaySegmentationMethod === "yen") &&
                  fieldAssayManualCountMode === "none";
                const invalidReviewedRegion =
                  fieldAssayFocusMode === "all" ||
                  (fieldAssayBackgroundMode === "value" &&
                    (Number(fieldAssayBackgroundValue) === 0 || !fieldAssayBackgroundValue.trim()));
                const cannotAdoptReviewedReason = !fieldAssayReviewer.trim()
                  ? "Enter a reviewer name to approve."
                  : dynamicWithoutManual
                  ? "Approval needs a fixed threshold or manual count."
                  : invalidReviewedRegion
                  ? "Approval needs a focus ROI and measured background."
                  : null;
                return <>
                  {cannotAdoptReviewedReason && <p className="field-assay-review-reason" id="field-review-reason">{cannotAdoptReviewedReason}</p>}
                  <div className="research-actions">
                    <button disabled={locked || isAssayConfigStale}
                      onClick={() => void adoptFieldAssay(false)}>Save exploratory</button>
                    <button className="research-primary" aria-describedby={`field-review-scope${cannotAdoptReviewedReason ? " field-review-reason" : ""}`}
                      disabled={locked || isAssayConfigStale || Boolean(cannotAdoptReviewedReason)}
                      onClick={() => void adoptFieldAssay(true)}>Approve & save</button>
                  </div>
                </>;
              })()}
            </fieldset>
          </div>}
        </>}
      </>}

      {mode === "channels" && <details><summary>About derived channels</summary><p>Registered channels retain their registration record and fixed-grid geometry. They remain derived data.</p></details>}
    </div>
  );
}
