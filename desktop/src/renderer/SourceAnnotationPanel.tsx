import { MousePointer2, Pentagon, Redo2, Ruler, BetweenHorizontalStart, Lasso, Square, Trash2, Undo2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ResearchDesktopApi, ResearchSelection, ResearchSource } from "../shared/research-contracts";
import type { AnnotationTool, EpidermalTransectMetadata, ImageAnnotation, ImagePoint } from "./ImageViewport";
import "./SourceAnnotationPanel.css";

export type { AnnotationTool } from "./ImageViewport";

type MeasuredAnnotation = ImageAnnotation & {
  length: number | null; area: number | null; unit: string;
};
type Receipt = {
  source_id: string; source_sha256: string; revision: number;
  annotations: MeasuredAnnotation[];
  can_undo: boolean; can_redo: boolean;
};
type TransectDetails = Omit<EpidermalTransectMetadata, "schema"> & {
  metadata_status: "structured" | "legacy-unverified";
};

function transectDetails(annotation: MeasuredAnnotation): TransectDetails | null {
  if (annotation.transect) {
    const { schema: _schema, ...details } = annotation.transect;
    return { ...details, metadata_status: "structured" };
  }
  const legacyClass = annotation.label.match(/\[transect:(suprapapillary|ridge-base|custom)\]/)?.[1];
  if (!legacyClass) return null;
  return {
    class: legacyClass as TransectDetails["class"],
    upper_boundary: "",
    lower_boundary: "",
    orientation_rule: "",
    exclusions: "",
    review: { status: "unverified", reviewer: null },
    metadata_status: "legacy-unverified",
  };
}

