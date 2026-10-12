import type { ImageViewTargetSnapshot } from "../shared/image-view-contracts";
import { validateTargetSnapshot } from "../shared/image-view-contracts";
import type { ResearchSnapshot } from "../shared/research-contracts";
import { assertResearchRequestBound } from "./research-request-limits";
import { VIEW_OPERATIONS } from "./viewer-request-queue";

export type ImageViewAccess = "read" | "annotate";

interface ViewDocumentState {
  project: string | null;
  epoch: number;
  switching: boolean;
}

interface ResearchViewAccessDependencies {
  documentState: () => ViewDocumentState;
  snapshot: (project: string) => Promise<ResearchSnapshot>;
  executeControl: (
    project: string,
    operation: string,
    request: Record<string, unknown>,
  ) => Promise<unknown>;
  executeViewer: (
    project: string,
    operation: string,
    request: Record<string, unknown>,
    lane: string,
    scope: string,
  ) => Promise<unknown>;
  cancelViewerScope: (scope: string, error: Error) => void;
}

interface CapturedDocument {
  project: string;
  epoch: number;
}

const READ_OPERATIONS = new Set([
  ...VIEW_OPERATIONS,
  "viewer_defaults",
  "source_view",
  "source_annotations",
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value instanceof String || value instanceof Number || value instanceof Boolean) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

function checkedViewerLane(operation: string, options: unknown): string {
  if (options === undefined) return "default";
  if (!VIEW_OPERATIONS.has(operation) || !isPlainRecord(options) ||
      Object.keys(options).sort().join(",") !== "viewer_lane") {
    throw new Error("Invalid viewer scheduling options.");
  }
  const lane = options.viewer_lane;
  if (typeof lane !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(lane)) {
    throw new Error("Invalid viewer scheduling lane.");
  }
  return lane;
}

function assertViewId(viewId: unknown): asserts viewId is string {
  if (typeof viewId !== "string" || !viewId || viewId.length > 128 ||
      /[\u0000-\u001f\u007f]/u.test(viewId)) {
    throw new Error("Invalid image view ID.");
  }
}

function identityField(key: string):
  | "sourceId"
  | "sourceSha256"
  | "resultId"
  | "resultRevisionHash"
  | null {
  switch (key) {
    case "source_id":
    case "sourceId":
    case "expected_source_id":
    case "expectedSourceId":
      return "sourceId";
    case "source_sha256":
    case "sourceSha256":
    case "source_hash":
    case "sourceHash":
    case "expected_source_sha256":
    case "expectedSourceSha256":
    case "expected_source_hash":
    case "expectedSourceHash":
      return "sourceSha256";
    case "result_id":
    case "resultId":
    case "expected_result_id":
    case "expectedResultId":
      return "resultId";
    case "revision_hash":
    case "result_revision_hash":
    case "resultRevisionHash":
    case "expected_revision_hash":
    case "expectedRevisionHash":
    case "expected_result_revision_hash":
    case "expectedResultRevisionHash":
      return "resultRevisionHash";
    default:
      return null;
  }
}

function isPrivateLocationField(key: string): boolean {
  const snakeCase = key.replace(/[A-Z]/gu, (character) => `_${character.toLowerCase()}`);
  return snakeCase === "project" || snakeCase.startsWith("project_") ||
    snakeCase === "path" || snakeCase.endsWith("_path");
}

/** Reject native locations and any source/result identity that differs from the captured target. */
function assertTargetBoundValue(
  value: unknown,
  target: ImageViewTargetSnapshot,
  label: string,
  seen = new WeakSet<object>(),
): void {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertTargetBoundValue(item, target, label, seen);
    return;
  }
  for (const [key, fieldValue] of Object.entries(value)) {
    if (isPrivateLocationField(key)) {
      throw new Error(`${label} contains a main-process-only project or path field.`);
    }
    const targetField = identityField(key);
    if (targetField && fieldValue !== target[targetField]) {
      throw new Error(`${label} ${key} does not match the captured image view target.`);
    }
    assertTargetBoundValue(fieldValue, target, label, seen);
  }
}

