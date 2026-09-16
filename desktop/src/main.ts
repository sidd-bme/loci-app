import { isLociManualLink } from "./main/manual-links";
import { BrowserWindow, Menu, app, dialog, ipcMain, session, shell } from "electron";
import type {
  IpcMainEvent,
  IpcMainInvokeEvent,
  OpenDialogOptions,
  SaveDialogOptions,
} from "electron";
import started from "electron-squirrel-startup";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ResearchBridge } from "./main/research-bridge";
import { correctionOperationIds } from "./main/correction-provenance";

import type {
  AnalysisCorrectionReceipt,
  AnalysisCorrections,
  AnalysisResult,
  AnalysisSettings,
  BatchExportFailure,
  BatchExportReceipt,
  BatchExportSession,
  CellposeProfileId,
  CellposeStatus,
  CellMeasurement,
  DesktopSessionState,
  DurableBatchItemSummary,
  DurableBatchSession,
  DurableBatchSessionState,
  EditableInstanceBoundary,
  ExportOptions,
  ExportReceipt,
  ImportedImage,
  JobSummary,
  ProjectSessionReceipt,
  ProjectSummary,
  RecentProjectSummary,
  SegmentationModelIdentity,
  SegmentationProfile,
  SegmentationProfileProvenance,
  SegmentationSettingDefinition,
  SourcePoint,
  SourceMetadata,
  ViewerExportOptions,
  ViewerExportReceipt,
  WindowPresentationState,
} from "./shared/contracts";
import {
  JOB_EVENT_SCHEMA,
  JOB_SPEC_SCHEMA,
  RESULT_MANIFEST_SCHEMA,
  MAX_PROJECT_SOURCES,
  type JobEvent,
  type JobSpec,
  type JobState,
  type ProjectManifestV1,
  type ResultArtifact,
  type ResultManifest,
  type SourceFingerprint,
} from "./shared/foundation-contracts";
import { validateProjectManifestV1 } from "./shared/foundation-validation";
import {
  assertExportReceiptContained,
  canonicalizeBatchRoot,
  containedBatchDirectoryPath,
  isLociExportBundleDirectory,
  sanitizeBatchFailureMessage,
} from "./main/batch-safety";
import { EngineWorkerClient, sanitizedWorkerErrorMessage } from "./main/worker-client";
import {
  rememberedDialogDirectory,
  rememberDialogDirectory,
} from "./main/dialog-history";
import {
  RelativePathAllocator,
  refreshedSourceGrant,
  type SourceCandidate,
  type SourceGrant,
} from "./main/source-grants";
import { serializeCountSummaryCsv } from "./main/count-csv";
import { DurableOperationTracker } from "./main/durable-operations";
import { ProjectSourceOperationQueue } from "./main/project-source-operations";
import {
  assertRestoredProjectResultBinding,
  selectRestorableProjectResult,
} from "./main/project-result-selection";
import {
  activeProjectModelResults,
  latestActiveProjectResultIds,
  replaceActiveProjectResultBinding,
  retireActiveProjectResultBindings,
  type ActiveProjectResultBinding,
} from "./main/active-project-results";
import { waitForShutdownDecision } from "./main/shutdown";
import {
  QuitProjectSaveCoordinator,
  shouldQuitAfterProjectSave,
  validatedQuitProjectSaveRequestId,
  type QuitProjectSaveOutcome,
} from "./main/quit-project-save";
import { readWindowState, trackWindowState } from "./main/window-state";
import {
  assertCellposeStatusMatches,
  CELLPOSE_MODELS,
  requireCellposeProfileId,
} from "./main/cellpose-models";
import {
  cellposeImportDialogDefaultDirectory,
  openCellposeModelImportDirectory,
} from "./main/cellpose-model-imports";
import {
  resolvedViewerExportTarget,
  suggestedViewerExportFilename,
  validatedViewerExportOptions,
} from "./main/viewer-export";
import {
  createProject,
  discardCreatedProject,
  installProjectPublicationGuard,
  openProject,
  sanitizedProjectSummary,
  saveProject,
  type OpenProjectSession,
  type ProjectSourceLocatorV1,
} from "./main/project-store";
import { RecentProjectRegistry } from "./main/recent-projects";
import {
  JobStore,
  JobStoreCorruptError,
  MAX_DURABLE_JOBS,
  sha256CanonicalJson,
} from "./main/job-store";
import { LocalJobExecutor } from "./main/local-job-executor";
import { isTerminalJobState } from "./shared/job-transitions";
import {
  BatchRunStore,
  BatchRunStoreError,
  sanitizeBatchRunPublicText,
  type BatchRunPlan,
  type BatchRunItem,
  type BatchRunSummary,
} from "./main/batch-run-store";
import { MODEL_EVIDENCE_REGISTRY } from "./shared/model-registry";
import {
  WORKING_RESULT_ARTIFACT_ID,
  WORKING_RESULT_MEDIA_TYPE,
  verifyRestorableProjectWorkingResultArtifact,
  verifyStoredWorkingResultArtifact,
  verifyPublishedWorkingResult,
  type VerifiedWorkingResultPublication,
  type WorkingResultReceipt,
} from "./main/working-result-publication";
import {
  DurableCorrectionFailClosedError,
  DurableCorrectionTransactionError,
  executeDurableCorrectionTransaction,
  runDurableCorrectionOnProjectLane,
} from "./main/durable-correction-transaction";
import {
  openWorkingResultRetentionStore,
  workingResultBatchRecoveryOwnerId,
  type WorkingResultReferenceInput,
  type WorkingResultReferenceKey,
  type WorkingResultRetentionStore,
} from "./main/working-result-retention";
import { projectWorkingResultReferences } from "./main/project-working-result-references";
import {
  ProjectRetentionCheckpointFailClosedError,
  checkpointProjectBeforeRetention,
  restoreProjectAfterRetention,
} from "./main/project-retention-checkpoint";
import { EngineResultResidencyCoordinator } from "./main/engine-result-residency";
import { drainResultRetentionForShutdown } from "./main/result-retention-shutdown";
import {
  assertDurableBatchProjectSources,
  assertBatchChildMatchesParent,
  assertBatchPlanMatchesParent,
  assertBatchPlanMatchesProjectSources,
  frozenBatchCheckpointBindings,
  isBatchLedgerComplete,
  protectCompletedBatchResults,
  releaseCompletedBatchProtection,
} from "./main/batch-recovery";

const ownsSingleInstanceLock = !started && app.requestSingleInstanceLock();
if (!ownsSingleInstanceLock) app.quit();

const engine = new EngineWorkerClient();
const researchBridge = new ResearchBridge();
const engineResultResidency = new EngineResultResidencyCoordinator();
let mainWindow: BrowserWindow | null = null;
const MAX_DISCOVERED_SOURCES = MAX_PROJECT_SOURCES;
const SUPPORTED_EXTENSIONS = new Set([".tif", ".tiff", ".png", ".jpg", ".jpeg", ".ims"]);
const SHUTDOWN_GRACE_MILLISECONDS = 15_000;

interface RawSource {
  path: string;
  name: string;
  width: number;
  height: number;
  channels: number;
  dtype: string;
  format: string;
  page_count: number;
  sha256: string;
  color_model: "intensity" | "interleaved-rgb" | "channel-composite";
  access_mode: "full" | "overview";
  view_only_reason: string | null;
  source_details: {
    kind: "ims-volume";
    width: number;
    height: number;
    depth: number;
    channels: number;
    timepoints: number;
    resolution_levels: number;
    selected_resolution_level: number;
    selected_level_width: number;
    selected_level_height: number;
    selected_level_depth: number;
    selected_timepoint: number;
    selected_z: number;
    sampling_stride: number;
    channel_names: string[];
    channel_dtypes: string[];
    channel_color_sources: string[];
    channel_range_sources: string[];
    composite_mode: "single-channel" | "rgb-components" | "loci-overview-composite";
    rendered_dtype: string;
    physical_extents: Array<[number, number]> | null;
    voxel_size: [number, number, number] | null;
    physical_unit: string | null;
  } | {
    kind: "tiff-pyramid";
    width: number;
    height: number;
    channels: number;
    dtype: string;
    resolution_levels: number;
    selected_resolution_level: number;
    selected_level_width: number;
    selected_level_height: number;
    full_decoded_bytes: number;
    selected_decoded_bytes: number;
    tiled: boolean;
    selected_level_tiled: boolean;
  } | null;
}

interface RawDisplayStatistics {
  histogram_bins: number[];
  percentile_low: number;
  percentile_high: number;
  basis: "luminance" | "intensity";
  sample_count: number;
  display_minimum: number;
  display_maximum: number;
  source_minimum: number;
  source_maximum: number;
}

interface BatchSuccess {
  sourceRelativePath: string;
  outputDirectory: string;
  files: string[];
  cellCount: number;
}

interface BatchSessionRecord {
  batchId: string;
  outputDirectory: string;
  outputDevice: string;
  outputInode: string;
  startedAt: string;
  successes: BatchSuccess[];
  exportOptions: ExportOptions;
  activeExports: Set<Promise<void>>;
  finalizing: boolean;
}

interface ActiveBatchRunRecord {
  batchId: string;
  parentJobId: string;
  projectId: string;
  createdAt: string;
  publicTitle: string;
  profileId: string;
  settings: AnalysisSettings;
  sourceFingerprints: Array<{ sourceId: string; sha256: string }>;
  plan: BatchRunPlan;
}

interface RawExportReceipt {
  directory: string;
  bundle_name?: string;
  files: Record<string, string>;
  cell_count?: number;
}

interface RawBatchMetadataReceipt {
  files: Record<string, string>;
}

interface RawViewerExportReceipt {
  path: string;
  format: "png" | "tiff";
  width: number;
  height: number;
  channels: number;
  dtype: "uint8" | "uint16";
  byte_length: number;
  source_sha256: string;
  output_sha256: string;
  settings: Omit<ViewerExportOptions["settings"], "blackPoint" | "whitePoint"> & {
    black_point: number;
    white_point: number;
  };
}

const sourceGrants = new Map<string, SourceGrant>();
const sourceIdsByPath = new Map<string, string>();
const resultSources = new Map<string, string>();
const resultCounts = new Map<string, number>();
const resultCorrections = new Map<string, AnalysisCorrections>();
const resultWorkingPacks = new Map<string, string>();
const resultWorkingArtifacts = new Map<string, ResultArtifact>();
const activeResultIdsBySourceId = new Map<string, string>();
const sessionRetentionOwnerId = `session-${randomUUID()}`;
const sessionRetentionReferences = new Map<string, WorkingResultReferenceKey>();
const protectedSessionResultIds = new Set<string>();
const batchSessions = new Map<string, BatchSessionRecord>();
const activeBatchRuns = new Map<string, ActiveBatchRunRecord>();
const batchFinalizations = new DurableOperationTracker();
const resultLifecycleOperations = new DurableOperationTracker();
const projectSourceOperations = new ProjectSourceOperationQueue();
let relativePathAllocator = new RelativePathAllocator();
let activeProject: OpenProjectSession | null = null;
const recentProjects = new RecentProjectRegistry();
let jobStore: JobStore;
let localJobExecutor: LocalJobExecutor;
let batchRunStore: BatchRunStore;
let workingResultRetentionStore: WorkingResultRetentionStore;
let activeAnalysisJobId: string | null = null;
let earlyAnalysisCancellationJobId: string | null = null;
let activeBatchRunId: string | null = null;
let preserveSessionWorkingResultsOnShutdown = false;
let rendererSessionState: DesktopSessionState = {
  sourceCount: 0,
  resultCount: 0,
  isRunning: false,
  projectDirty: false,
};
let closePromptOpen = false;
let closeConfirmed = false;
const quitProjectSaveCoordinator = new QuitProjectSaveCoordinator();
installProjectPublicationGuard({
  begin: () => quitProjectSaveCoordinator.cancellationRevision,
  beforeCommit: (revision) => {
    quitProjectSaveCoordinator.claimPublication(revision);
  },
});

function runProjectOperation<T>(start: () => Promise<T>): Promise<T> {
  return projectSourceOperations.runProject(start);
}

function assertProjectOperationIdle(): void {
  if (projectSourceOperations.isProjectBusy) {
    throw new Error("Wait for the current project operation to finish and try again.");
  }
}

function rendererProjectSummary(project: OpenProjectSession): ProjectSummary {
  const summary = sanitizedProjectSummary(project);
  return {
    projectId: summary.projectId,
    title: summary.title,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    appVersion: summary.appVersion,
    revision: summary.revision,
    sourceCount: summary.sources.length,
  };
}

function projectFingerprint(sourceId: string): SourceFingerprint {
  const grant = sourceGrants.get(sourceId);
  return grant?.expectedSha256 && grant.fingerprintVerifiedAt
    ? {
      status: "verified",
      algorithm: "sha256",
      sha256: grant.expectedSha256,
      verifiedAt: grant.fingerprintVerifiedAt,
    }
    : {
      status: "pending",
      algorithm: "sha256",
      sha256: null,
      verifiedAt: null,
    };
}

function preparedProjectManifest(
  value: unknown,
  options: {
    title?: string;
    createdAt?: string;
    activeResultBindings?: ReadonlyMap<string, string>;
  } = {},
): ProjectManifestV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The project snapshot is invalid.");
  }
  const requestedReviews = (value as { reviews?: unknown }).reviews ?? [];
  // Reviews may refer to a result that was completed in the main process after
  // the renderer's last project snapshot. Validate the renderer-owned document
  // without decisions first, then bind decisions to main-authoritative jobs.
  const validated = validateProjectManifestV1({
    ...(value as Record<string, unknown>),
    reviews: [],
  });
  const manifestSourceIds = new Set(validated.sources.map(({ sourceId }) => sourceId));
  if (
    manifestSourceIds.size !== sourceGrants.size ||
    [...sourceGrants.keys()].some((sourceId) => !manifestSourceIds.has(sourceId))
  ) {
    throw new Error("The project snapshot does not match the images in the current session.");
  }
  const embeddedJobs = new Map(validated.jobs.map((job) => [job.spec.jobId, job] as const));
  for (const record of jobStore.list()) {
    if (
      record.spec.inputs.length > 0 &&
      record.spec.inputs.every(({ sourceId }) => manifestSourceIds.has(sourceId))
    ) {
      embeddedJobs.set(record.spec.jobId, {
        spec: record.spec,
        events: record.events,
        result: record.result,
      });
    }
  }
  const jobs = [...embeddedJobs.values()].sort((left, right) =>
    left.spec.createdAt.localeCompare(right.spec.createdAt) ||
    left.spec.jobId.localeCompare(right.spec.jobId));
  const requestedActiveBindings = options.activeResultBindings ?? activeResultIdsBySourceId;
  const activeBindings = new Map(
    [...requestedActiveBindings].filter(([sourceId]) => manifestSourceIds.has(sourceId)),
  );
  const modelResults = activeProjectModelResults(
    jobs,
    activeBindings,
    (modelId) => MODEL_EVIDENCE_REGISTRY.getModel(modelId)?.evidenceStatus ?? "unvalidated",
  );
  const modelResultIds = new Set(modelResults.map(({ resultId }) => resultId));
  const corrections = new Map(
    validated.corrections
      .filter(({ resultId }) => modelResultIds.has(resultId))
      .map((correction) => [correction.resultId, correction] as const),
  );
  for (const [resultId, correction] of resultCorrections) {
    const sourceId = resultSources.get(resultId);
    if (!sourceId || !manifestSourceIds.has(sourceId) || !modelResultIds.has(resultId)) continue;
    if (correction.revision === 0) {
      corrections.delete(resultId);
      continue;
    }
    const artifact = resultWorkingArtifacts.get(resultId);
    if (!artifact) {
      throw new Error("A corrected result is missing its verified working-result artifact.");
    }
    corrections.set(resultId, {
      correctionId: `correction-${createHash("sha256")
        .update(`${resultId}:${correction.revision}`)
        .digest("hex")
        .slice(0, 32)}`,
      sourceId,
      resultId,
      revision: correction.revision,
      operationIds: correction.appliedOperations.flatMap((operation) => {
        const operationId = operation.operation_id;
        return typeof operationId === "string" && operationId ? [operationId] : [];
      }),
      workingResultArtifact: structuredClone(artifact),
    });
  }
  const now = new Date().toISOString();
  return validateProjectManifestV1({
    ...validated,
    title: options.title ?? validated.title,
    createdAt: options.createdAt ?? validated.createdAt,
    updatedAt: now,
    appVersion: app.getVersion(),
    jobs,
    modelResults,
    corrections: [...corrections.values()],
    reviews: Array.isArray(requestedReviews)
      ? requestedReviews.filter((review) => {
        if (!review || typeof review !== "object" || Array.isArray(review)) return true;
        const candidate = review as { sourceId?: unknown; resultId?: unknown };
        if (typeof candidate.sourceId !== "string" || typeof candidate.resultId !== "string") {
          return true;
        }
        return activeBindings.get(candidate.sourceId) === candidate.resultId;
      })
      : requestedReviews,
    sources: validated.sources.map((source) => {
      const grant = requireSourceGrant(source.sourceId);
      const fingerprint = projectFingerprint(source.sourceId);
      return {
        ...source,
        displayName: grant.name,
        relativeLabel: grant.relativePath,
        fingerprint,
        ...(source.inspectionStatus === "ready"
          ? {
            descriptor: {
              ...source.descriptor,
              displayName: grant.name,
              relativeLabel: grant.relativePath,
              fingerprint,
              access: {
                ...source.descriptor.access,
                provisionalUntilFingerprintVerified: fingerprint.status !== "verified",
              },
            },
          }
          : {}),
      };
    }),
  });
}

function currentProjectLocators(manifest: ProjectManifestV1): ProjectSourceLocatorV1[] {
  return manifest.sources.map(({ sourceId }) => ({
    sourceId,
    kind: "local-file" as const,
    platform: process.platform === "win32" ? "win32" as const : "posix" as const,
    canonicalPath: requireSourceGrant(sourceId).path,
  }));
}

function projectReceipt(project: OpenProjectSession): ProjectSessionReceipt {
  return {
    summary: rendererProjectSummary(project),
    manifest: structuredClone(project.document.manifest),
    sources: project.document.manifest.sources.map((source) =>
      mapProjectStub(source, requireSourceGrant(source.sourceId))),
  };
}

async function rememberProjectBestEffort(
  project: OpenProjectSession,
): Promise<RecentProjectSummary[] | undefined> {
  try {
    return await recentProjects.remember(project);
  } catch (error) {
    console.error("Loci could not update its recent-project history.", error);
    return undefined;
  }
}

async function projectReceiptWithRecent(project: OpenProjectSession): Promise<ProjectSessionReceipt> {
  const receipt = projectReceipt(project);
  const updatedRecentProjects = await rememberProjectBestEffort(project);
  return updatedRecentProjects
    ? { ...receipt, recentProjects: updatedRecentProjects }
    : receipt;
}

async function rendererSafeProjectOperation<T>(
  operation: () => Promise<T>,
  fallbackMessage: string,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const originalMessage = error instanceof Error ? error.message : fallbackMessage;
    const sanitizedMessage = sanitizedWorkerErrorMessage(originalMessage);
    if (sanitizedMessage !== originalMessage || sanitizedMessage.includes("<local path>")) {
      console.error(fallbackMessage, error);
      throw new Error(fallbackMessage);
    }
    throw new Error(sanitizedMessage);
  }
}

