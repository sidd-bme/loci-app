import { useEffect, useRef, useState } from "react";
import type { ResearchPerinuclearRequest, ResearchPerinuclearResponse, ResearchPerinuclearRow } from "../shared/perinuclear-contracts";
import type { ResearchChannelDeclaration, ResearchDesktopApi, ResearchResult, ResearchSnapshot, ResearchSource } from "../shared/research-contracts";
import { PerinuclearSummary, PerinuclearValue, perinuclearReason } from "./PerinuclearSummary";
import { checkedPerinuclearRecord, checkedPerinuclearResponse, checkedPerinuclearRows, perinuclearNuclei, perinuclearRevisionKey } from "./perinuclear-validation";
import { ValidatedNumberInput } from "./ValidatedNumberInput";
import { resultTitle } from "./result-title";
import { PerinuclearQC } from "./PerinuclearQC";
import "./ResearchPerinuclearPanel.css";

type Report = <T>(work: () => Promise<T>, fallback: string) => Promise<T | undefined>;

function PerinuclearRows({ rows, total, signalChannel }: { rows: ResearchPerinuclearRow[]; total: number; signalChannel: number }) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(rows.length / 25)), currentPage = Math.min(page, pages - 1);
  return <details className="perinuclear-measurements"><summary>Object measurements ({rows.length.toLocaleString()})</summary>
    {rows.length < total && <p>Showing {rows.length.toLocaleString()} of {total.toLocaleString()} nuclei. Export includes the full saved measurements.</p>}
    <div className="perinuclear-table-region" role="region" aria-label="Perinuclear measurements scroll area" tabIndex={0}>
      <table aria-label="Perinuclear object measurements"><thead><tr>{["Nucleus", "Nuclear pixels", "Nuclear sum", "Nuclear mean", "Ring pixels", "Ring sum", "Ring mean", "Nuclear / ring", "Excluded because"].map((name) => <th key={name} scope="col">{name}</th>)}</tr></thead>
        <tbody>{rows.slice(currentPage * 25, (currentPage + 1) * 25).map((row) => {
          const nuclear = row.intensity[`source_channel_${signalChannel}`], ring = row.perinuclear_ring;
          return <tr key={row.label}><th scope="row">{row.label}</th><td>{row.voxel_count}</td><td><PerinuclearValue value={nuclear.sum} /></td><td><PerinuclearValue value={nuclear.mean} /></td>
            <td>{ring.count}</td><td><PerinuclearValue value={ring.sum} /></td><td><PerinuclearValue value={ring.mean} /></td><td><PerinuclearValue value={ring.nuclear_to_ring_mean_ratio} /></td>
            <td>{ring.exclusions.length ? ring.exclusions.map((reason) => perinuclearReason[reason]).join("; ") : "None"}</td></tr>;
        })}</tbody></table>
    </div>
    {pages > 1 && <div className="perinuclear-pages"><button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous nuclei</button><span>{currentPage + 1} / {pages}</span><button disabled={currentPage + 1 === pages} onClick={() => setPage(currentPage + 1)}>Next nuclei</button></div>}
  </details>;
}

export function PerinuclearResultSummary({ result, rows = [], api }: { result: ResearchResult; rows?: Array<Record<string, unknown>>; api?: ResearchDesktopApi }) {
  try {
    const record = checkedPerinuclearRecord(result.perinuclear, result);
    const checkedRows = checkedPerinuclearRows(rows, record.signal_channel);
    if (rows.length > result.object_count) throw new Error("Perinuclear row count exceeds the saved nucleus count.");
    return <div className="perinuclear-result">
      <p>Raw signal channel {record.signal_channel + 1} · ring radius {record.radius_px} px</p>
      <PerinuclearSummary summary={record.summary} />
      {api && <PerinuclearQC key={perinuclearRevisionKey(result)} api={api} result={result} />}
      {checkedRows.length > 0 && <PerinuclearRows key={perinuclearRevisionKey(result)} rows={checkedRows} total={result.object_count} signalChannel={record.signal_channel} />}
    </div>;
  } catch (error) {
    return <p role="alert">{error instanceof Error ? error.message : "The saved perinuclear measurements could not be verified."}</p>;
  }
}