function csvCell(value: string | number | null): string {
  const text = value === null ? "" : String(value);
  const safe = /^[\t\r\n ]*[=+\-@]/u.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function serializeTransectsCsv(
  source: Pick<ResearchSource, "id" | "name" | "sha256">,
  annotations: MeasuredAnnotation[],
): string {
  const header = [
    "source_name", "source_id", "source_sha256", "transect_id", "class",
    "start_x", "start_y", "end_x", "end_y", "z", "t", "coordinate_space", "length", "unit",
    "upper_boundary", "lower_boundary", "orientation_rule", "exclusions",
    "review_status", "reviewer", "metadata_status", "label",
  ];
  const rows = annotations.flatMap((annotation) => {
    const details = transectDetails(annotation);
    if (!details) return [];
    const start = annotation.points[0] ?? { x: 0, y: 0 };
    const end = annotation.points[1] ?? { x: 0, y: 0 };
    return [[
      source.name, source.id, source.sha256, annotation.id, details.class,
      start.x, start.y, end.x, end.y, annotation.z, annotation.t, "level0-pixel-edges", annotation.length, annotation.unit,
      details.upper_boundary, details.lower_boundary, details.orientation_rule,
      details.exclusions, details.review.status, details.review.reviewer,
      details.metadata_status, annotation.label,
    ].map(csvCell).join(",")];
  });
  return [header.map(csvCell).join(","), ...rows].join("\n") + "\n";
}

export function SourceAnnotationPanel({ api, source, selection, tool, onTool, points, onPoints,
  onAnnotations, onError, measurementMode = "general",
}: {
  api: ResearchDesktopApi; source: ResearchSource; selection: ResearchSelection;
  tool: AnnotationTool; onTool: (tool: AnnotationTool) => void;
  points: ImagePoint[]; onPoints: (points: ImagePoint[]) => void;
  onAnnotations: (annotations: ImageAnnotation[]) => void; onError: (message: string) => void;
  measurementMode?: "general" | "epidermis";
}) {
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState("");
  const [interchangeStatus, setInterchangeStatus] = useState("");
  const [transectClass, setTransectClass] = useState<"suprapapillary" | "ridge-base" | "custom">("suprapapillary");
  const [upperBoundary, setUpperBoundary] = useState("Stratum granulosum (viable epidermis)");
  const [lowerBoundary, setLowerBoundary] = useState("Dermal-epidermal junction");
  const [orientationRule, setOrientationRule] = useState("Perpendicular to local basement membrane");
  const [exclusions, setExclusions] = useState("Tears, folds, appendages excluded");
  const [transectReviewer, setTransectReviewer] = useState("");
  const [transectReviewed, setTransectReviewed] = useState(false);
  const draftPlane = useRef({ z: selection.z, t: selection.t });
  useEffect(() => {
    setTransectReviewed(false);
  }, [source.id, source.sha256, selection.z, selection.t, points,
    transectClass, upperBoundary, lowerBoundary, orientationRule, exclusions]);
  useEffect(() => {
    const previous = draftPlane.current;
    draftPlane.current = { z: selection.z, t: selection.t };
    if (previous.z !== selection.z || previous.t !== selection.t) onPoints([]);
  }, [selection.z, selection.t, onPoints]);
  const generation = useRef(0);
  const adopt = useCallback((value: Receipt) => {
    if (value.source_id !== source.id || value.source_sha256 !== source.sha256) throw new Error("Annotation source identity changed.");
    setReceipt(value); onAnnotations(value.annotations);
  }, [source.id, source.sha256, onAnnotations]);
  useEffect(() => {
    const token = ++generation.current;
    setReceipt(null); onPoints([]); setBusy(false); setInterchangeStatus("");
    void api.execute("source_annotations", { source_id: source.id }).then((value) => {
      if (generation.current === token) adopt(value as Receipt);
    }).catch((error) => { if (generation.current === token) onError(error.message); });
    return () => { generation.current++; };
  }, [api, source.id, source.sha256, adopt, onError, onPoints]);
  const change = async (action: string, annotationId?: string) => {
    if (!receipt || busy) return;
    const token = generation.current;
    const required = { point: 1, line: 2, rectangle: 2, polygon: 3, freehand: 3,
      transect: 2, navigate: Infinity }[tool];
    if (action === "add" && points.length < required) return;
    const polygon = action === "add" && tool === "rectangle" ? [points[0], { x: points[1].x, y: points[0].y },
      points[1], { x: points[0].x, y: points[1].y }] : points;
    setBusy(true);
    const annotationKind = tool === "transect" ? "line" : tool === "freehand" ? "polygon" : tool;
    const annotationColor = tool === "transect"
      ? (transectClass === "suprapapillary" ? "#84cf91" : transectClass === "ridge-base" ? "#86b9ec" : "#ffd36a")
      : "#ffd36a";
    const annotationLabel = tool === "transect"
      ? `[transect:${transectClass}] ${label.trim() || transectClass}`.slice(0, 120)
      : label;
    const transect = tool === "transect" ? {
      schema: "loci.epidermal-transect/v1" as const,
      class: transectClass,
      upper_boundary: upperBoundary.trim(),
      lower_boundary: lowerBoundary.trim(),
      orientation_rule: orientationRule.trim(),
      exclusions: exclusions.trim(),
      review: transectReviewed
        ? { status: "approved" as const, reviewer: transectReviewer.trim() }
        : { status: "unverified" as const, reviewer: null },
    } : null;
    try {
      const result = await api.execute("annotate_source", {
        source_id: source.id, source_sha256: source.sha256, expected_revision: receipt.revision,
        action, ...(annotationId ? { annotation_id: annotationId } : {}),
        ...(action === "add" ? { annotation: { kind: annotationKind, points: polygon,
          label: annotationLabel, color: annotationColor, z: selection.z, t: selection.t,
          ...(transect ? { transect } : {}) } } : {}),
      }) as Receipt;
      if (generation.current === token) {
        adopt(result); onPoints([]);
        if (action === "add") setTransectReviewed(false);
      }
    } catch (error) { if (generation.current === token) onError(error instanceof Error ? error.message : "Could not save the annotation."); }
    finally { if (generation.current === token) setBusy(false); }
  };
  const interchange = async (action: "import" | "export") => {
    if (!receipt || busy) return;
    const token = generation.current;
    setBusy(true); setInterchangeStatus("");
    try {
      const binding = { source_id: source.id, source_sha256: source.sha256, expected_revision: receipt.revision };
      if (action === "import") {
        const result = await api.importSourceAnnotations?.(binding);
        if (result && generation.current === token) { adopt(result as Receipt); onPoints([]); setInterchangeStatus("Annotations imported. Undo is available."); }
      } else {
        const result = await api.exportSourceAnnotations?.(binding);
        if (result && generation.current === token) setInterchangeStatus(`Exported ${result.annotation_count} annotations to ${result.basename}.`);
      }
    } catch (error) { if (generation.current === token) onError(error instanceof Error ? error.message : "Could not transfer annotations."); }
    finally { if (generation.current === token) setBusy(false); }
  };
  const enough = tool === "point" ? points.length === 1 : tool === "line" || tool === "rectangle" || tool === "transect" ? points.length === 2 :
    (tool === "polygon" || tool === "freehand") && points.length >= 3;
  const transectProtocolComplete = tool !== "transect" || [upperBoundary, lowerBoundary,
    orientationRule, exclusions].every((value) => value.trim().length > 0);
  const transectReviewComplete = tool !== "transect" || !transectReviewed || transectReviewer.trim().length > 0;
  return <div className="research-panel source-annotations">
    <h2>{measurementMode === "epidermis" ? "Epidermal thickness" : "Annotate"}</h2>
    {measurementMode === "epidermis" && <p className="annotation-workflow-intro">Define the boundaries, draw across the epidermis, then review and save each transect. Rete ridges and spaces between them remain separate measurement classes.</p>}
    <div className={`annotation-tools${measurementMode === "general" ? " annotation-tools-icons" : ""}`} aria-label="Annotation tools">
      {([
        ["navigate", "Navigate", MousePointer2], ["point", "Point", PlusPoint],
        ["line", "Distance", Ruler], ["transect", "Epidermal Transect", BetweenHorizontalStart],
        ["rectangle", "Rectangle", Square], ["polygon", "Polygon", Pentagon],
        ["freehand", "Freehand region", Lasso],
      ] as const).filter(([value]) => measurementMode !== "epidermis" || value === "navigate" || value === "transect").map(([value, title, Icon]) => <button key={value} title={title} aria-label={title}
        aria-pressed={tool === value} className={tool === value ? "active" : ""}
        onClick={() => { onTool(value); onPoints([]); }}><Icon />{measurementMode === "epidermis" ? (value === "navigate" ? "Navigate" : "Draw transect") : null}</button>)}
    </div>
    {tool !== "navigate" && <>
      {tool === "transect" ? (
        <div className="transect-form">
          <h3>Measurement protocol</h3>
          <p className="annotation-instruction">Click one boundary, then the opposite boundary. {points.length} / 2 endpoints placed.</p>
          <label>Transect class
            <select aria-label="Transect class" value={transectClass} onChange={(e) => setTransectClass(e.target.value as "suprapapillary" | "ridge-base" | "custom")}>
              <option value="suprapapillary">Suprapapillary · between ridges</option>
              <option value="ridge-base">Ridge-base</option>
              <option value="custom">Custom protocol site</option>
            </select>
          </label>
          <label>Upper boundary<input aria-label="Upper boundary" maxLength={240} value={upperBoundary} onChange={(e) => setUpperBoundary(e.target.value)} /></label>
          <label>Lower boundary<input aria-label="Lower boundary" maxLength={240} value={lowerBoundary} onChange={(e) => setLowerBoundary(e.target.value)} /></label>
          <label>Orientation rule<input aria-label="Orientation rule" maxLength={240} value={orientationRule} onChange={(e) => setOrientationRule(e.target.value)} /></label>
          <label>Exclusion criteria<input aria-label="Exclusion criteria" maxLength={240} value={exclusions} onChange={(e) => setExclusions(e.target.value)} /></label>
          <label>Reviewer name<input aria-label="Transect reviewer" maxLength={120} value={transectReviewer} onChange={(e) => setTransectReviewer(e.target.value)} placeholder="Required for reviewed measurement" /></label>
          <label className="research-check"><input type="checkbox" aria-label="Confirm transect review" disabled={points.length !== 2} checked={transectReviewed} onChange={(e) => setTransectReviewed(e.target.checked)} /> This transect's boundaries & orientation confirmed</label>
          {transectReviewed && !transectReviewComplete && <p role="alert">Enter the reviewer name before saving an approved transect.</p>}
        </div>
      ) : (
        <p className="annotation-instruction">{tool === "polygon" ? "Click around the region. Click the first point, double-click, or press Enter to close it, then save." :
          tool === "freehand" ? "Drag around the region and release to close it, then save." :
          tool === "rectangle" ? "Drag across the region, or click two opposite corners." :
          tool === "line" ? "Click the start and end." : "Click a point in the image."} Right-drag to pan. Press Esc to clear the draft.</p>
      )}
      <label>Label <input aria-label="Annotation label" maxLength={120} value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Optional" /></label>
      <div className="research-actions">
        <button disabled={!enough || !transectProtocolComplete || !transectReviewComplete || busy || !receipt} onClick={() => void change("add")}>Save annotation</button>
        <button disabled={!points.length || busy} onClick={() => onPoints([])}>Clear draft</button>
      </div>
    </>}
    <div className="research-actions">
      <button title="Undo annotation change" aria-label="Undo annotation" disabled={!receipt?.can_undo || busy} onClick={() => void change("undo")}><Undo2 /></button>
      <button title="Redo annotation change" aria-label="Redo annotation" disabled={!receipt?.can_redo || busy} onClick={() => void change("redo")}><Redo2 /></button>
      <span>{receipt?.annotations.length ?? 0} saved</span>
    </div>
    <ol className="annotation-list">
      {receipt?.annotations.map((item) => <li key={item.id}>
        <div><strong>{item.label || item.kind}</strong><small>
          {typeof item.area === "number" ? `${Number(item.area.toPrecision(5))} ${item.unit}²` : typeof item.length === "number" ? `${Number(item.length.toPrecision(5))} ${item.unit}` : item.points[0] ? `X ${item.points[0].x.toFixed(1)}, Y ${item.points[0].y.toFixed(1)}` : ""}
          {source.metadata.dimensions && source.metadata.dimensions.z > 1 ? ` · Z ${item.z + 1}` : ""}
          {source.metadata.dimensions && source.metadata.dimensions.t > 1 ? ` · T ${item.t + 1}` : ""}
          {transectDetails(item)?.metadata_status === "legacy-unverified" ? " · Legacy protocol metadata unavailable; unverified" : item.transect?.review.status === "approved" ? ` · Approved by ${item.transect.review.reviewer}` : item.transect ? " · Unverified" : ""}
        </small></div>
        <button title="Remove this annotation (undo available)" aria-label={`Remove ${item.label || item.kind}`} disabled={busy} onClick={() => void change("remove", item.id)}><Trash2 /></button>
      </li>)}
    </ol>
    {(() => {
      const transectAnnotations = receipt?.annotations.filter((annotation) => transectDetails(annotation)) ?? [];
      const planeTransects = transectAnnotations.filter((item) => item.z === selection.z && item.t === selection.t);

      const exportTransectsCsv = () => {
        if (!transectAnnotations.length) return;
        const blob = new Blob([serializeTransectsCsv(source, transectAnnotations)], { type: "text/csv;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `${source.name.replace(/\.[^/.]+$/, "")}-transects.csv`;
        link.click();
        URL.revokeObjectURL(url);
      };

      if (!transectAnnotations.length) return null;
      const approvedCount = planeTransects.filter((annotation) =>
        transectDetails(annotation)?.review.status === "approved").length;
      const unit = transectAnnotations[0]?.unit ?? "px";
      return (
        <div className="transects-summary">
          <h3>Epidermal transects ({transectAnnotations.length})</h3>
          <p>
            {["px", "pixel", "pixels"].includes(unit) ? "Uncalibrated pixel lengths." : `Calibrated lengths (${unit}).`} Descriptive summaries of sampled transects.
            {` Current Z ${selection.z + 1}, T ${selection.t + 1}: ${approvedCount} approved; ${planeTransects.length - approvedCount} unverified.`}
          </p>
          <div className="transect-class-summaries">
            {([ ["suprapapillary", "Suprapapillary"], ["ridge-base", "Ridge-base"] ] as const).map(([kind, title]) => {
              const members = planeTransects.filter((item) => transectDetails(item)?.class === kind);
              const protocols = new Set(members.map((item) => item.transect ? JSON.stringify([
                item.unit, item.transect.upper_boundary, item.transect.lower_boundary,
                item.transect.orientation_rule, item.transect.exclusions,
              ]) : null));
              const comparable = protocols.size <= 1 && !protocols.has(null);
              const lengths = members.map((item) => item.length).filter((value): value is number => value !== null && Number.isFinite(value));
              return <div key={kind}>
                <strong>{title} ({members.length})</strong>
                {comparable ? <>
                  <div>Mean: {lengths.length ? (lengths.reduce((a, b) => a + b, 0) / lengths.length).toFixed(2) : "—"} {unit}</div>
                  <div>Range: {lengths.length ? `${Math.min(...lengths).toFixed(1)} – ${Math.max(...lengths).toFixed(1)}` : "—"}</div>
                </> : <p>Different or missing protocols. Review individual measurements in the CSV.</p>}
              </div>;
            })}
          </div>
          <button type="button" onClick={exportTransectsCsv}>Export transects CSV</button>
        </div>
      );
    })()}
    <details><summary>Import & export annotations</summary>
      <p>Vector coordinates and calibration bound to this exact source. Image pixels are not included.</p>
      <div className="research-actions">
        <button disabled={!receipt || busy || !api.exportSourceAnnotations} onClick={() => void interchange("export")}>Export annotations</button>
        <button disabled={!receipt || busy || !api.importSourceAnnotations} onClick={() => void interchange("import")}>Import annotations</button>
      </div>
      {interchangeStatus && <p role="status">{interchangeStatus}</p>}
    </details>
  </div>;
}

function PlusPoint() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 4v16M4 12h16" /><circle cx="12" cy="12" r="4" /></svg>; }
