import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from "lucide-react";
import type { ResearchAgentControlRequest, ResearchAgentTaskRecord, ResearchSnapshot } from "../shared/research-contracts";
import { agentTargetState, AgentTargetLinks, RecordedTime, type AgentActivityNavigation } from "./AgentActivityTimeline";
import "./AgentTaskPanel.css";

type Assessment = ResearchAgentTaskRecord["assessments"][number];
type Draft = { revision: number; goal: string; steps: { id: string; title: string }[] };
const taskState = { active: "In progress", awaiting_review: "Ready for your review", complete: "Reported complete", cancelled: "Plan cancelled" };
const stepState = { planned: "Planned", in_progress: "In progress", complete: "Reported complete", blocked: "Blocked" };

function AssessmentView({ assessment, snapshot, navigation, unavailable }: {
  assessment: Assessment; snapshot: ResearchSnapshot; navigation: AgentActivityNavigation; unavailable: boolean;
}): React.JSX.Element {
  return <section className="agent-task-assessment" aria-label="Agent assessment">
    <div className="agent-task-heading"><h4>Agent assessment</h4><span>{assessment.client_id}</span></div>
    {assessment.stale && <p className="agent-task-warning" role="note">Some evidence has changed since this assessment was recorded.</p>}
    <p className="agent-task-prose">{assessment.summary}</p>
    {assessment.observations.length > 0 && <ul className="agent-task-observations" aria-label="Agent observations">
      {assessment.observations.map((text, index) => <li key={index}>{text}</li>)}
    </ul>}
    <div className="agent-task-limitations"><h5>Limitations</h5>
      {assessment.limitations.length ? <ul>{assessment.limitations.map((text, index) => <li key={index}>{text}</li>)}</ul>
        : <p>The agent did not record limitations.</p>}
    </div>
    <div className="agent-task-evidence"><h5>Evidence</h5>
      <AgentTargetLinks targets={assessment.targets} snapshot={snapshot} navigation={navigation} unavailable={unavailable} allowReview />
    </div>
    <p className="agent-task-note">Agent interpretation. Scientific review is recorded on the result.</p>
    <details><summary>Assessment record</summary><dl className="agent-approval-meta">
      <dt>Recorded</dt><dd><RecordedTime value={assessment.created_at} /></dd>
      <dt>Assessment</dt><dd>{assessment.id}</dd><dt>Session</dt><dd>{assessment.session_id}</dd>
    </dl></details>
  </section>;
}