export function ResearchPerinuclearPanel({ api, snapshot, source, channels, workingBytes, busy, report, onBusyChange, onPublished }: {
  api: ResearchDesktopApi; snapshot: ResearchSnapshot; source: ResearchSource; channels: ResearchChannelDeclaration[];
  workingBytes: number; busy: boolean; report: Report; onBusyChange: (busy: boolean) => void;
  onPublished: (result: ResearchResult) => Promise<void>;
}) {
  const nuclei = snapshot.results.filter((result) => perinuclearNuclei(result, source));
  const [revision, setRevision] = useState("");
  const nucleus = nuclei.find((result) => perinuclearRevisionKey(result) === revision);
  const [signal, setSignal] = useState("");
  const [radius, setRadius] = useState(5), [radiusValid, setRadiusValid] = useState(true);
  const [control, setControl] = useState("");
  const [pending, setPending] = useState(false), [error, setError] = useState("");
  const [output, setOutput] = useState<{ scope: string; response: ResearchPerinuclearResponse } | null>(null);
  const mounted = useRef(true), running = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const signalChannel = signal === "" ? null : channels.find((channel) => String(channel.index) === signal)?.index;
  const scope = JSON.stringify([source.id, source.sha256, revision, nucleus?.revision_hash ?? null, signal, radius, radiusValid, control, workingBytes]);
  const liveScope = useRef(scope); liveScope.current = scope;
  const locked = busy || pending;
  const supported = source.source_kind === "native" && !["RGB", "RGBA"].includes(source.metadata.sample_semantics ?? "") && source.locator_state !== "relink-required";
  const available = Boolean(snapshot.operations.perinuclear_run);
  const ready = available && supported && nucleus && signalChannel !== null && signalChannel !== undefined &&
    Number.isSafeInteger(signalChannel) && signalChannel >= 0 && signalChannel <= 255 && signalChannel < (source.metadata.dimensions?.c ?? 0) && radiusValid &&
    Number.isSafeInteger(workingBytes) && workingBytes >= 1024 ** 2 && workingBytes <= 8 * 1024 ** 3 &&
    control.trim().length > 0 && control.trim().length <= 2048;
  const measure = async () => {
    if (!ready || locked || running.current || !nucleus || signalChannel === null || signalChannel === undefined) return;
    running.current = true; setPending(true); setError(""); onBusyChange(true);
    const capturedScope = scope;
    const request: ResearchPerinuclearRequest = { result_id: nucleus.id, revision_hash: nucleus.revision_hash,
      signal_channel: signalChannel, radius_px: radius, working_bytes: workingBytes, control: control.trim() };
    try {
      const response = await report(async () => {
        const checked = checkedPerinuclearResponse(await api.execute("perinuclear_run", { ...request }), nucleus, request);
        if (!mounted.current || liveScope.current !== capturedScope) throw new Error("The selected perinuclear inputs changed during measurement. The saved result remains in study history.");
        await onPublished(checked.result);
        return checked;
      }, "Could not measure perinuclear enrichment.");
      if (response && mounted.current && liveScope.current === capturedScope) setOutput({ scope: capturedScope, response });
    } catch (caught) {
      if (mounted.current) setError(caught instanceof Error ? caught.message : "Could not measure perinuclear enrichment.");
    } finally {
      running.current = false; if (mounted.current) setPending(false); onBusyChange(false);
    }
  };
  return <section className="research-perinuclear" aria-labelledby="perinuclear-heading">
    <h2 id="perinuclear-heading">Perinuclear enrichment</h2>
    <p>Nuclear mean ÷ surrounding ring mean, measured in the same raw signal channel.</p>
    {!supported ? <p role="status">Choose a native scalar image for perinuclear enrichment.</p> : !available ? <p role="status">This worker does not provide perinuclear enrichment.</p> : nuclei.length === 0 && <p role="status">Create nucleus labels on a full image plane at native resolution first.</p>}
    <label>Nucleus labels<select aria-label="Perinuclear nucleus result" value={nucleus ? revision : ""} disabled={locked} onChange={(event) => setRevision(event.target.value)}>
      <option value="">Choose a saved nucleus revision…</option>{nuclei.map((result, index) => <option key={perinuclearRevisionKey(result)} value={perinuclearRevisionKey(result)}>{resultTitle(result)} · Run {index + 1} · rev {result.revision_hash.slice(0, 8)}</option>)}
    </select></label>
    {nucleus && <p className="quantification-guidance">Full image · T {nucleus.selection!.t + 1} · Z {nucleus.selection!.z + 1} · {nucleus.object_count.toLocaleString()} nuclei</p>}
    <label>Raw signal channel<select aria-label="Perinuclear raw signal channel" value={signalChannel === undefined ? "" : signal} disabled={locked} onChange={(event) => setSignal(event.target.value)}>
      <option value="">Choose a declared signal channel…</option>{channels.map((channel) => <option key={channel.index} value={channel.index}>{channel.index + 1}: {channel.name || `Channel ${channel.index + 1}`}</option>)}
    </select></label>
    <label>Ring radius (px)<ValidatedNumberInput label="Perinuclear ring radius (px)" value={radius} minimum={Number.MIN_VALUE} maximum={128} commitOnChange disabled={locked} onValidity={setRadiusValid} onValue={(value) => { setRadius(value); return true; }} /></label>
    <label>Controls / assumptions<textarea aria-label="Perinuclear controls and assumptions" value={control} maxLength={2048} disabled={locked} onChange={(event) => setControl(event.target.value)} /></label>
    <details><summary>Ring definition and exclusions</summary>
      <p>Raw signal values across the selected plane must be finite and nonnegative. Negative values are rejected without clipping or an offset.</p>
      <p>Rings extend by the chosen Euclidean pixel radius outside each nucleus. All nuclear pixels and pixels claimed by more than one nucleus are removed. A boundary-touching nucleus still claims its ring pixels before overlaps are removed.</p>
      <p>Border-touching nuclei, empty rings and zero mean ring signals have no ratio. This ring is a perinuclear proxy; it does not define a cell's cytoplasm.</p>
      <p>The field median and mean use every nucleus with a defined ratio. Nuclei within one image are not independent biological replicates.</p>
    </details>
    <button className="research-primary" disabled={locked || !ready} onClick={() => void measure()}>{pending ? "Measuring…" : "Measure perinuclear enrichment"}</button>
    {error && <p role="alert">{error}</p>}
    {output?.scope === scope && <PerinuclearResultSummary api={api} result={output.response.result} rows={output.response.measurements} />}
  </section>;
}
