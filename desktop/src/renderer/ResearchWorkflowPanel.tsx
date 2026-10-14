import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Check, Download, GitBranch, Image, Play, Plus, Save, Scan, SlidersHorizontal, Trash2 } from "lucide-react";
import type { ResearchDesktopApi, ResearchRecipe, ResearchResult, ResearchSelection, ResearchSource, ResearchJob, ResearchBatchTask, ResearchBatchReceipt } from "../shared/research-contracts";
import { checkedWorkflow, connected, finiteDraft, nodeLabel, PROCESS_OPTIONS, reconnectProcess, workflowFromRecipe, type WorkflowDefinition, type WorkflowNode, type WorkflowRecord } from "./workflow-editor";
import "./ResearchWorkflowPanel.css";

export interface ResearchWorkflowPanelProps {
  api: ResearchDesktopApi; source: ResearchSource; sources: ResearchSource[]; selection: ResearchSelection; recipe: ResearchRecipe; busy: boolean;
  active: boolean; jobs: ResearchJob[]; displayedResult: ResearchResult | null; onBusyChange: (busy: boolean) => void;
  onPreview: (image: string | null) => void; onResult: (result: ResearchResult) => void | Promise<void>;
  onReview: (result: ResearchResult, runId: string) => void | Promise<void>;
  onExport: (result: ResearchResult, runId: string) => void | Promise<void>; onRefresh: () => void | Promise<void>;
}
interface RunRecord { id: string; data: { result_id: string; revision_hash: string; workflow_id: string; workflow_revision: number; definition_sha256: string;
  source_id: string; source_sha256: string; selection: ResearchSelection; population?: { total_count: number; filtered_count: number; membership_sha256: string; query_sha256: string } | null } }