async function rememberProjectDirectoryBestEffort(directory: string): Promise<void> {
  try {
    await rememberDialogDirectory("import", directory);
  } catch (error) {
    console.error("Loci could not update its project-dialog history.", error);
  }
}

function rendererJobs(): JobSummary[] {
  return jobStore?.listRendererSummaries() ?? [];
}

function notifyJobsChanged(): void {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send("loci:jobs-changed", rendererJobs());
  }
}

async function openDurableJobStore(): Promise<JobStore> {
  const destination = path.join(app.getPath("userData"), "jobs-v1.json");
  let store = new JobStore(destination);
  try {
    await store.open();
    return store;
  } catch (error) {
    if (!(error instanceof JobStoreCorruptError)) throw error;
    const recoveryPath = `${destination}.invalid-${Date.now()}`;
    try {
      await fs.rename(destination, recoveryPath);
    } catch (renameError) {
      if ((renameError as NodeJS.ErrnoException).code !== "ENOENT") throw renameError;
    }
    console.error("Loci preserved an invalid background-job registry for review and started a clean registry.", error);
    store = new JobStore(destination);
    await store.open();
    return store;
  }
}

function jobEvent(
  jobId: string,
  sequence: number,
  state: JobState,
  message: string,
  progress: number | null,
  reasonCode: string | null = null,
): JobEvent {
  return {
    schemaVersion: JOB_EVENT_SCHEMA,
    jobId,
    sequence,
    occurredAt: new Date().toISOString(),
    state,
    progress,
    message,
    reasonCode,
    schedulerState: null,
  };
}

async function appendJobState(
  jobId: string,
  state: JobState,
  message: string,
  progress: number | null,
  options: { reasonCode?: string; result?: ResultManifest } = {},
): Promise<void> {
  const current = jobStore.get(jobId);
  if (!current) return;
  const sequence = current.events.at(-1)!.sequence + 1;
  await jobStore.applyEvent(
    jobEvent(jobId, sequence, state, message, progress, options.reasonCode ?? null),
    randomUUID(),
    options.result,
  );
  notifyJobsChanged();
}

function rendererBatchItem(item: BatchRunItem): DurableBatchItemSummary {
  return {
    sourceId: item.sourceId,
    state: item.state,
    attemptCount: item.attemptCount,
    resultId: item.resultId,
    failureCode: item.failureCode,
    failureSummary: item.failureSummary,
  };
}

function assertBatchPlanMatchesActiveProject(plan: Readonly<BatchRunPlan>): void {
  const project = activeProject;
  if (!project || project.document.manifest.projectId !== plan.projectId) {
    throw new Error("Reopen the exact Loci project that created this batch before continuing.");
  }
  assertBatchPlanMatchesProjectSources(
    plan,
    project.document.manifest.sources.map((source) => ({
      sourceId: source.sourceId,
      relativeLabel: source.relativeLabel,
      fingerprintSha256: source.fingerprint.status === "verified"
        ? source.fingerprint.sha256
        : null,
    })),
  );
}

function requireBatchParent(record: ActiveBatchRunRecord) {
  const parent = jobStore.get(record.parentJobId);
  if (!parent) throw new Error("The durable parent batch specification is unavailable.");
  assertBatchPlanMatchesParent(record.plan, parent.spec);
  return parent;
}

async function openBatchRunBoundToParent(parent: Readonly<JobSpec>) {
  return batchRunStore.open(parent.jobId, (plan) => {
    assertBatchPlanMatchesParent(plan, parent);
  });
}

async function rendererBatchSession(
  record: ActiveBatchRunRecord,
  state: DurableBatchSessionState,
): Promise<DurableBatchSession> {
  requireBatchParent(record);
  const [summary, items] = await Promise.all([
    batchRunStore.summary(record.batchId),
    batchRunStore.list(record.batchId),
  ]);
  return {
    batchId: record.batchId,
    parentJobId: record.parentJobId,
    createdAt: record.createdAt,
    publicTitle: record.publicTitle,
    state,
    profileId: record.profileId,
    settings: structuredClone(record.settings),
    total: summary.total,
    pending: summary.pending,
    running: summary.running,
    completed: summary.completed,
    failed: summary.failed,
    cancelled: summary.cancelled,
    retryable: summary.retryable,
    items: items.map(rendererBatchItem),
  };
}

function batchRecordFromDurableJob(plan: BatchRunPlan): ActiveBatchRunRecord {
  const job = jobStore.get(plan.batchId);
  if (
    !job ||
    job.spec.kind !== "segment" ||
    job.spec.inputs.length < 2 ||
    !job.spec.operation.profileId ||
    !job.spec.operation.settings ||
    job.spec.inputs.some((input) => !input.fingerprintSha256)
  ) {
    throw new Error("This job is not a recoverable Loci batch.");
  }
  assertBatchPlanMatchesParent(plan, job.spec);
  return {
    batchId: plan.batchId,
    parentJobId: job.spec.jobId,
    projectId: plan.projectId,
    createdAt: job.spec.createdAt,
    publicTitle: job.presentation.title,
    profileId: job.spec.operation.profileId,
    settings: structuredClone(job.spec.operation.settings as AnalysisSettings),
    sourceFingerprints: job.spec.inputs.map((input) => ({
      sourceId: input.sourceId,
      sha256: input.fingerprintSha256 as string,
    })),
    plan: structuredClone(plan),
  };
}

async function appendBatchProgress(
  record: ActiveBatchRunRecord,
  publicMessage?: string,
): Promise<BatchRunSummary> {
  const summary = await batchRunStore.summary(record.batchId);
  const terminal = summary.completed + summary.failed + summary.cancelled;
  const progress = summary.total ? Math.min(0.9, terminal / summary.total * 0.9) : 0;
  const message = publicMessage ?? (
    summary.failed > 0
      ? `${terminal.toLocaleString()} of ${summary.total.toLocaleString()} processed; ${summary.failed.toLocaleString()} need review.`
      : `${terminal.toLocaleString()} of ${summary.total.toLocaleString()} processed.`
  );
  await appendJobState(record.parentJobId, "running", message, progress);
  return summary;
}

async function createPrivateWorkingResultDirectory(jobId: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(jobId)) {
    throw new Error("The analysis job identifier cannot be used for private storage.");
  }
  const requestedRoot = path.join(app.getPath("userData"), "working-results");
  await fs.mkdir(requestedRoot, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await fs.chmod(requestedRoot, 0o700);
  const rootStat = await fs.lstat(requestedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("The private working-result location is not a real directory.");
  }
  const root = await fs.realpath(requestedRoot);
  const directory = path.join(root, jobId);
  await fs.mkdir(directory, { mode: 0o700 });
  if (process.platform !== "win32") await fs.chmod(directory, 0o700);
  return directory;
}

function workingResultArtifact(
  verified: VerifiedWorkingResultPublication,
): ResultArtifact {
  return {
    artifactId: WORKING_RESULT_ARTIFACT_ID,
    filename: verified.receipt.pack.basename,
    mediaType: verified.receipt.pack.media_type,
    byteLength: verified.receipt.pack.size_bytes,
    sha256: verified.receipt.pack.sha256,
  };
}

function sessionRetentionKey(resultId: string, revision: number): string {
  return `${resultId}:${revision}`;
}

async function referenceSessionWorkingResult(
  resultId: string,
  revision: number,
  jobId: string,
  artifact: ResultArtifact,
  packPath: string,
): Promise<void> {
  const reference = await workingResultRetentionStore.reference({
    projectId: sessionRetentionOwnerId,
    resultId,
    revision,
    jobId,
    artifact: {
      artifactId: WORKING_RESULT_ARTIFACT_ID,
      filename: artifact.filename,
      mediaType: WORKING_RESULT_MEDIA_TYPE,
      byteLength: artifact.byteLength,
      sha256: artifact.sha256,
    },
    packPath,
  });
  sessionRetentionReferences.set(sessionRetentionKey(resultId, revision), {
    projectId: reference.projectId,
    resultId: reference.resultId,
    revision: reference.revision,
  });
}

async function unreferenceSessionWorkingResult(
  resultId: string,
  revision: number,
): Promise<void> {
  const key = sessionRetentionKey(resultId, revision);
  const reference = sessionRetentionReferences.get(key);
  if (!reference) return;
  await workingResultRetentionStore.unreference(reference);
  sessionRetentionReferences.delete(key);
}

async function unreferenceSessionResult(resultId: string): Promise<void> {
  if (protectedSessionResultIds.has(resultId)) return;
  for (const [key, reference] of [...sessionRetentionReferences]) {
    if (reference.resultId !== resultId) continue;
    await workingResultRetentionStore.unreference(reference);
    sessionRetentionReferences.delete(key);
  }
}

async function releaseSessionWorkingResults(): Promise<void> {
  if (preserveSessionWorkingResultsOnShutdown) {
    console.error(
      "Loci preserved session working-result ownership because a project rollback could not be verified.",
    );
    return;
  }
  for (const [key, reference] of [...sessionRetentionReferences]) {
    if (protectedSessionResultIds.has(reference.resultId)) continue;
    try {
      await workingResultRetentionStore.unreference(reference);
      sessionRetentionReferences.delete(key);
    } catch (error) {
      console.error("Loci could not release a session working-result reference.", error);
    }
  }
}

async function reconcileProjectWorkingResults(manifest: ProjectManifestV1): Promise<void> {
  await workingResultRetentionStore.reconcileProject(
    manifest.projectId,
    projectWorkingResultReferences(
      manifest,
      path.join(app.getPath("userData"), "working-results"),
    ),
  );
}

async function inspectWithDurableJob(
  grant: SourceGrant,
): Promise<ImportedImage> {
  const jobId = randomUUID();
  const createdAt = new Date().toISOString();
  const spec: JobSpec = {
    schemaVersion: JOB_SPEC_SCHEMA,
    jobId,
    kind: "fingerprint",
    createdAt,
    executionTarget: { kind: "local" },
    inputs: [{
      sourceId: grant.sourceId,
      fingerprintSha256: grant.expectedSha256 ?? null,
      byteLength: null,
    }],
    operation: {
      profileId: null,
      modelId: null,
      modelSha256: null,
      settings: null,
    },
    resources: {
      cpuCores: null,
      memoryMiB: null,
      gpuCount: 0,
      walltimeMinutes: null,
    },
    expectedOutputs: [],
  };
  await jobStore.createJob(spec, randomUUID(), { title: "Inspect source" });
  notifyJobsChanged();
  try {
    await appendJobState(jobId, "running", "Reading trusted metadata and a bounded preview.", 0.2);
    const raw = await engine.request<{
      engine_version: string;
      source: RawSource;
      preview_data_url: string;
      display_statistics: RawDisplayStatistics;
    }>("inspect", {
      path: grant.path,
      expected_sha256: grant.expectedSha256,
      max_edge: 1_600,
    });
    if (typeof raw.engine_version !== "string" || !raw.engine_version || raw.engine_version.length > 80) {
      throw new Error("The analysis engine returned invalid version provenance.");
    }
    await appendJobState(jobId, "verifying", "Verifying the source fingerprint.", 0.9);
    const imported = mapImported(raw, grant);
    const resultCreatedAt = new Date().toISOString();
    const result: ResultManifest = {
      schemaVersion: RESULT_MANIFEST_SCHEMA,
      resultManifestId: randomUUID(),
      resultId: `fingerprint-${jobId}`,
      jobId,
      createdAt: resultCreatedAt,
      sourceFingerprints: [{ sourceId: grant.sourceId, sha256: raw.source.sha256 }],
      producer: {
        appVersion: app.getVersion(),
        engineVersion: raw.engine_version,
        modelId: null,
        modelSha256: null,
        settingsSha256: sha256CanonicalJson(null),
      },
      artifacts: [],
      publication: {
        state: "verified",
        atomic: true,
        reason: null,
      },
    };
    await appendJobState(jobId, "completed", "Source ready.", 1, { result });
    return imported;
  } catch (error) {
    await appendJobState(jobId, "failed", "Source inspection failed.", null, {
      reasonCode: "source-inspection-failed",
    }).catch((jobError) => console.error("Loci could not persist a failed source-inspection state.", jobError));
    throw error;
  }
}

async function segmentWithDurableJobOperation(request: {
  sourceId: string;
  settings: AnalysisSettings;
  profileId?: string;
}): Promise<AnalysisResult> {
  if (activeAnalysisJobId) {
    throw new Error("Another analysis is already queued or running.");
  }
  const grant = requireSourceGrant(request.sourceId);
  const profileId = request.profileId ?? "loci-classical";
  const model = MODEL_EVIDENCE_REGISTRY.getModel(profileId);
  if (!model) {
    throw new Error("This analysis profile has no registered model and evidence manifest.");
  }
  const jobId = randomUUID();
  const spec: JobSpec = {
    schemaVersion: JOB_SPEC_SCHEMA,
    jobId,
    kind: "segment",
    createdAt: new Date().toISOString(),
    executionTarget: { kind: "local" },
    inputs: [{
      sourceId: grant.sourceId,
      fingerprintSha256: grant.expectedSha256 ?? null,
      byteLength: null,
    }],
    operation: {
      profileId,
      modelId: model.modelId,
      modelSha256: model.artifact.sha256,
      settings: structuredClone(request.settings),
    },
    resources: {
      cpuCores: null,
      memoryMiB: null,
      gpuCount: 0,
      walltimeMinutes: null,
    },
    expectedOutputs: [{
      artifactId: WORKING_RESULT_ARTIFACT_ID,
      mediaType: WORKING_RESULT_MEDIA_TYPE,
    }],
  };
  activeAnalysisJobId = jobId;
  try {
    const handle = await localJobExecutor.submit<AnalysisResult>({
      spec,
      presentation: { title: `Segment ${grant.name}` },
      interrupt: () => engine.cancelCurrent(),
      run: ({ signal, reportProgress }) => engineResultResidency.runExclusive(async () => {
        let analysis: AnalysisResult | null = null;
        try {
          await reportProgress({ progress: 0.08, message: "Preparing the source and pinned model." });
          const raw = await engine.request<any>(
            "segment",
            {
              path: grant.path,
              expected_sha256: grant.expectedSha256,
              profile_id: profileId,
              settings: request.settings,
            },
            10 * 60_000,
            signal,
          );
          if (signal.aborted) throw signal.reason ?? new Error("The analysis was cancelled.");
          analysis = mapAnalysis(raw, grant);
          if (
            analysis.profile.id !== profileId ||
            analysis.profile.model.sha256?.toLowerCase() !== model.artifact.sha256?.toLowerCase()
          ) {
            throw new Error("The analysis result does not match the frozen model identity.");
          }
          await reportProgress({ progress: 0.78, message: "Publishing a recoverable working result." });
          const directory = await createPrivateWorkingResultDirectory(jobId);
          const published = await engine.request<WorkingResultReceipt>(
            "publish_working_result",
            { result_id: analysis.resultId, directory },
            2 * 60_000,
          );
          if (signal.aborted) throw signal.reason ?? new Error("The analysis was cancelled.");
          const verified = await verifyPublishedWorkingResult(directory, published);
          const artifact = workingResultArtifact(verified);
          resultWorkingPacks.set(analysis.resultId, verified.packPath);
          resultWorkingArtifacts.set(analysis.resultId, artifact);
          await referenceSessionWorkingResult(
            analysis.resultId,
            analysis.corrections.revision,
            jobId,
            artifact,
            verified.packPath,
          );
          await reportProgress({ progress: 0.9, message: "Working result verified and ready for review." });
          const sourceSha256 = grant.expectedSha256;
          if (!sourceSha256 || !/^[0-9a-f]{64}$/.test(sourceSha256)) {
            throw new Error("The analysis source fingerprint was not verified before publication.");
          }
          const resultManifest: ResultManifest = {
            schemaVersion: RESULT_MANIFEST_SCHEMA,
            resultManifestId: randomUUID(),
            resultId: analysis.resultId,
            jobId,
            createdAt: new Date().toISOString(),
            sourceFingerprints: [{
              sourceId: grant.sourceId,
              sha256: sourceSha256,
            }],
            producer: {
              appVersion: app.getVersion(),
              engineVersion: analysis.engine.version,
              modelId: model.modelId,
              modelSha256: model.artifact.sha256,
              settingsSha256: sha256CanonicalJson(spec.operation.settings),
            },
            artifacts: [artifact],
            publication: {
              state: "verified",
              atomic: true,
              reason: null,
            },
          };
          return { value: analysis, resultManifest };
        } catch (error) {
          if (analysis) {
            await unreferenceSessionWorkingResult(
              analysis.resultId,
              analysis.corrections.revision,
            ).catch(() => undefined);
            await discardCachedResult(analysis.resultId);
          }
          throw error;
        }
      }, signal),
    });
    // Cancellation may arrive while submit() is still persisting the staging
    // and queued records, before the executor can find the job. Apply that
    // exact deferred request as soon as registration completes.
    if (earlyAnalysisCancellationJobId === jobId) {
      earlyAnalysisCancellationJobId = null;
      await localJobExecutor.cancel(jobId).catch(() => false);
    }
    const completed = await handle.completion;
    await replaceActiveProjectResultBinding(
      activeResultIdsBySourceId,
      grant.sourceId,
      completed.resultId,
      async (supersededResultId) => {
        await discardCachedResult(supersededResultId);
      },
    );
    return completed;
  } finally {
    if (earlyAnalysisCancellationJobId === jobId) {
      earlyAnalysisCancellationJobId = null;
    }
    if (activeAnalysisJobId === jobId) activeAnalysisJobId = null;
  }
}

async function cancelActiveAnalysisJob(): Promise<boolean> {
  const jobId = activeAnalysisJobId;
  if (!jobId) return false;
  if (await localJobExecutor.cancel(jobId)) return true;
  if (activeAnalysisJobId !== jobId) return false;
  earlyAnalysisCancellationJobId = jobId;
  return true;
}

function segmentWithDurableJob(request: {
  sourceId: string;
  settings: AnalysisSettings;
  profileId?: string;
}): Promise<AnalysisResult> {
  return resultLifecycleOperations.run(() => segmentWithDurableJobOperation(request));
}

async function publishUpdatedWorkingResult(
  resultId: string,
): Promise<VerifiedWorkingResultPublication> {
  const previousPack = resultWorkingPacks.get(resultId);
  if (!previousPack) {
    throw new Error("This result has no durable working copy. Run segmentation again before correcting it.");
  }
  const directory = path.dirname(previousPack);
  const published = await engine.request<WorkingResultReceipt>(
    "publish_working_result",
    { result_id: resultId, directory },
    2 * 60_000,
  );
  const verified = await verifyPublishedWorkingResult(directory, published);
  return verified;
}

async function checkpointActiveProjectCorrection(): Promise<void> {
  if (!activeProject) return;
  const previousProject = activeProject;
  const previousManifest = previousProject.document.manifest;
  const manifest = preparedProjectManifest(previousManifest, {
    createdAt: previousManifest.createdAt,
  });
  await checkpointProjectBeforeRetention({
    persist: async () => {
      const persisted = await saveProject(
        previousProject,
        manifest,
        currentProjectLocators(manifest),
      );
      activeProject = persisted;
      return persisted;
    },
    reconcile: (persisted) =>
      reconcileProjectWorkingResults(persisted.document.manifest),
    rollbackPersistence: async (persisted) => {
      const rolledBack = await saveProject(
        persisted,
        previousManifest,
        currentProjectLocators(previousManifest),
      );
      activeProject = rolledBack;
      return rolledBack;
    },
    reconcilePrevious: (rolledBack) =>
      reconcileProjectWorkingResults(rolledBack.document.manifest),
  });
}

