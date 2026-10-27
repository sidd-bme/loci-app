import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import "./AgentPreviewComparison.css";

export interface SharedTaskPreview {
  schema: "loci.task-preview/v1";
  job_id: string;
  operation: string;
  request_sha256: string;
  source_id: string;
  source_sha256: string;
  created_at: string;
  adopted: false;
  output_sha256: string;
  output: Record<string, unknown>;
}

type RecordValue = Record<string, unknown>;
type PreviewCell = { value: RecordValue; receipt: RecordValue | null; label: string };
type PinnedPreview = { preview: SharedTaskPreview; cellIndex: number };
const hash = /^[a-f0-9]{64}$/;
const record = (value: unknown): RecordValue | null => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const exact = (value: unknown): string => JSON.stringify(value, (_key, item) => record(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

function cellsFor(preview: SharedTaskPreview | null): PreviewCell[] {
  if (!preview || preview.schema !== "loci.task-preview/v1" || preview.adopted !== false ||
    !text(preview.job_id) || !text(preview.source_id) || !text(preview.operation) ||
    !hash.test(preview.source_sha256) || !hash.test(preview.request_sha256) || !hash.test(preview.output_sha256)) return [];
  const output = record(preview.output);
  if (!output || output.adopted === true || "result" in output) return [];
  if (output.cells !== undefined) {
    if (!Array.isArray(output.cells) || !output.cells.length || output.cells.length > 32) return [];
    const cells: PreviewCell[] = [];
    for (const value of output.cells) {
      const cell = record(value);
      const receipt = record(cell?.receipt);
      if (!cell || !receipt || !Number.isSafeInteger(cell.region_index) || Number(cell.region_index) < 0 ||
        !Number.isSafeInteger(cell.configuration_index) || Number(cell.configuration_index) < 0) return [];
      cells.push({ value: cell, receipt, label: `Region index ${cell.region_index} · Configuration index ${cell.configuration_index}` });
    }
    return cells;
  }
  return [{ value: output, receipt: record(output.receipt), label: "Single preview" }];
}

function pngData(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 8 * 1024 * 1024 ||
    !/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(value) ||
    (value.length - "data:image/png;base64,".length) % 4 !== 0) return null;
  const encoded = value.slice("data:image/png;base64,".length);
  if (encoded.length < 60) return null;
  try {
    const header = atob(encoded.slice(0, 44));
    if (header.slice(12, 16) !== "IHDR") return null;
    const dimension = (offset: number) => Array.from(header.slice(offset, offset + 4)).reduce((size, byte) => size * 256 + byte.charCodeAt(0), 0);
    if (dimension(16) <= 0 || dimension(20) <= 0) return null;
  } catch { return null; }
  return value;
}

function PreviewImage({ value, label }: { value: unknown; label: string }): React.JSX.Element {
  const data = pngData(value);
  const [failedData, setFailedData] = useState<string | null>(null);
  if (!data || data === failedData) return <p className="agent-preview-unavailable">{label} unavailable · valid PNG preview data was not provided.</p>;
  return <figure><img src={data} alt={label} onError={() => setFailedData(data)} /><figcaption>{label}</figcaption></figure>;
}

function selectionFor(cell: PreviewCell): RecordValue | null {
  const selection = record(cell.receipt?.selection) ?? record(record(cell.value.provenance)?.selection) ?? record(cell.value.selection);
  if (!selection || !["x", "y", "width", "height", "c", "t", "z", "level"].every((key) =>
    Number.isSafeInteger(selection[key]) && Number(selection[key]) >= (key === "width" || key === "height" ? 1 : 0)) ||
    (selection.z_stop !== undefined && (!Number.isSafeInteger(selection.z_stop) || Number(selection.z_stop) <= Number(selection.z)))) return null;
  return selection;
}

function Scope({ cell }: { cell: PreviewCell }): React.JSX.Element {
  const selection = selectionFor(cell);
  return selection ? <p className="agent-preview-scope">
    X {String(selection.x)}, Y {String(selection.y)}, {String(selection.width)} × {String(selection.height)} pixels;
    {" "}C index {String(selection.c)}, T index {String(selection.t)}, Z index {String(selection.z)}
    {selection.z_stop !== undefined ? ` to ${selection.z_stop} (exclusive)` : ""}; level {String(selection.level)}
  </p> : <p className="agent-preview-scope">Scope unavailable in the recorded output.</p>;
}

function PreviewPane({ preview, cell, label }: { preview: SharedTaskPreview; cell: PreviewCell; label: string }): React.JSX.Element {
  const workflow = record(cell.value.workflow) ?? record(preview.output.workflow);
  const summary = record(cell.value.size_summary) ?? record(cell.receipt?.size_summary);
  const count = cell.value.object_count;
  const recipe = record(cell.receipt?.effective_recipe) ?? record(record(cell.value.provenance)?.recipe);
  const recipeHash = cell.receipt?.recipe_sha256 ?? record(cell.value.provenance)?.recipe_sha256;
  return <section className="agent-preview-pane" aria-label={label}>
    <h3>{label}</h3>
    <p className="agent-preview-cell-label">{cell.label}</p>
    <Scope cell={cell} />
    <div className="agent-preview-images">
      <PreviewImage value={cell.value.image} label={`${label} image`} />
      {cell.value.label_image !== undefined && cell.value.label_image !== null && <PreviewImage value={cell.value.label_image} label={`${label} draft labels`} />}
    </div>
    <dl className="agent-preview-metadata">
      {Number.isSafeInteger(count) && Number(count) >= 0 && <><dt>Object count</dt><dd>{String(count)}</dd></>}
      {summary && text(summary.measure_kind) && text(summary.measure_unit) && ["total", "mean", "median", "min", "max"].map((key) => finite(summary[key])
        ? <div className="agent-preview-metadata-pair" key={key}><dt>{key} {String(summary.measure_kind)} ({String(summary.measure_unit)})</dt><dd>{String(summary[key])}</dd></div> : null)}
      {summary && Number.isSafeInteger(summary.border_object_count) && Number(summary.border_object_count) >= 0 && <><dt>Border object count</dt><dd>{String(summary.border_object_count)}</dd></>}
    </dl>
    <details>
      <summary>Exact preview identity and settings</summary>
      <dl className="agent-preview-metadata">
        <dt>Job ID</dt><dd>{preview.job_id}</dd>
        <dt>Operation</dt><dd>{preview.operation}</dd>
        <dt>Request SHA-256</dt><dd>{preview.request_sha256}</dd>
        <dt>Output SHA-256</dt><dd>{preview.output_sha256}</dd>
        <dt>Source ID</dt><dd>{preview.source_id}</dd>
        <dt>Source SHA-256</dt><dd>{preview.source_sha256}</dd>
        <dt>Created</dt><dd>{preview.created_at}</dd>
        {workflow && text(workflow.id) && <><dt>Workflow ID</dt><dd>{workflow.id}</dd></>}
        {workflow && Number.isSafeInteger(workflow.revision) && <><dt>Workflow revision</dt><dd>{String(workflow.revision)}</dd></>}
        {workflow && text(workflow.definition_sha256) && <><dt>Workflow definition SHA-256</dt><dd>{workflow.definition_sha256}</dd></>}
        {text(cell.value.target_node_id) && <><dt>Preview prefix ends at</dt><dd>{cell.value.target_node_id}</dd></>}
        {text(recipeHash) && <><dt>Recipe SHA-256</dt><dd>{recipeHash}</dd></>}
        {text(cell.receipt?.receipt_sha256) && <><dt>Receipt SHA-256</dt><dd>{cell.receipt.receipt_sha256}</dd></>}
      </dl>
      {recipe && <pre aria-label={`${label} recorded recipe`}>{JSON.stringify(recipe, null, 2)}</pre>}
    </details>
  </section>;
}

/** The host verifies the cache, active source and document before mounting this view. */
export function AgentPreviewComparison({ preview, sourceLabel, onClose }: {
  preview: SharedTaskPreview | null;
  sourceLabel: string;
  onClose: () => void;
}): React.JSX.Element | null {
  const [selected, setSelected] = useState({ key: "", index: 0 });
  const [pinned, setPinned] = useState<PinnedPreview | null>(null);
  const close = useRef<HTMLButtonElement>(null);
  const identity = preview ? `${preview.source_id}:${preview.source_sha256}` : "";
  const previewKey = preview ? `${preview.job_id}:${preview.output_sha256}` : "";
  const cellIndex = selected.key === previewKey ? selected.index : 0;
  const cells = cellsFor(preview);
  const cell = cells[cellIndex];
  // Gate during render too: a source switch cannot display the previous pinned image.
  const reference = pinned && `${pinned.preview.source_id}:${pinned.preview.source_sha256}` === identity ? pinned : null;
  const referenceCell = reference ? cellsFor(reference.preview)[reference.cellIndex] : undefined;
  const comparing = Boolean(reference && referenceCell && (reference.preview.job_id !== preview?.job_id ||
    reference.preview.output_sha256 !== preview.output_sha256 || reference.cellIndex !== cellIndex));
  useEffect(() => { setPinned(null); }, [identity]);
  const visible = Boolean(preview);
  useEffect(() => { if (visible) close.current?.focus(); }, [visible]);
  if (!preview) return null;
  const currentScope = cell && selectionFor(cell);
  const referenceScope = referenceCell && selectionFor(referenceCell);
  const scopeMessage = !currentScope || !referenceScope
    ? "Scope comparison unavailable from the recorded outputs."
    : exact(currentScope) === exact(referenceScope)
      ? "Same recorded source and selection. Preview settings may differ."
      : "Distinct scopes · these previews use different recorded selections; pixel alignment is not established.";
  return <section className="agent-preview-comparison" aria-label="Agent preview comparison"
    onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Escape") { event.preventDefault(); onClose(); } }}>
    <header className="agent-preview-header">
      <div><h2>Agent preview · {sourceLabel}</h2><p>Non-adopted preview · no result or review is created here.</p></div>
      <button type="button" ref={close} aria-label="Close preview comparison" onClick={onClose}><X size={16} aria-hidden="true" /></button>
    </header>
    <div className="agent-preview-toolbar">
      {cells.length > 1 && <label>Preview cell<select aria-label="Preview cell" value={cellIndex}
        onChange={(event) => setSelected({ key: previewKey, index: Number(event.target.value) })}>
        {cells.map((item, index) => <option key={index} value={index}>{item.label}</option>)}
      </select></label>}
      <button type="button" disabled={!cell || !pngData(cell.value.image)} onClick={() => setPinned({ preview: JSON.parse(JSON.stringify(preview)) as SharedTaskPreview, cellIndex })}>
        {reference ? "Replace pinned reference" : "Pin current preview"}
      </button>
      {reference && <button type="button" onClick={() => setPinned(null)}>Clear pinned reference</button>}
    </div>
    <div className="agent-preview-body">
      {comparing && <p className="agent-preview-comparison-scope" role="status">{scopeMessage}</p>}
      {reference && !comparing && <p className="agent-preview-comparison-scope" role="status">Reference pinned. Open another preview from this source or select another cell to compare.</p>}
      <div className={`agent-preview-columns${comparing ? " is-comparing" : ""}`}>
        {comparing && reference && referenceCell && <PreviewPane preview={reference.preview} cell={referenceCell} label="Pinned reference" />}
        {cell ? <PreviewPane preview={preview} cell={cell} label="Current preview" />
          : <p className="agent-preview-unavailable" role="status">Preview unavailable · the recorded output is missing or unsupported. It has not been rerun.</p>}
      </div>
    </div>
  </section>;
}