const taskRequest = (job: ResearchJob): Record<string, unknown> => { const value = job.request.task_request; return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; };
interface RunResponse { result: ResearchResult; run: RunRecord }
// Match the complete durable key accepted by the main-process batch ledger.
const workflowBatchId = (job: ResearchJob): string | null => /^loci-batch:([a-f0-9]{32}):(initial|resume|retry):([a-f0-9]{5,32})$/u.exec(job.request_key)?.[1] ?? null;
const icon = (node: WorkflowNode) => node.type === "source" ? Image : node.type === "process" ? SlidersHorizontal : node.type === "segment" ? Scan : node.type === "export" ? Download : node.type === "review" ? Check : GitBranch;
const port = (node: WorkflowNode) => node.type === "source" || node.type === "process" ? "Image" : node.type === "segment" ? "Labels" : node.type === "measure" || node.type === "population" ? "Objects" : "Result";
const failure = (error: unknown) => error instanceof Error ? error.message : "This workflow operation failed. Retry after checking the study.";
const definitionJson = (definition: WorkflowDefinition) => exactJson({ ...definition, nodes: definition.nodes.map((node) => node.type === "population" ? { ...node, settings: { filters: [...node.settings.filters as unknown[]].sort((a, b) => exactJson(a).localeCompare(exactJson(b))) } } : node) });
const exactJson = (value: unknown) => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
export function ResearchWorkflowPanel(props: ResearchWorkflowPanelProps) { return <WorkflowEditor {...props} />; }
function WorkflowEditor({ api, source, sources, selection, recipe, busy, active, jobs, displayedResult, onBusyChange, onPreview, onResult, onReview, onExport, onRefresh }: ResearchWorkflowPanelProps) {
  const [definition, setDefinition] = useState<WorkflowDefinition>(() => workflowFromRecipe(recipe));
  const [selectedId, setSelectedId] = useState("source"), [saved, setSaved] = useState<WorkflowRecord | null>(null);
  const [library, setLibrary] = useState<WorkflowRecord[]>([]), [openId, setOpenId] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({}), [invalid, setInvalid] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(""), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [previewScope, setPreviewScope] = useState<string | null>(null);
  const [run, setRun] = useState<{ response: RunResponse; scope: string } | null>(null), [runState, setRunState] = useState("waiting_review");
  const [templateReferences, setTemplateReferences] = useState(Boolean(recipe.references && Object.keys(recipe.references).length));
  const [targets, setTargets] = useState<string[]>([source.id]), [batchId, setBatchId] = useState<string | null>(null);
  const restoreGeneration = useRef(0), preflightGeneration = useRef(0);
  const metricsBinding = useRef("");
  const [metrics, setMetrics] = useState<Array<{ id: string; unit: string; label?: string }>>([]);
  const generation = useRef(0), mounted = useRef(true), nextNode = useRef(0), lock = useRef(false), stop = useRef(false);
  const scope = exactJson({ definition, selection, source: [source.id, source.sha256], drafts, active });
  const scopeRef = useRef(scope); if (scopeRef.current !== scope) generation.current++; scopeRef.current = scope;
  const sourceScope = exactJson({ source: [source.id, source.sha256], selection });
  const sourceMetrics = metricsBinding.current === sourceScope ? metrics : [];
  const selected = definition.nodes.find((node) => node.id === selectedId) ?? definition.nodes[0];
  const edited = !saved || definitionJson(saved.data.definition) !== definitionJson(definition);
  const outdated = Boolean(run && run.scope !== scope);
  const blocked = !active || (busy && !pending) || Boolean(pending) || Object.keys(invalid).length > 0;
  const unsupported = templateReferences;
  const displayedRef = useRef(displayedResult); displayedRef.current = displayedResult;
  const exactDisplayed = Boolean(run && displayedResult && displayedResult.id === run.response.result.id && displayedResult.revision_hash === run.response.result.revision_hash && displayedResult.source_id === source.id && displayedResult.source_sha256 === source.sha256);
  useEffect(() => { mounted.current = true; let live = true;
    void api.execute("workflow_list", {}).then((value) => {
      if (!mounted.current || !live) return;
      const records = (value as { workflows?: unknown[] }).workflows;
      if (!Array.isArray(records)) throw new Error("The workflow list response is invalid.");
      setLibrary(records.map(checkedWorkflow));
    }).catch((caught) => { if (mounted.current && live) setError(failure(caught)); });
    return () => { live = false; mounted.current = false; generation.current++; };
  }, [api]);
  const mutate = (next: WorkflowDefinition) => { generation.current++; setDefinition(next); setNotice(""); setError(""); };
  const patch = (settings: Record<string, unknown>) => mutate({ ...definition, nodes: definition.nodes.map((node) => node.id === selected.id ? { ...node, settings: { ...node.settings, ...settings } } : node) });
  const perform = async (label: string, work: (current: () => boolean) => Promise<void>) => {
    if (lock.current || busy || !active) return;
    lock.current = true; const token = ++generation.current, captured = scopeRef.current;
    const current = () => mounted.current && token === generation.current && captured === scopeRef.current;
    setPending(label); setError(""); setNotice(""); onBusyChange(true);
    try { await work(current); } catch (caught) { if (current()) setError(failure(caught)); }
    finally { lock.current = false; if (mounted.current) setPending(""); onBusyChange(false); }
  };
  const binding = (record: WorkflowRecord) => ({ workflow_id: record.id, workflow_revision: record.revision, definition_sha256: record.data.definition_sha256, source_id: source.id, source_sha256: source.sha256, selection: structuredClone(selection) });
  const checkedRun = (value: RunResponse, request: ReturnType<typeof binding>) => {
    const data = value.run?.data;
    if (!data || typeof value.run.id !== "string" || data.workflow_id !== request.workflow_id || data.workflow_revision !== request.workflow_revision || data.definition_sha256 !== request.definition_sha256 ||
      data.source_id !== request.source_id || data.source_sha256 !== request.source_sha256 || exactJson(data.selection) !== exactJson(request.selection) ||
      value.result?.id !== data.result_id || value.result.revision_hash !== data.revision_hash || value.result.source_id !== request.source_id || value.result.source_sha256 !== request.source_sha256 ||
      !Number.isSafeInteger(value.result.object_count) || value.result.object_count < 0 ||
      (data.population && (!Number.isSafeInteger(data.population.filtered_count) || data.population.filtered_count < 0 || data.population.total_count !== value.result.object_count || data.population.filtered_count > data.population.total_count || !/^[a-f0-9]{64}$/.test(data.population.membership_sha256) || !/^[a-f0-9]{64}$/.test(data.population.query_sha256))))
      throw new Error("The run response does not match the exact workflow, source and result. Refresh the study before review.");
    return value;
  };
  const validate = async () => {
    if (blocked) return;
    await perform("Validating", async (current) => {
      const value = await api.execute("workflow_validate", { definition }) as { definition?: WorkflowDefinition; definition_sha256?: string };
      if (!value.definition || definitionJson(value.definition) !== definitionJson(definition) || !/^[a-f0-9]{64}$/.test(value.definition_sha256 ?? "")) throw new Error("Validation did not return this exact workflow.");
      if (current()) setNotice("Connections and parameters are valid. Save before preview or run.");
    });
  };
  const save = async () => {
    if (blocked || unsupported) return;
    await perform("Saving", async (current) => {
      const id = saved?.id ?? crypto.randomUUID().replaceAll("-", "");
      const validated = await api.execute("workflow_validate", { definition }) as { definition: WorkflowDefinition; definition_sha256: string };
      if (!validated.definition || definitionJson(validated.definition) !== definitionJson(definition) || !/^[a-f0-9]{64}$/.test(validated.definition_sha256)) throw new Error("Validation did not return this exact workflow.");
      if (!current()) return;
      const response = await api.execute("workflow_save", { workflow_id: id, expected_revision: saved?.revision ?? 0, definition: validated.definition });
      const record = checkedWorkflow((response as { workflow: unknown }).workflow);
      if (record.id !== id || record.revision !== (saved?.revision ?? 0) + 1 || record.data.definition_sha256 !== validated.definition_sha256 || definitionJson(record.data.definition) !== definitionJson(definition)) throw new Error("The saved revision does not match this draft. Reopen the workflow before continuing.");
      if (!current()) return;
      setSaved(record); setDefinition(record.data.definition); setOpenId(record.id); setLibrary((old) => [...old.filter((item) => item.id !== record.id), record]); setNotice("Saved revision " + record.revision + "."); await onRefresh();
    });
  };
  const reopen = async () => {
    if (!openId) return;
    await perform("Opening", async (current) => {
      const record = checkedWorkflow(((await api.execute("workflow_get", { workflow_id: openId })) as { workflow: unknown }).workflow);
      if (record.id !== openId) throw new Error("The returned workflow does not match the selected record.");
      if (!current()) return;
      setSaved(record); setTemplateReferences(false); setDefinition(record.data.definition); setDrafts({}); setInvalid({}); setRun(null); setBatchId(null); setSelectedId(record.data.definition.nodes[0].id); setNotice("Opened revision " + record.revision + ".");
    });
  };
  const preview = async () => {
    if (!saved || edited || blocked) return;
    await perform("Previewing", async (current) => {
      const value = await api.execute("workflow_preview", { ...binding(saved), target_node_id: selected.id }) as { image?: string; workflow?: { id: string; revision: number; definition_sha256: string }; target_node_id?: string; object_count?: number };
      if (value.workflow?.id !== saved.id || value.workflow.revision !== saved.revision || value.workflow.definition_sha256 !== saved.data.definition_sha256 || value.target_node_id !== selected.id) throw new Error("The preview does not match this exact workflow prefix.");
      if (!current()) return;
      if (typeof value.image !== "string") throw new Error("The workflow preview did not return an image.");
      onPreview(value.image); setPreviewScope(scopeRef.current); setNotice("Preview through " + nodeLabel(selected) + (typeof value.object_count === "number" ? " · " + value.object_count + " objects" : "") + ". Display only; no result was saved.");
    });
  };
  const execute = async () => {
    if (!saved || edited || blocked) return;
    await perform("Running", async (current) => {
      const value = checkedRun(await api.execute("workflow_run", binding(saved)) as RunResponse, binding(saved));
      await onRefresh(); if (!current()) return;
      setPreviewScope(null); setRun({ response: value, scope: scopeRef.current }); setRunState("waiting_review"); setNotice("Result saved. Inspect the image and objects before human review."); await onResult(value.result);
    });
  };
  const resultAction = async (action: "inspect" | "review" | "export") => {
    if (!run || outdated || blocked || (action === "review" && !exactDisplayed)) return;
    await perform(action === "inspect" ? "Inspecting" : action === "review" ? "Recording review" : "Exporting", async (current) => {
      const status = await api.execute("workflow_status", { run_id: run.response.run.id }) as { run: RunRecord; workflow_outdated: boolean; state: string };
      if (status.run?.id !== run.response.run.id || status.run.data.result_id !== run.response.result.id || status.run.data.revision_hash !== run.response.result.revision_hash || status.workflow_outdated) throw new Error("This execution is outdated or its result changed. Run the current saved workflow before continuing.");
      if (!current()) return;
      checkedRun({ result: run.response.result, run: status.run }, binding(saved!));
      if (!["waiting_review", "reviewed", "excluded", "exported"].includes(status.state)) throw new Error("The workflow status response is invalid.");
      if (action === "review" && (displayedRef.current?.id !== run.response.result.id || displayedRef.current.revision_hash !== run.response.result.revision_hash)) throw new Error("The displayed result changed before approval. Inspect this exact result again.");
      if (action === "inspect") { setPreviewScope(null); await onReview(run.response.result, run.response.run.id); }
      if (action === "review") await api.reviewResult(run.response.result.id, run.response.result.revision_hash, "reviewed");
      if (action === "export") {
        if (!["reviewed", "exported"].includes(status.state)) throw new Error("Human review must approve this exact result before export.");
        await onExport(run.response.result, run.response.run.id);
      }
      if (!current()) return;
      const next = await api.execute("workflow_status", { run_id: run.response.run.id }) as { run: RunRecord; state: string; workflow_outdated: boolean };
      if (current()) {
        checkedRun({ result: run.response.result, run: next.run }, binding(saved!));
        if (!["waiting_review", "reviewed", "excluded", "exported"].includes(next.state)) throw new Error("The workflow status response is invalid.");
        setRunState(next.workflow_outdated ? "outdated" : next.state); await onRefresh();
      }
    });
  };
  const runJobs = async (receipt: ResearchBatchReceipt, current: () => boolean) => {
    if (!api.runBatchJob) throw new Error("This build cannot execute durable workflow batches.");
    setBatchId(receipt.batch_id); stop.current = false;
    for (const job of receipt.jobs) {
      if (job.state !== "queued" || stop.current || !current()) continue;
      const value = await api.runBatchJob(receipt.batch_id, job.id) as RunResponse;
      const request = taskRequest(job);
      const response = checkedRun(value, request as ReturnType<typeof binding>);
      await onRefresh();
      if (current() && response.result.source_id === source.id) { setPreviewScope(null); setRun({ response, scope: scopeRef.current }); setRunState("waiting_review"); await onResult(response.result); }
    }
  };
  const batch = async () => {
    if (!saved || edited || blocked || !api.submitBatch || !targets.length) return;
    await perform("Running batch", async (current) => {
      const tasks: ResearchBatchTask[] = [];
      for (const id of targets) {
        const target = sources.find((item) => item.id === id); if (!target) throw new Error("A selected batch source is no longer available.");
        const request = { ...binding(saved), source_id: target.id, source_sha256: target.sha256 };
        const checked = await api.execute("workflow_preflight", request) as { source_id: string; source_sha256: string; selection: ResearchSelection };
        if (checked.source_id !== target.id || checked.source_sha256 !== target.sha256 || exactJson(checked.selection) !== exactJson(selection)) throw new Error("Batch preflight returned a different source or region.");
        tasks.push({ operation: "workflow_run", source: { id: target.id, sha256: target.sha256 }, request } as ResearchBatchTask);
      }
      if (!current()) return; await runJobs(await api.submitBatch!(tasks), current);
      if (current()) setNotice("Batch requests retained. Follow Jobs for exact status and recovery.");
    });
  };
  const workflowJobs = jobs.filter((job) => job.operation === "workflow_run" && taskRequest(job).workflow_id === saved?.id);
  const latestBatchId = batchId ?? [...workflowJobs].reverse().map(workflowBatchId).find(Boolean) ?? null;
  const durableJobs = latestBatchId ? workflowJobs.filter((job) => workflowBatchId(job) === latestBatchId) : [];
  const cancelBatch = async () => {
    stop.current = true;
    try { for (const job of durableJobs.filter((item) => ["queued", "running"].includes(item.state))) await api.cancelJob(job.id); await onRefresh(); }
    catch (caught) { setError(failure(caught)); }
  };
  const recoverBatch = async (retry: boolean) => {
    if (!latestBatchId || !api.resumeBatch || !api.retryBatch) return;
    await perform(retry ? "Retrying batch" : "Resuming batch", async (current) => { await runJobs(await (retry ? api.retryBatch!(latestBatchId) : api.resumeBatch!(latestBatchId)), current); await onRefresh(); });
  };
  const numberInput = (key: string, value: number, minimum?: number, integer = false) => {
    const field = selected.id + ":" + key;
    return <input aria-label={"Workflow " + key.replaceAll("_", " ")} aria-invalid={Boolean(invalid[field])} inputMode={integer ? "numeric" : "decimal"}
      value={drafts[field] ?? String(value)} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setDrafts((old) => { const next = { ...old }; delete next[field]; return next; }); setInvalid((old) => { const next = { ...old }; delete next[field]; return next; }); } }}
      onChange={(event) => { generation.current++; const text = event.target.value; setDrafts((old) => ({ ...old, [field]: text }));
        try { const parsed = finiteDraft(text, integer, minimum); patch({ [key]: parsed }); setInvalid((old) => { const next = { ...old }; delete next[field]; return next; }); }
        catch (caught) { setInvalid((old) => ({ ...old, [field]: failure(caught) })); } }} />;
  };
  const addProcess = (op: string) => {
    let id: string; do { id = "process-new-" + nextNode.current++; } while (definition.nodes.some((node) => node.id === id));
    const node: WorkflowNode = { id, type: "process", settings: ["gaussian", "subtract_background"].includes(op) ? { op, sigma: 1 } : op === "subtract_constant" ? { op, value: 0 } : { op, radius: 1 } };
    const nodes = [...definition.nodes]; nodes.splice(nodes.findIndex((entry) => entry.type === "segment"), 0, node); mutate(connected(definition, nodes)); setSelectedId(node.id);
  };
  const remove = () => { const prefix = selected.id + ":"; setDrafts((old) => Object.fromEntries(Object.entries(old).filter(([key]) => !key.startsWith(prefix)))); setInvalid((old) => Object.fromEntries(Object.entries(old).filter(([key]) => !key.startsWith(prefix)))); mutate(connected(definition, definition.nodes.filter((node) => node.id !== selected.id))); setSelectedId(definition.nodes[0].id); };
  const move = (delta: number) => {
    const nodes = [...definition.nodes], index = nodes.findIndex((node) => node.id === selected.id), target = index + delta;
    if (nodes[target]?.type !== "process") return; [nodes[index], nodes[target]] = [nodes[target], nodes[index]]; mutate(connected(definition, nodes));
  };
  useEffect(() => {
    const token = ++preflightGeneration.current; setMetrics([]);
    if (!saved || !active) return;
    const request = binding(saved);
    void api.execute("workflow_preflight", request).then((value) => {
      const checked = value as { source_id: string; source_sha256: string; selection: ResearchSelection; metrics: Array<{ id: string; unit: string; label?: string }> };
      if (token !== preflightGeneration.current || !mounted.current) return;
      if (checked.source_id !== request.source_id || checked.source_sha256 !== request.source_sha256 || exactJson(checked.selection) !== exactJson(request.selection) ||
        !Array.isArray(checked.metrics) || checked.metrics.some((metric) => typeof metric.id !== "string" || typeof metric.unit !== "string")) throw new Error("Preflight returned inconsistent source metrics.");
      metricsBinding.current = sourceScope; setMetrics(checked.metrics);
    }).catch((caught) => { if (token === preflightGeneration.current && mounted.current) setError(failure(caught)); });
    return () => { preflightGeneration.current++; };
    // Stable source/workflow scope governs these requests.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, saved, active, source.id, source.sha256, exactJson(selection)]);
  useEffect(() => {
    const token = ++restoreGeneration.current;
    if (!saved || edited || !active || pending) return;
    const job = [...jobs].reverse().find((item) => item.operation === "workflow_run" && item.state === "succeeded" &&
      taskRequest(item).workflow_id === saved.id && taskRequest(item).workflow_revision === saved.revision &&
      taskRequest(item).definition_sha256 === saved.data.definition_sha256 && taskRequest(item).source_id === source.id &&
      taskRequest(item).source_sha256 === source.sha256 && exactJson(taskRequest(item).selection) === exactJson(selection));
    if (!job || run?.response.run.id === job.id) return;
    const capturedScope = scopeRef.current;
    void Promise.all([api.execute("workflow_status", { run_id: job.id }), api.getSnapshot()]).then(([value, snapshot]) => {
      if (!mounted.current || token !== restoreGeneration.current || capturedScope !== scopeRef.current) return;
      const status = value as { run: RunRecord; state: string; workflow_outdated: boolean };
      const result = snapshot?.results.find((item) => item.id === status.run?.data.result_id);
      if (!result || status.workflow_outdated || status.run.id !== job.id) throw new Error("The retained execution is unavailable or outdated.");
      const response = checkedRun({ result, run: status.run }, binding(saved));
      setRun({ response, scope: capturedScope }); setRunState(status.state);
    }).catch((caught) => { if (token === restoreGeneration.current && mounted.current) setError(failure(caught)); });
    return () => { restoreGeneration.current++; };
    // Recovery binds only the exact saved workflow/source/scope; dirty drafts never adopt an old run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, jobs, saved, edited, active, source.id, source.sha256, exactJson(selection), pending]);

  const runResult = run?.response.result;
  return <section className="workflow-panel" aria-label="Visual workflow builder">
    <header className="workflow-toolbar">
      <div className="workflow-title"><GitBranch size={21} /><div><h2>Workflow builder</h2><p>From source pixels to a reviewed result</p></div></div>
      <div className="workflow-library"><select aria-label="Saved workflow" value={openId} onChange={(event) => setOpenId(event.target.value)}><option value="">Saved workflows…</option>{library.map((record) => <option key={record.id} value={record.id}>{record.data.definition.name} · v{record.revision}</option>)}</select><button disabled={blocked || !openId} onClick={() => void reopen()}>Open</button></div>
      <label className="workflow-name">Name<input aria-label="Workflow name" value={definition.name} maxLength={120} onChange={(event) => mutate({ ...definition, name: event.target.value })} /></label>
      <div className="workflow-actions"><button disabled={blocked || unsupported} onClick={() => void save()}><Save size={14} />{saved ? "Save revision" : "Save workflow"}</button><button disabled={blocked} onClick={() => void validate()}>Validate</button><button disabled={blocked} onClick={() => { mutate(workflowFromRecipe(recipe)); setTemplateReferences(Boolean(recipe.references && Object.keys(recipe.references).length)); setSaved(null); setRun(null); setBatchId(null); setDrafts({}); setInvalid({}); setSelectedId("source"); }}>{recipe.segmentation ? "From current recipe" : "Start object workflow"}</button></div>
      <div className="workflow-save-state" role="status">{pending ? pending + "…" : edited ? "Unsaved draft · save before execution" : "Saved revision " + saved!.revision}</div>
    </header>
    <div className="workflow-binding"><Image size={16} /><div><strong title={source.name}>{source.name}</strong><span>X {selection.x} · Y {selection.y} · {selection.width} × {selection.height} · T {selection.t + 1} · Z {selection.z + 1}{selection.z_stop !== undefined ? "–" + selection.z_stop : ""} · C {selection.c + 1} · level {selection.level}</span></div></div>
    <div className="workflow-workspace">
      <section className="workflow-canvas" aria-label="Connected workflow schematic">
        <div className="workflow-canvas-heading"><strong>Analysis chain</strong><span>Image → labels → objects → review</span></div>
        <div className="workflow-graph-scroll" tabIndex={0} aria-label="Workflow graph canvas">
          <ol className="workflow-graph" aria-label="Connected workflow nodes">{definition.nodes.map((node, index) => { const Icon = icon(node); const selectedNode = selected.id === node.id;
            return <li key={node.id} className={"workflow-node-row " + (selectedNode ? "is-selected" : "")}>
              {index > 0 && <div className="workflow-wire" aria-hidden="true"><span>{port(definition.nodes[index - 1])}</span></div>}
              <button aria-label={"Select " + nodeLabel(node)} aria-pressed={selectedNode} disabled={Boolean(pending)} onClick={() => setSelectedId(node.id)}>
                {index > 0 && <i className="workflow-port workflow-port-in" aria-hidden="true" />}
                <span className="workflow-node-index">{String(index + 1).padStart(2, "0")}</span><Icon size={22} />
                <strong>{nodeLabel(node)}</strong>
                <small>{node.type === "review" ? "Manual approval" : node.type === "export" ? "Reviewed result" : node.type === "measure" ? "Original values" : node.type === "population" ? (node.settings.filters as unknown[] | undefined)?.length + " inclusive ranges" : node.type === "source" ? selection.width + " × " + selection.height : node.type === "process" ? Object.entries(node.settings).filter(([key]) => key !== "op").map(([key, value]) => key + " " + String(value)).join(" · ") : String(node.settings.method ?? "Configure method")}</small>
                <span className="workflow-node-status">{outdated ? "Changed" : runResult ? node.type === "review" ? runState.replaceAll("_", " ") : node.type === "export" ? runState === "exported" ? "Exported" : "Manual action" : "Executed" : node.type === "review" || node.type === "export" ? "Manual step" : "Configured"}</span>
                {index < definition.nodes.length - 1 && <i className="workflow-port workflow-port-out" aria-hidden="true" />}
              </button>
            </li>; })}</ol>
        </div>
        <div className="workflow-add"><label>Add processing<select aria-label="Add workflow processing" value="" disabled={blocked || definition.nodes.filter((node) => node.type === "process").length >= 32} onChange={(event) => { if (event.target.value) addProcess(event.target.value); }}><option value="">Choose operation…</option>{PROCESS_OPTIONS.map((op) => <option value={op} key={op}>{op.replaceAll("_", " ")}</option>)}</select></label>
          {!definition.nodes.some((node) => node.type === "population") && <button disabled={blocked} onClick={() => { const nodes = [...definition.nodes]; nodes.splice(nodes.findIndex((node) => node.type === "review"), 0, { id: "population", type: "population", settings: { filters: [] } }); mutate(connected(definition, nodes)); setSelectedId("population"); }}><Plus size={14} />Population filter</button>}</div>
        <p className="workflow-help">One ordered, compatible chain. Processing changes segmentation; measurements retain the raw source basis.</p>
      </section>
      <section className="workflow-inspector" aria-label="Selected node parameters"><div className="workflow-inspector-heading"><h3>{nodeLabel(selected)}</h3></div>
        {selected.type === "source" && <><p>The active image and exact selected region bind every preview and execution.</p><label>Input interpretation<select aria-label="Workflow input interpretation" value={String(selected.settings.input_transform ?? "native")} onChange={(event) => mutate({ ...definition, nodes: definition.nodes.map((node) => node.id === selected.id ? { ...node, settings: event.target.value === "native" ? {} : { input_transform: "rgb_intensity" } } : node) })}><option value="native">Native selected channel</option><option value="rgb_intensity">RGB intensity</option></select></label><p>RGB components are display samples, not declared biological channels.</p><label>Working memory<select aria-label="Workflow working memory" value={definition.working_bytes} onChange={(event) => mutate({ ...definition, working_bytes: Number(event.target.value) })}>{[512 * 1024 ** 2, 1024 ** 3, 2 * 1024 ** 3, 4 * 1024 ** 3].map((bytes) => <option key={bytes} value={bytes}>{bytes / 1024 ** 2} MiB</option>)}</select></label></>}
        {(selected.type === "process" || selected.type === "segment") && <>{Object.entries(selected.settings).map(([key, value]) => typeof value === "number" ? <label key={key}>{key === "min_size" ? "Minimum " + (selection.z_stop !== undefined ? "volume" : "area") : key === "threshold" ? "Intensity threshold" : key.replaceAll("_", " ")}{["min_size", "radius", "sigma", "split_height"].includes(key) && <small>{sourceMetrics.find((metric) => metric.id === (key === "min_size" ? "measure" : "nearest_centroid_distance"))?.unit ?? "Source geometry units · resolve on save"}</small>}{numberInput(key, value, ["min_size", "radius", "sigma"].includes(key) ? 0 : key === "split_height" ? Number.MIN_VALUE : undefined)}</label> : typeof value === "boolean" ? <label key={key} className="workflow-checkbox"><input type="checkbox" checked={value} onChange={(event) => patch({ [key]: event.target.checked })} />{key.replaceAll("_", " ")}</label> : null)}
          {selected.type === "segment" && <><label>Threshold method<select aria-label="Workflow threshold method" value={selected.settings.threshold === "otsu" ? "otsu" : "manual"} onChange={(event) => { const field = selected.id + ":threshold"; setDrafts((old) => { const next = { ...old }; delete next[field]; return next; }); setInvalid((old) => { const next = { ...old }; delete next[field]; return next; }); patch({ threshold: event.target.value === "otsu" ? "otsu" : 0 }); }}><option value="otsu">Otsu on selected image</option><option value="manual">Manual numeric threshold</option></select></label><label>Method<select aria-label="Workflow segmentation method" value={String(selected.settings.method)} onChange={(event) => patch(event.target.value === "watershed" ? { method: "watershed", split_height: selected.settings.split_height ?? 1 } : { method: "components" })}><option value="components">Connected components</option><option value="watershed">Watershed</option></select></label><label>Polarity<select aria-label="Workflow polarity" value={String(selected.settings.polarity ?? "bright")} onChange={(event) => patch({ polarity: event.target.value })}><option value="bright">Bright objects</option><option value="dark">Dark objects</option></select></label></>}
          {selected.type === "process" && <><label>Connect image input after<select aria-label="Connect processing input after" value={definition.edges.find((edge) => edge.to === selected.id)?.from ?? ""} onChange={(event) => { try { mutate(reconnectProcess(definition, selected.id, event.target.value)); } catch (caught) { setError(failure(caught)); } }}>{definition.nodes.filter((node) => node.id !== selected.id).map((node) => <option key={node.id} value={node.id}>{nodeLabel(node)} · {node.id}</option>)}</select></label><p>Image inputs accept the source or another processing output. Moving a node reconnects the ordered chain.</p><div className="workflow-actions"><button aria-label="Move workflow node up" disabled={definition.nodes[definition.nodes.indexOf(selected) - 1]?.type !== "process"} onClick={() => move(-1)}><ArrowUp size={14} />Up</button><button aria-label="Move workflow node down" disabled={definition.nodes[definition.nodes.indexOf(selected) + 1]?.type !== "process"} onClick={() => move(1)}><ArrowDown size={14} />Down</button><button onClick={remove}><Trash2 size={14} />Remove node</button></div></>}
        </>}
        {selected.type === "measure" && <><p>Measurements use original source pixels. Processing affects segmentation only.</p><fieldset><legend>Raw measurement channels</legend>{Array.from({ length: source.metadata.dimensions?.c ?? 1 }, (_, channel) => <label className="workflow-checkbox" key={channel}><input type="checkbox" checked={(selected.settings.measurement_channels as number[]).includes(channel)} onChange={(event) => patch({ measurement_channels: event.target.checked ? [...selected.settings.measurement_channels as number[], channel].sort((a, b) => a - b) : (selected.settings.measurement_channels as number[]).filter((item) => item !== channel) })} />{source.metadata.channel_names?.[channel] ?? "Channel " + (channel + 1)}</label>)}</fieldset><p>{(selected.settings.gates as unknown[]).length} configured gates retained.</p></>}
        {selected.type === "population" && <PopulationSettings node={selected} metrics={sourceMetrics} drafts={drafts} invalid={invalid} onEdit={() => { generation.current++; }} onDraft={setDrafts} onInvalid={setInvalid} onPatch={patch} onRemove={remove} />}
        {selected.type === "review" && <><p>Inspect the saved result in the image and object explorer. Review records this exact revision.</p><p>Current displayed result: {exactDisplayed ? "matches this execution" : "inspect the exact execution before approval"}.</p></>}
        {selected.type === "export" && <p>Export opens the native destination picker after exact human approval. Population filters retain membership receipts; they do not remove segmentation labels.</p>}
        <div className="workflow-node-action"><button disabled={blocked || edited || ["review", "export"].includes(selected.type)} onClick={() => void preview()}><Scan size={15} />Preview through this step</button></div>
      </section>
    </div>
    <div className="workflow-feedback" aria-live="polite">
      {Object.keys(invalid).length > 0 && <p role="alert" className="workflow-error">Correct the numeric draft before saving or running. {Object.values(invalid)[0]}</p>}
      {unsupported && <p role="alert" className="workflow-error">This recipe uses reference images. Workflow compilation does not yet support those bindings; remove them in Processing before creating a workflow.</p>}
      {!recipe.segmentation && !saved && definition.nodes.find((node) => node.type === "segment")?.settings.threshold === "otsu" && <p className="workflow-notice">Object workflow starts with connected components and an Otsu threshold. Configure the segmentation node before running.</p>}
      {previewScope && previewScope !== scope && <p className="workflow-outdated">Previous preview is outdated. Save and preview again to inspect the current parameters and image scope.</p>}
      {error && <p role="alert" className="workflow-error">{error}</p>}{notice && <p role="status" className="workflow-notice">{notice}</p>}
    </div>
    <section className="workflow-execution" aria-label="Workflow execution result">
      <div className="workflow-execute"><div><h3>Execution</h3><p>Run the saved chain on the selected image region</p></div><button className="workflow-run" disabled={blocked || edited || unsupported} onClick={() => void execute()}><Play size={15} />Run workflow</button></div>
      {!run ? <p>No execution in this editor yet. Save the chain, preview a step, then run.</p> : <><p className={outdated ? "workflow-outdated" : ""}>{outdated || runState === "outdated" ? "Outdated execution · parameters or image scope changed. Run again before review or export." : run.response.result.object_count.toLocaleString() + " objects · " + runState.replaceAll("_", " ")}</p>
        {run.response.run.data.population && <><p>{run.response.run.data.population.filtered_count.toLocaleString()} of {run.response.run.data.population.total_count.toLocaleString()} objects match.</p>
          <details><summary>Technical record</summary><p>Membership SHA-256 <code>{run.response.run.data.population.membership_sha256}</code></p></details></>}
        <div className="workflow-actions"><button disabled={blocked || outdated} onClick={() => void resultAction("inspect")}>Inspect exact result</button><button disabled={blocked || outdated || !exactDisplayed || runState === "outdated"} onClick={() => void resultAction("review")}>Mark reviewed</button><button disabled={blocked || outdated || !["reviewed", "exported"].includes(runState)} onClick={() => void resultAction("export")}>Export reviewed result</button></div></>}
      <p className="workflow-help">Select a node to edit or preview its prefix. Jobs reports measured execution status; nodes do not imply individual progress.</p>
    </section>
    {api.submitBatch && <details className="workflow-batch"><summary>Batch sources · {targets.length} selected</summary><p>Use the same exact region and axes on every source. All sources must pass compatibility checks before submission.</p><div className="workflow-batch-sources">{sources.map((target) => <label key={target.id} className="workflow-checkbox"><input type="checkbox" checked={targets.includes(target.id)} disabled={Boolean(pending)} onChange={(event) => setTargets((old) => event.target.checked ? [...old, target.id] : old.filter((id) => id !== target.id))} />{target.name}</label>)}</div><div className="workflow-actions"><button disabled={blocked || edited || !targets.length} onClick={() => void batch()}>Check and run batch</button><button disabled={!durableJobs.some((job) => ["queued", "running"].includes(job.state))} onClick={() => void cancelBatch()}>Cancel batch</button>{latestBatchId && <><button disabled={blocked} onClick={() => void recoverBatch(false)}>Resume batch</button><button disabled={blocked} onClick={() => void recoverBatch(true)}>Retry failed batch</button></>}</div>
      {durableJobs.length > 0 && <ul className="workflow-job-list">{durableJobs.map((job) => <li key={job.id}><span>{sources.find((item) => item.id === job.request.source_id)?.name ?? "Source"} · {job.state}</span>{job.error && <span className="workflow-error">{job.error}</span>}</li>)}</ul>}
    </details>}
  </section>;
}
function PopulationSettings({ node, metrics, drafts, invalid, onDraft, onInvalid, onEdit, onPatch, onRemove }: {
  node: WorkflowNode; metrics: Array<{ id: string; unit: string; label?: string }>; drafts: Record<string, string>; invalid: Record<string, string>;
  onDraft: React.Dispatch<React.SetStateAction<Record<string, string>>>; onInvalid: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  onEdit: () => void; onPatch: (settings: Record<string, unknown>) => void; onRemove: () => void;
}) {
  const filters = node.settings.filters as Array<{ metric: string; unit: string; min?: number; max?: number }>;
  const [metric, setMetric] = useState("measure");
  const descriptor = metrics.find((item) => item.id === metric);
  const changeBound = (index: number, key: "min" | "max", text: string) => {
    const field = node.id + ":filter-" + filters[index].metric + "-" + key; onEdit(); onDraft((old) => ({ ...old, [field]: text }));
    try { const candidate = { ...filters[index] };
      for (const bound of ["min", "max"] as const) {
        const fieldKey = node.id + ":filter-" + candidate.metric + "-" + bound;
        const draft = bound === key ? text : drafts[fieldKey] ?? (candidate[bound] === undefined ? "" : String(candidate[bound]));
        candidate[bound] = draft.trim() ? finiteDraft(draft) : undefined;
      }
      const next = filters.map((filter, i) => i === index ? candidate : filter);
      if (next[index].min === undefined && next[index].max === undefined) throw new Error("Keep at least one finite range bound.");
      if (next[index].min !== undefined && next[index].max !== undefined && next[index].min! > next[index].max!) throw new Error("Minimum must be no greater than maximum.");
      onPatch({ filters: next }); onInvalid((old) => { const nextInvalid = { ...old }; delete nextInvalid[node.id + ":filter-" + filters[index].metric + "-min"]; delete nextInvalid[node.id + ":filter-" + filters[index].metric + "-max"]; return nextInvalid; });
    } catch (caught) { onInvalid((old) => ({ ...old, [field]: failure(caught) })); }
  };
  return <><p>Inclusive ranges bind exact metric identifiers and units. The engine checks units against source geometry; missing values are excluded.</p>
    <label>Metric<select aria-label="Workflow population metric" value={metric} onChange={(event) => setMetric(event.target.value)}><option value="measure">{metrics.find((item) => item.id === "measure")?.label ?? "Area / volume"}</option>{metrics.filter((item) => item.id !== "measure").map((item, index) => <option key={item.id} value={item.id}>{item.label ?? (item.id === "voxel_count" ? "Pixel / voxel count" : item.id === "nearest_centroid_distance" ? "Nearest centroid distance" : "Intensity metric " + (index + 1))} ({item.unit})</option>)}</select></label>
    <p>Exact unit: {descriptor?.unit ?? "save this workflow to resolve source metrics"}</p>
    <button disabled={!descriptor || filters.length >= 8 || filters.some((filter) => filter.metric === metric)} onClick={() => onPatch({ filters: [...filters, { metric, unit: descriptor!.unit, min: 0 }] })}><Plus size={14} />Add range</button>
    {filters.map((filter, index) => <fieldset key={index + ":" + filter.metric}><legend>{metrics.find((item) => item.id === filter.metric)?.label ?? (filter.metric === "measure" ? "Area / volume" : filter.metric === "voxel_count" ? "Pixel / voxel count" : filter.metric === "nearest_centroid_distance" ? "Nearest centroid distance" : "Intensity range")} ({filter.unit})</legend>{(["min", "max"] as const).map((key) => { const field = node.id + ":filter-" + filters[index].metric + "-" + key;
      return <label key={key}>{key === "min" ? "Minimum (inclusive)" : "Maximum (inclusive)"}<input aria-label={"Workflow population " + (key === "min" ? "minimum" : "maximum") + " " + (index + 1)} aria-invalid={Boolean(invalid[field])} inputMode="decimal" value={drafts[field] ?? (filter[key] === undefined ? "" : String(filter[key]))}
        onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onDraft((old) => { const next = { ...old }; delete next[field]; return next; }); onInvalid((old) => { const next = { ...old }; delete next[field]; return next; }); } }}
        onChange={(event) => changeBound(index, key, event.target.value)} /></label>; })}<button onClick={() => {
        const prefix = node.id + ":filter-" + filter.metric + "-";
        onDraft((old) => Object.fromEntries(Object.entries(old).filter(([field]) => !field.startsWith(prefix))));
        onInvalid((old) => Object.fromEntries(Object.entries(old).filter(([field]) => !field.startsWith(prefix))));
        onPatch({ filters: filters.filter((_, i) => i !== index) });
      }}>Remove range</button></fieldset>)}
    <button onClick={onRemove}><Trash2 size={14} />Remove population node</button></>;
}