async function checkpointCompletedBatchResults(
  record: ActiveBatchRunRecord,
  items: readonly BatchRunItem[],
): Promise<void> {
  if (!activeProject || activeProject.document.manifest.projectId !== record.projectId) {
    throw new Error("Reopen the exact Loci project that created this batch before finalizing it.");
  }
  const previousProject = activeProject;
  const previousManifest = previousProject.document.manifest;
  const frozenItems = items.map((item) => ({
    ...item,
    createdAt: verifiedResultManifestForBatchItem(
      record,
      item.sourceId,
      item.resultId!,
      item.resultManifestId!,
    ).createdAt,
  }));
  const exactBindings = frozenBatchCheckpointBindings(
    activeResultIdsBySourceId,
    latestActiveProjectResultIds(previousManifest.modelResults),
    new Map(previousManifest.modelResults.map((result) => [result.resultId, result.createdAt])),
    frozenItems,
  );
  const manifest = preparedProjectManifest(previousManifest, {
    createdAt: previousManifest.createdAt,
    activeResultBindings: exactBindings,
  });
  await checkpointProjectBeforeRetention({
    persist: async () => {
      const persisted = await saveProject(
        previousProject,
        manifest,
        currentProjectLocators(manifest),
      );
      activeProject = persisted;
      return persisted;
    },
    reconcile: (persisted) =>
      reconcileProjectWorkingResults(persisted.document.manifest),
    rollbackPersistence: async (persisted) => {
      const rolledBack = await saveProject(
        persisted,
        previousManifest,
        currentProjectLocators(previousManifest),
      );
      activeProject = rolledBack;
      return rolledBack;
    },
    reconcilePrevious: (rolledBack) =>
      reconcileProjectWorkingResults(rolledBack.document.manifest),
  });
  for (const item of items) {
    activeResultIdsBySourceId.set(item.sourceId, item.resultId!);
  }
}

async function restoreExactWorkingRevision(
  sourceId: string,
  resultId: string,
  packPath: string,
  artifact: ResultArtifact,
  expectedCorrections: AnalysisCorrections,
): Promise<void> {
  const grant = requireSourceGrant(sourceId);
  if (!grant.expectedSha256) {
    throw new Error("The source fingerprint is unavailable for correction rollback.");
  }
  await verifyStoredWorkingResultArtifact(packPath, artifact);
  const raw = await engine.request<any>("restore_working_result", {
    pack_path: packPath,
    source_path: grant.path,
    expected_sha256: grant.expectedSha256,
  }, 2 * 60_000);
  const restoredCorrections = mapCorrections(raw?.corrections);
  if (
    raw?.result_id !== resultId ||
    raw?.working_result_pack?.basename !== artifact.filename ||
    raw?.working_result_pack?.sha256 !== artifact.sha256 ||
    raw?.working_result_pack?.size_bytes !== artifact.byteLength ||
    restoredCorrections.revision !== expectedCorrections.revision ||
    JSON.stringify(correctionOperationIds(restoredCorrections)) !==
      JSON.stringify(correctionOperationIds(expectedCorrections))
  ) {
    throw new Error("The previous correction revision could not be restored exactly.");
  }
  const restored = mapAnalysis(raw, grant);
  resultWorkingPacks.set(restored.resultId, packPath);
  resultWorkingArtifacts.set(restored.resultId, structuredClone(artifact));
}

async function restoreDurableResultToEngine(
  sourceId: string,
  resultId: string,
): Promise<void> {
  const grant = requireSourceGrant(sourceId);
  requireResultForSource(resultId, sourceId);
  if (!grant.expectedSha256) {
    throw new Error("The source fingerprint is unavailable for working-result restoration.");
  }
  const packPath = resultWorkingPacks.get(resultId);
  const artifact = resultWorkingArtifacts.get(resultId);
  const expectedCorrections = resultCorrections.get(resultId);
  if (!packPath || !artifact || !expectedCorrections) {
    throw new Error("This result has no verified working copy. Run segmentation again before using it.");
  }

  await verifyStoredWorkingResultArtifact(packPath, artifact);
  const raw = await engine.request<any>("restore_working_result", {
    pack_path: packPath,
    source_path: grant.path,
    expected_sha256: grant.expectedSha256,
  }, 2 * 60_000);
  if (
    raw?.result_id !== resultId ||
    raw?.working_result_pack?.basename !== artifact.filename ||
    raw?.working_result_pack?.sha256 !== artifact.sha256 ||
    raw?.working_result_pack?.size_bytes !== artifact.byteLength
  ) {
    throw new Error("The restored analysis does not match its verified working-result artifact.");
  }
  const restoredCorrections = mapCorrections(raw.corrections);
  if (
    restoredCorrections.revision !== expectedCorrections.revision ||
    JSON.stringify(correctionOperationIds(restoredCorrections)) !==
      JSON.stringify(correctionOperationIds(expectedCorrections))
  ) {
    throw new Error("The restored analysis does not match its verified correction revision.");
  }
  const restored = mapAnalysis(raw, grant);
  if (restored.resultId !== resultId) {
    throw new Error("The restored analysis identity changed unexpectedly.");
  }
  resultWorkingPacks.set(resultId, packPath);
  resultWorkingArtifacts.set(resultId, structuredClone(artifact));
}

function withDurableResult<T>(
  sourceId: string,
  resultId: string,
  operation: () => Promise<T>,
): Promise<T> {
  requireSourceGrant(sourceId);
  requireResultForSource(resultId, sourceId);
  return engineResultResidency.withResidentResult(
    resultId,
    () => restoreDurableResultToEngine(sourceId, resultId),
    operation,
  );
}

const activeCorrectionResults = new Set<string>();

async function applyDurableCorrectionOperation(
  sourceId: string,
  resultId: string,
  method: "delete_instance" | "add_polygon" | "undo_correction" | "redo_correction" |
    "split_instance" | "merge_instances" | "replace_instance_boundary" |
    "paint_stroke" | "erase_stroke" | "move_boundary_vertex",
  params: Record<string, unknown>,
): Promise<AnalysisCorrectionReceipt> {
  requireSourceGrant(sourceId);
  requireResultForSource(resultId, sourceId);
  if (activeCorrectionResults.has(resultId)) {
    throw new Error("Wait for the current correction to finish before editing this result again.");
  }
  activeCorrectionResults.add(resultId);
  try {
    return await withDurableResult(sourceId, resultId, async () => {
      const previousPack = resultWorkingPacks.get(resultId);
      const previousArtifact = resultWorkingArtifacts.get(resultId);
      const previousCorrections = resultCorrections.get(resultId);
      if (!previousPack || !previousArtifact || !previousCorrections) {
        throw new Error("This result has no verified working copy. Run segmentation again before correcting it.");
      }
      const transaction = await executeDurableCorrectionTransaction({
        mutate: () => engine.request<any>(
          method,
          { result_id: resultId, ...params },
          2 * 60_000,
        ),
        publish: async (raw) => {
          const prepared = prepareCorrectionReceipt(raw);
          if (
            prepared.receipt.resultId !== resultId ||
            prepared.evictedResultIds.includes(resultId)
          ) {
            throw new Error("The correction receipt does not match the edited result.");
          }
          const verified = await publishUpdatedWorkingResult(resultId);
          const artifact = workingResultArtifact(verified);
          await referenceSessionWorkingResult(
            resultId,
            prepared.corrections.revision,
            path.basename(path.dirname(verified.packPath)),
            artifact,
            verified.packPath,
          );
          return { prepared, verified, artifact };
        },
        commit: ({ publication }) => {
          commitCorrectionReceipt(publication.prepared);
          resultWorkingPacks.set(resultId, publication.verified.packPath);
          resultWorkingArtifacts.set(resultId, publication.artifact);
          return publication.prepared.receipt;
        },
        checkpoint: async () => {
          await checkpointActiveProjectCorrection();
          if (previousCorrections.revision > 0) {
            await unreferenceSessionWorkingResult(
              resultId,
              previousCorrections.revision,
            ).catch((error) =>
              console.error("Loci could not release a superseded session revision.", error));
          }
        },
        rollback: async ({ publication }) => {
          await restoreExactWorkingRevision(
            sourceId,
            resultId,
            previousPack,
            previousArtifact,
            previousCorrections,
          );
          if (publication) {
            await unreferenceSessionWorkingResult(
              resultId,
              publication.prepared.corrections.revision,
            ).catch((error) =>
              console.error("Loci could not release a rolled-back session revision.", error));
          }
        },
        invalidate: () => discardCachedResult(resultId).then(() => undefined),
      });
      return transaction.commit;
    });
  } catch (error) {
    if (error instanceof DurableCorrectionFailClosedError) {
      throw new Error(
        "The correction could not be saved and the previous verified revision could not be restored. The result was invalidated; run segmentation again.",
        { cause: error },
      );
    }
    if (error instanceof DurableCorrectionTransactionError) {
      throw new Error(
        "The correction was not saved. Loci restored the previous verified revision.",
        { cause: error },
      );
    }
    throw error;
  } finally {
    activeCorrectionResults.delete(resultId);
  }
}

function applyDurableCorrection(
  sourceId: string,
  resultId: string,
  method: "delete_instance" | "add_polygon" | "undo_correction" | "redo_correction" |
    "split_instance" | "merge_instances" | "replace_instance_boundary" |
    "paint_stroke" | "erase_stroke" | "move_boundary_vertex",
  params: Record<string, unknown>,
): Promise<AnalysisCorrectionReceipt> {
  // A correction checkpoint writes the same project revision as explicit and
  // automatic saves. Keep the full correction transaction on the project lane
  // so another save cannot advance activeProject between correction mutation
  // and its fail-closed checkpoint.
  return runDurableCorrectionOnProjectLane(
    projectSourceOperations,
    resultLifecycleOperations,
    () => applyDurableCorrectionOperation(sourceId, resultId, method, params),
  );
}

async function restoreActiveProjectResult(sourceId: string): Promise<AnalysisResult | null> {
  const grant = requireSourceGrant(sourceId);
  if (!activeProject || !grant.expectedSha256) return null;
  const activeResultId = activeResultIdsBySourceId.get(sourceId);
  if (!activeResultId) return null;
  const selected = selectRestorableProjectResult(activeProject.document.manifest, sourceId);
  if (!selected) return null;
  if (selected.modelResult.resultId !== activeResultId) return null;
  const { job, resultManifest, correction, originalArtifact } = selected;
  const correctionRevision = correction?.revision ?? 0;
  const expectedArtifact = correction?.workingResultArtifact ?? originalArtifact;
  const filename = expectedArtifact.filename;
  const directory = path.join(app.getPath("userData"), "working-results", job.spec.jobId);
  const packPath = path.join(directory, filename);
  return engineResultResidency.runExclusive(async () => {
    await verifyRestorableProjectWorkingResultArtifact(packPath, expectedArtifact);
    const raw = await engine.request<any>("restore_working_result", {
      pack_path: packPath,
      source_path: grant.path,
      expected_sha256: grant.expectedSha256,
    }, 2 * 60_000);
    let analysis: AnalysisResult | null = null;
    let statePublished = false;
    try {
      if (
        raw?.result_id !== resultManifest.resultId ||
        raw?.working_result_pack?.basename !== filename ||
        raw?.working_result_pack?.sha256 !== expectedArtifact.sha256 ||
        raw?.working_result_pack?.size_bytes !== expectedArtifact.byteLength
      ) {
        throw new Error("The restored analysis does not match its saved result manifest.");
      }
      const restoredCorrections = mapCorrections(raw.corrections);
      const expectedOperationIds = correction?.operationIds ?? [];
      if (
        restoredCorrections.revision !== correctionRevision ||
        JSON.stringify(correctionOperationIds(restoredCorrections)) !== JSON.stringify(expectedOperationIds)
      ) {
        throw new Error("The restored correction state does not match its saved project revision.");
      }
      // Decode and cross-bind every identity from the immutable pack before it
      // can enter session registries or acquire a retention owner.
      analysis = mapAnalysis(raw, grant, false);
      assertRestoredProjectResultBinding(selected, analysis);
      publishAnalysisState(raw, grant, analysis);
      statePublished = true;
      // Project ownership protects the saved checkpoint; a distinct session
      // reference protects this exact restored revision while it is resident
      // and while a later project checkpoint may replace its active binding.
      await referenceSessionWorkingResult(
        analysis.resultId,
        correctionRevision,
        job.spec.jobId,
        expectedArtifact,
        packPath,
      );
      resultWorkingPacks.set(analysis.resultId, packPath);
      resultWorkingArtifacts.set(analysis.resultId, structuredClone(expectedArtifact));
      return analysis;
    } catch (error) {
      if (statePublished && analysis) {
        await discardCachedResult(analysis.resultId);
      } else if (typeof raw?.result_id === "string" && raw.result_id) {
        await engine.request<{ discarded: boolean }>("discard_result", {
          result_id: raw.result_id,
        }).catch(() => undefined);
        engineResultResidency.discard(raw.result_id);
      }
      throw error;
    }
  });
}

engine.onInvalidated(({ generation, reason }) => {
  // The worker lost only its bounded decoded-array cache. Verified immutable
  // packs and renderer-safe review state remain valid and can be restored.
  engineResultResidency.invalidate();
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send("loci:engine-invalidated", {
      generation,
      message: reason.message,
    });
  }
});

function mapSourceDetails(
  details: NonNullable<RawSource["source_details"]>,
): NonNullable<SourceMetadata["sourceDetails"]> {
  if (details.kind === "tiff-pyramid") {
    return {
      kind: details.kind,
      width: details.width,
      height: details.height,
      channels: details.channels,
      dtype: details.dtype,
      resolutionLevels: details.resolution_levels,
      selectedResolutionLevel: details.selected_resolution_level,
      selectedLevelWidth: details.selected_level_width,
      selectedLevelHeight: details.selected_level_height,
      fullDecodedBytes: details.full_decoded_bytes,
      selectedDecodedBytes: details.selected_decoded_bytes,
      tiled: details.tiled,
      selectedLevelTiled: details.selected_level_tiled,
    };
  }
  return {
    kind: details.kind,
    width: details.width,
    height: details.height,
    depth: details.depth,
    channels: details.channels,
    timepoints: details.timepoints,
    resolutionLevels: details.resolution_levels,
    selectedResolutionLevel: details.selected_resolution_level,
    selectedLevelWidth: details.selected_level_width,
    selectedLevelHeight: details.selected_level_height,
    selectedLevelDepth: details.selected_level_depth,
    selectedTimepoint: details.selected_timepoint,
    selectedZ: details.selected_z,
    samplingStride: details.sampling_stride,
    channelNames: details.channel_names,
    channelDtypes: details.channel_dtypes,
    channelColorSources: details.channel_color_sources,
    channelRangeSources: details.channel_range_sources,
    compositeMode: details.composite_mode,
    renderedDtype: details.rendered_dtype,
    ...(details.physical_extents ? { physicalExtents: details.physical_extents } : {}),
    ...(details.voxel_size ? { voxelSize: details.voxel_size } : {}),
    ...(details.physical_unit ? { physicalUnit: details.physical_unit } : {}),
  };
}

function mapSource(source: RawSource, relativePath: string): SourceMetadata {
  return {
    name: source.name,
    relativePath,
    width: source.width,
    height: source.height,
    channels: source.channels,
    dtype: source.dtype,
    format: source.format,
    pageCount: source.page_count,
    colorModel: source.color_model,
    accessMode: source.access_mode,
    ...(source.view_only_reason ? { viewOnlyReason: source.view_only_reason } : {}),
    ...(source.source_details ? { sourceDetails: mapSourceDetails(source.source_details) } : {}),
  };
}

function markSourceFingerprintVerified(grant: SourceGrant, sha256: string): void {
  const verifiedAt = new Date().toISOString();
  if (grant.expectedSha256 !== sha256 || !grant.fingerprintVerifiedAt) {
    grant.fingerprintVerifiedAt = verifiedAt;
  }
  grant.expectedSha256 = sha256;
  grant.sessionFingerprintVerifiedAt = verifiedAt;
}

function mapImported(
  raw: {
    source: RawSource;
    preview_data_url: string;
    display_statistics: RawDisplayStatistics;
  },
  grant: SourceGrant,
): ImportedImage {
  markSourceFingerprintVerified(grant, raw.source.sha256);
  const source = mapSource(raw.source, grant.relativePath);
  return {
    ...source,
    sourceId: grant.sourceId,
    previewDataUrl: raw.preview_data_url,
    displayStatistics: {
      histogramBins: raw.display_statistics.histogram_bins,
      percentileLow: raw.display_statistics.percentile_low,
      percentileHigh: raw.display_statistics.percentile_high,
      basis: raw.display_statistics.basis,
      sampleCount: raw.display_statistics.sample_count,
      displayMinimum: raw.display_statistics.display_minimum,
      displayMaximum: raw.display_statistics.display_maximum,
      sourceMinimum: raw.display_statistics.source_minimum,
      sourceMaximum: raw.display_statistics.source_maximum,
    },
  };
}

function mapStub(grant: SourceGrant): ImportedImage {
  return {
    sourceId: grant.sourceId,
    name: grant.name,
    relativePath: grant.relativePath,
  };
}

function mapProjectStub(
  source: ProjectManifestV1["sources"][number],
  grant: SourceGrant,
): ImportedImage {
  if (source.inspectionStatus !== "ready") return mapStub(grant);
  const descriptor = source.descriptor;
  const z = descriptor.axes.find((axis) => axis.name === "Z")?.length ?? 1;
  const t = descriptor.axes.find((axis) => axis.name === "T")?.length ?? 1;
  return {
    ...mapStub(grant),
    width: descriptor.dimensions.width,
    height: descriptor.dimensions.height,
    channels: descriptor.channels.length,
    dtype: descriptor.channels[0]?.dtype ?? "unknown",
    format: descriptor.format,
    pageCount: Math.max(1, z * t),
    colorModel: descriptor.colorModel === "unknown" ? undefined : descriptor.colorModel,
    accessMode: descriptor.access.mode,
    viewOnlyReason: descriptor.access.reason ?? undefined,
    restoredDescriptor: structuredClone(descriptor),
  };
}

function mapMeasurement(raw: Record<string, number>): CellMeasurement {
  return {
    cellId: raw.cell_id,
    areaPx: raw.area_px,
    centroidXPx: raw.centroid_x_px,
    centroidYPx: raw.centroid_y_px,
    equivalentDiameterPx: raw.equivalent_diameter_px,
    eccentricity: raw.eccentricity,
  };
}

function mapCorrections(raw: any): AnalysisCorrections {
  if (
    !raw ||
    !Number.isInteger(raw.revision) ||
    raw.revision < 0 ||
    typeof raw.has_manual_edits !== "boolean" ||
    typeof raw.can_undo !== "boolean" ||
    typeof raw.can_redo !== "boolean" ||
    !Array.isArray(raw.applied_operations) ||
    !Array.isArray(raw.events) ||
    !Number.isInteger(raw.event_count) ||
    raw.event_count < raw.events.length ||
    typeof raw.events_truncated !== "boolean"
  ) {
    throw new Error("The analysis engine returned invalid correction provenance.");
  }
  const corrections: AnalysisCorrections = {
    revision: raw.revision,
    hasManualEdits: raw.has_manual_edits,
    canUndo: raw.can_undo,
    canRedo: raw.can_redo,
    appliedOperations: raw.applied_operations,
    events: raw.events,
    eventCount: raw.event_count,
    eventsTruncated: raw.events_truncated,
  };
  correctionOperationIds(corrections);
  return corrections;
}

