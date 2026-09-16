import { randomUUID } from "node:crypto";

import type {
  ResearchBatchTask,
  ResearchJob,
  ResearchJobState,
  ResearchSource,
} from "../shared/research-contracts";

const HEX_32 = /^[a-f0-9]{32}$/u;
const SHA_256 = /^[a-f0-9]{64}$/u;
const BATCH_KEY = /^loci-batch:([a-f0-9]{32}):(initial|resume|retry):([a-f0-9]{5,32})$/u;
const OPERATIONS = new Set<ResearchBatchTask["operation"]>([
  "run_recipe",
  "classical_run",
  "cellpose_run",
]);
const RETRYABLE_STATES = new Set<ResearchJobState>([
  "failed",
  "cancelled",
]);
const RESUMABLE_STATES = new Set<ResearchJobState>(["interrupted"]);
const ACTIVE_OR_COMPLETE_STATES = new Set<ResearchJobState>([
  "queued",
  "running",
  "succeeded",
]);

export const MAX_RESEARCH_BATCH_TASKS = 10_000;
export const MAX_RESEARCH_BATCH_BYTES = 32 * 1024 * 1024;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  if (Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) {
    throw new Error(`${label} contains unsupported fields.`);
  }
}

export function requireResearchBatchId(value: unknown): string {
  if (typeof value !== "string" || !HEX_32.test(value)) {
    throw new Error("Choose a valid durable batch.");
  }
  return value;
}

export function requireResearchJobId(value: unknown): string {
  if (typeof value !== "string" || !HEX_32.test(value)) {
    throw new Error("Choose a valid durable batch job.");
  }
  return value;
}

export function createResearchBatchId(): string {
  return randomUUID().replaceAll("-", "");
}

export function createResearchBatchKey(
  batchIdValue: unknown,
  phase: "initial" | "resume" | "retry",
  ordinal?: number,
): string {
  const batchId = requireResearchBatchId(batchIdValue);
  const suffix = phase === "initial"
    ? String(ordinal ?? -1).padStart(5, "0")
    : randomUUID().replaceAll("-", "");
  if (phase === "initial" &&
      (!Number.isSafeInteger(ordinal) || (ordinal as number) < 0 || (ordinal as number) >= MAX_RESEARCH_BATCH_TASKS)) {
    throw new Error("The durable batch item position is invalid.");
  }
  return `loci-batch:${batchId}:${phase}:${suffix}`;
}

export function researchBatchIdForJob(job: Pick<ResearchJob, "request_key">): string | null {
  return BATCH_KEY.exec(job.request_key)?.[1] ?? null;
}

export function researchJobsForBatch(
  jobs: readonly ResearchJob[],
  batchIdValue: unknown,
): ResearchJob[] {
  const batchId = requireResearchBatchId(batchIdValue);
  return jobs.filter((job) => researchBatchIdForJob(job) === batchId);
}

export function validateResearchBatchTasks(
  value: unknown,
  sources: readonly ResearchSource[],
): ResearchBatchTask[] {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("The durable batch request is not serializable.");
  }
  if (!serialized || Buffer.byteLength(serialized, "utf8") > MAX_RESEARCH_BATCH_BYTES) {
    throw new Error("The durable batch request exceeds its safe size limit.");
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_RESEARCH_BATCH_TASKS) {
    throw new Error("Choose between 1 and 10,000 sources for a durable batch.");
  }
  const available = new Map(sources.map((source) => [source.id, source] as const));
  const seen = new Set<string>();
  const checked = value.map((candidate, index) => {
    const task = record(candidate, `Batch task ${index + 1}`);
    exactKeys(task, ["operation", "source", "request"], `Batch task ${index + 1}`);
    if (typeof task.operation !== "string" ||
        !OPERATIONS.has(task.operation as ResearchBatchTask["operation"])) {
      throw new Error("A durable study batch supports generic recipes, Loci Adaptive Watershed, or Cellpose runs.");
    }
    const source = record(task.source, `Batch task ${index + 1} source binding`);
    exactKeys(source, ["id", "sha256"], `Batch task ${index + 1} source binding`);
    if (typeof source.id !== "string" || !HEX_32.test(source.id) ||
        typeof source.sha256 !== "string" || !SHA_256.test(source.sha256)) {
      throw new Error("Every durable batch item needs an exact source ID and SHA-256.");
    }
    if (seen.has(source.id)) {
      throw new Error("A source can appear only once in a durable batch.");
    }
    seen.add(source.id);
    const current = available.get(source.id);
    if (!current || current.sha256 !== source.sha256) {
      throw new Error("A durable batch source no longer matches the current study snapshot.");
    }
    const request = record(task.request, `Batch task ${index + 1} request`);
    if (request.source_id !== source.id) {
      throw new Error("The durable task request disagrees with its source binding.");
    }
    return structuredClone({
      operation: task.operation,
      source: { id: source.id, sha256: source.sha256 },
      request,
    }) as ResearchBatchTask;
  });
  return checked;
}

export function originalResearchBatchTask(
  job: ResearchJob,
  sources: readonly ResearchSource[],
): ResearchBatchTask {
  if (!OPERATIONS.has(job.operation as ResearchBatchTask["operation"])) {
    throw new Error("The durable batch contains an unsupported operation.");
  }
  const normalized = record(job.request, "Stored durable batch request");
  const sourceId = normalized.source_id;
  const request = job.operation === "run_recipe"
    ? normalized
    : record(normalized.task_request, "Stored durable task request");
  const source = sources.find((candidate) => candidate.id === sourceId);
  if (!source || request.source_id !== source.id || !SHA_256.test(source.sha256)) {
    throw new Error("The durable batch source cannot be rebound to the current study.");
  }
  return validateResearchBatchTasks([{
    operation: job.operation,
    source: { id: source.id, sha256: source.sha256 },
    request,
  }], sources)[0];
}

export function researchBatchRetryCandidates(
  jobs: readonly ResearchJob[],
  batchIdValue: unknown,
  phase: "resume" | "retry",
): ResearchJob[] {
  const batch = researchJobsForBatch(jobs, batchIdValue);
  const targetStates = phase === "resume" ? RESUMABLE_STATES : RETRYABLE_STATES;
  const byRequest = new Map<string, ResearchJob[]>();
  for (const job of batch) {
    const group = byRequest.get(job.request_hash) ?? [];
    group.push(job);
    byRequest.set(job.request_hash, group);
  }
  const candidates: ResearchJob[] = [];
  for (const group of byRequest.values()) {
    if (group.some((job) => ACTIVE_OR_COMPLETE_STATES.has(job.state))) continue;
    const candidate = [...group].reverse().find((job) => targetStates.has(job.state));
    if (candidate) candidates.push(candidate);
  }
  return candidates.sort((left, right) =>
    left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id));
}
