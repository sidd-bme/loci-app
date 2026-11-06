import { useEffect, useRef, useState } from "react";
import { Check, ChevronRight, Play, RefreshCw, Save, Square } from "lucide-react";
import type { ResearchDesktopApi, ResearchResult, ResearchSelection, ResearchSnapshot } from "../shared/research-contracts";
import { checkedGraphContinuation, checkedGraphPreparedPreviews, checkedGraphRun, checkedGraphStatus, checkedGraphWorkflow, graphJson, type GraphContinuation, type GraphPreparedPreviewBinding, type GraphBindings, type GraphPlan, type GraphRun, type GraphStatus, type GraphWorkflow } from "../shared/workflow-graph-contracts";
import "./ResearchWorkflowGraphPanel.css";

export interface ResearchWorkflowGraphPanelProps {
  api: ResearchDesktopApi; snapshot: ResearchSnapshot; sourceId: string; selection: ResearchSelection;
  active: boolean; busy: boolean; onBusyChange: (busy: boolean) => void;
  onOpenResult: (result: ResearchResult) => void | Promise<void>; onRefresh: () => void | Promise<void>;
}
const message = (error: unknown) => error instanceof Error ? error.message : "The composed workflow could not be updated.";
const labels: Record<string, string> = { run_recipe: "Segment and measure", classical_run: "Adaptive segmentation", associate_results: "Associate labels", spatial_distance_run: "Measure distance bands", morphometrics_run: "Measure morphology", annotation_evaluation_run: "Compare annotations", method_run: "Apply reusable method", tissue_model_run: "Create tissue candidate" };
const ended = (run: GraphRun) => ["succeeded", "failed", "cancelled"].includes(run.data.state);

