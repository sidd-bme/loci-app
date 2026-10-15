import { useEffect, useState } from "react";
import type { ResearchDesktopApi, ResearchResult, ResearchResultContext, ResearchResultContextField } from "../shared/research-contracts";
import "./ResultContextPanel.css";

const label = (name: string) => name.replaceAll("_", " ").replace(/^./, (value) => value.toUpperCase());
const valueText = (value: ResearchResultContextField["value"]): string => value === null ? "Not recorded"
  : Array.isArray(value) ? value.map(valueText).join(", ") : typeof value === "boolean" ? value ? "Yes" : "No" : String(value);
const technical = (field: ResearchResultContextField) => /sha256|hash|fingerprint|digest|^id$/u.test(field.name)
  || (typeof field.value === "string" && /^[a-f0-9]{32,}$/u.test(field.value));

function Fields({ fields }: { fields: ResearchResultContextField[] }) {
  if (!fields.length) return null;
  return <dl className="result-context-fields">{fields.map((field, index) => {
    const step = /(?:processing|steps)\[(\d+)\]/u.exec(field.source);
    return <div key={`${field.source}:${index}`}><dt title={field.source}>{step ? `Step ${Number(step[1]) + 1} · ` : ""}{label(field.name)}</dt>
      <dd>{valueText(field.value)}</dd></div>;
  })}</dl>;
}

export function ResultContextPanel({ api, result }: { api: ResearchDesktopApi; result: ResearchResult }) {
  const [open, setOpen] = useState(false);
  const [response, setResponse] = useState<{ key: string; context?: ResearchResultContext; error?: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const key = `${result.id}:${result.revision_hash}:${result.source_id}:${result.source_sha256}`;
  useEffect(() => {
    let current = true;
    setCopied(false); setCopyError(null);
    if (!open) return;
    void api.execute("describe_result", { result_id: result.id, revision_hash: result.revision_hash }).then((value) => {
      if (!current) return;
      const context = value as ResearchResultContext;
      if (context?.schema !== "loci.result-context/v1" || context.result_id !== result.id || context.revision_hash !== result.revision_hash
        || context.source_id !== result.source_id || context.source_sha256 !== result.source_sha256
        || ![context.settings, context.runtime, context.model, context.importer, context.correction, context.parents, context.unavailable].every(Array.isArray))
        throw new Error("Analysis details do not match the selected result.");
      setResponse({ key, context });
    }).catch((error: unknown) => {
      if (current) setResponse({ key, error: error instanceof Error ? error.message : "Could not load analysis details." });
    });
    return () => { current = false; };
  }, [api, key, open, result.id, result.revision_hash, result.source_id, result.source_sha256]);
  const current = response?.key === key ? response : null;
  const context = current?.context;
  const channelName = (index: number) => context?.channels.names?.find((entry) => entry.index === index)?.name ?? `Channel ${index + 1}`;
  const copyRequest = async () => {
    if (!context || context.replay.status !== "available" || !context.replay.operation || !context.replay.request) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify({ operation: context.replay.operation, request: context.replay.request }, null, 2));
      setCopied(true); setCopyError(null);
    } catch { setCopyError("Could not copy the analysis request."); }
  };
  return <details className="result-context" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Analysis details</summary>
    {open && <div className="result-context-body">
      {!current && <p role="status">Loading analysis details…</p>}
      {current?.error && <p role="alert">{current.error}</p>}
      {context && <>
        <dl className="result-context-fields">
          <div><dt>Method</dt><dd>{context.producing_method_label}</dd></div>
          {context.channels.segmentation !== null && <div><dt>Segmentation channel</dt><dd>{channelName(context.channels.segmentation)}</dd></div>}
          {context.channels.measurement && <div><dt>Measurement channels</dt><dd>{context.channels.measurement.map(channelName).join(", ")}</dd></div>}
          {context.measurement_basis && <div><dt>Measurements</dt><dd>{context.measurement_basis.replaceAll("-", " ")}</dd></div>}
          {context.selection && <div><dt>Region</dt><dd>{context.selection.width} × {context.selection.height}{context.selection.z_stop !== undefined ? ` × ${context.selection.z_stop - context.selection.z}` : ""}; X {context.selection.x}, Y {context.selection.y}; T {context.selection.t + 1}, Z {context.selection.z + 1}</dd></div>}
          {context.calibration && <div><dt>Coordinates</dt><dd>{context.calibration.axes} · {context.calibration.unit} · {context.calibration.frame}</dd></div>}
        </dl>
        {context.settings.length > 0 && <section><h3>Recorded settings</h3><Fields fields={context.settings.filter((field) => !technical(field))} /></section>}
        {context.correction.length > 0 && <section><h3>Correction</h3><Fields fields={context.correction.filter((field) => !technical(field))} /></section>}
        {context.importer.length > 0 && <section><h3>Imported labels</h3><Fields fields={context.importer.filter((field) => !technical(field))} /></section>}
        {context.model.length > 0 && <section><h3>Model</h3><Fields fields={context.model.filter((field) => !technical(field))} /></section>}
        {context.parents.length > 0 && <section><h3>Previous steps</h3><ol>{context.parents.map((parent) => <li key={parent.result_id}>{parent.method_label}</li>)}</ol></section>}
        {context.replay.status === "available" && <button onClick={() => void copyRequest()}>{copied ? "Request copied" : "Copy analysis request"}</button>}
        {copyError && <p role="alert">{copyError}</p>}
        <details><summary>Technical record</summary>
          <dl className="result-context-fields"><div><dt>Result</dt><dd>{context.result_id}</dd></div>
            <div><dt>Revision</dt><dd>{context.revision_hash}</dd></div><div><dt>Source fingerprint</dt><dd>{context.source_sha256}</dd></div>
            {context.engine_version && <div><dt>Loci engine</dt><dd>{context.engine_version}</dd></div>}</dl>
          <Fields fields={[...context.settings, ...context.correction, ...context.importer, ...context.model].filter(technical)} />
          <Fields fields={context.runtime} />
          {context.unavailable.length > 0 && <p>Not recorded: {context.unavailable.join(", ")}</p>}
          {context.replay.status === "unsupported" && <p>{context.replay.reason}</p>}
        </details>
      </>}
    </div>}
  </details>;
}