function mapModelIdentity(raw: any): SegmentationModelIdentity {
  if (
    !raw ||
    !["builtin-algorithm", "cellpose-native", "onnx"].includes(raw.format) ||
    (raw.artifact_id !== null && typeof raw.artifact_id !== "string") ||
    (raw.sha256 !== null && typeof raw.sha256 !== "string")
  ) {
    throw new Error("The analysis engine returned an invalid model identity.");
  }
  return {
    format: raw.format,
    artifactId: raw.artifact_id,
    sha256: raw.sha256,
  };
}

function mapProfileProvenance(raw: any): SegmentationProfileProvenance {
  const preprocessing = raw?.preprocessing;
  if (
    !raw ||
    typeof raw.id !== "string" ||
    typeof raw.name !== "string" ||
    typeof raw.version !== "string" ||
    !["classical", "cellpose", "onnx"].includes(raw.backend_kind) ||
    !preprocessing ||
    !["grayscale-luminance", "rgb-or-replicated-grayscale"].includes(preprocessing.channel_conversion) ||
    !["per-image-percentile-1-99", "cellpose-configurable-percentile"].includes(preprocessing.intensity_normalization) ||
    !["none", "downsample-only"].includes(preprocessing.resize_policy) ||
    !(
      (preprocessing.resize_policy === "none" && preprocessing.max_edge_px === null) ||
      (preprocessing.resize_policy === "downsample-only" &&
        Number.isInteger(preprocessing.max_edge_px) &&
        preprocessing.max_edge_px >= 64 &&
        preprocessing.max_edge_px <= 10_000)
    ) ||
    preprocessing.output_grid !== "source-resolution"
  ) {
    throw new Error("The analysis engine returned invalid profile provenance.");
  }
  return {
    id: raw.id,
    name: raw.name,
    version: raw.version,
    backendKind: raw.backend_kind,
    model: mapModelIdentity(raw.model),
    preprocessing: {
      channelConversion: preprocessing.channel_conversion,
      intensityNormalization: preprocessing.intensity_normalization,
      resizePolicy: preprocessing.resize_policy,
      maxEdgePx: preprocessing.max_edge_px,
      outputGrid: preprocessing.output_grid,
    },
  };
}

function mapSettingDefinition(raw: any): SegmentationSettingDefinition {
  if (
    !raw ||
    typeof raw.key !== "string" ||
    typeof raw.label !== "string" ||
    typeof raw.section !== "string" ||
    !["boolean", "integer", "number", "choice"].includes(raw.value_type) ||
    typeof raw.help !== "string" ||
    (raw.minimum !== null && typeof raw.minimum !== "number") ||
    (raw.maximum !== null && typeof raw.maximum !== "number") ||
    (raw.step !== null && typeof raw.step !== "number") ||
    !Array.isArray(raw.choices) ||
    raw.choices.some((choice: unknown) => typeof choice !== "string")
  ) {
    throw new Error("The analysis engine returned an invalid settings contract.");
  }
  return {
    key: raw.key,
    label: raw.label,
    section: raw.section,
    valueType: raw.value_type,
    help: raw.help,
    minimum: raw.minimum,
    maximum: raw.maximum,
    step: raw.step,
    choices: raw.choices,
  };
}

function mapProfile(raw: any): SegmentationProfile {
  const provenance = mapProfileProvenance(raw);
  const failureModes = raw?.validation?.failure_modes;
  if (
    typeof raw.schema_version !== "string" ||
    !["ready", "unavailable", "validation_failed"].includes(raw.status) ||
    !raw.availability ||
    typeof raw.availability.code !== "string" ||
    typeof raw.availability.summary !== "string" ||
    !raw.rights ||
    typeof raw.rights.code_license !== "string" ||
    typeof raw.rights.model_license !== "string" ||
    !["bundled", "permitted", "not_permitted", "unknown"].includes(raw.rights.redistribution) ||
    !["permitted", "restricted", "not_permitted", "not_applicable", "unknown"].includes(raw.rights.commercial_use) ||
    typeof raw.rights.training_data_lineage !== "string" ||
    !raw.recommended_settings ||
    !Array.isArray(raw.settings_contract) ||
    !raw.validation ||
    !["baseline", "validated", "limited", "unvalidated"].includes(raw.validation.status) ||
    typeof raw.validation.summary !== "string" ||
    !Array.isArray(failureModes) ||
    failureModes.some((failure: any) =>
      !failure || typeof failure.code !== "string" || typeof failure.summary !== "string")
  ) {
    throw new Error("The analysis engine returned an invalid profile descriptor.");
  }
  return {
    ...provenance,
    schemaVersion: raw.schema_version,
    status: raw.status,
    availability: {
      code: raw.availability.code,
      summary: raw.availability.summary,
    },
    rights: {
      codeLicense: raw.rights.code_license,
      modelLicense: raw.rights.model_license,
      redistribution: raw.rights.redistribution,
      commercialUse: raw.rights.commercial_use,
      trainingDataLineage: raw.rights.training_data_lineage,
    },
    recommendedSettings: raw.recommended_settings,
    settingsContract: raw.settings_contract.map(mapSettingDefinition),
    validation: {
      status: raw.validation.status,
      summary: raw.validation.summary,
      failureModes: failureModes.map((failure: any) => ({
        code: failure.code,
        summary: failure.summary,
      })),
    },
  };
}

function publishAnalysisState(
  raw: any,
  grant: SourceGrant,
  analysis: AnalysisResult,
): void {
  engineResultResidency.observe(raw.result_id, raw.evicted_result_ids);
  markSourceFingerprintVerified(grant, raw.source.sha256);
  resultSources.set(analysis.resultId, grant.sourceId);
  resultCounts.set(analysis.resultId, analysis.metrics.count);
  resultCorrections.set(analysis.resultId, structuredClone(analysis.corrections));
}

function mapAnalysis(
  raw: any,
  grant: SourceGrant,
  publishState = true,
): AnalysisResult {
  const corrections = mapCorrections(raw.corrections);
  const runtime = raw.runtime ? {
    package: {
      name: String(raw.runtime.package?.name ?? "cellpose"),
      version: String(raw.runtime.package?.version ?? raw.profile.version),
    },
    model: {
      artifactId: String(raw.runtime.model?.artifact_id ?? raw.profile.model.artifact_id),
      sha256: String(raw.runtime.model?.sha256 ?? raw.profile.model.sha256),
    },
    requestedDevice: raw.runtime.requested_device,
    resolvedDevice: raw.runtime.resolved_device,
    fallbackReason: typeof raw.runtime.fallback_reason === "string"
      ? raw.runtime.fallback_reason
      : null,
    inferenceScale: Number(raw.runtime.inference_scale),
  } : undefined;
  const analysis: AnalysisResult = {
    resultId: raw.result_id,
    // Engine LRU eviction releases only decoded arrays. The verified durable
    // result remains reviewable and is restored on demand before export/edit.
    evictedResultIds: [],
    source: mapSource(raw.source, grant.relativePath),
    engine: raw.engine,
    profile: mapProfileProvenance(raw.profile),
    settings: raw.settings,
    resolved: raw.resolved,
    ...(runtime ? { runtime } : {}),
    metrics: {
      count: raw.metrics.count,
      confluencePercent: raw.metrics.confluence_percent,
    },
    quality: raw.quality,
    measurements: raw.measurements.map(mapMeasurement),
    corrections: structuredClone(corrections),
    previewDataUrl: raw.preview_data_url,
    overlayDataUrl: raw.overlay_data_url,
  };
  // Restore can postpone this publication until the decoded pack has been
  // cross-bound to the exact project producer record.
  if (publishState) publishAnalysisState(raw, grant, analysis);
  return analysis;
}

function mapEditableInstanceBoundary(
  raw: unknown,
  expectedResultId: string,
): EditableInstanceBoundary {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("The analysis engine returned an invalid editable boundary.");
  }
  const record = raw as Record<string, unknown>;
  const expectedKeys = new Set([
    "result_id",
    "cell_id",
    "source_coordinate",
    "vertices",
    "simplified",
  ]);
  if (
    Object.keys(record).some((key) => !expectedKeys.has(key)) ||
    Object.keys(record).length !== expectedKeys.size ||
    record.result_id !== expectedResultId ||
    !Number.isSafeInteger(record.cell_id) ||
    (record.cell_id as number) < 1 ||
    typeof record.simplified !== "boolean" ||
    !Array.isArray(record.vertices) ||
    record.vertices.length < 3 ||
    record.vertices.length > 96
  ) {
    throw new Error("The analysis engine returned an invalid editable boundary.");
  }
  const point = (value: unknown): SourcePoint => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("The analysis engine returned an invalid boundary coordinate.");
    }
    const candidate = value as Record<string, unknown>;
    if (
      Object.keys(candidate).length !== 2 ||
      !("x" in candidate) ||
      !("y" in candidate) ||
      typeof candidate.x !== "number" ||
      typeof candidate.y !== "number" ||
      !Number.isFinite(candidate.x) ||
      !Number.isFinite(candidate.y) ||
      candidate.x < 0 ||
      candidate.y < 0
    ) {
      throw new Error("The analysis engine returned an invalid boundary coordinate.");
    }
    return { x: candidate.x, y: candidate.y };
  };
  return {
    resultId: expectedResultId,
    cellId: record.cell_id as number,
    sourceCoordinate: point(record.source_coordinate),
    vertices: record.vertices.map(point),
    simplified: record.simplified,
  };
}

interface PreparedCorrectionReceipt {
  receipt: AnalysisCorrectionReceipt;
  corrections: AnalysisCorrections;
  evictedResultIds: string[];
}

function prepareCorrectionReceipt(raw: any): PreparedCorrectionReceipt {
  if (typeof raw?.result_id !== "string" || !raw.result_id) {
    throw new Error("The analysis engine returned an invalid correction receipt.");
  }
  const evictedResultIds = Array.isArray(raw.evicted_result_ids)
    ? raw.evicted_result_ids.filter((value: unknown): value is string =>
        typeof value === "string" && /^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,127}$/.test(value))
    : [];
  if (evictedResultIds.length !== (Array.isArray(raw.evicted_result_ids) ? raw.evicted_result_ids.length : 0)) {
    throw new Error("The analysis engine returned invalid result eviction provenance.");
  }
  const corrections = mapCorrections(raw.corrections);
  const prepared: PreparedCorrectionReceipt = {
    corrections,
    evictedResultIds,
    receipt: {
      resultId: raw.result_id,
      evictedResultIds: [],
      metrics: {
        count: raw.metrics.count,
        confluencePercent: raw.metrics.confluence_percent,
      },
      quality: raw.quality,
      measurements: raw.measurements.map(mapMeasurement),
      corrections: structuredClone(corrections),
      overlayDataUrl: raw.overlay_data_url,
    },
  };
  engineResultResidency.observe(raw.result_id, evictedResultIds);
  return prepared;
}

function commitCorrectionReceipt(prepared: PreparedCorrectionReceipt): void {
  resultCounts.set(prepared.receipt.resultId, prepared.receipt.metrics.count);
  resultCorrections.set(prepared.receipt.resultId, structuredClone(prepared.corrections));
}

function mapExportReceipt(raw: RawExportReceipt): ExportReceipt {
  return {
    directory: raw.directory,
    bundleName: raw.bundle_name,
    files: raw.files,
    cellCount: raw.cell_count,
  };
}

function mapViewerExportReceipt(
  raw: RawViewerExportReceipt,
  expectedPath: string,
): ViewerExportReceipt {
  if (
    !raw ||
    raw.path !== expectedPath ||
    !["png", "tiff"].includes(raw.format) ||
    !Number.isInteger(raw.width) ||
    raw.width < 1 ||
    !Number.isInteger(raw.height) ||
    raw.height < 1 ||
    ![1, 3, 4].includes(raw.channels) ||
    !["uint8", "uint16"].includes(raw.dtype) ||
    !Number.isInteger(raw.byte_length) ||
    raw.byte_length < 1 ||
    !/^[0-9a-f]{64}$/.test(raw.source_sha256) ||
    !/^[0-9a-f]{64}$/.test(raw.output_sha256)
  ) {
    throw new Error("The image engine returned an invalid viewer export receipt.");
  }
  const { black_point, white_point, ...commonSettings } = raw.settings;
  const settings = validatedViewerExportOptions({
    format: raw.format,
    settings: {
      ...commonSettings,
      blackPoint: black_point,
      whitePoint: white_point,
    },
  }).settings;
  return {
    path: raw.path,
    format: raw.format,
    width: raw.width,
    height: raw.height,
    channels: raw.channels,
    dtype: raw.dtype,
    byteLength: raw.byte_length,
    sourceSha256: raw.source_sha256,
    outputSha256: raw.output_sha256,
    settings,
  };
}

function mapCellposeStatus(raw: any, expectedProfileId: CellposeProfileId): CellposeStatus {
  if (
    !raw ||
    typeof raw.profile_id !== "string" ||
    typeof raw.ready !== "boolean" ||
    typeof raw.code !== "string" ||
    typeof raw.summary !== "string" ||
    !raw.package ||
    typeof raw.package.required_version !== "string" ||
    (raw.package.installed_version !== null && typeof raw.package.installed_version !== "string") ||
    typeof raw.package.exact !== "boolean" ||
    !raw.model ||
    typeof raw.model.artifact_id !== "string" ||
    typeof raw.model.expected_sha256 !== "string" ||
    !Number.isInteger(raw.model.expected_size_bytes) ||
    typeof raw.model.present !== "boolean" ||
    typeof raw.model.verified !== "boolean" ||
    !raw.devices
  ) {
    throw new Error("The Cellpose runtime returned an invalid status record.");
  }
  const deviceValue = (value: unknown): boolean | null =>
    typeof value === "boolean" ? value : null;
  const profileId = requireCellposeProfileId(raw.profile_id);
  assertCellposeStatusMatches(expectedProfileId, profileId, raw.model.artifact_id);
  return {
    profileId,
    ready: raw.ready,
    code: raw.code,
    summary: raw.summary,
    package: {
      requiredVersion: raw.package.required_version,
      installedVersion: raw.package.installed_version,
      exact: raw.package.exact,
    },
    model: {
      artifactId: raw.model.artifact_id,
      expectedSha256: raw.model.expected_sha256,
      expectedSizeBytes: raw.model.expected_size_bytes,
      present: raw.model.present,
      verified: raw.model.verified,
    },
    devices: {
      cpu: deviceValue(raw.devices.cpu),
      mps: deviceValue(raw.devices.mps),
      cuda: deviceValue(raw.devices.cuda),
    },
  };
}

function assertTrustedSender(event: IpcMainInvokeEvent | IpcMainEvent): void {
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== mainWindow.webContents.mainFrame
  ) {
    throw new Error("This request did not come from the active Loci window.");
  }
}

function currentWindowPresentation(window = mainWindow): WindowPresentationState {
  return {
    fullscreen: Boolean(window && !window.isDestroyed() && window.isFullScreen()),
    maximized: Boolean(window && !window.isDestroyed() && window.isMaximized()),
  };
}

function validatedSessionState(value: unknown): DesktopSessionState {
  const candidate = value as Partial<DesktopSessionState> | null;
  if (
    !candidate ||
    !Number.isInteger(candidate.sourceCount) ||
    !Number.isInteger(candidate.resultCount) ||
    candidate.sourceCount! < 0 ||
    candidate.sourceCount! > MAX_DISCOVERED_SOURCES ||
    candidate.resultCount! < 0 ||
    candidate.resultCount! > MAX_DISCOVERED_SOURCES ||
    typeof candidate.isRunning !== "boolean" ||
    typeof candidate.projectDirty !== "boolean"
  ) {
    throw new Error("The renderer session state is invalid.");
  }
  return {
    sourceCount: candidate.sourceCount!,
    resultCount: candidate.resultCount!,
    isRunning: candidate.isRunning,
    projectDirty: candidate.projectDirty,
  };
}

function validatedExportOptions(value: unknown): ExportOptions {
  const candidate = value as Partial<ExportOptions> | null;
  const keys: Array<keyof ExportOptions> = [
    "overlayPng",
    "labelsTiff",
    "measurementsCsv",
    "summaryCsv",
    "analysisJson",
  ];
  if (
    !candidate ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    Object.keys(candidate).some((key) => !keys.includes(key as keyof ExportOptions)) ||
    keys.some((key) => typeof candidate[key] !== "boolean")
  ) {
    throw new Error("The export selection is invalid.");
  }
  const options = Object.fromEntries(keys.map((key) => [key, candidate[key]])) as unknown as ExportOptions;
  if (!Object.values(options).some(Boolean)) {
    throw new Error("Choose at least one export artifact.");
  }
  return options;
}

function engineExportOptions(
  options: ExportOptions,
  { batch = false }: { batch?: boolean } = {},
): Record<string, boolean> {
  return {
    overlay_png: options.overlayPng,
    labels_tiff: options.labelsTiff,
    measurements_csv: options.measurementsCsv,
    summary_csv: batch ? false : options.summaryCsv,
    analysis_json: options.analysisJson,
  };
}

async function discardCachedResult(resultId: string): Promise<boolean> {
  try {
    const result = await engine.request<{ discarded: boolean }>("discard_result", {
      result_id: resultId,
    });
    return Boolean(result?.discarded);
  } catch (error) {
    console.warn("Loci could not eagerly release an expired cached result.", error);
    return false;
  } finally {
    engineResultResidency.discard(resultId);
    await unreferenceSessionResult(resultId).catch((retentionError) =>
      console.error("Loci could not release a discarded session result.", retentionError));
    resultSources.delete(resultId);
    resultCounts.delete(resultId);
    resultCorrections.delete(resultId);
    resultWorkingPacks.delete(resultId);
    resultWorkingArtifacts.delete(resultId);
  }
}