export function ResearchWorkflowGraphPanel({ api, snapshot, sourceId, selection, active, busy, onBusyChange, onOpenResult, onRefresh }: ResearchWorkflowGraphPanelProps) {
  const [library, setLibrary] = useState<GraphWorkflow[]>([]), [selectedId, setSelectedId] = useState("");
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [plan, setPlan] = useState<{ value: GraphPlan; scope: string } | null>(null);
  const [runs, setRuns] = useState<GraphRun[]>([]), [run, setRun] = useState<GraphRun | null>(null);
  const [saveName, setSaveName] = useState("");
  const [continuation, setContinuation] = useState<GraphContinuation | null>(null);
  const [previewChoices, setPreviewChoices] = useState<Record<string, string>>({});
  const [preparedPreviews, setPreparedPreviews] = useState<GraphPreparedPreviewBinding[]>([]);
  const [previewError, setPreviewError] = useState(""), [previewLoading, setPreviewLoading] = useState(false);
  const [previewRefresh, setPreviewRefresh] = useState(0), [unavailablePreviews, setUnavailablePreviews] = useState(0);
  const [pending, setPending] = useState(""), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const mounted = useRef(true), generation = useRef(0), lock = useRef(false), requestKey = useRef<{ scope: string; key: string } | null>(null);
  const workflow = library.find((row) => row.id === selectedId) ?? null;
  const projectId = snapshot.project.project_id ?? "";
  const previewSource = snapshot.sources.find(item => item.id === sourceId && item.locator_state !== "relink-required");
  const currentPreviews = preparedPreviews.filter(preview => previewSource && preview.receipt.request.source_id === previewSource.id && preview.receipt.request.source_sha256 === previewSource.sha256);
  const bindings: GraphBindings = {};
  let missing = false;
  for (const [name, kind] of Object.entries(workflow?.data.definition.inputs ?? {})) {
    const chosen = choices[name];
    if (kind === "source-selection") {
      const source = snapshot.sources.find((row) => row.id === chosen && row.locator_state !== "relink-required");
      const dims = source?.metadata.levels?.[0]?.dimensions ?? source?.metadata.dimensions;
      if (!source || (!dims && source.id !== sourceId)) { missing = true; continue; }
      const exact = source.id === sourceId ? selection : { x: 0, y: 0, width: dims!.x, height: dims!.y, t: 0, c: 0, z: 0, level: 0 };
      bindings[name] = { source_id: source.id, source_sha256: source.sha256, selection: structuredClone(exact) };
    } else if (kind === "tissue-preview") {
      const preview = currentPreviews.find(item => `${item.preview_id}:${item.preview_hash}` === chosen);
      if (!preview) { missing = true; continue; }
      bindings[name] = preview;
    } else {
      const result = snapshot.results.find((row) => `${row.id}:${row.revision_hash}` === chosen && row.schema !== "loci.research-result/v2" && row.kind !== "annotation-agreement" && row.arrays?.labels);
      if (!result) { missing = true; continue; }
      bindings[name] = { result_id: result.id, revision_hash: result.revision_hash };
    }
  }
  const scope = graphJson({ projectId, workflow, bindings, sourceId, selection, active });
  const scopeRef = useRef(scope); if (scopeRef.current !== scope) generation.current++; scopeRef.current = scope;
  const context = useRef({ projectId, runId: run?.id }); context.current = { projectId, runId: run?.id };
  const currentPlan = plan?.scope === scope ? plan.value : null;
  const exactContinuation = continuation && run && continuation.run_id === run.id && continuation.run_revision === run.revision && continuation.run_sha256 === run.data.run_sha256 ? continuation : null;
  const needsPreviews = Object.values(workflow?.data.definition.inputs ?? {}).includes("tissue-preview") || Boolean(exactContinuation?.required_fresh_previews.length);
  useEffect(() => {
    let live = true;
    setPreparedPreviews([]); setPreviewError(""); setUnavailablePreviews(0);
    if (!needsPreviews || !previewSource || !active) { setPreviewLoading(false); return; }
    setPreviewLoading(true);
    void api.execute("workflow_graph_prepared_previews", { source_id: previewSource.id }).then(output => {
      const checked = checkedGraphPreparedPreviews(output, previewSource);
      if (live) { setPreparedPreviews(checked.previews); setUnavailablePreviews(checked.unavailable_count); }
    }).catch(error => { if (live) setPreviewError(message(error)); }).finally(() => { if (live) setPreviewLoading(false); });
    return () => { live = false; };
  }, [api, projectId, previewSource?.id, previewSource?.sha256, needsPreviews, active, previewRefresh]);
  const callbacks = useRef({ onRefresh, onBusyChange }); callbacks.current = { onRefresh, onBusyChange };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  useEffect(() => {
    let live = true;
    setLibrary([]); setSelectedId(""); setChoices({}); setPlan(null); setRuns([]); setRun(null); setContinuation(null); setPreviewChoices({}); setError("");
    void Promise.all([api.execute("workflow_graph_list", {}), api.execute("workflow_graph_runs", {})]).then(([definitions, saved]) => {
      if (!live || !mounted.current) return;
      const records = (definitions as { workflows?: unknown[] }).workflows;
      const runRecords = (saved as { runs?: unknown[] }).runs;
      if (!Array.isArray(records) || !Array.isArray(runRecords)) throw new Error("The saved composed workflow library is invalid.");
      setLibrary(records.map(checkedGraphWorkflow)); setRuns(runRecords.map(checkedGraphRun));
    }).catch((caught) => { if (live && mounted.current) setError(message(caught)); });
    return () => { live = false; generation.current++; };
  }, [api, projectId]);
  const perform = async (label: string, work: (current: () => boolean) => Promise<void>) => {
    if (lock.current || busy || !active) return;
    lock.current = true; const token = ++generation.current, captured = scopeRef.current;
    const current = () => mounted.current && generation.current === token && scopeRef.current === captured;
    setPending(label); setError(""); setNotice(""); onBusyChange(true);
    try { await work(current); } catch (caught) { if (current()) setError(message(caught)); }
    finally { lock.current = false; if (mounted.current) setPending(""); callbacks.current.onBusyChange(false); }
  };
  const refreshLibrary = () => perform("Refreshing workflows", async (current) => {
    const [definitions, saved] = await Promise.all([api.execute("workflow_graph_list", {}), api.execute("workflow_graph_runs", {})]);
    const records = (definitions as { workflows: unknown[] }).workflows;
    const runRecords = (saved as { runs: unknown[] }).runs;
    if (!Array.isArray(records) || !Array.isArray(runRecords)) throw new Error("The saved composed workflow library is invalid.");
    const nextLibrary = records.map(checkedGraphWorkflow), nextRuns = runRecords.map(checkedGraphRun);
    if (current()) { setLibrary(nextLibrary); setRuns(nextRuns); setPlan(null); setNotice("Saved workflows refreshed. Check inputs before running."); }
  });
  const binding = () => ({ workflow_id: workflow!.id, workflow_revision: workflow!.revision, definition_sha256: workflow!.data.definition_sha256, bindings: structuredClone(bindings) });
  const adoptRun = (status: GraphStatus) => {
    if (status.run.data.project_id !== projectId) throw new Error("The returned run belongs to a different study.");
    if (ended(status.run)) requestKey.current = null;
    setRun(status.run); setRuns((old) => [status.run, ...old.filter((row) => row.id !== status.run.id)]);
  };
  const preflight = () => perform("Checking inputs", async (current) => {
    if (!workflow || missing) return;
    const request = binding();
    const output = await api.execute("workflow_graph_preflight", request) as { plan: GraphPlan };
    if (!output.plan || output.plan.definition_sha256 !== request.definition_sha256 || graphJson(output.plan.bindings) !== graphJson(request.bindings) || graphJson(output.plan.definition) !== graphJson(workflow.data.definition) || !/^[a-f0-9]{64}$/u.test(output.plan.plan_sha256)) throw new Error("Preflight did not return this exact workflow and input selection.");
    if (current()) { setPlan({ value: output.plan, scope }); setNotice("Inputs and native settings checked. Ready to run."); }
  });
  const advance = (target: GraphRun) => perform("Running next step", async (current) => {
    if (target.data.owner || ended(target) || target.data.cancel_requested) return;
    const output = checkedGraphStatus(await api.execute("workflow_graph_advance", { run_id: target.id }));
    if (output.run.id !== target.id || output.run.data.plan.plan_sha256 !== target.data.plan.plan_sha256) throw new Error("The returned run does not match its saved plan.");
    if (current()) { adoptRun(output); await onRefresh(); }
  });
  const start = () => perform("Starting run", async (current) => {
    if (!workflow || !currentPlan) return;
    if (requestKey.current?.scope !== scope) requestKey.current = { scope, key: crypto.randomUUID() };
    const output = checkedGraphStatus(await api.execute("workflow_graph_start", { ...binding(), plan_sha256: currentPlan.plan_sha256, request_key: requestKey.current.key }));
    if (output.run.data.owner || output.run.data.plan.plan_sha256 !== currentPlan.plan_sha256) throw new Error("The returned run does not match the checked local plan.");
    if (!current()) return;
    adoptRun(output);
    const advanced = checkedGraphStatus(await api.execute("workflow_graph_advance", { run_id: output.run.id }));
    if (advanced.run.id !== output.run.id || advanced.run.data.plan.plan_sha256 !== currentPlan.plan_sha256) throw new Error("The native step did not return this exact run.");
    if (current()) { adoptRun(advanced); await onRefresh(); }
  });
  const cancel = async () => {
    if (!run || run.data.owner || ended(run)) return;
    const captured = projectId, runId = run.id;
    try {
      const status = checkedGraphStatus(await api.execute("workflow_graph_cancel", { run_id: runId }));
      if (mounted.current && captured === context.current.projectId && runId === context.current.runId) { adoptRun(status); setNotice(status.state === "cancelling" ? "Cancellation requested. Published results remain available." : "Run cancelled. Published results remain available."); }
    } catch (caught) { if (mounted.current && captured === context.current.projectId && runId === context.current.runId) setError(message(caught)); }
  };
  const refresh = () => perform("Refreshing saved run", async (current) => {
    if (!run) return;
    await onRefresh();
    if (run.data.owner) {
      const saved = await api.execute("workflow_graph_runs", {}) as { runs: unknown[] };
      const exact = saved.runs.map(checkedGraphRun).find((row) => row.id === run.id);
      if (current() && exact) setRun(exact);
    } else {
      const status = checkedGraphStatus(await api.execute("workflow_graph_status", { run_id: run.id }));
      if (current()) adoptRun(status);
    }
  });
  useEffect(() => { setSaveName(run ? `${run.data.plan.definition.name} copy` : ""); }, [run?.id]);
  const saveSuccessfulRun = () => perform("Saving reusable workflow", async (current) => {
    if (!run || run.data.state !== "succeeded" || !saveName.trim()) return;
    const workflowId = crypto.randomUUID().replaceAll("-", "");
    const name = saveName.trim();
    const response = await api.execute("workflow_graph_save_from_run", {
      run_id: run.id, run_revision: run.revision, run_sha256: run.data.run_sha256,
      workflow_id: workflowId, expected_revision: 0, name,
    }) as { workflow?: unknown };
    const saved = checkedGraphWorkflow(response.workflow);
    if (saved.id !== workflowId || saved.revision !== 1 || graphJson(saved.data.definition) !== graphJson({ ...run.data.plan.definition, name }))
      throw new Error("The saved workflow does not match the exact successful run.");
    if (current()) { setLibrary(old => [saved, ...old.filter(item => item.id !== saved.id)]); setNotice(`Saved ${name}. Choose its inputs before running it again.`); }
  });
  const inspectContinuation = () => perform("Inspecting unfinished work", async current => {
    if (!run) return;
    const checked = checkedGraphContinuation(await api.execute("workflow_graph_continuation", { run_id: run.id }));
    if (checked.run_id !== run.id || checked.run_revision !== run.revision || checked.run_sha256 !== run.data.run_sha256 ||
        checked.workflow_id !== run.data.workflow_id || checked.workflow_revision !== run.data.workflow_revision ||
        checked.definition_sha256 !== run.data.definition_sha256 || checked.plan_sha256 !== run.data.plan.plan_sha256 ||
        checked.state !== run.data.state || graphJson(checked.owner) !== graphJson(run.data.owner))
      throw new Error("The continuation receipt differs from this exact saved run. Refresh the run before continuing.");
    for (const proof of checked.completed_nodes) {
      const node = run.data.nodes[proof.node_id];
      if (!node || node.state !== "succeeded" || graphJson(node.output) !== graphJson(proof.output) ||
          node.intent?.job_id !== proof.job_id || node.intent.request_key !== proof.request_key ||
          node.intent.request_sha256 !== proof.request_sha256 || node.intent.operation !== proof.operation || graphJson(proof.job_owner) !== graphJson(run.data.owner))
        throw new Error("A completed step differs from its saved native job evidence.");
    }
    if (current()) { setContinuation(checked); setPreviewChoices({}); }
  });
  const replacements: Record<string, GraphPreparedPreviewBinding> = {};
  for (const name of exactContinuation?.required_fresh_previews ?? []) {
    const selected = currentPreviews.find(item => `${item.preview_id}:${item.preview_hash}` === previewChoices[name]);
    if (selected) replacements[name] = selected;
  }
  const replacementsReady = (exactContinuation?.required_fresh_previews ?? []).every(name => name in replacements);
  const prepareContinuation = () => perform("Preparing fresh continuation", async current => {
    if (!run || !exactContinuation?.can_start_fresh || !exactContinuation.proposal || !replacementsReady) return;
    const receipt = exactContinuation, proposal = receipt.proposal!;
    const workflowId = crypto.randomUUID().replaceAll("-", "");
    const request = { run_id: run.id, run_revision: run.revision, run_sha256: run.data.run_sha256,
      continuation_sha256: receipt.continuation_sha256, workflow_id: workflowId, request_key: crypto.randomUUID(),
      ...(receipt.required_fresh_previews.length ? { preview_replacements: structuredClone(replacements) } : {}) };
    const response = checkedGraphStatus(await api.execute("workflow_graph_continue", request));
    const fresh = response.run;
    const retained = checkedGraphContinuation(fresh.data.continuation);
    if (fresh.id === run.id || fresh.data.project_id !== projectId || fresh.data.owner !== null || fresh.data.workflow_id !== workflowId ||
        fresh.data.state !== "prepared" || fresh.data.workflow_revision !== 1 ||
        fresh.data.plan.definition_sha256 !== proposal.definition_sha256 || graphJson(fresh.data.plan.definition) !== graphJson(proposal.definition) ||
        graphJson(fresh.data.plan.bindings) !== graphJson({ ...proposal.bindings, ...replacements }) ||
        retained.run_id !== receipt.run_id || retained.run_revision !== receipt.run_revision || retained.run_sha256 !== receipt.run_sha256 ||
        Object.values(fresh.data.nodes).some(node => node.state !== "pending" || node.intent !== null || node.output !== null))
      throw new Error("The prepared continuation differs from the reviewed remaining work. Inspect saved runs before retrying.");
    if (current()) {
      const saved = checkedGraphWorkflow({ id: workflowId, revision: 1, kind: "workflow", data: { schema: "loci.saved-workflow/v2", definition: proposal.definition, definition_sha256: proposal.definition_sha256 } });
      setLibrary(old => [saved, ...old.filter(item => item.id !== workflowId)]); setSelectedId(workflowId); setChoices({}); setPlan(null);
      setContinuation(null); adoptRun(response); setNotice("Fresh continuation prepared. Advance workflow when you are ready; no step has started.");
    }
  });
  const blocked = !active || busy || Boolean(pending);
  const savedRuns = runs.filter((row) => !workflow || row.data.workflow_id === workflow.id);
  const canAdvance = run && !run.data.owner && !ended(run) && !run.data.cancel_requested && Object.values(run.data.nodes).some((node) => ["pending", "intent", "queued"].includes(node.state));
  return <section className="composed-workflow-panel" aria-label="Composed workflows">
    <p>Run saved workflows with multiple inputs and exact result revisions.</p>
    <label>Saved composed workflow<select aria-label="Saved composed workflow" value={selectedId} disabled={blocked} onChange={(event) => { setSelectedId(event.target.value); setChoices({}); setPlan(null); setRun(null); requestKey.current = null; setError(""); setNotice(""); }}>
      <option value="">Choose a saved workflow</option>{library.map((row) => <option key={row.id} value={row.id}>{row.data.definition.name} · revision {row.revision}</option>)}
    </select></label>
    <div className="composed-actions"><button type="button" disabled={blocked} onClick={() => void refreshLibrary()}><RefreshCw size={14} />Refresh composed workflows</button></div>
    {!library.length && <p>No composed workflows are saved in this study. Save one through an authorized agent connection to inspect and run it here.</p>}
    {workflow && <>
      <p className="composed-identity">Saved revision {workflow.revision} · <code title={workflow.data.definition_sha256}>{workflow.data.definition_sha256.slice(0, 12)}</code> · {Math.round(workflow.data.definition.working_bytes / 1024 ** 2)} MiB</p>
      <div className="composed-input-heading"><h4>Inputs for a new run</h4>{run && <p>These choices do not change the saved run below.</p>}</div>
      <div className="composed-inputs">{Object.entries(workflow.data.definition.inputs).map(([name, kind]) => <label key={name}>{name} <span>{kind === "source-selection" ? "Source region" : kind === "tissue-preview" ? "Prepared tissue preview" : "Label result revision"}</span>
        <select aria-label={`Workflow input ${name}`} disabled={blocked || (kind === "tissue-preview" && previewLoading)} value={choices[name] ?? ""} onChange={(event) => { setChoices((old) => ({ ...old, [name]: event.target.value })); setPlan(null); setNotice(""); }}><option value="">Choose an input</option>
          {kind === "source-selection" ? snapshot.sources.filter((row) => row.locator_state !== "relink-required").map((source) => <option key={source.id} value={source.id}>{source.name} · {source.id === sourceId ? "current region" : "whole plane T0 Z0 C0"}</option>)
            : kind === "tissue-preview" ? currentPreviews.map(preview => <option key={preview.preview_id} value={`${preview.preview_id}:${preview.preview_hash}`}>{previewLabel(preview)}</option>)
            : snapshot.results.filter((row) => row.schema !== "loci.research-result/v2" && row.kind !== "annotation-agreement" && row.arrays?.labels).map((result) => <option key={`${result.id}:${result.revision_hash}`} value={`${result.id}:${result.revision_hash}`}>{snapshot.sources.find((source) => source.id === result.source_id)?.name ?? "Source"} · {result.method_label ?? result.kind} · {result.revision_hash.slice(0, 8)}</option>)}
        </select>{bindings[name] && <small>{bindingText(bindings[name])}</small>}
      </label>)}</div>
      <details><summary>Saved steps and settings ({workflow.data.definition.nodes.length})</summary><ol className="composed-definition">{workflow.data.definition.nodes.map((node) => <li key={node.id}><strong>{node.id}</strong> · {labels[node.operation]}<p>{Object.entries(node.inputs).map(([port, ref]) => `${port} ← ${"input" in ref ? ref.input : ref.node}`).join("; ")}</p><pre>{JSON.stringify(node.settings, null, 2)}</pre></li>)}</ol></details>
      <div className="composed-actions"><button type="button" disabled={blocked || missing} onClick={() => void preflight()}><Check size={14} />Check inputs</button><button type="button" className="primary" disabled={blocked || !currentPlan || Boolean(run && !ended(run))} onClick={() => void start()}><Play size={14} />Run composed workflow</button></div>
      {plan && !currentPlan && <p role="status">Inputs or the selected region changed. Check inputs again before running.</p>}
    </>}
    {needsPreviews && <div className="composed-preview-status" aria-label="Prepared tissue previews">
      <p>{previewLoading ? "Checking retained previews…" : currentPreviews.length ? `${currentPreviews.length} prepared previews for ${previewSource?.name ?? "the current source"}. Each preview can be used once.` : "No unused preview is available for the current source. Prepare a candidate in Epidermis model, then refresh here."}</p>
      {unavailablePreviews > 0 && <p>{unavailablePreviews} retained {unavailablePreviews === 1 ? "preview is" : "previews are"} unavailable or already used.</p>}
      {previewError && <p role="alert">{previewError}</p>}
      <button type="button" disabled={blocked || previewLoading || !previewSource} onClick={() => setPreviewRefresh(value => value + 1)}><RefreshCw size={14} aria-hidden="true" />Refresh prepared previews</button>
    </div>}
    {savedRuns.length > 0 && <label>Saved run<select aria-label="Saved composed run" value={run?.id ?? ""} disabled={blocked} onChange={(event) => { const chosen = savedRuns.find((row) => row.id === event.target.value); setRun(chosen ?? null); setError(""); setNotice(chosen ? "Showing saved state. Refresh to reconcile native jobs." : ""); }}><option value="">Choose a saved run</option>{savedRuns.map((row) => <option key={row.id} value={row.id}>{row.id.slice(0, 8)} · {row.data.state}{row.data.owner ? " · agent-owned" : ""}</option>)}</select></label>}
    {run && <section className="composed-current-run" aria-label="Current composed workflow run">
      <div className="composed-run-heading"><strong>{run.data.state === "succeeded" ? "Run complete" : `Run ${run.data.state}`}</strong><code title={run.id}>{run.id.slice(0, 8)}</code></div>
      {run.data.owner ? <p>Agent-owned saved run. Continue or cancel it through its authorized agent session.</p> : <p>Each step keeps its own native job and result. Advance starts the next ready step or reconciles an interrupted submission.</p>}
      <ol className="composed-run-nodes">{Object.entries(run.data.nodes).map(([name, node]) => <li key={name}><div><strong>{name}</strong><span>{node.state}</span>{node.intent?.job_id && <code title={node.intent.job_id}>Job {node.intent.job_id.slice(0, 8)}</code>}</div>{node.output && <button type="button" disabled={blocked} onClick={() => { const sourceScope = run.data.plan.node_scopes[name]; const result = snapshot.results.find((row) => row.id === node.output!.result_id && row.revision_hash === node.output!.revision_hash && row.source_id === sourceScope?.source_id && row.source_sha256 === sourceScope?.source_sha256); if (!result) { setError("This exact result revision is not in the current study history. Refresh the run."); return; } void Promise.resolve(onOpenResult(result)).catch((caught) => setError(message(caught))); }}>Open result <ChevronRight size={14} /></button>}</li>)}</ol>
      <details><summary>Saved run input bindings</summary><pre>{JSON.stringify(run.data.plan.bindings, null, 2)}</pre></details>
      {run.data.state === "succeeded" && <form className="composed-save" aria-label="Save successful run as workflow" onSubmit={event => { event.preventDefault(); void saveSuccessfulRun(); }}>
        <label>Reusable workflow name<input value={saveName} maxLength={240} disabled={blocked} onChange={event => setSaveName(event.target.value)} /></label>
        <p>Save these steps and settings. Inputs are chosen afresh for each run.</p>
        <button type="submit" disabled={blocked || !saveName.trim()}><Save size={14} aria-hidden="true" />Save as workflow</button>
      </form>}
      {["failed", "cancelled"].includes(run.data.state) && <section className="composed-continuation" aria-label="Continue unfinished workflow">
        <h4>Continue unfinished work</h4>
        <p>Keep completed results and prepare a separate run for the remaining steps.</p>
        <button type="button" disabled={blocked} onClick={() => void inspectContinuation()}>Inspect continuation</button>
        {exactContinuation && <>
          <p>{exactContinuation.completed_nodes.length} completed {exactContinuation.completed_nodes.length === 1 ? "step retained" : "steps retained"} · {exactContinuation.uncompleted_nodes.length} remaining</p>
          {exactContinuation.unavailable_reason && <p role="note">{exactContinuation.unavailable_reason}</p>}
          {exactContinuation.required_fresh_previews.map(name => <label key={name}>Fresh preview for {name}<select aria-label={`Continuation preview ${name}`} value={previewChoices[name] ?? ""} disabled={blocked || previewLoading}
            onChange={event => setPreviewChoices(old => ({ ...old, [name]: event.target.value }))}><option value="">Choose a fresh prepared preview</option>
            {currentPreviews.map(preview => <option key={preview.preview_id} value={`${preview.preview_id}:${preview.preview_hash}`}>{previewLabel(preview)}</option>)}
          </select></label>)}
          <details><summary>Remaining steps and retained evidence</summary>
            <ol>{exactContinuation.uncompleted_nodes.map(name => <li key={name}>{name}</li>)}</ol>
            <pre>{JSON.stringify({ completed: exactContinuation.completed_nodes, inputs: exactContinuation.proposal?.bindings, continuation_sha256: exactContinuation.continuation_sha256 }, null, 2)}</pre>
          </details>
          <p>Preparing requires native approval. It does not start any step or transfer the original agent’s permissions.</p>
          <button type="button" className="primary" disabled={blocked || !exactContinuation.can_start_fresh || !exactContinuation.proposal || !replacementsReady} onClick={() => void prepareContinuation()}>Prepare fresh run</button>
        </>}
      </section>}
      <div className="composed-actions"><button type="button" disabled={blocked} onClick={() => void refresh()}><RefreshCw size={14} />Refresh run</button>{!run.data.owner && <><button type="button" disabled={blocked || !canAdvance} onClick={() => void advance(run)}><Play size={14} />Advance workflow</button><button type="button" disabled={!active || ended(run) || run.data.cancel_requested} onClick={() => void cancel()}><Square size={14} />Cancel composed run</button></>}</div>
    </section>}
    {pending && <p role="status">{pending}…</p>}{notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
  </section>;
}
function regionText(selection: ResearchSelection) { return `X${selection.x} Y${selection.y} · ${selection.width} × ${selection.height} px · T${selection.t} Z${selection.z}${selection.z_stop === undefined ? "" : `–${selection.z_stop} exclusive`} C${selection.c} · level ${selection.level}`; }

function previewLabel(preview: GraphPreparedPreviewBinding): string { return `${regionText(preview.receipt.request.output_selection)} · preview ${preview.preview_id.slice(0, 8)}`; }
function bindingText(binding: GraphBindings[string]): string {
  if ("source_id" in binding) return regionText(binding.selection);
  if ("preview_id" in binding) return `Exact prepared preview ${binding.preview_id.slice(0, 8)} · ${regionText(binding.receipt.request.output_selection)}`;
  return `Exact result ${binding.result_id.slice(0, 8)} · revision ${binding.revision_hash.slice(0, 12)}`;
}