function TaskView({ task, snapshot, navigation, unavailable, busy, canControl, onControl, onEditingChange }: {
  task: ResearchAgentTaskRecord; snapshot: ResearchSnapshot; navigation: AgentActivityNavigation;
  unavailable: boolean; busy: boolean; canControl: boolean;
  onControl: (request: ResearchAgentControlRequest) => Promise<boolean>;
  onEditingChange: (editing: boolean) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saveError, setSaveError] = useState("");
  const submitting = useRef(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  useEffect(() => {
    if (!draft && returnFocus.current) { editButton.current?.focus(); returnFocus.current = false; }
  }, [draft]);
  const revisionChanged = draft !== null && draft.revision !== task.revision;
  const locked = busy || unavailable || !canControl;
  const editable = !locked && task.state !== "cancelled";
  const session = snapshot.agent_sessions?.sessions.find(item => item.session_id === task.session_id);
  const retained = !session || ["disconnected", "interrupted", "failed"].includes(session.state);
  const evidenceJobIds = new Set([...task.targets, ...task.steps.flatMap(step => step.targets), ...task.assessments.flatMap(assessment => assessment.targets)]
    .filter(target => target.kind === "job" && agentTargetState(target, snapshot, navigation.currentTargets) === "current").map(target => target.id));
  const runningJobs = snapshot.jobs.filter(job => evidenceJobIds.has(job.id) && ["running", "queued"].includes(job.state) &&
    job.owner?.session_id === task.session_id && job.owner.policy_sha256 === task.policy_sha256);
  const assessments = [...task.assessments].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const edit = () => {
    setDraft({ revision: task.revision, goal: task.goal, steps: task.steps.map(({ id, title }) => ({ id, title })) });
    setSaveError(""); onEditingChange(true);
  };
  const finishEdit = () => { returnFocus.current = true; setDraft(null); setSaveError(""); onEditingChange(false); };
  const save = async () => {
    if (!draft || locked || revisionChanged || submitting.current) return;
    submitting.current = true; setSaveError("");
    try {
      const saved = await onControl({ action: "edit_task", task_id: task.id, expected_revision: draft.revision,
        goal: draft.goal.trim(), steps: draft.steps.map(step => ({ ...step, title: step.title.trim() })) });
      if (saved) finishEdit();
      else setSaveError("The plan was not saved. Your draft is preserved; check the latest task state before retrying.");
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "The plan was not saved. Your draft is preserved.");
    } finally { submitting.current = false; }
  };
  const reorder = (index: number, direction: number) => setDraft(current => {
    if (!current) return current;
    const steps = [...current.steps];
    [steps[index], steps[index + direction]] = [steps[index + direction], steps[index]];
    return { ...current, steps };
  });
  return <article className="agent-task" aria-label={`Agent task: ${task.goal}`}>
    <div className="agent-task-heading"><h3>Task plan</h3><span className="agent-session-badge">{taskState[task.state]}</span></div>
    <p className="agent-task-note">{task.client_id} · Agent-reported plan{task.updated_by === "human" ? " · Updated by you" : ""}</p>
    {retained && <p className="agent-task-note">Retained plan · {session ? session.state.replaceAll("_", " ") : "session unavailable"}. Continuing requires an explicit resume from the external agent.</p>}
    {task.stale && <p className="agent-task-warning" role="note">A recorded source or result has changed. Inspect the exact evidence before continuing.</p>}
    {draft ? <form className="agent-task-editor" aria-label="Edit agent plan" onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="agent-task-editor-header">
        <div className="agent-task-actions" role="group" aria-label="Plan editing actions"><button type="submit" className="research-primary"
          disabled={locked || revisionChanged || !draft.goal.trim() || !draft.steps.length || draft.steps.some(step => !step.title.trim())}>Save plan</button>
          <button type="button" disabled={busy} onClick={finishEdit}>Cancel editing</button></div>
        {revisionChanged && <p role="alert" className="agent-task-warning">The task changed while you were editing. Your draft is preserved. Cancel editing to load the latest plan.</p>}
        {saveError && <p role="alert" className="agent-task-warning">{saveError}</p>}
      </div>
      <label>Goal<textarea autoFocus value={draft.goal} maxLength={2000} disabled={busy}
        onChange={event => setDraft({ ...draft, goal: event.target.value })} /></label>
      <ol className="agent-task-edit-steps">{draft.steps.map((step, index) => <li key={step.id}>
        <label>Step {index + 1}<input value={step.title} maxLength={240} disabled={busy}
          onChange={event => setDraft({ ...draft, steps: draft.steps.map((item, i) => i === index ? { ...item, title: event.target.value } : item) })} /></label>
        <div className="agent-task-reorder">
          <button type="button" aria-label={`Move step ${index + 1} up`} title="Move step up" disabled={busy || index === 0} onClick={() => reorder(index, -1)}><ArrowUp size={15} aria-hidden="true" /></button>
          <button type="button" aria-label={`Move step ${index + 1} down`} title="Move step down" disabled={busy || index === draft.steps.length - 1} onClick={() => reorder(index, 1)}><ArrowDown size={15} aria-hidden="true" /></button>
          <button type="button" aria-label={`Remove step ${index + 1}`} title="Remove step" disabled={busy || draft.steps.length === 1}
            onClick={() => setDraft({ ...draft, steps: draft.steps.filter((_, i) => i !== index) })}><Trash2 size={15} aria-hidden="true" /></button>
        </div>
      </li>)}</ol>
      <button type="button" disabled={busy || draft.steps.length >= 20} onClick={() => setDraft({ ...draft, steps: [...draft.steps, { id: `human-${crypto.randomUUID()}`, title: "" }] })}><Plus size={15} aria-hidden="true" />Add step</button>
      <p className="agent-task-note">Changed steps return to planned. Saving does not run the plan.</p>
    </form> : <>
      <p className="agent-task-goal">{task.goal}</p>
      <ol className="agent-task-steps" aria-label="Agent-reported steps">{task.steps.map(step => <li key={step.id}>
        <div className="agent-task-step-heading"><strong>{step.title}</strong><span>{stepState[step.state]}</span></div>
        {step.note && <p className="agent-task-note">{step.note}</p>}
        {step.targets.length > 0 && <details><summary>Step evidence</summary><AgentTargetLinks targets={step.targets} snapshot={snapshot} navigation={navigation} unavailable={unavailable} /></details>}
      </li>)}</ol>
      {task.state !== "cancelled" && <div className="agent-task-actions">
        <button ref={editButton} type="button" disabled={!editable} onClick={edit}><Pencil size={14} aria-hidden="true" />Edit plan</button>
        {task.state !== "complete" && <button type="button" disabled={locked} onClick={() => void onControl({ action: "cancel_task", task_id: task.id, expected_revision: task.revision })}>Cancel plan</button>}
      </div>}
    </>}
    {runningJobs.length > 0 && <section className="agent-task-jobs" aria-label="Confirmed task jobs">
      <h4>Running jobs</h4>{runningJobs.map(job => <div className="agent-task-job" key={job.id}>
        <span>{job.operation.replaceAll("_", " ")} · {job.state} · {job.id.slice(0, 8)}</span>
        <button type="button" disabled={busy || unavailable || !canControl || job.cancel_requested}
          aria-label={`Stop job ${job.id}`} onClick={() => void onControl({ action: "stop_job", job_id: job.id, session_id: task.session_id })}>
          {job.cancel_requested ? "Stop requested" : "Stop job"}</button>
      </div>)}
    </section>}
    {!draft && <p className="agent-task-note">Cancelling this plan leaves running jobs active. Use Stop job to request cancellation.</p>}
    <details><summary>Task sources &amp; record</summary>
      <AgentTargetLinks targets={task.targets} snapshot={snapshot} navigation={navigation} unavailable={unavailable} />
      <dl className="agent-approval-meta"><dt>Updated</dt><dd><RecordedTime value={task.updated_at} /></dd>
        <dt>Task</dt><dd>{task.id}</dd><dt>Revision</dt><dd>{task.revision}</dd><dt>Session</dt><dd>{task.session_id}</dd></dl>
    </details>
    {assessments[0] && <AssessmentView assessment={assessments[0]} snapshot={snapshot} navigation={navigation} unavailable={unavailable} />}
    {assessments.length > 1 && <details className="agent-task-history"><summary>Earlier assessments ({assessments.length - 1})</summary>
      {assessments.slice(1).map(item => <AssessmentView key={item.id} assessment={item} snapshot={snapshot} navigation={navigation} unavailable={unavailable} />)}
    </details>}
  </article>;
}