async function retireProjectResults(
  requestedBindings: readonly ActiveProjectResultBinding[],
): Promise<ActiveProjectResultBinding[]> {
  const bindings = requestedBindings.map(({ sourceId, resultId }) => ({ sourceId, resultId }));
  const sourceIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const binding of bindings) {
    requireSourceGrant(binding.sourceId);
    if (
      !binding.resultId ||
      sourceIds.has(binding.sourceId) ||
      resultIds.has(binding.resultId)
    ) {
      throw new Error("The result-clear request is invalid or contains duplicate bindings.");
    }
    sourceIds.add(binding.sourceId);
    resultIds.add(binding.resultId);
  }
  if (!bindings.length) return [];

  const previousProject = activeProject;
  await retireActiveProjectResultBindings(
    activeResultIdsBySourceId,
    bindings,
    async () => {
      if (!previousProject) return;
      const previousManifest = previousProject.document.manifest;
      const manifest = preparedProjectManifest(previousManifest, {
        createdAt: previousManifest.createdAt,
      });
      try {
        await checkpointProjectBeforeRetention({
          persist: async () => {
            const persisted = await saveProject(
              previousProject,
              manifest,
              currentProjectLocators(manifest),
            );
            activeProject = persisted;
            return persisted;
          },
          reconcile: (persisted) =>
            reconcileProjectWorkingResults(persisted.document.manifest),
          rollbackPersistence: async (persisted) => {
            const rolledBack = await saveProject(
              persisted,
              previousManifest,
              currentProjectLocators(previousManifest),
            );
            activeProject = rolledBack;
            return rolledBack;
          },
          reconcilePrevious: (rolledBack) =>
            reconcileProjectWorkingResults(rolledBack.document.manifest),
        });
      } catch (error) {
        // The binding helper restores every active result. Preserve whichever
        // project session the checkpoint established: the original session on
        // persistence failure, or the newer rollback revision after a
        // successful compensating write. Reverting to `previousProject` here
        // would leave an obsolete persistence token and make the next save
        // conflict with the rollback revision already on disk.
        if (error instanceof ProjectRetentionCheckpointFailClosedError) {
          preserveSessionWorkingResultsOnShutdown = true;
        }
        throw new Error(
          error instanceof ProjectRetentionCheckpointFailClosedError
            ? "Loci could not verify the project rollback. The previous result remains in this session; save the project again before closing."
            : "The result was not cleared because Loci could not save the project. The previous result remains active.",
          { cause: error },
        );
      }
    },
  );

  for (const { resultId } of bindings) await discardCachedResult(resultId);
  return bindings;
}

async function removeSourceGrant(sourceId: string): Promise<boolean> {
  const grant = requireSourceGrant(sourceId);
  const resultIds = [...resultSources]
    .filter(([, mappedSourceId]) => mappedSourceId === sourceId)
    .map(([resultId]) => resultId);
  for (const resultId of resultIds) await discardCachedResult(resultId);
  activeResultIdsBySourceId.delete(sourceId);
  sourceGrants.delete(sourceId);
  if (sourceIdsByPath.get(grant.path) === sourceId) sourceIdsByPath.delete(grant.path);
  return true;
}

function isSupportedImage(filePath: string): boolean {
  return SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function portableRelativePath(value: string): string {
  return value.split(path.sep).join("/");
}

class PublicSourceCollectionError extends Error {}

function sourceCollectionFailure(error: unknown): never {
  if (error instanceof PublicSourceCollectionError) throw error;
  console.error("Loci could not read a selected source path.", error);
  throw new PublicSourceCollectionError(
    "Loci could not read one or more selected images. Check that they still exist and that macOS has granted folder access.",
  );
}

async function collectFolder(rootPath: string): Promise<SourceCandidate[]> {
  try {
    const canonicalRoot = await fs.realpath(rootPath);
    const rootStat = await fs.stat(canonicalRoot);
    if (!rootStat.isDirectory()) {
      throw new PublicSourceCollectionError("The selected folder is no longer available.");
    }
    const rootLabel = path.basename(canonicalRoot);
    if (await isLociExportBundleDirectory(canonicalRoot)) return [];
    const candidates: SourceCandidate[] = [];

    const visit = async (directory: string): Promise<void> => {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => {
        const localized = left.name.localeCompare(right.name, "en-US", { numeric: true });
        if (localized !== 0) return localized;
        return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
      });
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name.startsWith("._") || entry.isSymbolicLink()) continue;
        const candidatePath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!(await isLociExportBundleDirectory(candidatePath))) await visit(candidatePath);
        } else if (entry.isFile() && isSupportedImage(candidatePath)) {
          const relativeFromRoot = path.relative(canonicalRoot, candidatePath);
          candidates.push({
            path: candidatePath,
            relativePath: portableRelativePath(path.join(rootLabel, relativeFromRoot)),
          });
          if (candidates.length > MAX_DISCOVERED_SOURCES) {
            throw new PublicSourceCollectionError(`This folder contains more than ${MAX_DISCOVERED_SOURCES.toLocaleString()} supported images. Choose a smaller folder.`);
          }
        }
      }
    };

    await visit(canonicalRoot);
    return candidates;
  } catch (error) {
    return sourceCollectionFailure(error);
  }
}

async function collectSelections(paths: string[], recursiveDirectories: boolean): Promise<SourceCandidate[]> {
  if (
    !Array.isArray(paths) ||
    paths.length === 0 ||
    paths.length > MAX_DISCOVERED_SOURCES ||
    paths.some((value) => typeof value !== "string" || !value)
  ) {
    throw new Error("The image selection is invalid or too large.");
  }

  try {
    const collected: SourceCandidate[] = [];
    for (const selectedPath of paths) {
      const canonicalPath = await fs.realpath(selectedPath);
      const stat = await fs.stat(canonicalPath);
      if (stat.isDirectory()) {
        if (!recursiveDirectories) {
          throw new PublicSourceCollectionError("Choose images here, or use Import Folder for recursive processing.");
        }
        collected.push(...await collectFolder(canonicalPath));
      } else if (stat.isFile()) {
        if (!isSupportedImage(canonicalPath)) {
          throw new PublicSourceCollectionError(`Unsupported image extension: ${path.extname(canonicalPath) || "none"}. Use TIFF, PNG, JPG, JPEG, or modern IMS.`);
        }
        collected.push({ path: canonicalPath, relativePath: path.basename(canonicalPath) });
      }
      if (collected.length > MAX_DISCOVERED_SOURCES) {
        throw new PublicSourceCollectionError(`Select no more than ${MAX_DISCOVERED_SOURCES.toLocaleString()} supported images at once.`);
      }
    }

    const deduplicated = new Map<string, SourceCandidate>();
    for (const candidate of collected) {
      if (!deduplicated.has(candidate.path)) deduplicated.set(candidate.path, candidate);
    }
    return [...deduplicated.values()];
  } catch (error) {
    return sourceCollectionFailure(error);
  }
}

function grantCandidates(candidates: SourceCandidate[]): ImportedImage[] {
  const newPaths = new Set(
    candidates
      .map((candidate) => candidate.path)
      .filter((candidatePath) => !sourceIdsByPath.has(candidatePath)),
  );
  if (sourceGrants.size + newPaths.size > MAX_DISCOVERED_SOURCES) {
    throw new Error(
      `This session supports up to ${MAX_DISCOVERED_SOURCES.toLocaleString()} imported images. ` +
      "Close and reopen Loci to begin a new session.",
    );
  }

  return candidates.map((candidate) => {
    const existingId = sourceIdsByPath.get(candidate.path);
    const relativePath = relativePathAllocator.reserve(
      portableRelativePath(candidate.relativePath),
      candidate.path,
    );
    const grant = refreshedSourceGrant(
      { ...candidate, relativePath },
      existingId,
      randomUUID,
    );
    if (existingId) {
      for (const [resultId, resultSourceId] of resultSources) {
        if (resultSourceId === existingId) {
          engineResultResidency.discard(resultId);
          resultSources.delete(resultId);
          resultCounts.delete(resultId);
          resultCorrections.delete(resultId);
          resultWorkingPacks.delete(resultId);
          resultWorkingArtifacts.delete(resultId);
        }
      }
    }
    sourceIdsByPath.set(candidate.path, grant.sourceId);
    sourceGrants.set(grant.sourceId, grant);
    return mapStub(grant);
  });
}

async function pickImages(): Promise<ImportedImage[]> {
  const defaultPath = await rememberedDialogDirectory("import");
  const options: OpenDialogOptions = {
    title: "Import microscopy images",
    buttonLabel: "Import",
    ...(defaultPath ? { defaultPath } : {}),
    // The native macOS 26 picker exposed supported JPEGs as disabled when an
    // Electron extension filter was present. Keep the authoritative type check
    // in the read-only engine on macOS; retain the convenient picker filter on
    // Windows and Linux.
    ...(process.platform === "darwin"
      ? {}
      : {
          filters: [
            {
              name: "Microscopy images",
              extensions: ["tif", "tiff", "png", "jpg", "jpeg", "ims"],
            },
          ],
        }),
    properties: ["openFile", "multiSelections"],
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths.length) return [];
  await rememberDialogDirectory("import", path.dirname(result.filePaths[0]));
  return grantCandidates(await collectSelections(result.filePaths, false));
}

async function pickFolder(): Promise<ImportedImage[]> {
  const defaultPath = await rememberedDialogDirectory("import");
  const options: OpenDialogOptions = {
    title: "Import an image folder recursively",
    buttonLabel: "Import folder",
    ...(defaultPath ? { defaultPath } : {}),
    properties: ["openDirectory"],
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled) return [];
  await rememberDialogDirectory("import", result.filePaths[0]);
  const candidates = await collectSelections(result.filePaths, true);
  if (!candidates.length) {
    throw new Error("No supported TIFF, PNG, JPG, JPEG, or modern IMS images were found in that folder or its subfolders.");
  }
  return grantCandidates(candidates);
}

async function confirmProjectReplacement(): Promise<boolean> {
  if (sourceGrants.size === 0) return true;
  if (rendererSessionState.isRunning || batchSessions.size > 0) {
    throw new Error("Wait for the current analysis or export to finish before opening a project.");
  }
  const options = {
    type: "question" as const,
    title: "Open another project?",
    message: "Replace the current Loci session?",
    detail:
      `${sourceGrants.size.toLocaleString()} open image${sourceGrants.size === 1 ? "" : "s"} will be removed from this session. ` +
      "Source files remain unchanged.",
    buttons: ["Open Project", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
  const result = mainWindow
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options);
  return result.response === 0;
}

async function confirmDiscardUnsavedProject(): Promise<boolean> {
  const options = {
    type: "warning" as const,
    title: "Unsaved project changes",
    message: "Loci could not save the latest project changes.",
    detail:
      "Opening another project will discard the unsaved changes in this session. " +
      "The project file and source images on disk will not be changed.",
    buttons: ["Keep working", "Discard and open"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const result = mainWindow
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options);
  return result.response === 1;
}

async function clearProjectSession(): Promise<void> {
  for (const resultId of [...resultSources.keys()]) await discardCachedResult(resultId);
  sourceGrants.clear();
  sourceIdsByPath.clear();
  resultSources.clear();
  resultCounts.clear();
  resultCorrections.clear();
  resultWorkingPacks.clear();
  resultWorkingArtifacts.clear();
  activeResultIdsBySourceId.clear();
  relativePathAllocator = new RelativePathAllocator();
  activeProject = null;
}

async function restoreProjectSession(project: OpenProjectSession): Promise<ProjectSessionReceipt> {
  const expectedPlatform = process.platform === "win32" ? "win32" : "posix";
  const prepared: SourceGrant[] = [];
  const restoredCanonicalPaths = new Set<string>();
  const manifestSourceById = new Map(
    project.document.manifest.sources.map((source) => [source.sourceId, source] as const),
  );
  for (const locator of project.document.sourceLocators) {
    if (locator.platform !== expectedPlatform) {
      throw new Error("This project references source locations from another operating system. Relinking is not available yet.");
    }
    let canonical: string;
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      canonical = await fs.realpath(locator.canonicalPath);
      stat = await fs.stat(canonical);
    } catch {
      throw new Error("One or more project source images are missing or unreadable. Restore them before reopening this project.");
    }
    if (!stat.isFile() || !isSupportedImage(canonical)) {
      throw new Error("One or more project source images are missing or unsupported. Restore them before reopening this project.");
    }
    const canonicalPathKey = process.platform === "win32"
      ? canonical.toLocaleLowerCase("en-US")
      : canonical;
    if (restoredCanonicalPaths.has(canonicalPathKey)) {
      throw new Error("The project assigns the same source image more than once. Repair the project before reopening it.");
    }
    restoredCanonicalPaths.add(canonicalPathKey);
    const source = manifestSourceById.get(locator.sourceId);
    if (!source) throw new Error("The project source index is inconsistent.");
    prepared.push({
      sourceId: locator.sourceId,
      path: canonical,
      name: path.basename(canonical),
      relativePath: source.relativeLabel,
      ...(source.fingerprint.status === "verified"
        ? {
          expectedSha256: source.fingerprint.sha256,
          fingerprintVerifiedAt: source.fingerprint.verifiedAt,
        }
        : {}),
    });
  }
  await restoreProjectAfterRetention({
    reconcile: () => reconcileProjectWorkingResults(project.document.manifest),
    install: async () => {
      await clearProjectSession();
      for (const grant of prepared) {
        sourceGrants.set(grant.sourceId, grant);
        sourceIdsByPath.set(grant.path, grant.sourceId);
        // Rebuild the allocator after the old session has been cleared.
        grant.relativePath = relativePathAllocator.reserve(grant.relativePath, grant.path);
      }
      activeProject = project;
      for (const [sourceId, resultId] of latestActiveProjectResultIds(
        project.document.manifest.modelResults,
      )) {
        activeResultIdsBySourceId.set(sourceId, resultId);
      }
    },
  });
  return projectReceiptWithRecent(project);
}

async function chooseAndCreateProject(value: unknown): Promise<ProjectSessionReceipt | null> {
  if (!sourceGrants.size) throw new Error("Open at least one image before creating a project.");
  if (activeProject) throw new Error("A project is already open. Save the current project instead.");
  const defaultPath = await rememberedDialogDirectory("import");
  const options: SaveDialogOptions = {
    title: "Save Loci project",
    buttonLabel: "Save project",
    ...(defaultPath ? { defaultPath: path.join(defaultPath, "Untitled Loci project.loci-project") } : {}),
    filters: [{ name: "Loci project", extensions: ["loci-project"] }],
  };
  const selection = mainWindow
    ? await dialog.showSaveDialog(mainWindow, options)
    : await dialog.showSaveDialog(options);
  if (selection.canceled || !selection.filePath) return null;
  const requestedPath = selection.filePath.toLocaleLowerCase("en-US").endsWith(".loci-project")
    ? selection.filePath
    : `${selection.filePath}.loci-project`;
  const title = path.basename(requestedPath, ".loci-project").trim() || "Untitled Loci project";
  const now = new Date().toISOString();
  const manifest = preparedProjectManifest(value, { title, createdAt: now });
  const project = await checkpointProjectBeforeRetention({
    persist: async () => {
      const persisted = await createProject(
        requestedPath,
        manifest,
        currentProjectLocators(manifest),
      );
      activeProject = persisted;
      return persisted;
    },
    reconcile: (persisted) =>
      reconcileProjectWorkingResults(persisted.document.manifest),
    rollbackPersistence: async (persisted) => {
      try {
        await discardCreatedProject(persisted);
      } catch (error) {
        // Keep the app-private session references durable at shutdown if the
        // new project file cannot be safely removed after ownership failed.
        preserveSessionWorkingResultsOnShutdown = true;
        throw error;
      }
      if (activeProject?.filePath === persisted.filePath) activeProject = null;
      return null;
    },
    reconcilePrevious: async () => undefined,
  });
  await rememberProjectDirectoryBestEffort(path.dirname(requestedPath));
  return projectReceiptWithRecent(project);
}

async function chooseAndOpenProject(): Promise<ProjectSessionReceipt | null> {
  if (!await confirmProjectReplacement()) return null;
  const defaultPath = await rememberedDialogDirectory("import");
  const options: OpenDialogOptions = {
    title: "Open Loci project",
    buttonLabel: "Open project",
    ...(defaultPath ? { defaultPath } : {}),
    filters: [{ name: "Loci project", extensions: ["loci-project"] }],
    properties: ["openFile"],
  };
  const selection = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  if (selection.canceled || !selection.filePaths[0]) return null;
  const project = await openProject(selection.filePaths[0]);
  await rememberProjectDirectoryBestEffort(path.dirname(selection.filePaths[0]));
  return restoreProjectSession(project);
}

async function openRecentProject(recentId: unknown): Promise<ProjectSessionReceipt> {
  if (typeof recentId !== "string") throw new Error("The recent project selection is invalid.");
  if (!await confirmProjectReplacement()) throw new Error("Project opening was cancelled.");
  const projectPath = await recentProjects.resolve(recentId);
  if (!projectPath) throw new Error("This recent project is no longer available.");
  return restoreProjectSession(await openProject(projectPath));
}

async function saveActiveProject(
  value: unknown,
  quitRequestIdValue?: unknown,
): Promise<ProjectSessionReceipt> {
  if (!activeProject) throw new Error("Create or open a project before saving changes.");
  const quitRequestId = quitRequestIdValue === undefined
    ? null
    : validatedQuitProjectSaveRequestId(quitRequestIdValue);
  if (quitRequestIdValue !== undefined && !quitRequestId) {
    throw new Error("The quit project-save request is invalid or no longer active.");
  }
  const saveCancellationRevision = quitProjectSaveCoordinator.cancellationRevision;
  let claimedQuitRequestId: string | null = null;
  const previousProject = activeProject;
  const previousManifest = previousProject.document.manifest;
  const manifest = preparedProjectManifest(value, {
    createdAt: previousManifest.createdAt,
  });
  try {
    await checkpointProjectBeforeRetention({
      persist: async () => {
        const persisted = await saveProject(
          previousProject,
          manifest,
          currentProjectLocators(manifest),
          () => {
            claimedQuitRequestId = quitProjectSaveCoordinator.claimCommit(
              quitRequestId,
              saveCancellationRevision,
            );
          },
        );
        activeProject = persisted;
        return persisted;
      },
      reconcile: (persisted) =>
        reconcileProjectWorkingResults(persisted.document.manifest),
      rollbackPersistence: async (persisted) => {
        const rolledBack = await saveProject(
          persisted,
          previousManifest,
          currentProjectLocators(previousManifest),
        );
        activeProject = rolledBack;
        return rolledBack;
      },
      reconcilePrevious: (rolledBack) =>
        reconcileProjectWorkingResults(rolledBack.document.manifest),
    });
    if (claimedQuitRequestId) {
      quitProjectSaveCoordinator.completeCommit(claimedQuitRequestId, true);
    }
    return projectReceiptWithRecent(activeProject);
  } catch (error) {
    if (claimedQuitRequestId) {
      quitProjectSaveCoordinator.completeCommit(claimedQuitRequestId, false);
    }
    throw error;
  }
}

function requireSourceGrant(sourceId: unknown): SourceGrant {
  if (typeof sourceId !== "string" || !sourceId) throw new Error("The source request is invalid.");
  const grant = sourceGrants.get(sourceId);
  if (!grant) throw new Error("This source is no longer available. Import it again and retry.");
  return grant;
}

function requireResultForSource(resultId: unknown, sourceId: string): string {
  if (typeof resultId !== "string" || !resultId || resultSources.get(resultId) !== sourceId) {
    throw new Error("This result is no longer available for the selected source. Run segmentation again.");
  }
  return resultId;
}

function validatedBatchRunRequest(value: unknown): {
  sourceIds: string[];
  settings: AnalysisSettings;
  profileId: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The batch request is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).some((key) => !["sourceIds", "settings", "profileId"].includes(key)) ||
    !Array.isArray(candidate.sourceIds) ||
    candidate.sourceIds.length < 2 ||
    candidate.sourceIds.length > MAX_DISCOVERED_SOURCES ||
    candidate.sourceIds.some((sourceId) => typeof sourceId !== "string" || !sourceId) ||
    new Set(candidate.sourceIds).size !== candidate.sourceIds.length ||
    !candidate.settings ||
    typeof candidate.settings !== "object" ||
    Array.isArray(candidate.settings) ||
    typeof candidate.profileId !== "string" ||
    !candidate.profileId
  ) {
    throw new Error("The batch request is invalid.");
  }
  return {
    sourceIds: [...candidate.sourceIds] as string[],
    settings: structuredClone(candidate.settings as unknown as AnalysisSettings),
    profileId: candidate.profileId,
  };
}

