import type { ResearchSelection } from "./research-contracts";

export const graphOperations = ["run_recipe", "classical_run", "associate_results", "spatial_distance_run"] as const;
export type GraphOperation = typeof graphOperations[number];
export type GraphRef = { input: string } | { node: string; port: "result" };
export type GraphResultBinding = { result_id: string; revision_hash: string };
export type GraphSourceBinding = { source_id: string; source_sha256: string; selection: ResearchSelection };
export type GraphBindings = Record<string, GraphSourceBinding | GraphResultBinding>;
export interface GraphDefinition {
  schema: "loci.workflow/v2"; name: string;
  inputs: Record<string, "source-selection" | "label-result">;
  nodes: Array<{ id: string; operation: GraphOperation; contract_version: 1; inputs: Record<string, GraphRef>; settings: Record<string, unknown> }>;
  outputs: Record<string, { node: string; port: "result" }>; working_bytes: number;
}
export interface GraphWorkflow {
  id: string; revision: number; kind: "workflow";
  data: { schema: "loci.saved-workflow/v2"; definition: GraphDefinition; definition_sha256: string };
}
export interface GraphPlan {
  schema: "loci.workflow-plan/v2"; definition: GraphDefinition; definition_sha256: string;
  bindings: GraphBindings; bindings_sha256: string; plan_sha256: string; node_order: string[];
  node_scopes: Record<string, { source_id: string; source_sha256: string; selection: Record<string, number>; geometry: unknown; shape: number[] }>;
  runtime: Record<string, unknown>; adapter_versions: Record<string, number>;
}
export type GraphNodeState = "pending" | "intent" | "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
export interface GraphNodeReceipt {
  state: GraphNodeState; output: GraphResultBinding | null;
  intent: null | { operation: GraphOperation; request: Record<string, unknown>; request_sha256: string; request_key: string; job_id: string | null };
}
export interface GraphRun {
  id: string; kind: "workflow_run"; revision: number; updated_at?: string;
  data: { schema: "loci.workflow-run/v2"; workflow_id: string; workflow_revision: number; definition_sha256: string;
    project_id: string; plan: GraphPlan; owner: { policy_sha256: string; session_id: string | null } | null;
    state: "prepared" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled";
    cancel_requested: boolean; nodes: Record<string, GraphNodeReceipt>; outputs: Record<string, GraphResultBinding>;
    run_sha256: string; [key: string]: unknown };
}
export interface GraphStatus { run: GraphRun; state: GraphRun["data"]["state"]; partial_results: Array<GraphResultBinding & { node_id: string }> }
export const graphJson = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const id = (value: unknown) => typeof value === "string" && /^[a-f0-9]{32}$/u.test(value);
const sha = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
export function checkedGraphWorkflow(value: unknown): GraphWorkflow {
  if (!object(value) || !id(value.id) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || value.kind !== "workflow" || !object(value.data) || value.data.schema !== "loci.saved-workflow/v2" || !sha(value.data.definition_sha256)) throw new Error("The composed workflow revision is invalid.");
  const definition = value.data.definition;
  if (!object(definition) || definition.schema !== "loci.workflow/v2" || typeof definition.name !== "string" || !object(definition.inputs) || !object(definition.outputs) || !Array.isArray(definition.nodes) || !definition.nodes.length || definition.nodes.length > 32 || !Number.isSafeInteger(definition.working_bytes)) throw new Error("The composed workflow definition is invalid.");
  for (const node of definition.nodes) if (!object(node) || typeof node.id !== "string" || !graphOperations.includes(node.operation as GraphOperation) || node.contract_version !== 1 || !object(node.inputs) || !object(node.settings)) throw new Error("A composed workflow node is invalid.");
  return value as unknown as GraphWorkflow;
}
export function checkedGraphRun(value: unknown): GraphRun {
  if (!object(value) || !id(value.id) || value.kind !== "workflow_run" || !Number.isSafeInteger(value.revision) || !object(value.data) || value.data.schema !== "loci.workflow-run/v2" || !id(value.data.workflow_id) || !id(value.data.project_id) || !sha(value.data.definition_sha256) || !sha(value.data.run_sha256) || !object(value.data.plan) || !sha(value.data.plan.plan_sha256) || !object(value.data.nodes) || !object(value.data.outputs) || typeof value.data.cancel_requested !== "boolean" || !["prepared", "running", "cancelling", "succeeded", "failed", "cancelled"].includes(String(value.data.state))) throw new Error("The saved composed workflow run is invalid.");
  for (const [nodeId, node] of Object.entries(value.data.nodes)) {
    if (!object(node) || !["pending", "intent", "queued", "running", "succeeded", "failed", "cancelled", "interrupted"].includes(String(node.state))) throw new Error("A composed workflow node state is invalid.");
    if (node.intent !== null && (!object(node.intent) || !graphOperations.includes(node.intent.operation as GraphOperation) || !object(node.intent.request) || !sha(node.intent.request_sha256) || node.intent.request_key !== `graph-v2:${value.id}:${nodeId}` || (node.intent.job_id !== null && !id(node.intent.job_id)))) throw new Error("A composed workflow job identity is invalid.");
    if (node.output !== null && (!object(node.output) || !id(node.output.result_id) || !sha(node.output.revision_hash) || node.state !== "succeeded")) throw new Error("A composed workflow result identity is invalid.");
  }
  return value as unknown as GraphRun;
}
export function checkedGraphStatus(value: unknown): GraphStatus {
  if (!object(value) || !Array.isArray(value.partial_results)) throw new Error("The composed workflow status is invalid.");
  const run = checkedGraphRun(value.run);
  if (value.state !== run.data.state) throw new Error("The composed workflow state does not match its saved run.");
  return value as unknown as GraphStatus;
}
