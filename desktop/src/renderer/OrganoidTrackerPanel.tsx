import { useEffect, useMemo, useState } from "react";
import type { ResearchDesktopApi, ResearchSource } from "../shared/research-contracts";
import type { OrganoidGraph, OrganoidNode } from "../shared/organoidtracker";

function probabilityValue(value: number | null, label: string) {
  if (value === null) return "unavailable";
  const exact = Object.is(value, -0) ? "-0" : String(value);
  return <data value={exact} title={`${label} (full precision): ${exact}`}>{Number(value.toPrecision(4))}</data>;
}

export function OrganoidTrackerPanel({ api, source, busy, canNavigate, onPlane, onClearFocus }: {
  api: ResearchDesktopApi;
  source: ResearchSource;
  busy: boolean;
  canNavigate: boolean;
  onClearFocus?: () => void;
  onPlane: (t: number, node: OrganoidNode) => void;
}) {
  const binding = useMemo(() => ({ id: source.id, sha256: source.sha256 }), [source.id, source.sha256]);
  const [first, setFirst] = useState("");
  const [origin, setOrigin] = useState("unspecified");
  const [confirmed, setConfirmed] = useState(false);
  const [ids, setIds] = useState<string[]>([]);
  const [saved, setSaved] = useState("");
  const [graph, setGraph] = useState<OrganoidGraph | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("all");
  const [index, setIndex] = useState(0);
  useEffect(() => {
    let current = true;
    api.listOrganoidGraphs?.(binding).then(list => {
      if (current) setIds(previous => [...new Set([...previous, ...list])]);
    }).catch(() => { if (current) setError("Saved graphs could not be listed."); });
    return () => { current = false; };
  }, [api, binding]);
  async function inspect(loadSaved: boolean) {
    setPending(true);
    setError("");
    try {
      const next = loadSaved ? await api.loadOrganoidGraph?.(binding, saved || ids[0])
        : await api.importOrganoidGraph?.(binding, Number(first), origin);
      if (!next) return;
      if (next.source_id !== binding.id || next.source_sha256 !== binding.sha256)
        throw new Error("The graph belongs to another image.");
      setIds(items => [next.id, ...items.filter(id => id !== next.id)]);
      setSaved(next.id); setGraph(next); setIndex(0); setFilter("all");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "OrganoidTracker inspection failed.");
    } finally { setPending(false); }
  }
  const children = useMemo(() => {
    const byParent = new Map<number, number[]>();
    for (const [parent, daughter] of graph?.edges ?? []) {
      const targets = byParent.get(parent) ?? [];
      targets.push(daughter);
      byParent.set(parent, targets);
    }
    return byParent;
  }, [graph]);
  const edges = useMemo(() => (graph?.edges ?? []).filter(([parent, , , marginal]) =>
    filter === "branches" ? children.get(parent)?.length === 2 :
    filter === "low" ? marginal !== null && marginal < 0.99 : true), [graph, filter, children]);
  const edge = edges[index];
  useEffect(() => () => onClearFocus?.(), [edge, graph, onClearFocus]);
  const unavailable = busy || pending || source.locator_state === "relink-required";
  const eligible = source.metadata.format === "OME-TIFF" && (source.metadata.dimensions?.t ?? 0) > 1 &&
    source.metadata.physical_calibration?.spacing?.length === 3 && source.metadata.timing?.source === "ome-time-increment";
  return <section className="research-panel" aria-label="OrganoidTracker lineage">
    <h3>OrganoidTracker lineage</h3>
    <p>Inspect an external v1 .aut graph against {source.name}.</p>
    {eligible ? <>
      <label>Upstream time point at the first image frame
        <input type="number" step="1" value={first} onChange={e => { setFirst(e.target.value); setConfirmed(false); }} />
      </label>
      <label>Graph origin <select value={origin} onChange={e => setOrigin(e.target.value)}>
        <option value="unspecified">Unknown or mixed</option><option value="model-output">Model output</option>
        <option value="manually-annotated">Manual annotation</option><option value="synthetic">Synthetic</option>
      </select></label>
      <label className="research-check"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />
        These are selected tracks for this image series, frame numbering and native pixel grid.</label>
      <button className="research-primary" disabled={unavailable || !api.importOrganoidGraph || !confirmed || !first.trim() || !Number.isSafeInteger(Number(first))}
        onClick={() => void inspect(false)}>Choose .aut graph…</button>
    </> : <p>Select a 3D OME-TIFF time series with physical spacing and uniform OME timing.</p>}
    {ids.length > 0 && <><label>Saved graph <select value={saved || ids[0]} onChange={e => setSaved(e.target.value)}>
      {ids.map(id => <option key={id} value={id}>{id.slice(0, 12)}</option>)}</select></label>
      <button disabled={unavailable} onClick={() => void inspect(true)}>Inspect saved graph</button></>}
    {error && <p role="alert">{error}</p>}
    {graph && <>
      <p>{graph.nodes.length} positions · {graph.edges.length} links · {[...children.values()].filter(d => d.length === 2).length} branch parents</p>
      <p>Declared origin {graph.origin} · Graph {graph.id.slice(0, 12)}</p>
      <details><summary>Graph identity</summary>
        <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify({
          source_id: graph.source_id, source_sha256: graph.source_sha256,
          graph_id: graph.id, graph_sha256: graph.graph_sha256,
        }, null, 2)}</pre>
      </details>
      <label>Inspect links <select value={filter} onChange={e => { setFilter(e.target.value); setIndex(0); }}>
        <option value="all">All links</option><option value="branches">Parent–daughter links</option>
        <option value="low">Marginal probability below 0.99</option>
      </select></label>
      {!canNavigate && <p>Open the source in the 2D viewer to locate individual positions.</p>}
      {edge ? <>
        <p>Link {index + 1} of {edges.length} · Reported link probability {probabilityValue(edge[2], "Reported link probability")} · Marginal probability {probabilityValue(edge[3], "Marginal probability")}</p>
        {[edge[0], edge[1]].map((id, i) => {
          const node = graph.nodes[id], t = node[0] - graph.first;
          return <div key={id}><p>{i === 0 ? "From" : "To"} upstream time {node[0]} · {t * graph.interval_s} s · XYZ {node.slice(1).join(", ")} px
            {" · "}{node.slice(1).map((v, axis) => Number((v * graph.spacing_xyz_um[axis]).toPrecision(6))).join(", ")} µm</p>
            <button disabled={unavailable || !canNavigate} onClick={() => onPlane(t, node)}>View {i === 0 ? "earlier" : "later"} source plane</button></div>;
        })}
        <button disabled={index === 0} onClick={() => setIndex(index-1)}>Previous link</button>
        <button disabled={index+1 >= edges.length} onClick={() => setIndex(index+1)}>Next link</button>
      </> : <p>No links match this filter.</p>}
    </>}
  </section>;
}