export function AgentTaskPanel({ tasks, sessionId, snapshot, navigation = {}, unavailable = false, busy = false, canControl, onControl }: {
  tasks: ResearchAgentTaskRecord[]; sessionId?: string; snapshot: ResearchSnapshot; navigation?: AgentActivityNavigation;
  unavailable?: boolean; busy?: boolean; canControl: boolean; onControl: (request: ResearchAgentControlRequest) => Promise<boolean>;
}): React.JSX.Element | null {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const ordered = [...tasks].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const preferred = (sessionId && ordered.find(task => task.session_id === sessionId)) || ordered[0];
  const task = ordered.find(item => item.id === selectedId) ?? preferred;
  if (!task) return null;
  return <section className="agent-task-panel" aria-label="External agent plans and assessments">
    {ordered.length > 1 && <label className="agent-task-selector">Task<select value={task.id} disabled={editing || busy} onChange={event => setSelectedId(event.target.value)}>
      {ordered.map(item => <option key={item.id} value={item.id}>{item.client_id} · {item.goal}</option>)}
    </select></label>}
    <TaskView key={task.id} task={task} snapshot={snapshot} navigation={navigation} unavailable={unavailable} busy={busy} canControl={canControl}
      onControl={onControl} onEditingChange={value => { setEditing(value); if (value) setSelectedId(task.id); }} />
  </section>;
}