function requireVerifiedBatchGrant(sourceId: string): SourceGrant & {
  expectedSha256: string;
  fingerprintVerifiedAt: string;
} {
  const grant = requireSourceGrant(sourceId);
  if (
    !grant.expectedSha256 ||
    !/^[0-9a-f]{64}$/.test(grant.expectedSha256) ||
    !grant.sessionFingerprintVerifiedAt ||
    !Number.isFinite(Date.parse(grant.sessionFingerprintVerifiedAt))
  ) {
    throw new Error("Every batch source must be inspected and fingerprinted before processing.");
  }
  return grant as SourceGrant & { expectedSha256: string; fingerprintVerifiedAt: string };
}

async function createDurableBatchRun(value: unknown): Promise<DurableBatchSession> {
  if (activeBatchRunId || activeAnalysisJobId) {
    throw new Error("Wait for the current analysis batch to finish before starting another.");
  }
  const request = validatedBatchRunRequest(value);
  const batchProject = activeProject;
  assertDurableBatchProjectSources(
    batchProject?.document.manifest.sources.map(({ sourceId }) => sourceId) ?? null,
    request.sourceIds,
  );
  if (jobStore.list().length + request.sourceIds.length + 1 > MAX_DURABLE_JOBS) {
    throw new Error("The durable job history does not have enough room for this batch. Clear older history before retrying.");
  }
  const model = MODEL_EVIDENCE_REGISTRY.getModel(request.profileId);
  if (!model) throw new Error("This batch profile has no registered model and evidence manifest.");
  const grants = request.sourceIds.map(requireVerifiedBatchGrant);
  const batchId = randomUUID();
  const createdAt = new Date().toISOString();
  const publicTitle = `Segment ${grants.length.toLocaleString()} images`;
  const sourceFingerprints = grants.map((grant) => ({
    sourceId: grant.sourceId,
    sha256: grant.expectedSha256,
  }));
  const spec: JobSpec = {
    schemaVersion: JOB_SPEC_SCHEMA,
    jobId: batchId,
    kind: "segment",
    createdAt,
    executionTarget: { kind: "local" },
    inputs: sourceFingerprints.map(({ sourceId, sha256 }) => ({
      sourceId,
      fingerprintSha256: sha256,
      byteLength: null,
    })),
    operation: {
      profileId: request.profileId,
      modelId: model.modelId,
      modelSha256: model.artifact.sha256,
      settings: structuredClone(request.settings),
    },
    resources: {
      cpuCores: null,
      memoryMiB: null,
      gpuCount: 0,
      walltimeMinutes: null,
    },
    expectedOutputs: [],
  };
  await jobStore.createJob(spec, randomUUID(), { title: publicTitle });
  notifyJobsChanged();
  let opened: Awaited<ReturnType<BatchRunStore["create"]>>;
  try {
    opened = await batchRunStore.create({
      batchId,
      projectId: batchProject!.document.manifest.projectId,
      createdAt,
      publicTitle,
      sources: grants.map((grant) => ({
        sourceId: grant.sourceId,
        fingerprintSha256: grant.expectedSha256,
        relativeLabel: grant.relativePath,
      })),
    });
    assertBatchPlanMatchesParent(opened.plan, spec);
    assertBatchPlanMatchesActiveProject(opened.plan);
  } catch (error) {
    await appendJobState(batchId, "failed", "The durable batch plan could not be created.", 0, {
      reasonCode: "batch-plan-failed",
    }).catch(() => undefined);
    throw error;
  }
  const record = batchRecordFromDurableJob(opened.plan);
  activeBatchRuns.set(batchId, record);
  activeBatchRunId = batchId;
  await appendJobState(batchId, "running", "Batch plan verified; ready to process images.", 0);
  return rendererBatchSession(record, "active");
}

async function listRecoverableBatchRuns(): Promise<DurableBatchSession[]> {
  if (!activeProject) return [];
  const projectId = activeProject.document.manifest.projectId;
  const projectSourceIds = activeProject.document.manifest.sources.map(({ sourceId }) => sourceId);
  const candidates = jobStore.list().filter((record) =>
    record.spec.kind === "segment" &&
    record.spec.inputs.length >= 2 &&
    record.events.at(-1)?.state === "needs-attention");
  const sessions: DurableBatchSession[] = [];
  for (const candidate of candidates) {
    try {
      const opened = await batchRunStore.open(candidate.spec.jobId);
      if (opened.plan.projectId !== projectId) continue;
      assertDurableBatchProjectSources(
        projectSourceIds,
        opened.plan.sources.map(({ sourceId }) => sourceId),
      );
      const record = batchRecordFromDurableJob(opened.plan);
      sessions.push(await rendererBatchSession(record, "needs-attention"));
    } catch {
      // A multi-source analytical job is not necessarily a Loci batch. Do not
      // expose private storage details while probing the dedicated ledger.
    }
  }
  return sessions;
}

async function resumeDurableBatchRun(batchIdValue: unknown): Promise<DurableBatchSession> {
  if (typeof batchIdValue !== "string" || !batchIdValue) {
    throw new Error("The batch retry request is invalid.");
  }
  if (activeBatchRunId || activeAnalysisJobId) {
    throw new Error("Wait for the current analysis batch to finish before retrying another.");
  }
  const job = jobStore.get(batchIdValue);
  if (!job || job.events.at(-1)?.state !== "needs-attention") {
    throw new Error("This batch is not waiting for retry.");
  }
  const opened = await batchRunStore.open(batchIdValue);
  const project = activeProject;
  if (!project || opened.plan.projectId !== project.document.manifest.projectId) {
    throw new Error("Reopen the exact Loci project that created this batch before retrying it.");
  }
  assertDurableBatchProjectSources(
    project.document.manifest.sources.map(({ sourceId }) => sourceId),
    opened.plan.sources.map(({ sourceId }) => sourceId),
  );
  const record = batchRecordFromDurableJob(opened.plan);
  for (const source of opened.plan.sources) {
    const grant = requireVerifiedBatchGrant(source.sourceId);
    if (
      grant.expectedSha256 !== source.fingerprintSha256 ||
      grant.relativePath !== source.relativeLabel
    ) {
      throw new Error("The open sources no longer match this batch plan. Reopen the original project and inspect every source before retrying.");
    }
  }
  await batchRunStore.retryFailed(batchIdValue);
  const summary = await batchRunStore.summary(batchIdValue);
  if (isBatchLedgerComplete(summary)) return completeDurableBatchRun(record);
  if (!summary.pending) throw new Error("This batch has no failed or pending images to retry.");
  activeBatchRuns.set(batchIdValue, record);
  activeBatchRunId = batchIdValue;
  await appendBatchProgress(record, "Retrying the images that still need a verified result.");
  return rendererBatchSession(record, "active");
}

function requireActiveBatchRun(batchIdValue: unknown): ActiveBatchRunRecord {
  if (typeof batchIdValue !== "string" || !batchIdValue) {
    throw new Error("The batch request is invalid.");
  }
  const record = activeBatchRuns.get(batchIdValue);
  if (!record || activeBatchRunId !== batchIdValue) {
    throw new Error("This batch is not active. Review it in the Job Center before retrying.");
  }
  return record;
}

async function beginDurableBatchItem(
  batchIdValue: unknown,
  sourceIdValue: unknown,
): Promise<DurableBatchItemSummary> {
  const record = requireActiveBatchRun(batchIdValue);
  if (typeof sourceIdValue !== "string" || !sourceIdValue) {
    throw new Error("The batch source request is invalid.");
  }
  if (activeAnalysisJobId) throw new Error("Wait for the current image to finish before starting the next one.");
  const item = await batchRunStore.beginAttempt(record.batchId, sourceIdValue);
  const sourceIndex = record.sourceFingerprints.findIndex(({ sourceId }) => sourceId === sourceIdValue);
  await appendBatchProgress(
    record,
    `Processing image ${(sourceIndex + 1).toLocaleString()} of ${record.sourceFingerprints.length.toLocaleString()}.`,
  );
  return rendererBatchItem(item);
}

function verifiedResultManifestForBatchItem(
  batch: ActiveBatchRunRecord,
  sourceId: string,
  resultId: string,
  resultManifestId?: string,
): ResultManifest {
  const parent = jobStore.get(batch.parentJobId);
  if (!parent) throw new Error("The durable parent batch specification is unavailable.");
  const candidates = jobStore.list().filter((candidate) =>
    candidate.spec.kind === "segment" &&
    candidate.spec.inputs.length === 1 &&
    candidate.spec.inputs[0].sourceId === sourceId &&
    candidate.result?.resultId === resultId &&
    (resultManifestId === undefined || candidate.result.resultManifestId === resultManifestId));
  const result = candidates[0]?.result ?? null;
  if (candidates.length !== 1 || !result) {
    throw new Error("The batch item has no verified durable result manifest.");
  }
  const child = candidates[0];
  assertBatchChildMatchesParent(parent.spec, child.spec, result, sourceId);
  return result;
}

function batchWorkingResultReference(
  batch: ActiveBatchRunRecord,
  item: Pick<BatchRunItem, "sourceId" | "state" | "resultId" | "resultManifestId">,
): WorkingResultReferenceInput {
  if (item.state !== "completed" || !item.resultId || !item.resultManifestId) {
    throw new Error("Only an exact completed batch item can own a working result.");
  }
  const result = verifiedResultManifestForBatchItem(
    batch,
    item.sourceId,
    item.resultId,
    item.resultManifestId,
  );
  const artifacts = result.artifacts.filter((artifact) =>
    artifact.artifactId === WORKING_RESULT_ARTIFACT_ID
    && artifact.mediaType === WORKING_RESULT_MEDIA_TYPE);
  if (artifacts.length !== 1) {
    throw new Error("The completed batch result does not contain one exact working-result pack.");
  }
  const artifact = artifacts[0];
  return {
    projectId: workingResultBatchRecoveryOwnerId(batch.batchId),
    resultId: result.resultId,
    revision: 0,
    jobId: result.jobId,
    artifact: {
      artifactId: WORKING_RESULT_ARTIFACT_ID,
      filename: artifact.filename,
      mediaType: WORKING_RESULT_MEDIA_TYPE,
      byteLength: artifact.byteLength,
      sha256: artifact.sha256,
    },
    packPath: path.join(
      app.getPath("userData"),
      "working-results",
      result.jobId,
      artifact.filename,
    ),
  };
}

/**
 * Under the app's single-instance lock, replace references left by dead process
 * sessions with stable ownership for every exact output still named by a
 * recoverable durable batch. Project-owned references remain untouched.
 */
async function recoverWorkingResultOwnershipAtStartup(): Promise<boolean> {
  const recoverableBatchReferences: WorkingResultReferenceInput[] = [];
  try {
    const candidates = jobStore.list().filter((record) =>
      record.spec.kind === "segment" && record.spec.inputs.length >= 2);
    for (const candidate of candidates) {
      const latestState = candidate.events.at(-1)?.state;
      let opened: Awaited<ReturnType<BatchRunStore["open"]>>;
      try {
        opened = await batchRunStore.open(candidate.spec.jobId);
      } catch (error) {
        if (
          error instanceof BatchRunStoreError
          && error.code === "not-found"
          && latestState
          && isTerminalJobState(latestState)
        ) continue;
        throw error;
      }
      if (!latestState || isTerminalJobState(latestState)) continue;
      const record = batchRecordFromDurableJob(opened.plan);
      for (const item of opened.items) {
        if (item.state === "completed") {
          recoverableBatchReferences.push(batchWorkingResultReference(record, item));
        }
      }
    }
    const receipt = await workingResultRetentionStore.recoverStaleSessionReferences(
      sessionRetentionOwnerId,
      recoverableBatchReferences,
    );
    if (receipt.released.length || receipt.adopted.length) {
      console.info("Loci reconciled working-result ownership after restart.", {
        releasedStaleReferences: receipt.released.length,
        adoptedBatchReferences: receipt.adopted.length,
      });
    }
    return true;
  } catch (error) {
    console.error(
      "Loci preserved prior working-result ownership because startup recovery could not be verified.",
      error,
    );
    return false;
  }
}

async function completeDurableBatchItem(
  batchIdValue: unknown,
  sourceIdValue: unknown,
  resultIdValue: unknown,
): Promise<DurableBatchItemSummary> {
  const record = requireActiveBatchRun(batchIdValue);
  if (typeof sourceIdValue !== "string" || typeof resultIdValue !== "string") {
    throw new Error("The batch completion request is invalid.");
  }
  requireResultForSource(resultIdValue, sourceIdValue);
  const result = verifiedResultManifestForBatchItem(record, sourceIdValue, resultIdValue);
  const recoveryReference = batchWorkingResultReference(record, {
    sourceId: sourceIdValue,
    state: "completed",
    resultId: result.resultId,
    resultManifestId: result.resultManifestId,
  });
  await workingResultRetentionStore.reference(recoveryReference);
  let item: BatchRunItem;
  try {
    item = await batchRunStore.completeAttempt(record.batchId, sourceIdValue, {
      resultId: result.resultId,
      resultManifestId: result.resultManifestId,
    });
  } catch (error) {
    await workingResultRetentionStore.unreference({
      projectId: recoveryReference.projectId,
      resultId: recoveryReference.resultId,
      revision: recoveryReference.revision,
    }).catch(() => undefined);
    throw error;
  }
  await appendBatchProgress(record);
  return rendererBatchItem(item);
}

async function failDurableBatchItem(
  batchIdValue: unknown,
  sourceIdValue: unknown,
  failureSummaryValue: unknown,
): Promise<DurableBatchItemSummary> {
  const record = requireActiveBatchRun(batchIdValue);
  if (typeof sourceIdValue !== "string") throw new Error("The batch failure request is invalid.");
  const failureSummary = sanitizeBatchRunPublicText(failureSummaryValue, 1_000)
    ?? "This image could not be processed.";
  const item = await batchRunStore.failAttempt(record.batchId, sourceIdValue, {
    code: "analysis-failed",
    summary: failureSummary,
  });
  await appendBatchProgress(record);
  return rendererBatchItem(item);
}

async function cancelDurableBatchRun(
  record: ActiveBatchRunRecord,
  message = "Batch cancelled by the researcher.",
): Promise<DurableBatchSession> {
  const currentJob = jobStore.get(record.parentJobId);
  if (currentJob && !isTerminalJobState(currentJob.events.at(-1)!.state) && !currentJob.cancellation) {
    await jobStore.requestCancellation(record.parentJobId, randomUUID(), message);
    notifyJobsChanged();
  }
  const items = await batchRunStore.list(record.batchId);
  for (const item of items) {
    if (item.state === "running") await batchRunStore.cancelAttempt(record.batchId, item.sourceId, message);
  }
  await batchRunStore.cancelPending(record.batchId);
  const latest = jobStore.get(record.parentJobId)?.events.at(-1);
  if (latest && !isTerminalJobState(latest.state)) {
    await appendJobState(record.parentJobId, "cancelled", message, latest.progress, {
      reasonCode: "cancelled-by-user",
    });
  }
  await workingResultRetentionStore.reconcileProject(
    workingResultBatchRecoveryOwnerId(record.batchId),
    [],
  ).catch((error) =>
    console.error("Loci could not release cancelled-batch working-result ownership.", error));
  if (activeBatchRunId === record.batchId) activeBatchRunId = null;
  activeBatchRuns.delete(record.batchId);
  return rendererBatchSession(record, "cancelled");
}

function assertCompletedBatchLedgerMatchesJobs(
  record: ActiveBatchRunRecord,
  items: readonly BatchRunItem[],
): void {
  for (const item of items) {
    if (item.state !== "completed" || !item.resultId || !item.resultManifestId) {
      throw new Error("The completed batch ledger contains an incomplete item result.");
    }
    verifiedResultManifestForBatchItem(
      record,
      item.sourceId,
      item.resultId,
      item.resultManifestId,
    );
  }
}

async function completeDurableBatchRun(
  record: ActiveBatchRunRecord,
): Promise<DurableBatchSession> {
  const [summary, items] = await Promise.all([
    batchRunStore.summary(record.batchId),
    batchRunStore.list(record.batchId),
  ]);
  if (!isBatchLedgerComplete(summary)) {
    throw new Error("Only a wholly completed batch ledger can be finalized.");
  }
  assertCompletedBatchLedgerMatchesJobs(record, items);

  try {
    // This save embeds every per-image result and reconciles its verified pack
    // before the parent job is allowed to claim completion.
    await runProjectOperation(() => checkpointCompletedBatchResults(record, items));
    await workingResultRetentionStore.reconcileProject(
      workingResultBatchRecoveryOwnerId(record.batchId),
      [],
    );
    releaseCompletedBatchProtection(protectedSessionResultIds, items);
  } catch (error) {
    protectCompletedBatchResults(protectedSessionResultIds, items);
    const latest = jobStore.get(record.parentJobId)?.events.at(-1);
    if (latest && !isTerminalJobState(latest.state)) {
      await appendJobState(
        record.parentJobId,
        "needs-attention",
        "All images finished, but their durable project checkpoint needs retry.",
        latest.progress,
        { reasonCode: "batch-project-checkpoint-failed" },
      ).catch(() => undefined);
    }
    if (activeBatchRunId === record.batchId) activeBatchRunId = null;
    activeBatchRuns.delete(record.batchId);
    throw new Error(
      "Every image finished, but Loci could not durably save the batch results into this project. Retry the batch finalization from the Job Center.",
      { cause: error },
    );
  }

  const parent = jobStore.get(record.parentJobId);
  if (!parent) throw new Error("The durable parent job is unavailable.");
  const result: ResultManifest = {
    schemaVersion: RESULT_MANIFEST_SCHEMA,
    resultManifestId: randomUUID(),
    resultId: randomUUID(),
    jobId: record.parentJobId,
    createdAt: new Date().toISOString(),
    sourceFingerprints: record.sourceFingerprints.map(({ sourceId, sha256 }) => ({ sourceId, sha256 })),
    producer: {
      appVersion: app.getVersion(),
      engineVersion: "batch-orchestrator/v1",
      modelId: parent.spec.operation.modelId,
      modelSha256: parent.spec.operation.modelSha256,
      settingsSha256: sha256CanonicalJson(parent.spec.operation.settings),
    },
    artifacts: [],
    publication: { state: "verified", atomic: true, reason: null },
  };
  try {
    await appendJobState(record.parentJobId, "verifying", "Verifying the completed batch ledger.", 0.95);
    await appendJobState(record.parentJobId, "completed", "All batch results were verified.", 1, { result });
  } catch (error) {
    const latest = jobStore.get(record.parentJobId)?.events.at(-1);
    if (latest?.state === "completed") {
      if (activeBatchRunId === record.batchId) activeBatchRunId = null;
      activeBatchRuns.delete(record.batchId);
      return rendererBatchSession(record, "completed");
    }
    if (latest && !isTerminalJobState(latest.state)) {
      await appendJobState(
        record.parentJobId,
        "needs-attention",
        "The saved batch results are ready, but parent-job finalization needs retry.",
        latest.progress,
        { reasonCode: "batch-parent-finalization-failed" },
      ).catch(() => undefined);
    }
    if (activeBatchRunId === record.batchId) activeBatchRunId = null;
    activeBatchRuns.delete(record.batchId);
    throw error;
  }
  if (activeBatchRunId === record.batchId) activeBatchRunId = null;
  activeBatchRuns.delete(record.batchId);
  return rendererBatchSession(record, "completed");
}