function assertOperationRequest(
  target: ImageViewTargetSnapshot,
  operation: string,
  request: Record<string, unknown>,
  access: ImageViewAccess,
): void {
  if (access !== "read" && access !== "annotate") {
    throw new Error("Invalid image view access capability.");
  }
  if (!READ_OPERATIONS.has(operation) && !(access === "annotate" && operation === "annotate_source")) {
    throw new Error("Operation is not available to an image view.");
  }
  assertTargetBoundValue(request, target, "Image view request");

  if (operation === "result_view") {
    if (!target.resultId || !target.resultRevisionHash || request.result_id !== target.resultId) {
      throw new Error("Result view requires the captured result identity and revision.");
    }
  } else if (request.source_id !== target.sourceId) {
    throw new Error("Image view request source_id does not match the captured target.");
  }

  if (operation === "annotate_source") {
    if (request.source_sha256 !== target.sourceSha256) {
      throw new Error("Annotation source_sha256 does not match the captured target.");
    }
    if (typeof request.expected_revision !== "number" ||
        !Number.isSafeInteger(request.expected_revision) || request.expected_revision < 0) {
      throw new Error("Annotation expected_revision must be a non-negative safe integer.");
    }
  }
}

function assertSnapshotTarget(
  snapshot: ResearchSnapshot,
  target: ImageViewTargetSnapshot,
): void {
  const sources = snapshot.sources.filter((source) => source.id === target.sourceId);
  if (sources.length !== 1 || sources[0].sha256 !== target.sourceSha256 ||
      sources[0].locator_state === "relink-required") {
    throw new Error("Image view source is stale or no longer belongs to the current study.");
  }

  if (target.resultId === null) return;
  const results = snapshot.results.filter((result) => result.id === target.resultId);
  const result = results.length === 1 ? results[0] : null;
  if (!result || result.source_id !== target.sourceId ||
      result.revision_hash !== target.resultRevisionHash ||
      (result.source_sha256 !== undefined && result.source_sha256 !== target.sourceSha256)) {
    throw new Error("Image view result is stale or no longer belongs to the captured source.");
  }
}

/** Main-process-only adapter used by the detached view coordinator. */
export class ResearchViewAccess {
  constructor(private readonly dependencies: ResearchViewAccessDependencies) {}

  async getSnapshot(): Promise<ResearchSnapshot> {
    const document = this.captureDocument();
    const snapshot = await this.dependencies.snapshot(document.project);
    this.assertDocumentCurrent(document);
    return snapshot;
  }

  async execute(
    targetValue: ImageViewTargetSnapshot,
    operationValue: unknown,
    requestValue: unknown,
    options?: unknown,
    access: ImageViewAccess = "read",
    assertTargetCurrent?: () => void,
  ): Promise<unknown> {
    const target = validateTargetSnapshot(targetValue);
    if (assertTargetCurrent !== undefined && typeof assertTargetCurrent !== "function") {
      throw new Error("Image view target assertion must be a function.");
    }
    assertTargetCurrent?.();
    if (typeof operationValue !== "string" || !isPlainRecord(requestValue)) {
      throw new Error("Invalid image view operation.");
    }
    const operation = operationValue;
    const request = requestValue;
    const lane = checkedViewerLane(operation, options);
    assertOperationRequest(target, operation, request, access);
    assertResearchRequestBound(operation, request);

    const document = this.captureDocument();
    const snapshot = await this.dependencies.snapshot(document.project);
    this.assertDocumentCurrent(document);
    assertSnapshotTarget(snapshot, target);
    assertTargetCurrent?.();

    const response = VIEW_OPERATIONS.has(operation)
      ? await this.dependencies.executeViewer(
        document.project,
        operation,
        request,
        lane,
        target.viewId,
      )
      : await this.dependencies.executeControl(document.project, operation, request);
    this.assertDocumentCurrent(document);
    assertTargetCurrent?.();
    assertTargetBoundValue(response, target, "Image view response");
    return response;
  }

  cancel(viewId: string): void {
    assertViewId(viewId);
    this.dependencies.cancelViewerScope(viewId, new Error("Image view cancelled."));
  }

  private captureDocument(): CapturedDocument {
    const state = this.dependencies.documentState();
    if (state.switching) throw new Error("Wait for the study to finish opening.");
    if (!state.project) throw new Error("Create or open a study first.");
    return { project: state.project, epoch: state.epoch };
  }

  private assertDocumentCurrent(captured: CapturedDocument): void {
    const current = this.dependencies.documentState();
    if (current.switching || current.project !== captured.project || current.epoch !== captured.epoch) {
      throw new Error("The study changed while the image view request was running.");
    }
  }
}
