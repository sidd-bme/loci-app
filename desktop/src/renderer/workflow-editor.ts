import type { ResearchRecipe } from "../shared/research-contracts";
export type WorkflowNodeType = "source" | "process" | "segment" | "measure" | "population" | "review" | "export";
export interface WorkflowNode { id: string; type: WorkflowNodeType; settings: Record<string, unknown> }
export interface WorkflowDefinition {
  schema: "loci.workflow/v1"; name: string; nodes: WorkflowNode[];
  edges: Array<{ from: string; to: string }>; working_bytes: number;
}
export interface WorkflowRecord { id: string; revision: number; data: { definition: WorkflowDefinition; definition_sha256: string } }
export const PROCESS_OPTIONS = ["gaussian", "subtract_background", "subtract_constant", "median", "opening", "closing"];
export const nodeLabel = (node: WorkflowNode): string => node.type === "process" ? String(node.settings.op).replaceAll("_", " ") :
  ({ source: "Source image", segment: "Segment objects", measure: "Measure raw pixels", population: "Filter population", review: "Human review", export: "Export result" } as Record<string, string>)[node.type];
export const connected = (definition: WorkflowDefinition, nodes: WorkflowNode[]): WorkflowDefinition => ({ ...definition, nodes,
  edges: nodes.slice(1).map((node, index) => ({ from: nodes[index].id, to: node.id })) });
export function workflowFromRecipe(recipe: ResearchRecipe): WorkflowDefinition {
  const nodes: WorkflowNode[] = [{ id: "source", type: "source", settings: recipe.input_transform ? { input_transform: recipe.input_transform } : {} },
    ...recipe.steps.map((settings, index): WorkflowNode => ({ id: "process-" + index, type: "process", settings: structuredClone(settings) })),
    { id: "segment", type: "segment", settings: structuredClone(recipe.segmentation ?? { method: "components", threshold: "otsu", polarity: "bright", min_size: 10, exclude_border: false }) },
    { id: "measure", type: "measure", settings: { measurement_channels: [...recipe.measurement_channels], gates: structuredClone(recipe.gates) } },
    { id: "review", type: "review", settings: {} }, { id: "export", type: "export", settings: {} }];
  return connected({ schema: "loci.workflow/v1", name: "Image analysis workflow", nodes: [], edges: [], working_bytes: recipe.working_bytes }, nodes);
}
export function reconnectProcess(definition: WorkflowDefinition, nodeId: string, predecessorId: string): WorkflowDefinition {
  const node = definition.nodes.find((entry) => entry.id === nodeId);
  const predecessor = definition.nodes.find((entry) => entry.id === predecessorId);
  if (!node || node.type !== "process" || !predecessor || !["source", "process"].includes(predecessor.type) || node.id === predecessor.id)
    throw new Error("Image processing can connect only after the source or another image processing node. Measurements and review cannot feed an image input.");
  const nodes = definition.nodes.filter((entry) => entry.id !== nodeId);
  nodes.splice(nodes.findIndex((entry) => entry.id === predecessorId) + 1, 0, node);
  return connected(definition, nodes);
}
export function finiteDraft(text: string, integer = false, minimum?: number): number {
  const number = Number(text);
  if (!text.trim() || !Number.isFinite(number) || (integer && !Number.isSafeInteger(number)) || (minimum !== undefined && number < minimum))
    throw new Error(integer ? "Enter a valid whole number in the allowed range." : "Enter a finite number in the allowed range.");
  return number;
}
export function checkedWorkflow(value: unknown): WorkflowRecord {
  const record = value as WorkflowRecord | null;
  if (!record || !/^[a-f0-9]{32}$/.test(record.id) || !Number.isSafeInteger(record.revision) || record.revision < 1 ||
    !record.data || !/^[a-f0-9]{64}$/.test(record.data.definition_sha256) || record.data.definition?.schema !== "loci.workflow/v1" ||
    !Array.isArray(record.data.definition.nodes) || !Array.isArray(record.data.definition.edges)) throw new Error("The saved workflow response is invalid. Reopen the study and retry.");
  return record;
}