async function finishDurableBatchRun(
  batchIdValue: unknown,
  cancelledValue: unknown,
): Promise<DurableBatchSession> {
  if (typeof batchIdValue !== "string" || typeof cancelledValue !== "boolean") {
    throw new Error("The batch finalization request is invalid.");
  }
  let record = activeBatchRuns.get(batchIdValue);
  if (!record) {
    const opened = await batchRunStore.open(batchIdValue);
    record = batchRecordFromDurableJob(opened.plan);
    const finalState = jobStore.get(record.parentJobId)?.events.at(-1)?.state;
    if (finalState === "completed") return rendererBatchSession(record, "completed");
    if (finalState === "cancelled") return rendererBatchSession(record, "cancelled");
    if (finalState === "needs-attention" && cancelledValue) {
      return rendererBatchSession(record, "needs-attention");
    }
    if (finalState !== "needs-attention") {
      throw new Error("This batch cannot be finalized from its current durable state.");
    }
    if (!activeProject || activeProject.document.manifest.projectId !== opened.plan.projectId) {
      throw new Error("Reopen the exact Loci project that created this batch before finalizing it.");
    }
  }
  if (cancelledValue) return cancelDurableBatchRun(record);

  const summary = await batchRunStore.summary(record.batchId);
  if (isBatchLedgerComplete(summary)) return completeDurableBatchRun(record);
  if (summary.pending || summary.running) {
    await appendJobState(record.parentJobId, "failed", "The batch stopped before every image reached a final state.", null, {
      reasonCode: "batch-incomplete",
    });
    await workingResultRetentionStore.reconcileProject(
      workingResultBatchRecoveryOwnerId(record.batchId),
      [],
    ).catch((error) =>
      console.error("Loci could not release failed-batch working-result ownership.", error));
    if (activeBatchRunId === record.batchId) activeBatchRunId = null;
    activeBatchRuns.delete(record.batchId);
    throw new Error("The batch stopped before every image reached a final state.");
  }
  if (summary.failed || summary.cancelled) {
    const latest = jobStore.get(record.parentJobId)?.events.at(-1);
    await appendJobState(
      record.parentJobId,
      "needs-attention",
      `${summary.failed.toLocaleString()} image${summary.failed === 1 ? "" : "s"} need retry or review.`,
      Math.max(0.9, latest?.progress ?? 0),
      { reasonCode: "batch-items-failed" },
    );
    if (activeBatchRunId === record.batchId) activeBatchRunId = null;
    activeBatchRuns.delete(record.batchId);
    return rendererBatchSession(record, "needs-attention");
  }
  throw new Error("This batch has no finalizable result state.");
}

async function beginBatchExport(exportOptionsValue: unknown): Promise<BatchExportSession | null> {
  const exportOptions = validatedExportOptions(exportOptionsValue);
  const defaultPath = await rememberedDialogDirectory("export");
  const options: OpenDialogOptions = {
    title: "Choose a destination for batch results",
    buttonLabel: "Process here",
    ...(defaultPath ? { defaultPath } : {}),
    properties: ["openDirectory", "createDirectory"],
  };
  const destination = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  if (destination.canceled || !destination.filePaths[0]) return null;
  await rememberDialogDirectory("export", destination.filePaths[0]);
  const outputDirectory = await canonicalizeBatchRoot(destination.filePaths[0]);
  const outputStat = await fs.stat(outputDirectory, { bigint: true });
  const batchId = randomUUID();
  batchSessions.set(batchId, {
    batchId,
    outputDirectory,
    outputDevice: outputStat.dev.toString(),
    outputInode: outputStat.ino.toString(),
    startedAt: new Date().toISOString(),
    successes: [],
    exportOptions,
    activeExports: new Set(),
    finalizing: false,
  });
  return { batchId };
}

async function finishBatchExport(
  batchId: unknown,
  failures: BatchExportFailure[],
  cancelled: boolean,
): Promise<BatchExportReceipt> {
  if (typeof batchId !== "string") throw new Error("The batch export request is invalid.");
  const batch = batchSessions.get(batchId);
  if (!batch) throw new Error("This batch export session has expired.");
  await Promise.all([...batch.activeExports]);
  const safeFailures = Array.isArray(failures)
    ? failures.slice(0, MAX_DISCOVERED_SOURCES).flatMap((failure) => {
        const grant = requireSourceGrant(failure?.sourceId);
        const message = sanitizeBatchFailureMessage(failure?.message, [
          { value: grant.path, replacement: grant.name },
          { value: batch.outputDirectory, replacement: "<export destination>" },
        ]);
        if (!message) return [];
        return [{ source_relative_path: grant.relativePath, message }];
      })
    : [];
  const completedAt = new Date().toISOString();
  let summaryName: string | null = null;
  let summaryContent: string | null = null;
  if (batch.exportOptions.summaryCsv) {
    const stamp = completedAt.replaceAll(/[:.]/g, "-");
    summaryName = `loci_count_summary_${stamp}_${batchId.slice(0, 8)}.csv`;
    summaryContent = serializeCountSummaryCsv(
      batch.successes.map((success) => ({
        imageName: success.sourceRelativePath,
        cellCount: success.cellCount,
      })),
    );
  }
  const manifest = {
    schema_version: 1,
    product: "Loci",
    status: cancelled ? "cancelled" : safeFailures.length ? "completed_with_errors" : "completed",
    started_at: batch.startedAt,
    completed_at: completedAt,
    exported_count: batch.successes.length,
    failed_count: safeFailures.length,
    outputs: batch.successes.map((success) => ({
      source_relative_path: success.sourceRelativePath,
      output_directory: success.outputDirectory,
      files: success.files,
    })),
    count_summary: summaryName,
    failures: safeFailures,
  };
  const stamp = completedAt.replaceAll(/[:.]/g, "-");
  const manifestName = `loci_batch_manifest_${stamp}_${batchId.slice(0, 8)}.json`;
  const metadataFiles: Record<string, string> = {};
  if (summaryName && summaryContent !== null) metadataFiles[summaryName] = summaryContent;
  // The manifest is the durable commit marker. Keep it last even though the
  // engine independently enforces publication ordering at its trust boundary.
  metadataFiles[manifestName] = `${JSON.stringify(manifest, null, 2)}\n`;
  const published = await engine.request<RawBatchMetadataReceipt>("publish_batch_metadata", {
    allowed_root: batch.outputDirectory,
    allowed_root_identity: {
      device: batch.outputDevice,
      inode: batch.outputInode,
    },
    files: metadataFiles,
  });
  const manifestPath = published.files[manifestName];
  const summaryPath = summaryName ? published.files[summaryName] : undefined;
  if (!manifestPath || (summaryName && !summaryPath)) {
    throw new Error("The analysis engine returned an invalid batch metadata receipt.");
  }
  batchSessions.delete(batchId);
  return {
    cancelled,
    exportedCount: batch.successes.length,
    failedCount: safeFailures.length,
    manifestPath,
    ...(summaryPath ? { summaryPath } : {}),
    outputDirectory: batch.outputDirectory,
  };
}

function scheduleBatchFinalization(
  batchId: string,
  failures: BatchExportFailure[],
  cancelled: boolean,
): Promise<BatchExportReceipt> {
  const batch = batchSessions.get(batchId);
  if (!batch) throw new Error("This batch export session has expired.");
  batch.finalizing = true;
  const operation = batchFinalizations.runOnce(batchId, () =>
    finishBatchExport(batchId, failures, cancelled),
  );
  void operation.then(
    () => undefined,
    () => {
      if (batchSessions.get(batchId) === batch) batch.finalizing = false;
    },
  );
  return operation;
}

async function finalizeOpenBatchesForShutdown(): Promise<void> {
  const pending: Promise<void>[] = [];
  for (const batchId of batchSessions.keys()) {
    try {
      pending.push(scheduleBatchFinalization(batchId, [], true).then(
        () => undefined,
        (error) => {
          console.error(`Loci could not finalize batch ${batchId} during shutdown.`, error);
        },
      ));
    } catch (error) {
      console.error(`Loci could not schedule batch ${batchId} for shutdown.`, error);
    }
  }
  await Promise.all(pending);
}

function registerIpc(): void {
  researchBridge.register(assertTrustedSender);
  ipcMain.handle("loci:create-project", (event, manifest: unknown) => {
    assertTrustedSender(event);
    return rendererSafeProjectOperation(
      () => runProjectOperation(() => chooseAndCreateProject(manifest)),
      "Loci could not create the project at the selected location.",
    );
  });
  ipcMain.handle("loci:open-project", (event) => {
    assertTrustedSender(event);
    return rendererSafeProjectOperation(
      () => runProjectOperation(() => chooseAndOpenProject()),
      "Loci could not open the selected project.",
    );
  });
  ipcMain.handle("loci:open-recent-project", (event, recentId: unknown) => {
    assertTrustedSender(event);
    return rendererSafeProjectOperation(
      () => runProjectOperation(() => openRecentProject(recentId)),
      "Loci could not open the recent project.",
    );
  });
  ipcMain.handle(
    "loci:save-project",
    (event, manifest: unknown, quitRequestId?: unknown) => {
      assertTrustedSender(event);
      return rendererSafeProjectOperation(
        () => runProjectOperation(() => saveActiveProject(manifest, quitRequestId)),
        "Loci could not save the project.",
      );
    },
  );
  ipcMain.handle("loci:confirm-discard-unsaved-project", (event) => {
    assertTrustedSender(event);
    return confirmDiscardUnsavedProject();
  });
  ipcMain.handle("loci:list-recent-projects", (event) => {
    assertTrustedSender(event);
    return rendererSafeProjectOperation(
      () => recentProjects.list(),
      "Loci could not read recent-project history.",
    );
  });
  ipcMain.handle("loci:list-jobs", (event) => {
    assertTrustedSender(event);
    return rendererJobs();
  });
  ipcMain.handle("loci:pick-images", (event) => {
    assertTrustedSender(event);
    assertProjectOperationIdle();
    return pickImages();
  });
  ipcMain.handle("loci:pick-folder", (event) => {
    assertTrustedSender(event);
    assertProjectOperationIdle();
    return pickFolder();
  });
  ipcMain.handle("loci:import-dropped-files", async (event, paths: string[]) => {
    assertTrustedSender(event);
    assertProjectOperationIdle();
    return grantCandidates(await collectSelections(paths, true));
  });
  ipcMain.handle("loci:inspect-source", async (event, sourceId: string) => {
    assertTrustedSender(event);
    const grant = requireSourceGrant(sourceId);
    return projectSourceOperations.runSourceOnce(sourceId, async () => {
      const imported = await inspectWithDurableJob(grant);
      if (sourceGrants.get(sourceId) !== grant) {
        throw new Error("The source session changed while inspection was finishing. Select the source again.");
      }
      return imported;
    });
  });
  ipcMain.handle("loci:restore-project-result", async (event, sourceId: string) => {
    assertTrustedSender(event);
    return projectSourceOperations.runProject(async () => {
      if (activeAnalysisJobId) {
        throw new Error("Wait for the active analysis before restoring a saved result.");
      }
      return restoreActiveProjectResult(sourceId);
    });
  });
  ipcMain.handle("loci:remove-source", async (event, sourceId: string) => {
    assertTrustedSender(event);
    assertProjectOperationIdle();
    if (projectSourceOperations.isSourceInspectionBusy) {
      throw new Error("Wait for source inspection to finish before removing an image.");
    }
    if (rendererSessionState.isRunning) {
      throw new Error("Wait for the active analysis to stop before removing an image.");
    }
    return { removed: await removeSourceGrant(sourceId) };
  });
  ipcMain.handle("loci:reveal-source", (event, sourceId: string) => {
    assertTrustedSender(event);
    const grant = requireSourceGrant(sourceId);
    shell.showItemInFolder(grant.path);
  });
  ipcMain.handle("loci:discard-result", async (
    event,
    sourceId: string,
    resultId: string,
  ) => {
    assertTrustedSender(event);
    return runProjectOperation(async () => {
      if (activeAnalysisJobId || activeCorrectionResults.size > 0) {
        throw new Error("Wait for the active analysis or correction before clearing a result.");
      }
      const discarded = await retireProjectResults([{ sourceId, resultId }]);
      return { discarded: discarded.length === 1 };
    });
  });
  ipcMain.handle("loci:discard-all-results", async (event) => {
    assertTrustedSender(event);
    return runProjectOperation(async () => {
      if (activeAnalysisJobId || activeCorrectionResults.size > 0) {
        throw new Error("Wait for the active analysis or correction before changing its configuration.");
      }
      const discarded = await retireProjectResults(
        [...activeResultIdsBySourceId].map(([sourceId, resultId]) => ({ sourceId, resultId })),
      );
      return { discarded };
    });
  });
  const registerCorrection = (
    channel: string,
    method: "delete_instance" | "add_polygon" | "undo_correction" | "redo_correction",
  ) => {
    ipcMain.handle(channel, async (
      event,
      sourceId: string,
      resultId: string,
      payload?: SourcePoint | SourcePoint[],
    ) => {
      assertTrustedSender(event);
      const params: Record<string, unknown> = {};
      if (method === "delete_instance") {
        const point = payload as SourcePoint;
        params.x = point?.x;
        params.y = point?.y;
      } else if (method === "add_polygon") {
        params.points = payload;
      }
      return applyDurableCorrection(sourceId, resultId, method, params);
    });
  };
  registerCorrection("loci:delete-instance", "delete_instance");
  registerCorrection("loci:add-polygon", "add_polygon");
  registerCorrection("loci:undo-correction", "undo_correction");
  registerCorrection("loci:redo-correction", "redo_correction");
  ipcMain.handle("loci:split-instance", async (
    event,
    sourceId: string,
    resultId: string,
    target: SourcePoint,
    points: SourcePoint[],
  ) => {
    assertTrustedSender(event);
    return applyDurableCorrection(sourceId, resultId, "split_instance", {
      x: target?.x,
      y: target?.y,
      points,
    });
  });
  ipcMain.handle("loci:merge-instances", async (
    event,
    sourceId: string,
    resultId: string,
    first: SourcePoint,
    second: SourcePoint,
  ) => {
    assertTrustedSender(event);
    return applyDurableCorrection(sourceId, resultId, "merge_instances", {
      x: first?.x,
      y: first?.y,
      other_x: second?.x,
      other_y: second?.y,
    });
  });
  ipcMain.handle("loci:replace-instance-boundary", async (
    event,
    sourceId: string,
    resultId: string,
    target: SourcePoint,
    points: SourcePoint[],
  ) => {
    assertTrustedSender(event);
    return applyDurableCorrection(sourceId, resultId, "replace_instance_boundary", {
      x: target?.x,
      y: target?.y,
      points,
    });
  });
  ipcMain.handle("loci:get-instance-boundary", async (
    event,
    sourceId: string,
    resultId: string,
    target: SourcePoint,
  ) => {
    assertTrustedSender(event);
    if (activeCorrectionResults.has(resultId)) {
      throw new Error("Wait for the current correction to finish before editing this result again.");
    }
    return resultLifecycleOperations.run(() => withDurableResult(
      sourceId,
      resultId,
      async () => mapEditableInstanceBoundary(
        await engine.request<unknown>("get_instance_boundary", {
          result_id: resultId,
          x: target?.x,
          y: target?.y,
        }),
        resultId,
      ),
    ));
  });
  ipcMain.handle("loci:paint-mask", async (
    event,
    sourceId: string,
    resultId: string,
    points: SourcePoint[],
    radiusPx: number,
  ) => {
    assertTrustedSender(event);
    return applyDurableCorrection(sourceId, resultId, "paint_stroke", {
      points,
      radius_px: radiusPx,
    });
  });
  ipcMain.handle("loci:erase-mask", async (
    event,
    sourceId: string,
    resultId: string,
    points: SourcePoint[],
    radiusPx: number,
  ) => {
    assertTrustedSender(event);
    return applyDurableCorrection(sourceId, resultId, "erase_stroke", {
      points,
      radius_px: radiusPx,
    });
  });
  ipcMain.handle("loci:move-boundary-vertex", async (
    event,
    sourceId: string,
    resultId: string,
    target: SourcePoint,
    vertices: SourcePoint[],
  ) => {
    assertTrustedSender(event);
    return applyDurableCorrection(sourceId, resultId, "move_boundary_vertex", {
      x: target?.x,
      y: target?.y,
      points: vertices,
    });
  });
  ipcMain.handle("loci:list-profiles", async (event) => {
    assertTrustedSender(event);
    const raw = await engine.request<{ profiles: unknown[] }>("list_profiles", {});
    if (!raw || !Array.isArray(raw.profiles)) {
      throw new Error("The analysis engine returned an invalid profile list.");
    }
    return raw.profiles.map(mapProfile);
  });
  ipcMain.handle("loci:cellpose-status", async (event, profileIdValue: unknown) => {
    assertTrustedSender(event);
    const profileId = requireCellposeProfileId(profileIdValue);
    return mapCellposeStatus(await engine.request<any>("cellpose_status", {
      profile_id: profileId,
    }), profileId);
  });
  ipcMain.handle("loci:import-cellpose-model", async (event, profileIdValue: unknown) => {
    assertTrustedSender(event);
    const profileId = requireCellposeProfileId(profileIdValue);
    const model = CELLPOSE_MODELS[profileId];
    const defaultPath = await cellposeImportDialogDefaultDirectory(profileId);
    const options: OpenDialogOptions = {
      title: `Import verified ${model.label} checkpoint`,
      buttonLabel: "Verify and import",
      ...(defaultPath ? { defaultPath } : {}),
      properties: ["openFile"],
    };
    const selection = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    if (selection.canceled || !selection.filePaths[0]) return null;
    return mapCellposeStatus(await engine.request<any>("import_cellpose_model", {
      path: selection.filePaths[0],
      profile_id: profileId,
    }), profileId);
  });
  ipcMain.handle("loci:open-cellpose-model-page", async (event, profileIdValue: unknown) => {
    assertTrustedSender(event);
    const profileId = requireCellposeProfileId(profileIdValue);
    await shell.openExternal(CELLPOSE_MODELS[profileId].page);
  });
  ipcMain.handle("loci:open-cellpose-model-folder", async (event, profileIdValue: unknown) => {
    assertTrustedSender(event);
    const profileId = requireCellposeProfileId(profileIdValue);
    const location = await openCellposeModelImportDirectory(profileId);
    return location;
  });
  ipcMain.handle(
    "loci:segment",
    async (
      event,
      request: { sourceId: string; settings: AnalysisSettings; profileId?: string },
    ) => {
      assertTrustedSender(event);
      assertProjectOperationIdle();
      if (!request || typeof request.sourceId !== "string" || !request.settings) {
        throw new Error("The segmentation request is invalid.");
      }
      if (request.profileId !== undefined && (typeof request.profileId !== "string" || !request.profileId)) {
        throw new Error("The segmentation profile selection is invalid.");
      }
      return segmentWithDurableJob(request);
    },
  );
  ipcMain.handle("loci:create-batch-run", (event, request: unknown) => {
    assertTrustedSender(event);
    assertProjectOperationIdle();
    return createDurableBatchRun(request);
  });
  ipcMain.handle("loci:list-recoverable-batch-runs", (event) => {
    assertTrustedSender(event);
    return listRecoverableBatchRuns();
  });
  ipcMain.handle("loci:resume-batch-run", (event, batchId: unknown) => {
    assertTrustedSender(event);
    assertProjectOperationIdle();
    return resumeDurableBatchRun(batchId);
  });
  ipcMain.handle("loci:begin-batch-run-item", (event, batchId: unknown, sourceId: unknown) => {
    assertTrustedSender(event);
    return beginDurableBatchItem(batchId, sourceId);
  });
  ipcMain.handle(
    "loci:complete-batch-run-item",
    (event, batchId: unknown, sourceId: unknown, resultId: unknown) => {
      assertTrustedSender(event);
      return completeDurableBatchItem(batchId, sourceId, resultId);
    },
  );
  ipcMain.handle(
    "loci:fail-batch-run-item",
    (event, batchId: unknown, sourceId: unknown, failureSummary: unknown) => {
      assertTrustedSender(event);
      return failDurableBatchItem(batchId, sourceId, failureSummary);
    },
  );
  ipcMain.handle("loci:finish-batch-run", (event, batchId: unknown, cancelled: unknown) => {
    assertTrustedSender(event);
    return finishDurableBatchRun(batchId, cancelled);
  });
  ipcMain.handle("loci:cancel-analysis", async (event) => {
    assertTrustedSender(event);
    const batch = activeBatchRunId ? activeBatchRuns.get(activeBatchRunId) : undefined;
    const analysisCancelled = await cancelActiveAnalysisJob();
    const batchCancelled = batch
      ? Boolean(await cancelDurableBatchRun(batch))
      : false;
    return { cancelled: analysisCancelled || batchCancelled };
  });
  ipcMain.handle("loci:export-view", async (
    event,
    sourceId: string,
    exportOptionsValue: unknown,
  ) => {
    assertTrustedSender(event);
    const grant = requireSourceGrant(sourceId);
    const exportOptions = validatedViewerExportOptions(exportOptionsValue);
    const defaultDirectory =
      await rememberedDialogDirectory("export") ?? path.dirname(grant.path);
    const defaultPath = path.join(
      defaultDirectory,
      suggestedViewerExportFilename(grant.name, exportOptions.format),
    );
    const pngFilter = { name: "PNG image", extensions: ["png"] };
    const tiffFilter = { name: "TIFF image", extensions: ["tif", "tiff"] };
    const options: SaveDialogOptions = {
      title: "Export rendered view",
      buttonLabel: "Export view",
      defaultPath,
      filters: exportOptions.format === "png"
        ? [pngFilter, tiffFilter]
        : [tiffFilter, pngFilter],
    };
    const selection = mainWindow
      ? await dialog.showSaveDialog(mainWindow, options)
      : await dialog.showSaveDialog(options);
    if (selection.canceled || !selection.filePath) return null;

    const target = resolvedViewerExportTarget(selection.filePath, exportOptions.format);
    const canonicalDirectory = await fs.realpath(target.directory);
    const directoryStat = await fs.stat(canonicalDirectory, { bigint: true });
    if (!directoryStat.isDirectory()) {
      throw new Error("The selected viewer export folder is no longer available.");
    }
    await rememberDialogDirectory("export", canonicalDirectory);
    const expectedPath = path.join(canonicalDirectory, target.filename);
    const { blackPoint, whitePoint, ...commonSettings } = exportOptions.settings;
    const raw = await engine.request<RawViewerExportReceipt>("export_view", {
      path: grant.path,
      expected_sha256: grant.expectedSha256,
      directory: canonicalDirectory,
      directory_identity: {
        device: directoryStat.dev.toString(),
        inode: directoryStat.ino.toString(),
      },
      filename: target.filename,
      format: target.format,
      settings: {
        ...commonSettings,
        black_point: blackPoint,
        white_point: whitePoint,
      },
    });
    const receipt = mapViewerExportReceipt(raw, expectedPath);
    markSourceFingerprintVerified(grant, receipt.sourceSha256);
    return receipt;
  });
  ipcMain.handle("loci:export-result", async (
    event,
    sourceId: string,
    resultId: string,
    exportOptionsValue: unknown,
  ) => {
    assertTrustedSender(event);
    requireSourceGrant(sourceId);
    requireResultForSource(resultId, sourceId);
    const exportOptions = validatedExportOptions(exportOptionsValue);
    const defaultPath = await rememberedDialogDirectory("export");
    const options: OpenDialogOptions = {
      title: "Export Loci analysis",
      buttonLabel: "Export here",
      ...(defaultPath ? { defaultPath } : {}),
      properties: ["openDirectory", "createDirectory"],
    };
    const destination = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    if (destination.canceled || !destination.filePaths[0]) return null;
    await rememberDialogDirectory("export", destination.filePaths[0]);
    const raw = await withDurableResult(sourceId, resultId, () =>
      engine.request<RawExportReceipt>("export", {
        result_id: resultId,
        directory: destination.filePaths[0],
        options: engineExportOptions(exportOptions),
      }));
    return mapExportReceipt(raw);
  });
  ipcMain.handle("loci:begin-batch-export", (event, exportOptions: unknown) => {
    assertTrustedSender(event);
    assertProjectOperationIdle();
    return beginBatchExport(exportOptions);
  });
  ipcMain.handle(
    "loci:export-batch-result",
    async (event, batchId: string, sourceId: string, resultId: string) => {
      assertTrustedSender(event);
      const batch = batchSessions.get(batchId);
      if (!batch) throw new Error("This batch export session has expired.");
      if (batch.finalizing) {
        throw new Error("This batch export is already being finalized.");
      }
      const operation = (async (): Promise<ExportReceipt> => {
        const grant = requireSourceGrant(sourceId);
        requireResultForSource(resultId, sourceId);
        const cellCount = resultCounts.get(resultId);
        if (!Number.isInteger(cellCount) || cellCount! < 0) {
          throw new Error("The cached result count is unavailable. Run segmentation again.");
        }
        const selectedPerImageOptions = engineExportOptions(batch.exportOptions, { batch: true });
        const hasPerImageArtifact = Object.values(selectedPerImageOptions).some(Boolean);
        if (!hasPerImageArtifact) {
          batch.successes.push({
            sourceRelativePath: grant.relativePath,
            outputDirectory: ".",
            files: [],
            cellCount: cellCount!,
          });
          return {
            directory: batch.outputDirectory,
            files: {},
            cellCount: cellCount!,
          } satisfies ExportReceipt;
        }
        const directory = containedBatchDirectoryPath(
          batch.outputDirectory,
          grant.relativePath,
        );
        const raw = await withDurableResult(sourceId, resultId, () =>
          engine.request<RawExportReceipt>("export", {
            result_id: resultId,
            directory,
            allowed_root: batch.outputDirectory,
            allowed_root_identity: {
              device: batch.outputDevice,
              inode: batch.outputInode,
            },
            basename: path.parse(path.basename(grant.relativePath)).name,
            options: selectedPerImageOptions,
          }));
        await assertExportReceiptContained(
          batch.outputDirectory,
          raw.directory,
          Object.values(raw.files),
        );
        const receipt = mapExportReceipt(raw);
        batch.successes.push({
          sourceRelativePath: grant.relativePath,
          outputDirectory: portableRelativePath(path.relative(batch.outputDirectory, receipt.directory)),
          files: Object.values(receipt.files).map((filePath) =>
            portableRelativePath(path.relative(batch.outputDirectory, filePath))),
          cellCount: receipt.cellCount ?? cellCount!,
        });
        return receipt;
      })();
      const settlement = operation.then(
        () => undefined,
        () => undefined,
      );
      batch.activeExports.add(settlement);
      void settlement.finally(() => batch.activeExports.delete(settlement));
      return operation;
    },
  );
  ipcMain.handle(
    "loci:finish-batch-export",
    (event, batchId: string, failures: BatchExportFailure[], cancelled: boolean) => {
      assertTrustedSender(event);
      return scheduleBatchFinalization(batchId, failures, Boolean(cancelled));
    },
  );
  ipcMain.handle("loci:get-window-presentation", (event) => {
    assertTrustedSender(event);
    return currentWindowPresentation();
  });
  ipcMain.on("loci:session-state", (event, state: unknown) => {
    assertTrustedSender(event);
    rendererSessionState = validatedSessionState(state);
  });
  ipcMain.on("loci:quit-project-save-completed", (event, result: unknown) => {
    assertTrustedSender(event);
    quitProjectSaveCoordinator.settle(result);
  });
  ipcMain.on("loci:request-quit", (event) => {
    assertTrustedSender(event);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
    else app.quit();
  });
}

function installMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin"
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              {
                label: "Settings…",
                accelerator: "CmdOrCtrl+,",
                click: () => mainWindow?.webContents.send("loci:settings-requested"),
              },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              {
                label: "Quit Loci",
                accelerator: "CmdOrCtrl+Q",
                click: () => {
                  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
                  else app.quit();
                },
              },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "Open Project…",
          accelerator: "CmdOrCtrl+Shift+P",
          click: () => mainWindow?.webContents.send("loci:open-project-requested"),
        },
        {
          label: "Save Project",
          accelerator: "CmdOrCtrl+S",
          click: () => mainWindow?.webContents.send("loci:save-project-requested"),
        },
        { type: "separator" },
        {
          label: "Import Images…",
          accelerator: "CmdOrCtrl+O",
          click: () => mainWindow?.webContents.send("loci:import-requested"),
        },
        {
          label: "Import Folder…",
          accelerator: "CmdOrCtrl+Shift+O",
          click: () => mainWindow?.webContents.send("loci:folder-import-requested"),
        },
        ...(process.platform === "darwin"
          ? []
          : [
              { type: "separator" as const },
              {
                label: "Settings…",
                accelerator: "CmdOrCtrl+,",
                click: () => mainWindow?.webContents.send("loci:settings-requested"),
              },
            ]),
        { type: "separator" },
        process.platform === "darwin"
          ? { role: "close" }
          : {
              label: "Quit Loci",
              accelerator: "CmdOrCtrl+Q",
              click: () => {
                if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
                else app.quit();
              },
            },
      ],
    },
    { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    {
      label: "View",
      submenu: [
        ...(MAIN_WINDOW_VITE_DEV_SERVER_URL
          ? [{ role: "reload" as const }, { role: "toggleDevTools" as const }, { type: "separator" as const }]
          : []),
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }, ...(process.platform === "darwin" ? [{ type: "separator" as const }, { role: "front" as const }] : [])] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function installContentSecurityPolicy(): void {
  const development = Boolean(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  const policy = development
    ? "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; connect-src 'self' ws: http:; font-src 'self' data:"
    : "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [policy],
      },
    });
  });
}

async function confirmWindowClose(window: BrowserWindow): Promise<boolean> {
  const sourceCount = sourceGrants.size;
  if (sourceCount === 0 && !rendererSessionState.isRunning && !rendererSessionState.projectDirty) return true;
  const sourceDetail = sourceCount === 1
    ? "1 image is open in this session."
    : `${sourceCount.toLocaleString()} images are open in this session.`;
  const runningDetail = rendererSessionState.isRunning
    ? "The active analysis will be stopped. "
    : "";
  const projectDetail = rendererSessionState.projectDirty
    ? "Loci will save the latest project changes before quitting. "
    : "";
  const result = await dialog.showMessageBox(window, {
    type: rendererSessionState.isRunning ? "warning" : "question",
    title: "Quit Loci?",
    message: rendererSessionState.isRunning
      ? "An analysis is still running."
      : "Close this Loci session?",
    detail: `${runningDetail}${projectDetail}${sourceDetail} Source images remain unchanged.`,
    buttons: ["Quit Loci", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  return result.response === 0;
}

async function requestRendererProjectSave(window: BrowserWindow): Promise<QuitProjectSaveOutcome> {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return "renderer-unavailable";
  const contents = window.webContents;
  const rendererUnavailable = () => quitProjectSaveCoordinator.rendererUnavailable();
  contents.once("destroyed", rendererUnavailable);
  try {
    return await quitProjectSaveCoordinator.request((request) => {
      if (contents.isDestroyed()) throw new Error("Renderer is unavailable.");
      contents.send("loci:quit-project-save-requested", request);
    }, (request) => {
      if (!contents.isDestroyed()) {
        contents.send("loci:quit-project-save-cancelled", request);
      }
    });
  } finally {
    contents.removeListener("destroyed", rendererUnavailable);
  }
}

async function confirmQuitWithoutSaving(
  window: BrowserWindow,
  outcome: Exclude<QuitProjectSaveOutcome, "saved">,
): Promise<boolean> {
  const timedOut = outcome === "timed-out";
  const result = await dialog.showMessageBox(window, {
    type: "warning",
    title: "Project changes are not saved",
    message: timedOut
      ? "Loci is still waiting for the project save."
      : "Loci could not save the latest project changes.",
    detail:
      "Keep working to retry without losing changes. Quit Without Saving discards changes made " +
      "since the last verified project save; source images remain unchanged.",
    buttons: ["Keep Working", "Quit Without Saving"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  return result.response === 1;
}

async function prepareApplicationQuit(window: BrowserWindow): Promise<boolean> {
  if (!await confirmWindowClose(window)) return false;
  return shouldQuitAfterProjectSave(
    Boolean(activeProject),
    () => requestRendererProjectSave(window),
    async (outcome) => {
      const discard = await confirmQuitWithoutSaving(window, outcome);
      if (!discard) quitProjectSaveCoordinator.resumeSavingAfterCancelledRequest();
      return discard;
    },
  );
}

function requestConfirmedApplicationQuit(window: BrowserWindow): void {
  if (closePromptOpen) return;
  closePromptOpen = true;
  void prepareApplicationQuit(window)
    .then((confirmed) => {
      if (!confirmed) return;
      closeConfirmed = true;
      app.quit();
    })
    .finally(() => {
      closePromptOpen = false;
    });
}

async function promptForStalledShutdown(): Promise<"keep-waiting" | "force-quit"> {
  const options = {
    type: "warning" as const,
    title: "Loci is still finishing local work",
    message: "An export or model operation is taking longer than expected.",
    detail:
      "Keep waiting to let it finish cleanly. Force Quit leaves source images unchanged, " +
      "but the unfinished export or model import may be discarded.",
    buttons: ["Keep Waiting", "Force Quit"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const result = mainWindow && !mainWindow.isDestroyed()
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options);
  return result.response === 1 ? "force-quit" : "keep-waiting";
}

async function createWindow(): Promise<void> {
  const state = await readWindowState();
  const { fullscreen, maximized, ...bounds } = state;
  const window = new BrowserWindow({
    ...bounds,
    minWidth: 1024,
    minHeight: 720,
    show: false,
    title: "Loci",
    backgroundColor: "#111614",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow = window;
  trackWindowState(window);
  const notifyPresentation = () => {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send(
        "loci:window-presentation-changed",
        currentWindowPresentation(window),
      );
    }
  };
  window.on("maximize", notifyPresentation);
  window.on("unmaximize", notifyPresentation);
  window.on("enter-full-screen", notifyPresentation);
  window.on("leave-full-screen", notifyPresentation);
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isLociManualLink(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    const current = window.webContents.getURL();
    if (url !== current) event.preventDefault();
  });
  window.once("ready-to-show", () => {
    window.show();
    notifyPresentation();
  });
  window.on("close", (event) => {
    if (closeConfirmed || quitAfterEngineDrain) return;
    event.preventDefault();
    requestConfirmedApplicationQuit(window);
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    await window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    await window.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }
  if (maximized) window.maximize();
  if (fullscreen) window.setFullScreen(true);
}

if (ownsSingleInstanceLock) {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

app.whenReady().then(async () => {
  if (!ownsSingleInstanceLock) return;
  installContentSecurityPolicy();
  workingResultRetentionStore = await openWorkingResultRetentionStore(
    path.join(app.getPath("userData"), "working-results"),
  );
  jobStore = await openDurableJobStore();
  localJobExecutor = new LocalJobExecutor(jobStore, { notify: notifyJobsChanged });
  batchRunStore = new BatchRunStore(path.join(app.getPath("userData"), "batch-runs-v1"));
  const workingResultOwnershipRecovered = await recoverWorkingResultOwnershipAtStartup();
  registerIpc();
  installMenu();
  await createWindow();
  if (workingResultOwnershipRecovered) void workingResultRetentionStore.collectGarbage().then((receipt) => {
    if (
      receipt.blockedReasons.length ||
      receipt.diagnostics.overQuotaBytes > 0 ||
      receipt.failedDeletionCount > 0
    ) {
      console.warn("Loci working-result cleanup needs attention.", {
        blockedReasons: receipt.blockedReasons,
        overQuotaBytes: receipt.diagnostics.overQuotaBytes,
        failedDeletionCount: receipt.failedDeletionCount,
      });
    }
  }).catch((error) =>
    console.error("Loci skipped working-result cleanup because its safety checks failed.", error));

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      closeConfirmed = false;
      rendererSessionState = { sourceCount: 0, resultCount: 0, isRunning: false, projectDirty: false };
      void createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

let quitAfterEngineDrain = false;
let engineDrainStarted = false;

async function finishApplicationQuit(): Promise<void> {
  const cleanShutdown = (async () => {
    await researchBridge.dispose();
    await finalizeOpenBatchesForShutdown();
    for (const record of [...activeBatchRuns.values()]) {
      await cancelDurableBatchRun(record, "Batch cancelled because Loci is closing.")
        .catch((error) => console.error("Loci could not finalize a durable batch during shutdown.", error));
    }
    await batchFinalizations.drain();
    await batchRunStore?.drain();
    await drainResultRetentionForShutdown({
      drainResultLifecycle: () => resultLifecycleOperations.drain(),
      drainProjectOperations: () => projectSourceOperations.drainProjects(),
      cancelActiveAnalysis: async () => {
        await cancelActiveAnalysisJob().catch(() => false);
      },
      drainLocalJobs: () => localJobExecutor?.drain() ?? Promise.resolve(),
      disposeEngine: () => engine.dispose(),
      releaseSessionReferences: releaseSessionWorkingResults,
    });
    await jobStore?.drain();
  })();
  const outcome = await waitForShutdownDecision(
    cleanShutdown,
    promptForStalledShutdown,
    SHUTDOWN_GRACE_MILLISECONDS,
  );
  if (outcome.kind === "failed") {
    console.error("Loci could not cleanly stop its analysis engine.", outcome.error);
  }
  if (outcome.kind === "force-quit") {
    researchBridge.forceDispose();
    engine.forceDispose();
    quitAfterEngineDrain = true;
    app.exit(0);
    return;
  }
  quitAfterEngineDrain = true;
  app.quit();
}

app.on("before-quit", (event) => {
  if (quitAfterEngineDrain) return;
  event.preventDefault();
  if (!closeConfirmed) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      requestConfirmedApplicationQuit(mainWindow);
    } else if (!activeProject) {
      closeConfirmed = true;
      app.quit();
    } else {
      console.error("Loci kept the application open because the active project could not be saved without a renderer.");
    }
    return;
  }
  if (engineDrainStarted) return;
  engineDrainStarted = true;
  // Finalize every still-open session as cancelled, including any per-image
  // export already in flight, before sealing the tracker and stopping the
  // serial worker used by the path-safe metadata publisher.
  void finishApplicationQuit().catch((error) => {
    console.error("Loci could not present its shutdown choice.", error);
    engine.forceDispose();
    quitAfterEngineDrain = true;
    app.exit(0);
  });
});

app.on("web-contents-created", (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
});
