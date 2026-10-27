import type { ScientificExportPreview, ScientificExportReceipt } from "../shared/scientific-export-contracts";
import { app, dialog, ipcMain } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { totalmem } from "node:os";
import { checkedVisionRequest, checkedVisionReceipt } from "../shared/vision-handoff";
import { recipeResources } from "../shared/recipe-resources";
import {
  ManagedResearchSessionStore,
  type ManagedSessionState,
} from "./managed-research-session";
import { assertResearchRequestBound } from "./research-request-limits";
import { prepareLegacyProjectImport } from "./legacy-project-adapter";
import {
  assertExportReceiptContained,
  canonicalizeBatchRoot,
  containedBatchDirectoryPath,
  createContainedBatchDirectory,
  isLociExportBundleDirectory,
} from "./batch-safety";
import { serializeCountSummaryCsv } from "./count-csv";
import {
  createResearchBatchId,
  createResearchBatchKey,
  originalResearchBatchTask,
  requireResearchBatchId,
  requireResearchJobId,
  researchBatchRetryCandidates,
  researchJobsForBatch,
  validateResearchBatchTasks,
} from "./research-batch";
import { exportStatisticsFigureBundle } from "./statistics-figure-export";
import { publishVolumeFigureBundle, checkedVolumeFigureRequest } from "./volume-figure-export";
import { QUEUED_VIEW_OPERATIONS, ViewerRequestQueue } from "./viewer-request-queue";
import {
  ResearchViewAccess,
  type ImageViewAccess,
} from "./research-view-access";
import type { ImageViewTargetSnapshot } from "../shared/image-view-contracts";
import type {
  ResearchBatchReceipt,
  ResearchJob,
  ResearchResult,
  ResearchSnapshot,
} from "../shared/research-contracts";

import {
  EngineWorkerClient,
  sanitizedWorkerErrorMessage,
} from "./worker-client";

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const MAX_FOLDER_SOURCES = 10_000;
const MAX_FOLDER_ENTRIES = 50_000;
const MAX_FOLDER_DEPTH = 64;
const MAX_FOLDER_PATH_BYTES = 4 * 1024 * 1024;
const FOLDER_IMAGE_EXTENSIONS = new Set([
  ".tif", ".tiff", ".ims", ".png", ".jpg", ".jpeg", ".nii", ".nrrd",
  ".nhdr", ".svs", ".ndpi",
]);

interface SourceAnnotationBinding {
  source_id: string;
  source_sha256: string;
  expected_revision: number;
}

interface PickedResearchSources {
  paths: string[];
  relativePaths: string[];
  /** Native-only picker grant; never returned to renderer state. */
  importRoot?: string;
}

type DroppedResearchSelection =
  | { route: "files"; picked: PickedResearchSources }
  | { route: "ome_zarr"; picked: PickedResearchSources }
  | { route: "study"; path: string }
  | { route: "legacy"; path: string };

interface ResearchBatchExportBinding {
  source_id: string;
  source_sha256: string;
  result_id: string;
  revision_hash: string;
}

interface ResearchBatchExportPlanItem {
  source_id: string;
  result_id: string;
  revision_hash: string;
  source_relative_path: string;
  export_basename: string;
  object_count: number;
}

function checkedBatchExportBindings(value: unknown): ResearchBatchExportBinding[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_FOLDER_SOURCES)
    throw new Error("Choose between 1 and 10000 reviewed result revisions.");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
        Object.keys(item).sort().join(",") !== "result_id,revision_hash,source_id,source_sha256")
      throw new Error("The reviewed batch export selection is invalid.");
    const binding = item as Record<string, unknown>;
    if (typeof binding.source_id !== "string" || !/^[a-f0-9]{32}$/u.test(binding.source_id) ||
        typeof binding.result_id !== "string" || !/^[a-f0-9]{32}$/u.test(binding.result_id) ||
        typeof binding.source_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(binding.source_sha256) ||
        typeof binding.revision_hash !== "string" || !/^[a-f0-9]{64}$/u.test(binding.revision_hash))
      throw new Error("The reviewed batch export selection is invalid.");
    return binding as unknown as ResearchBatchExportBinding;
  });
}

function requireSourceAnnotationBinding(value: unknown): SourceAnnotationBinding {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !==
        "expected_revision,source_id,source_sha256")
    throw new Error("Choose the current source annotation revision.");
  const binding = value as Record<string, unknown>;
  if (typeof binding.source_id !== "string" || !/^[a-f0-9]{32}$/.test(binding.source_id) ||
      typeof binding.source_sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(binding.source_sha256) ||
      typeof binding.expected_revision !== "number" ||
      !Number.isSafeInteger(binding.expected_revision) || binding.expected_revision < 0)
    throw new Error("Choose the current source annotation revision.");
  return binding as unknown as SourceAnnotationBinding;
}

function isFolderImage(filePath: string): boolean {
  const lower = filePath.toLocaleLowerCase("en-US");
  return FOLDER_IMAGE_EXTENSIONS.has(path.extname(lower)) || lower.endsWith(".nii.gz");
}

async function collectImageFolder(rootPath: string): Promise<string[]> {
  const root = await fs.lstat(rootPath).catch(() => null);
  if (!root || root.isSymbolicLink() || !root.isDirectory()) {
    throw new Error("The selected image folder is unavailable or is not a plain directory.");
  }
  if (path.extname(rootPath).toLocaleLowerCase("en-US") === ".zarr") {
    throw new Error("Choose the OME-Zarr import route for a Zarr image directory.");
  }

  let entriesSeen = 0;
  let pathBytes = 0;
  let containsDicom = false;
  const images: string[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_FOLDER_DEPTH) {
      throw new Error("The selected image folder exceeds the supported nesting depth.");
    }
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en-US", { numeric: true }));
    if (entries.some((entry) => entry.name === ".zgroup" || entry.name === "zarr.json")) {
      throw new Error("The folder contains an OME-Zarr image. Import that directory with the OME-Zarr route.");
    }
    for (const entry of entries) {
      entriesSeen += 1;
      if (entriesSeen > MAX_FOLDER_ENTRIES) {
        throw new Error("The selected image folder contains too many entries to inspect safely.");
      }
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const candidate = path.join(directory, entry.name);
      pathBytes += Buffer.byteLength(candidate, "utf8");
      if (pathBytes > MAX_FOLDER_PATH_BYTES) {
        throw new Error("The selected image folder contains too much path metadata to inspect safely.");
      }
      if (entry.isDirectory()) {
        if (path.extname(entry.name).toLocaleLowerCase("en-US") === ".zarr") {
          throw new Error("The folder contains an OME-Zarr image. Import that directory with the OME-Zarr route.");
        }
        if (!(await isLociExportBundleDirectory(candidate))) {
          await visit(candidate, depth + 1);
        }
      } else if (entry.isFile()) {
        const extension = path.extname(entry.name).toLocaleLowerCase("en-US");
        if (extension === ".dcm" || extension === ".ima") containsDicom = true;
        if (isFolderImage(candidate)) {
          images.push(candidate);
          if (images.length > MAX_FOLDER_SOURCES) {
            throw new Error("The selected folder contains more than 10,000 supported images. Choose a smaller folder.");
          }
        }
      }
    }
  };
  await visit(rootPath, 0);
  if (containsDicom) {
    throw new Error("The folder contains DICOM files. Select one series with the DICOM import route.");
  }
  if (images.length === 0) {
    throw new Error("No supported research images were found in the selected folder.");
  }
  return images;
}

/** Only the trusted main process chooses study, input and export paths. */
export class ResearchBridge {
  private readonly worker = new EngineWorkerClient();
  private readonly control = new EngineWorkerClient();
  private viewer = new EngineWorkerClient();
  private readonly compute = new EngineWorkerClient();
  private viewerQueue = this.createViewerQueue();
  private readonly sessions = new ManagedResearchSessionStore(app.getPath("userData"));
  private project: string | null = null;
  private sessionId: string | null = null;
  private running: { id: string; project: string } | null = null;
  private switching = false;
  private dataExportActive: { key: string; project: string; stage: "plan" | "export"; cancelled: boolean; jobId?: string; finished: Promise<void>; finish: () => void } | null = null;
  private viewDocumentEpoch = 0;
  private readonly viewDocumentListeners = new Set<() => void>();
  private vendorGrants = new Map<string, {
    project: string; source: string; jar: string; java: string; sourceSha256: string;
  }>();
  private readonly viewAccess = new ResearchViewAccess({
    documentState: () => ({
      project: this.project,
      epoch: this.viewDocumentEpoch,
      switching: this.switching,
    }),
    snapshot: (project) => this.engineSnapshot(project),
    executeControl: (project, operation, request) =>
      this.control.request("research_execute", { project, operation, request }),
    executeViewer: (project, operation, request, lane, scope) =>
      this.viewerQueue.request(operation, { project, operation, request }, lane, scope),
    cancelViewerScope: (scope, error) => this.viewerQueue.cancelScope(scope, error),
  });

  private requireProject(): string {
    if (!this.project) throw new Error("Create or open a study first.");
    return this.project;
  }

  private createViewerQueue(): ViewerRequestQueue {
    return new ViewerRequestQueue((_operation, params) =>
      this.viewer.request("research_execute", params as Record<string, unknown>, 0));
  }

  private replaceViewDocument(project: string | null, sessionId: string | null): void {
    this.project = project;
    this.sessionId = sessionId;
    this.vendorGrants.clear();
    this.viewDocumentEpoch += 1;
    for (const listener of [...this.viewDocumentListeners]) listener();
  }

  private async remember(project: string): Promise<void> {
    const state = await this.sessions.rememberOpened(
      project,
      path.basename(project, ".loci-study"),
    );
    this.replaceViewDocument(project, state.sessionId);
  }

  private async snapshot(): Promise<unknown> {
    if (!this.project) {
      const resolved = await this.sessions.resolveActive();
      if (!resolved.projectPath || resolved.state.status !== "ready") return null;
      const candidate = await this.control.request("research_snapshot", {
        project: resolved.projectPath,
      }) as { jobs?: Array<{ state: string }> } | null;
      const hasQueuedJobs = Boolean(
        candidate?.jobs?.some((j) => j.state === "queued" || j.state === "running"),
      );
      if (!hasQueuedJobs) {
        return null;
      }
      this.replaceViewDocument(resolved.projectPath, resolved.state.sessionId);
      return candidate;
    }
    return this.control.request("research_snapshot", {
      project: this.requireProject(),
    });
  }

  /** Private main-process identity for layout scoping; never expose it to a renderer. */
  getViewDocumentIdentity(): string | null {
    return this.project;
  }

  /** Subscribe the main coordinator to synchronous study replacement invalidation. */
  onViewDocumentChanged(listener: () => void): () => void {
    if (typeof listener !== "function") throw new Error("Document listener must be a function.");
    this.viewDocumentListeners.add(listener);
    return () => this.viewDocumentListeners.delete(listener);
  }

  getViewSnapshot(): Promise<ResearchSnapshot> {
    return this.viewAccess.getSnapshot();
  }

  executeImageView(
    target: ImageViewTargetSnapshot,
    operation: unknown,
    request: unknown,
    options?: unknown,
    access: ImageViewAccess = "read",
    assertTargetCurrent?: () => void,
  ): Promise<unknown> {
    return this.viewAccess.execute(
      target,
      operation,
      request,
      options,
      access,
      assertTargetCurrent,
    );
  }

  cancelImageView(viewId: string): void {
    this.viewAccess.cancel(viewId);
  }

  private async sessionState(): Promise<ManagedSessionState> {
    return (await this.sessions.resolveActive()).state;
  }

  private pickerOptions(kind: unknown): Parameters<typeof dialog.showOpenDialog>[0] {
    if (kind !== "files" && kind !== "folder" && kind !== "dicom" && kind !== "ome_zarr")
      throw new Error("Choose a supported image import route.");
    return {
      title:
        kind === "dicom"
          ? "Select all files from one DICOM image series"
          : kind === "ome_zarr"
            ? "Select an OME-Zarr image directory"
            : kind === "folder"
              ? "Select a folder of research images"
              : "Add microscopy or medical images",
      properties:
        kind === "ome_zarr" || kind === "folder"
          ? ["openDirectory"]
          : ["openFile", "multiSelections"],
      filters:
        kind === "dicom"
          ? [
              { name: "DICOM series files", extensions: ["dcm", "ima"] },
              { name: "All files", extensions: ["*"] },
            ]
          : kind === "ome_zarr" || kind === "folder"
            ? undefined
            : [
                {
                  name: "Research images",
                  extensions: [
                    "tif", "tiff", "ims", "png", "jpg", "jpeg", "nii",
                    "gz", "nrrd", "nhdr", "svs", "ndpi",
                  ],
                },
              ],
    };
  }

  private async pickedSources(kind: unknown): Promise<PickedResearchSources | null> {
    const picked = await dialog.showOpenDialog(this.pickerOptions(kind));
    if (picked.canceled || picked.filePaths.length === 0) return null;
    if (kind === "folder") {
      const paths = await collectImageFolder(picked.filePaths[0]);
      return { paths, importRoot: picked.filePaths[0], relativePaths: paths.map((item) =>
        path.relative(picked.filePaths[0], item).split(path.sep).join("/")) };
    }
    return { paths: picked.filePaths, relativePaths: picked.filePaths.map((item) => path.basename(item)) };
  }

  private async choose(create: boolean): Promise<unknown> {
    if (this.running || this.switching)
      throw new Error("Finish or cancel the active study operation first.");
    this.switching = true;
    try {
      let candidate: string;
      if (create) {
        const picked = await dialog.showSaveDialog({
          title: "Create research study",
          defaultPath: "Untitled study.loci-study",
          buttonLabel: "Create study",
          filters: [{ name: "Loci study", extensions: ["loci-study"] }],
        });
        if (picked.canceled || !picked.filePath) return null;
        candidate = picked.filePath.endsWith(".loci-study")
          ? picked.filePath
          : picked.filePath + ".loci-study";
        await this.control.request("research_create", {
          path: candidate,
          title: path.basename(candidate, ".loci-study"),
        });
      } else {
        const picked = await dialog.showOpenDialog({
          title: "Open research study",
          properties: ["openDirectory"],
        });
        if (picked.canceled || !picked.filePaths[0]) return null;
        candidate = picked.filePaths[0];
        await this.control.request("research_snapshot", { project: candidate });
      }
      await this.remember(candidate);
      return this.snapshot();
    } finally {
      this.switching = false;
    }
  }

  private async addSources(kind: unknown = "files"): Promise<unknown> {
    const project = this.requireProject();
    if (this.switching)
      throw new Error("Wait for the study to finish opening.");
    const picked = await this.pickedSources(kind);
    if (!picked) return this.snapshot();
    return this.control.request(
      "research_import",
      {
        project,
        paths: picked.paths,
        relative_paths: picked.relativePaths,
        ...(picked.importRoot ? { import_root: picked.importRoot } : {}),
        kind: kind === "dicom" ? "dicom" : kind === "ome_zarr" ? "ome_zarr" : "files",
      },
      0,
    );
  }

  private async openImages(kind: unknown = "files"): Promise<unknown> {
    if (this.running || this.switching)
      throw new Error("Finish or cancel the active study operation first.");
    this.switching = true;
    try {
      const picked = await this.pickedSources(kind);
      if (!picked) return null;
      return await this.importSelectedPaths(picked, kind);
    } finally {
      this.switching = false;
    }
  }

  private async importSelectedPaths(picked: PickedResearchSources, kind: unknown): Promise<unknown> {
    const { paths, relativePaths } = picked;
    let project = this.project;
    if (!project) {
      const title = path.basename(paths[0]).replace(/\.[^.]+$/u, "") || "Untitled study";
      const reservation = await this.sessions.reserve(title);
      try {
        await this.control.request("research_create", {
          path: reservation.projectPath,
          title,
        });
      } catch (error) {
        this.sessions.release(reservation);
        throw error;
      }
      const state = await this.sessions.adopt(reservation);
      project = reservation.projectPath;
      this.replaceViewDocument(project, state.sessionId);
    }
    return await this.control.request(
      "research_import",
      {
        project,
        paths,
        relative_paths: relativePaths,
        ...(picked.importRoot ? { import_root: picked.importRoot } : {}),
        kind: kind === "dicom" ? "dicom" : kind === "ome_zarr" ? "ome_zarr" : "files",
      },
      0,
    );
  }

  private async checkedDroppedPaths(value: unknown): Promise<DroppedResearchSelection> {
    // These strings are produced by Electron webUtils.getPathForFile in the
    // isolated preload. They are still bounded and rechecked here before main
    // grants them to the engine.
    if (!Array.isArray(value) || value.length < 1 || value.length > 10_000 ||
        Buffer.byteLength(JSON.stringify(value), "utf8") > 1024 * 1024) {
      throw new Error("Drop between 1 and 10000 local images.");
    }
    const paths: string[] = [];
    for (const candidate of value) {
      if (typeof candidate !== "string" || CONTROL_CHARACTER.test(candidate) ||
          !path.isAbsolute(candidate) || path.normalize(candidate) !== candidate) {
        throw new Error("A dropped image location is invalid.");
      }
      const stat = await fs.lstat(candidate).catch(() => null);
      if (!stat || stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
        throw new Error("Dropped items must be plain local files or directories.");
      paths.push(candidate);
    }
    if (paths.length > 1) {
      for (const item of paths) {
        const stat = await fs.lstat(item);
        if (!stat.isFile() || !isFolderImage(item))
          throw new Error("Drop multiple items only when every item is a supported image file.");
      }
      return { route: "files", picked: {
        paths,
        relativePaths: paths.map((item) => path.basename(item)),
      } };
    }
    const selected = paths[0];
    const stat = await fs.lstat(selected);
    const lower = selected.toLocaleLowerCase("en-US");
    if (stat.isDirectory()) {
      if (lower.endsWith(".loci-study")) return { route: "study", path: selected };
      if (lower.endsWith(".zarr")) return { route: "ome_zarr", picked: {
        paths: [selected], relativePaths: [path.basename(selected)],
      } };
      const sources = await collectImageFolder(selected);
      return { route: "files", picked: {
        paths: sources,
        importRoot: selected,
        relativePaths: sources.map((item) => path.relative(selected, item).split(path.sep).join("/")),
      } };
    }
    if (lower.endsWith(".loci-project")) return { route: "legacy", path: selected };
    if (!isFolderImage(selected))
      throw new Error("Drop a supported image, image folder, Loci study, or legacy Loci project.");
    return { route: "files", picked: {
      paths: [selected], relativePaths: [path.basename(selected)],
    } };
  }

  private async importLegacyPath(selected: string): Promise<unknown> {
    const prepared = await prepareLegacyProjectImport(
      selected,
      path.join(app.getPath("userData"), "working-results"),
    );
    let project = this.project;
    if (!project) {
      const reservation = await this.sessions.reserve(prepared.legacy_project.title);
      try {
        await this.control.request("research_create", {
          path: reservation.projectPath,
          title: prepared.legacy_project.title,
        });
      } catch (error) {
        this.sessions.release(reservation);
        throw error;
      }
      const state = await this.sessions.adopt(reservation);
      project = reservation.projectPath;
      this.replaceViewDocument(project, state.sessionId);
    }
    return this.control.request("research_import_legacy_project", {
      project,
      ...prepared,
    }, 0);
  }

  private async execute(
    operation: unknown,
    request: unknown,
    options?: unknown,
  ): Promise<unknown> {
    const project = this.requireProject();
    // The export picker pins this same study; display-only autosaves retain their
    // normal source fingerprint/revision checks and do not change scientific data.
    const exportViewSave = operation === "save_source_view" &&
      this.dataExportActive?.stage === "export" && this.dataExportActive.project === project;
    if (this.switching && !exportViewSave)
      throw new Error("Wait for the study to finish opening.");
    if (
      typeof operation !== "string" ||
      !request ||
      typeof request !== "object" ||
      Array.isArray(request)
    ) {
      throw new Error("Invalid research operation.");
    }
    let viewerLane = "default";
    let taskKey: string | undefined;
    if (options !== undefined) {
      const guided = ["exploration_preview", "exploration_compare", "exploration_run"].includes(operation);
      if (guided && options && typeof options === "object" && !Array.isArray(options) && Object.keys(options).join(",") === "request_key") {
        const key = (options as Record<string, unknown>).request_key;
        if (typeof key !== "string" || !/^exploration:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(key)) throw new Error("Invalid exploration task key.");
        taskKey = key;
      } else {
        if (!QUEUED_VIEW_OPERATIONS.has(operation) || !options || typeof options !== "object" ||
            Array.isArray(options) || Object.keys(options).join(",") !== "viewer_lane")
          throw new Error("Invalid viewer scheduling options.");
        const lane = (options as Record<string, unknown>).viewer_lane;
        if (typeof lane !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(lane)) throw new Error("Invalid viewer scheduling lane.");
        viewerLane = lane;
      }
    }
    assertResearchRequestBound(operation, request);
    if (operation.startsWith("remote_")) {
      const epoch = this.viewDocumentEpoch;
      const output = await this.compute.request("research_execute", { project, operation, request }, 0);
      if (this.project !== project || this.viewDocumentEpoch !== epoch)
        throw new Error("The compute request belongs to a study that is no longer open. Its progress is saved in that study.");
      return output;
    }
    if (operation === "describe_result") {
      const binding = request as Record<string, unknown>;
      if (Object.keys(binding).sort().join(",") !== "result_id,revision_hash" ||
          typeof binding.result_id !== "string" || !/^[a-f0-9]{32}$/u.test(binding.result_id) ||
          typeof binding.revision_hash !== "string" || !/^[a-f0-9]{64}$/u.test(binding.revision_hash))
        throw new Error("Result description needs an exact result and revision binding.");
      const epoch = this.viewDocumentEpoch;
      const output = await this.control.request("research_execute", { project, operation, request });
      if (this.project !== project || this.viewDocumentEpoch !== epoch)
        throw new Error("The result-description study changed during inspection.");
      return output;
    }
    if (operation === "viewer_defaults") {
      return this.control.request("research_execute", { project, operation, request });
    }
    if (QUEUED_VIEW_OPERATIONS.has(operation)) {
      return this.viewerQueue.request(operation, { project, operation, request }, viewerLane);
    }
    const taskOperations = new Set([
      "workflow_run",
      "exploration_preview",
      "exploration_compare",
      "exploration_run",
      "workflow_preview",
      "run_recipe",
      "large_components_run",
      "large_result_delete",
      "large_result_adopt",
      "large_result_export",
      "preview_recipe",
      "histology_run",
      "histology_preview",
      "tissue_preview",
      "tissue_run",
      "model_run",
      "model_preview",
      "classical_run",
      "cellpose_run",
      "correct_result",
      "labels_import",
      "roi_add",
      "roi_import",
      "track_results",
      "correct_tracks",
      "registration_preview",
      "registration_run",
      "resample_grid",
      "puncta_preview",
      "puncta_run",
      "field_assay_preview",
      "field_assay_run",
      "perinuclear_run",
      "associate_results",
      "colocalisation_run",
    ]);
    if (!taskOperations.has(operation)) {
      return this.control.request("research_execute", {
        project,
        operation,
        request,
      });
    }
    if (this.running) throw new Error("A local study job is already running.");
    // Reserve before awaiting submission so two renderer calls cannot share the worker.
    this.running = { id: "submitting", project };
    try {
      const job = await this.control.request<{ id: string }>(
        "research_submit",
        {
          project,
          request,
          request_key: taskKey ?? randomUUID(),
          operation,
        },
      );
      this.running.id = job.id;
      return await this.worker.request(
        "research_run",
        { project, job_id: job.id },
        0,
      );
    } finally {
      this.running = null;
    }
  }

  private async engineSnapshot(project: string): Promise<ResearchSnapshot> {
    return this.control.request<ResearchSnapshot>("research_snapshot", { project });
  }

  private async submitBatch(value: unknown): Promise<ResearchBatchReceipt> {
    if (this.running || this.switching) {
      throw new Error("Finish or cancel the active study operation first.");
    }
    const project = this.requireProject();
    this.switching = true;
    try {
      const snapshot = await this.engineSnapshot(project);
      const tasks = validateResearchBatchTasks(value, snapshot.sources);
      for (const task of tasks) assertResearchRequestBound(task.operation, task.request);

      // Validate every workflow target before publishing any queued job. A
      // later incompatible image must not leave a partially submitted batch.
      for (const task of tasks) {
        if (task.operation === "workflow_run") {
          await this.control.request("research_execute", {
            project, operation: "workflow_preflight", request: task.request,
          });
        }
      }

      const batchId = createResearchBatchId();
      const jobs: ResearchJob[] = [];
      // Every exact task is durably submitted before the renderer may start
      // the first item. A restart can therefore recover all untouched queued work.
      for (const [index, task] of tasks.entries()) {
        jobs.push(await this.control.request<ResearchJob>("research_submit", {
          project,
          request: task.request,
          request_key: createResearchBatchKey(batchId, "initial", index),
          operation: task.operation,
        }));
      }
      return { batch_id: batchId, jobs };
    } finally {
      this.switching = false;
    }
  }

  private async prepareExistingBatch(
    batchIdValue: unknown,
    phase: "resume" | "retry",
  ): Promise<ResearchBatchReceipt> {
    if (this.running || this.switching) {
      throw new Error("Finish or cancel the active study operation first.");
    }
    const batchId = requireResearchBatchId(batchIdValue);
    const project = this.requireProject();
    this.switching = true;
    try {
      // Snapshot reconciliation turns a lost executor into an honest
      // interrupted state before a researcher explicitly resumes it.
      let snapshot = await this.engineSnapshot(project);
      const existing = researchJobsForBatch(snapshot.jobs, batchId);
      if (!existing.length) throw new Error("The durable batch is not part of this study.");
      const candidates = researchBatchRetryCandidates(snapshot.jobs, batchId, phase);
      const tasks = candidates.map((candidate) => originalResearchBatchTask(candidate, snapshot.sources));
      for (const task of tasks) {
        assertResearchRequestBound(task.operation, task.request);
        if (task.operation === "workflow_run") {
          await this.control.request("research_execute", {
            project, operation: "workflow_preflight", request: task.request,
          });
        }
      }
      for (const task of tasks) {
        await this.control.request<ResearchJob>("research_submit", {
          project,
          request: task.request,
          request_key: createResearchBatchKey(batchId, phase),
          operation: task.operation,
        });
      }
      snapshot = await this.engineSnapshot(project);
      return { batch_id: batchId, jobs: researchJobsForBatch(snapshot.jobs, batchId) };
    } finally {
      this.switching = false;
    }
  }

  private async runBatchJob(batchIdValue: unknown, jobIdValue: unknown): Promise<unknown> {
    if (this.running || this.switching) {
      throw new Error("Finish or cancel the active study operation first.");
    }
    const batchId = requireResearchBatchId(batchIdValue);
    const jobId = requireResearchJobId(jobIdValue);
    const project = this.requireProject();
    const snapshot = await this.engineSnapshot(project);
    const job = researchJobsForBatch(snapshot.jobs, batchId).find((item) => item.id === jobId);
    if (!job) throw new Error("The selected job does not belong to this durable batch.");
    if (job.state !== "queued") return { job };

    this.running = { id: job.id, project };
    try {
      return await this.worker.request(
        "research_run",
        { project, job_id: job.id },
        0,
      );
    } finally {
      this.running = null;
    }
  }

  private async exportReviewedBatch(bindingsValue: unknown, optionsValue: unknown): Promise<unknown> {
    if (this.running || this.switching)
      throw new Error("Finish or cancel the active study operation first.");
    const bindings = checkedBatchExportBindings(bindingsValue);
    if (!optionsValue || typeof optionsValue !== "object" || Array.isArray(optionsValue) ||
        Object.keys(optionsValue).join(",") !== "mode" ||
        !["bundles", "bundles+summary", "summary-only"].includes(
          String((optionsValue as { mode?: unknown }).mode),
        ))
      throw new Error("Choose exact reviewed batch export contents.");
    const mode = (optionsValue as {
      mode: "bundles" | "bundles+summary" | "summary-only";
    }).mode;
    const project = this.requireProject();
    this.switching = true;
    try {
      const plan = await this.control.request<{ items: ResearchBatchExportPlanItem[] }>(
        "research_batch_export_plan", { project, bindings }, 0,
      );
      const picked = await dialog.showOpenDialog({
        title: "Choose a destination for reviewed batch results",
        buttonLabel: "Export reviewed batch",
        properties: ["openDirectory", "createDirectory"],
      });
      if (picked.canceled || !picked.filePaths[0]) return null;

      const root = await canonicalizeBatchRoot(picked.filePaths[0]);
      const rootStat = await fs.stat(root, { bigint: true });
      const targets = [] as Array<{ item: ResearchBatchExportPlanItem; target: string }>;
      const targetKeys = new Set<string>();
      if (mode !== "summary-only") {
        for (const item of plan.items) {
          // The engine owns portable filename normalization. Preflight and
          // publication must use its exact bounded basename, including suffix.
          if (typeof item.export_basename !== "string" || item.export_basename.length > 80 ||
              !/^[A-Za-z0-9][A-Za-z0-9._-]*_loci$/u.test(item.export_basename))
            throw new Error("The engine returned an invalid reviewed bundle name.");
          const parent = containedBatchDirectoryPath(root, item.source_relative_path);
          const target = path.join(parent, item.export_basename);
          const targetKey = target.normalize("NFC").toLocaleLowerCase("en-US");
          if (targetKeys.has(targetKey))
            throw new Error("Selected sources resolve to the same mirrored batch output.");
          targetKeys.add(targetKey);
          if (await fs.lstat(target).then(() => true, () => false))
            throw new Error(`A reviewed bundle already exists for ${path.basename(item.source_relative_path)}.`);
          targets.push({ item, target });
        }
      }

      const startedAt = new Date().toISOString();
      const outputs = [] as Array<Record<string, unknown>>;
      for (const { item, target } of targets) {
        await createContainedBatchDirectory(root, item.source_relative_path);
        const receipt = await this.control.request<{
          export_name: string;
          manifest_sha256: string;
          files: Array<{ name: string; sha256: string; size_bytes: number }>;
          result_id: string;
          revision_hash: string;
        }>("research_export", {
          project,
          result_id: item.result_id,
          revision_hash: item.revision_hash,
          destination: target,
        }, 0);
        if (receipt.result_id !== item.result_id || receipt.revision_hash !== item.revision_hash ||
            receipt.export_name !== item.export_basename)
          throw new Error("The engine exported a different result revision or bundle name.");
        await assertExportReceiptContained(
          root,
          target,
          receipt.files.map((file) => path.join(target, file.name)),
        );
        outputs.push({
          source_id: item.source_id,
          source_relative_path: item.source_relative_path,
          result_id: item.result_id,
          revision_hash: item.revision_hash,
          output_directory: path.relative(root, target).split(path.sep).join("/"),
          manifest_sha256: receipt.manifest_sha256,
          files: receipt.files,
        });
      }

      const completedAt = new Date().toISOString();
      const finalPlan = await this.control.request<{ items: ResearchBatchExportPlanItem[] }>(
        "research_batch_export_plan", { project, bindings }, 0,
      );
      if (JSON.stringify(finalPlan.items) !== JSON.stringify(plan.items))
        throw new Error("The reviewed batch selection changed during export.");
      const batchId = randomUUID();
      const stamp = completedAt.replaceAll(/[:.]/gu, "-");
      const summaryName = mode === "bundles" ? null : `loci_count_summary_${stamp}_${batchId.slice(0, 8)}.csv`;
      const manifestName = `loci_batch_manifest_${stamp}_${batchId.slice(0, 8)}.json`;
      const files: Record<string, string> = {};
      if (summaryName) {
        files[summaryName] = serializeCountSummaryCsv(plan.items.map((item) => ({
          imageName: item.source_relative_path,
          cellCount: item.object_count,
        })));
      }
      files[manifestName] = `${JSON.stringify({
        schema: "loci.research-batch-export/v1",
        product: "Loci",
        status: "completed",
        started_at: startedAt,
        completed_at: completedAt,
        exported_count: outputs.length,
        selected_results: plan.items,
        outputs,
        count_summary: summaryName,
      }, null, 2)}\n`;
      await this.control.request("publish_batch_metadata", {
        allowed_root: root,
        allowed_root_identity: { device: rootStat.dev.toString(), inode: rootStat.ino.toString() },
        files,
      }, 0);
      return {
        exportedCount: outputs.length,
        selectedCount: plan.items.length,
        mode,
        manifestName,
        summaryName,
      };
    } finally {
      this.switching = false;
    }
  }

  private async exportReviewPackage(bindingsValue: unknown, optionsValue: unknown): Promise<unknown> {
    if (this.running || this.switching)
      throw new Error("Finish or cancel the active study operation first.");
    const bindings = checkedBatchExportBindings(bindingsValue);
    if (!optionsValue || typeof optionsValue !== "object" || Array.isArray(optionsValue) ||
        Object.keys(optionsValue).join(",") !== "rootLabel")
      throw new Error("Choose an explicit review package name.");
    const label = (optionsValue as { rootLabel?: unknown }).rootLabel;
    if (typeof label !== "string" || !label.trim() || label !== label.trim() ||
        Buffer.byteLength(label, "utf8") > 120 || label.startsWith(".") || label.endsWith(".") ||
        /[\u0000-\u001f\u007f/\\:<>"|?*]/u.test(label) || label.normalize("NFC") !== label ||
        /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu.test(label))
      throw new Error("Choose a portable review package name of 1-120 UTF-8 bytes.");
    const project = this.requireProject();
    const epoch = this.viewDocumentEpoch;
    this.switching = true;
    try {
      const picked = await dialog.showOpenDialog({
        title: "Choose a parent folder for the review package",
        buttonLabel: "Export review package",
        properties: ["openDirectory", "createDirectory"],
      });
      if (picked.canceled || !picked.filePaths[0]) return null;
      if (!path.isAbsolute(picked.filePaths[0]) || this.project !== project ||
          this.viewDocumentEpoch !== epoch)
        throw new Error("The review package study or destination changed.");
      return await this.control.request("research_review_package_export", {
        project,
        request: { bindings, root_label: label },
        destination: path.join(picked.filePaths[0], label),
      }, 0);
    } finally {
      this.switching = false;
    }
  }

  private dataExportKey(value: unknown): string {
    if (typeof value !== "string" || !/^scientific-export:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value))
      throw new Error("Choose a unique scientific export request key.");
    return value;
  }

  private beginDataExport(key: string, project: string, stage: "plan" | "export"): NonNullable<ResearchBridge["dataExportActive"]> {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const active = { key, project, stage, cancelled: false, finished, finish };
    this.dataExportActive = active;
    return active;
  }

  async planDataExport(request: unknown, keyValue: unknown): Promise<ScientificExportPreview> {
    const key = this.dataExportKey(keyValue);
    if (this.running || this.switching) throw new Error("Finish or cancel the active study operation first.");
    const project = this.requireProject(), epoch = this.viewDocumentEpoch;
    const active = this.beginDataExport(key, project, "plan");
    this.running = { id: "scientific-data-plan", project };
    try {
      const response = await this.worker.request<ScientificExportPreview>("research_data_export_plan", { project, request }, 0);
      if (active.cancelled) throw new Error("Scientific export preparation cancelled.");
      if (this.project !== project || this.viewDocumentEpoch !== epoch)
        throw new Error("The study changed during export preparation.");
      if (!response || typeof response.plan_json !== "string" || response.plan_json.length > 8 * 1024 ** 2 ||
          !response.plan || !/^[0-9a-f]{64}$/u.test(response.plan.plan_sha256))
        throw new Error("The engine returned an invalid scientific export plan.");
      return response;
    } catch (error) {
      if (active.cancelled) throw new Error("Scientific export preparation cancelled.");
      throw error;
    } finally {
      if (this.dataExportActive === active) { this.dataExportActive = null; this.running = null; }
      active.finish();
    }
  }

  async exportDataPackage(planJson: unknown, keyValue: unknown): Promise<ScientificExportReceipt | null> {
    const key = this.dataExportKey(keyValue);
    if (typeof planJson !== "string" || !planJson || Buffer.byteLength(planJson, "utf8") > 8 * 1024 ** 2)
      throw new Error("Prepare a current scientific export plan first.");
    if (this.running || this.switching) throw new Error("Finish or cancel the active study operation first.");
    const project = this.requireProject(), epoch = this.viewDocumentEpoch;
    const active = this.beginDataExport(key, project, "export");
    this.running = { id: "scientific-data-export", project };
    this.switching = true;
    try {
      const picked = await dialog.showSaveDialog({ title: "Export scientific data package", defaultPath: "Loci-data", buttonLabel: "Export data" });
      if (active.cancelled) throw new Error("Scientific data export cancelled.");
      if (picked.canceled || !picked.filePath) return null;
      if (!path.isAbsolute(picked.filePath) || this.project !== project || this.viewDocumentEpoch !== epoch)
        throw new Error("The export study or destination changed.");
      const grant = await this.control.request<{ grant_id: string; plan_sha256: string; source_id: string; export_name: string }>(
        "research_data_export_grant", { project, plan_json: planJson, destination: picked.filePath }, 0);
      if (active.cancelled) throw new Error("Scientific data export cancelled before submission.");
      const job = await this.control.request<{ id: string }>("research_submit", {
        project, operation: "scientific_data_export", request: { grant_id: grant.grant_id, plan_sha256: grant.plan_sha256 }, request_key: key,
      });
      active.jobId = job.id;
      this.running.id = job.id;
      this.switching = false;
      if (active.cancelled) { await this.cancel(job.id); throw new Error("Scientific data export cancelled before execution."); }
      const receipt = await this.worker.request<ScientificExportReceipt>("research_run", { project, job_id: job.id }, 0);
      if (receipt.basename !== grant.export_name || !/^[0-9a-f]{64}$/u.test(receipt.manifest_sha256))
        throw new Error("The engine returned an invalid scientific export receipt.");
      // Private native paths and the grant never cross into renderer state.
      return { schema: receipt.schema, basename: receipt.basename, purpose: receipt.purpose,
        manifest_sha256: receipt.manifest_sha256, result_count: receipt.result_count,
        source_count: receipt.source_count, selected_count: receipt.selected_count };
    } finally {
      if (this.dataExportActive === active) { this.dataExportActive = null; this.running = null; this.switching = false; }
      active.finish();
    }
  }

  async cancelDataExport(keyValue: unknown): Promise<{ cancelled: boolean }> {
    const key = this.dataExportKey(keyValue), active = this.dataExportActive;
    if (!active || active.key !== key || active.project !== this.project) return { cancelled: false };
    if (active.jobId) {
      const job = await this.cancel(active.jobId);
      // A completed publication must retain its receipt even if Cancel arrives late.
      if (!job.cancel_requested || !["running", "cancelled"].includes(job.state)) return { cancelled: false };
      active.cancelled = true;
      // The bounded exporter polls this durable flag and removes its owned stage.
      // Killing the worker would prevent that cleanup or lose a published receipt.
    } else {
      active.cancelled = true;
      if (active.stage === "plan") this.worker.cancelCurrent();
    }
    return { cancelled: true };
  }

  async planIntensityExport(reportId: unknown, keyValue: unknown): Promise<unknown> {
    const key = this.dataExportKey(keyValue);
    if (typeof reportId !== "string" || !/^[a-f0-9]{32}$/u.test(reportId))
      throw new Error("Choose an exact saved intensity comparison.");
    if (this.running || this.switching) throw new Error("Finish or cancel the active study operation first.");
    const project = this.requireProject(), epoch = this.viewDocumentEpoch;
    const active = this.beginDataExport(key, project, "plan");
    this.running = { id: "intensity-report-plan", project };
    try {
      const response = await this.worker.request<import("../shared/intensity-contracts").IntensityExportPlan>("research_intensity_export_plan", { project, report_id: reportId }, 0);
      if (active.cancelled) throw new Error("Intensity export preparation cancelled.");
      if (this.project !== project || this.viewDocumentEpoch !== epoch) throw new Error("The study changed during preparation.");
      if (!response || response.schema !== "loci.intensity-export-plan/v1" ||
          response.report_id !== reportId || typeof response.report_hash !== "string" ||
          !/^[a-f0-9]{64}$/u.test(response.report_hash) || response.report_hash.slice(0, 32) !== reportId ||
          typeof response.plan_hash !== "string" || !/^[a-f0-9]{64}$/u.test(response.plan_hash) ||
          !response.status || typeof response.status.current !== "boolean" ||
          !Array.isArray(response.status.changes) || response.status.changes.length > 100 ||
          response.status.changes.some(row => !row || typeof row.result_id !== "string" ||
            !/^[a-f0-9]{32}$/u.test(row.result_id) || typeof row.reason !== "string" || row.reason.length > 2048))
        throw new Error("The engine returned an invalid intensity export preview.");
      return { schema: response.schema, report_id: response.report_id, report_hash: response.report_hash,
        plan_hash: response.plan_hash, status: { current: response.status.current,
          changes: response.status.changes.map(row => ({ result_id: row.result_id, reason: row.reason })) } };
    } finally {
      if (this.dataExportActive === active) { this.dataExportActive = null; this.running = null; }
      active.finish();
    }
  }

  async exportIntensityReport(reportId: unknown, planHash: unknown, keyValue: unknown): Promise<unknown> {
    const key = this.dataExportKey(keyValue);
    if (typeof reportId !== "string" || !/^[a-f0-9]{32}$/u.test(reportId) ||
        typeof planHash !== "string" || !/^[a-f0-9]{64}$/u.test(planHash))
      throw new Error("Preview an exact saved comparison before exporting.");
    if (this.running || this.switching) throw new Error("Finish or cancel the active study operation first.");
    const project = this.requireProject(), epoch = this.viewDocumentEpoch;
    const active = this.beginDataExport(key, project, "export");
    this.running = { id: "intensity-report-export", project }; this.switching = true;
    try {
      const picked = await dialog.showSaveDialog({ title: "Export intensity comparison", defaultPath: "Loci-intensity", buttonLabel: "Export report" });
      if (active.cancelled) throw new Error("Intensity report export cancelled.");
      if (picked.canceled || !picked.filePath) return null;
      if (!path.isAbsolute(picked.filePath) || this.project !== project || this.viewDocumentEpoch !== epoch)
        throw new Error("The report study or destination changed.");
      const grant = await this.control.request<{ grant_id: string; plan_hash: string; basename: string }>(
        "research_intensity_export_grant", { project, report_id: reportId, plan_hash: planHash, destination: picked.filePath }, 0);
      if (active.cancelled) throw new Error("Intensity report export cancelled before submission.");
      const job = await this.control.request<{ id: string }>("research_submit", {
        project, operation: "intensity_export", request: { grant_id: grant.grant_id, plan_hash: grant.plan_hash }, request_key: key,
      });
      active.jobId = job.id; this.running.id = job.id; this.switching = false;
      if (active.cancelled) { await this.cancel(job.id); throw new Error("Intensity report export cancelled before execution."); }
      const receipt = await this.worker.request<{ schema: string; basename: string; report_hash: string; manifest_sha256: string }>("research_run", { project, job_id: job.id }, 0);
      if (receipt.schema !== "loci.intensity-export-receipt/v1" || receipt.basename !== grant.basename ||
          !/^[a-f0-9]{64}$/u.test(receipt.manifest_sha256) || typeof receipt.report_hash !== "string" ||
          !/^[a-f0-9]{64}$/u.test(receipt.report_hash) || receipt.report_hash.slice(0, 32) !== reportId)
        throw new Error("The engine returned an invalid intensity export receipt.");
      return { schema: receipt.schema, basename: receipt.basename, report_hash: receipt.report_hash, manifest_sha256: receipt.manifest_sha256 };
    } finally {
      if (this.dataExportActive === active) { this.dataExportActive = null; this.running = null; this.switching = false; }
      active.finish();
    }
  }

  private async cancel(id: unknown): Promise<ResearchJob> {
    if (typeof id !== "string" || !/^[0-9a-f]{32}$/.test(id))
      throw new Error("Invalid job identity.");
    const project = this.requireProject();
    const result = await this.control.request<ResearchJob>("research_cancel", {
      project,
      job_id: id,
    });
    const active = this.dataExportActive;
    if (active?.jobId === id && active.project === project) {
      // Every job entrypoint must let export cleanup and receipt recording finish.
      if (result.cancel_requested && ["running", "cancelled"].includes(result.state))
        active.cancelled = true;
    } else if (this.running?.id === id && this.running.project === project) {
      this.worker.cancelCurrent();
    }
    return result;
  }

  /** Identity/options only: canonical measurements and artwork stay in the worker. */
  async exportStatisticsFigure(value: unknown): Promise<unknown> {
    const project = this.requireProject();
    if (this.running || this.switching) throw new Error("Wait for the active study operation to finish.");
    this.switching = true;
    try {
      return await exportStatisticsFigureBundle({
        request: value,
        applicationVersion: app.getVersion(),
        verifyPopulation: (request) => this.control.request("research_execute", {
          project, operation: "population_query",
          request: { ...request.query, result_id: request.result_id, revision_hash: request.revision_hash },
        }, 0),
        pickDestination: async () => {
          const picked = await dialog.showSaveDialog({
            title: "Export statistics figure", defaultPath: "Statistics figure.loci-figure",
            filters: [{ name: "Loci figure bundle", extensions: ["loci-figure"] }],
          });
          return picked.canceled || !picked.filePath ? null : picked.filePath;
        },
        publish: (request, destination, application_version) => this.control.request(
          "research_statistics_figure_export", { project, request, destination, application_version }, 0,
        ),
      });
    } finally { this.switching = false; }
  }

  /** Main-only figure publication; detached callers add their captured-view guard. */
  async exportVolumeFigure(value: unknown, assertTargetCurrent?: () => void): Promise<unknown> {
      assertTargetCurrent?.();
      const project = this.requireProject();
      if (this.running || this.switching) throw new Error("Wait for the active study operation to finish.");
      const record = value as { source_id?: unknown; source_sha256?: unknown } | null;
      if (!record || typeof record.source_id !== "string" || !/^[a-f0-9]{32}$/.test(record.source_id) ||
          typeof record.source_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.source_sha256))
        throw new Error("Volume figure export needs an exact source binding.");
      const expected = { source_id: record.source_id, source_sha256: record.source_sha256 };
      this.switching = true;
      try {
        const registeredSource = await this.control.request("research_execute", {
          project, operation: "source_view", request: { source_id: expected.source_id },
        }, 0) as typeof expected;
        assertTargetCurrent?.();
        const request = checkedVolumeFigureRequest(value, registeredSource);
        const picked = await dialog.showSaveDialog({
          title: "Export volume figure",
          defaultPath: "Volume figure.loci-figure",
          filters: [{ name: "Loci figure bundle", extensions: ["loci-figure"] }],
        });
        if (picked.canceled || !picked.filePath) return null;
        assertTargetCurrent?.();
        // Verify the original bytes after the picker before publishing the
        // captured display and manifest. Saved preferences are not a source check.
        const verifiedSource = await this.control.request("research_execute", {
          project, operation: "verify_source", request: { source_id: expected.source_id },
        }, 0) as typeof expected;
        assertTargetCurrent?.();
        return await publishVolumeFigureBundle({
          destination: picked.filePath,
          request,
          verifiedSource,
          applicationVersion: app.getVersion(),
          publishStagedBundle: async (publication) => {
            assertTargetCurrent?.();
            const result = await this.control.request(
              "publish_volume_figure", { ...publication }, 0,
            );
            if (!result || typeof result !== "object" ||
                (result as Record<string, unknown>).published !== true)
              throw new Error("The engine did not confirm volume figure publication.");
          },
        });
      } finally { this.switching = false; }
  }

  register(trusted: (event: IpcMainInvokeEvent) => void): void {
    const handle = (
      name: string,
      operation: (...args: unknown[]) => Promise<unknown>,
    ) => {
      ipcMain.handle(
        "loci-research:" + name,
        async (event, ...args: unknown[]) => {
          trusted(event);
          try {
            return await operation(...args);
          } catch (error) {
            throw new Error(
              sanitizedWorkerErrorMessage(
                error instanceof Error ? error.message : error,
              ),
            );
          }
        },
      );
    };
    handle("recipe-resources", async () => recipeResources(totalmem()));
    handle("compute-targets", async (operation, request) => {
      if (typeof operation !== "string" ||
          !["list", "import_ssh", "save", "test", "resources", "remember", "use", "forget"].includes(operation) ||
          !request || typeof request !== "object" || Array.isArray(request))
        throw new Error("Invalid compute settings request.");
      assertResearchRequestBound("compute-targets", request);
      if (this.switching) throw new Error("Wait for the study to finish opening.");
      const project = this.project, epoch = this.viewDocumentEpoch;
      if (["remember", "use"].includes(operation)) this.requireProject();
      const output = await this.compute.request("research_compute_targets", {
        directory: path.join(app.getPath("userData"), "compute-targets-v1.loci-study"),
        operation, request, project,
      }, 0);
      if (["remember", "use", "list"].includes(operation) &&
          (this.project !== project || this.viewDocumentEpoch !== epoch))
        throw new Error("The study changed during compute setup. Reload the target list.");
      return output;
    });
    handle("create", () => this.choose(true));
    handle("open", () => this.choose(false));
    handle("snapshot", () => this.snapshot());
    handle("workspace-visibility", async (request) => {
      if (!request || typeof request !== "object" || Array.isArray(request))
        throw new Error("Choose exact images or results to close or restore.");
      assertResearchRequestBound("workspace-visibility", request);
      const project = this.requireProject();
      if (this.running || this.switching)
        throw new Error("Finish or cancel the active study operation first.");
      this.switching = true;
      try {
        return await this.control.request("research_workspace_visibility", { project, request });
      } finally { this.switching = false; }
    });
    handle("source-order", async (request) => {
      if (!request || typeof request !== "object" || Array.isArray(request))
        throw new Error("Choose an exact image order.");
      assertResearchRequestBound("source-order", request);
      const project = this.requireProject();
      if (this.running || this.switching)
        throw new Error("Finish or cancel the active study operation first.");
      return await this.control.request("research_source_order", { project, request });
    });
    handle("session-state", () => this.sessionState());
    handle("new-session", async () => {
      if (this.running || this.switching)
        throw new Error("Finish or cancel the active study operation first.");
      this.switching = true;
      try {
        await this.sessions.leaveActive();
        this.replaceViewDocument(null, null);
        return { status: "empty" };
      } finally {
        this.switching = false;
      }
    });
    handle("try-example", async (...args) => {
      if (args.length) throw new Error("The offline example does not accept source paths or settings.");
      if (this.running || this.switching)
        throw new Error("Finish or cancel the active study operation first.");
      this.switching = true;
      const reservation = await this.sessions.reserve("Synthetic shapes practice").catch((error) => {
        this.switching = false;
        throw error;
      });
      try {
        const snapshot = await this.control.request("research_create_example", { path: reservation.projectPath }, 0);
        const state = await this.sessions.adopt(reservation);
        this.replaceViewDocument(reservation.projectPath, state.sessionId);
        return snapshot;
      } catch (error) {
        this.sessions.release(reservation);
        throw error;
      } finally { this.switching = false; }
    });
    handle("open-images", (kind) => this.openImages(kind));
    handle("open-dropped", async (paths, legacyKind = "files") => {
      if (this.running || this.switching)
        throw new Error("Finish or cancel the active study operation first.");
      if (legacyKind !== "files") throw new Error("Dropped items choose their route from exact local type.");
      this.switching = true;
      try {
        const selected = await this.checkedDroppedPaths(paths);
        if (selected.route === "study") {
          const snapshot = await this.control.request("research_snapshot", { project: selected.path });
          await this.remember(selected.path);
          return snapshot;
        }
        if (selected.route === "legacy") return await this.importLegacyPath(selected.path);
        return await this.importSelectedPaths(selected.picked, selected.route);
      } finally {
        this.switching = false;
      }
    });
    handle("save-as", async () => {
      const project = this.requireProject();
      if (!this.sessionId) throw new Error("Open the active study again before saving a copy.");
      if (this.running || this.switching)
        throw new Error("Finish or cancel the active study operation first.");
      this.switching = true;
      try {
        const state = await this.sessionState();
        const title = state.status === "empty" ? "Study" : state.title;
        const picked = await dialog.showSaveDialog({
          title: "Save research study as",
          defaultPath: `${title}.loci-study`,
          buttonLabel: "Save study",
          filters: [{ name: "Loci study", extensions: ["loci-study"] }],
        });
        if (picked.canceled || !picked.filePath) return null;
        const candidate = picked.filePath.toLocaleLowerCase("en-US").endsWith(".loci-study")
          ? picked.filePath : `${picked.filePath}.loci-study`;
        const result = await this.control.request("research_project_clone", {
          project,
          destination: candidate,
        }, 0);
        const remembered = await this.sessions.rememberSaved(this.sessionId, candidate);
        this.replaceViewDocument(candidate, remembered.sessionId);
        return result;
      } finally {
        this.switching = false;
      }
    });
    handle("import-legacy-project", async () => {
      if (this.running || this.switching)
        throw new Error("Finish or cancel the active study operation first.");
      this.switching = true;
      try {
        const picked = await dialog.showOpenDialog({
          title: "Import a legacy Loci project",
          buttonLabel: "Import project",
          properties: ["openFile"],
          filters: [{ name: "Legacy Loci project", extensions: ["loci-project"] }],
        });
        if (picked.canceled || !picked.filePaths[0]) return null;
        return await this.importLegacyPath(picked.filePaths[0]);
      } finally {
        this.switching = false;
      }
    });
    handle("recovery-list", () => this.sessions.listRecovery());
    handle("recovery-keep", async (sessionId) => {
      if (this.running || this.switching)
        throw new Error("Finish or cancel the active study operation first.");
      if (typeof sessionId !== "string") throw new Error("Select a valid recovery session.");
      this.switching = true;
      try {
        const kept = await this.sessions.keep(sessionId);
        if (!kept.projectPath) throw new Error("The selected recovery session is unavailable.");
        const result = await this.control.request("research_snapshot", {
          project: kept.projectPath,
        });
        this.replaceViewDocument(kept.projectPath, sessionId);
        return result;
      } finally {
        this.switching = false;
      }
    });
    handle("recovery-discard", async (sessionId) => {
      if (this.running || this.switching)
        throw new Error("Finish or cancel the active study operation first.");
      if (typeof sessionId !== "string") throw new Error("Select a valid recovery session.");
      const receipt = await this.sessions.discard(sessionId);
      if (this.sessionId === sessionId) {
        this.replaceViewDocument(null, null);
      }
      return { discarded: true, undoToken: receipt.undoToken };
    });
    handle("recovery-undo", async (token) => {
      const state = await this.sessions.undoDiscard(token);
      const resolved = await this.sessions.resolveActive();
      this.replaceViewDocument(resolved.projectPath, state.sessionId);
      return state;
    });
    handle("cancel-view", async () => {
      this.viewerQueue.cancelPending();
      this.viewer.forceDispose(new Error("View cancelled."));
      this.viewer = new EngineWorkerClient();
      this.viewerQueue = this.createViewerQueue();
      return { cancelled: true };
    });
    handle("vendor-inspect", async () => {
      const project = this.requireProject();
      if (this.running || this.switching) throw new Error("Finish the active study operation first.");
      this.switching = true;
      try {
        const source = await dialog.showOpenDialog({
          title: "Inspect a vendor file for explicit conversion",
          properties: ["openFile"],
          filters: [{ name: "Vendor microscopy", extensions: ["czi", "nd2", "lif"] }],
        });
        if (source.canceled || !source.filePaths[0]) return null;
        const jar = await dialog.showOpenDialog({
          title: "Select the verified Bio-Formats 8.5.0 package JAR",
          properties: ["openFile"],
          filters: [{ name: "Bio-Formats package", extensions: ["jar"] }],
        });
        if (jar.canceled || !jar.filePaths[0]) return null;
        const java = await dialog.showOpenDialog({
          title: "Select your installed Java executable",
          defaultPath: process.platform === "darwin" ? "/usr/bin/java" : undefined,
          properties: ["openFile", "showHiddenFiles"],
        });
        if (java.canceled || !java.filePaths[0]) return null;
        const inspection = await this.control.request<{ source_sha256: string }>(
          "research_vendor_inspect", {
            source: source.filePaths[0], jar: jar.filePaths[0], java: java.filePaths[0],
          }, 0,
        );
        if (!/^[a-f0-9]{64}$/.test(inspection.source_sha256))
          throw new Error("Vendor inspection returned an invalid fingerprint.");
        const grantId = randomUUID();
        this.vendorGrants.clear();
        this.vendorGrants.set(grantId, {
          project, source: source.filePaths[0], jar: jar.filePaths[0],
          java: java.filePaths[0], sourceSha256: inspection.source_sha256,
        });
        return { grant_id: grantId, source_name: path.basename(source.filePaths[0]),
          source_sha256: inspection.source_sha256, inspection };
      } finally { this.switching = false; }
    });
    handle("vendor-convert", async (request) => {
      const project = this.requireProject();
      if (this.running || this.switching) throw new Error("Finish the active study operation first.");
      if (!request || typeof request !== "object" || Array.isArray(request) ||
          Buffer.byteLength(JSON.stringify(request), "utf8") > 4096)
        throw new Error("Invalid vendor conversion request.");
      const { grant_id, ...selection } = request as Record<string, unknown>;
      const grant = typeof grant_id === "string" ? this.vendorGrants.get(grant_id) : null;
      if (!grant || grant.project !== project)
        throw new Error("Inspect the selected vendor file again before conversion.");
      this.switching = true;
      try {
        const destination = await dialog.showSaveDialog({
          title: "Create a new derived OME-TIFF conversion folder",
          defaultPath: "Vendor conversion", buttonLabel: "Convert and add source",
        });
        if (destination.canceled || !destination.filePath) return null;
        return await this.control.request("research_vendor_convert", {
          project, source: grant.source, jar: grant.jar, java: grant.java,
          destination: destination.filePath, request: selection,
          expected_source_sha256: grant.sourceSha256,
        }, 0);
      } finally { this.switching = false; }
    });
    handle("export-study", async () => {
      const project = this.requireProject();
      if (this.running || this.switching) throw new Error("Finish the active study operation first.");
      const picked = await dialog.showSaveDialog({
        title: "Export portable study with derived results",
        defaultPath: "Study.loci-study.zip",
        filters: [{ name: "Loci study archive", extensions: ["zip"] }],
      });
      if (picked.canceled || !picked.filePath) return null;
      return this.control.request("research_project_export", { project, destination: picked.filePath }, 0);
    });
    handle("import-study", async () => {
      if (this.running || this.switching) throw new Error("Finish the active study operation first.");
      this.switching = true;
      try {
        const archive = await dialog.showOpenDialog({
          title: "Import portable Loci study",
          properties: ["openFile"],
          filters: [{ name: "Loci study archive", extensions: ["zip"] }],
        });
        if (archive.canceled || !archive.filePaths[0]) return null;
        const destination = await dialog.showSaveDialog({
          title: "Choose a new study directory",
          defaultPath: "Imported study.loci-study",
          filters: [{ name: "Loci study", extensions: ["loci-study"] }],
        });
        if (destination.canceled || !destination.filePath) return null;
        const candidate = destination.filePath.endsWith(".loci-study")
          ? destination.filePath : destination.filePath + ".loci-study";
        const snapshot = await this.control.request("research_project_import", {
          archive: archive.filePaths[0], destination: candidate,
        }, 0);
        await this.remember(candidate);
        return snapshot;
      } finally { this.switching = false; }
    });
    handle("relink-source", async (source_id, kind) => {
      const project = this.requireProject();
      if (this.running || this.switching) throw new Error("Finish the active study operation first.");
      if (typeof source_id !== "string" || !/^[a-f0-9]{32}$/.test(source_id) ||
          (kind !== "file" && kind !== "dicom" && kind !== "ome_zarr"))
        throw new Error("Choose a supported source to relink.");
      this.switching = true;
      try {
        const picked = await dialog.showOpenDialog({
          title: "Relink an exact local copy of the source",
          properties: kind === "ome_zarr" ? ["openDirectory"] :
            kind === "dicom" ? ["openFile", "multiSelections"] : ["openFile"],
        });
        if (picked.canceled || !picked.filePaths[0]) return null;
        await this.control.request("research_relink", {
          project, source_id, candidate: kind === "dicom" ? picked.filePaths : picked.filePaths[0],
        }, 0);
        return this.control.request("research_snapshot", { project });
      } finally { this.switching = false; }
    });
    handle("export-recipe", async (recipe_id, source_id) => {
      const project = this.requireProject();
      const picked = await dialog.showSaveDialog({
        title: "Export reusable recipe template",
        defaultPath: "Recipe.loci-recipe.json",
        filters: [{ name: "Loci recipe", extensions: ["json"] }],
      });
      if (picked.canceled || !picked.filePath) return null;
      return this.control.request("research_recipe_export", { project, recipe_id, source_id, destination: picked.filePath }, 0);
    });
    handle("import-recipe", async (bindings) => {
      const project = this.requireProject();
      if (!bindings || typeof bindings !== "object" || Array.isArray(bindings) || JSON.stringify(bindings).length > 4096)
        throw new Error("Map the recipe source roles to this study.");
      const picked = await dialog.showOpenDialog({
        title: "Import reusable recipe template",
        properties: ["openFile"],
        filters: [{ name: "Loci recipe", extensions: ["json"] }],
      });
      if (picked.canceled || !picked.filePaths[0]) return null;
      return this.control.request("research_recipe_import", {
        project, path: picked.filePaths[0], bindings, recipe_id: randomUUID().replaceAll("-", ""),
        expected_revision: 0, require_exact_sources: false,
      }, 0);
    });
    handle("export-source-view", async (value) => {
      const project = this.requireProject();
      if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(value).length > 16384)
        throw new Error("Choose a bounded source view to export.");
      const request = value as Record<string, unknown>;
      if (Object.keys(request).some((key) => !["source_id", "source_sha256", "view", "format"].includes(key)) ||
          typeof request.source_id !== "string" || !/^[a-f0-9]{32}$/.test(request.source_id) ||
          typeof request.source_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(request.source_sha256) ||
          (request.format !== "png" && request.format !== "tiff"))
        throw new Error("Rendered export needs an exact source binding.");
      if (!request.view || typeof request.view !== "object" || Array.isArray(request.view))
        throw new Error("Choose a valid source rendering request.");
      assertResearchRequestBound("viewer_tile", request.view);
      if (this.running || this.switching) throw new Error("Wait for the active study operation to finish.");
      this.switching = true;
      try {
        const tiff = request.format === "tiff";
        const picked = await dialog.showSaveDialog({
          title: tiff ? "Export rendered source TIFF" : "Export rendered source PNG",
          defaultPath: tiff ? "Rendered source.tiff" : "Rendered source.png",
          filters: [{ name: tiff ? "Rendered TIFF" : "Rendered PNG", extensions: [tiff ? "tiff" : "png"] }],
        });
        if (picked.canceled || !picked.filePath) return null;
        return await this.control.request("research_source_rendered_export", { project, request, destination: picked.filePath }, 0);
      } finally { this.switching = false; }
    });
    handle("export-statistics-figure", (value) => this.exportStatisticsFigure(value));
    handle("export-correction-effect", async (receipt_sha256) => {
      const project = this.requireProject();
      if (typeof receipt_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(receipt_sha256))
        throw new Error("Choose an exact saved correction-effect receipt.");
      if (this.running || this.switching) throw new Error("Finish the active study operation first.");
      this.switching = true;
      try {
        const picked = await dialog.showSaveDialog({
          title: "Export reviewed experiment effect report",
          defaultPath: "Experiment effect", buttonLabel: "Export report",
        });
        if (picked.canceled || !picked.filePath) return null;
        if (this.requireProject() !== project) throw new Error("The active study changed.");
        const receipt = await this.control.request<{
          receipt_sha256: string; files: string[]; manifest_sha256: string;
        }>("research_export_correction_effect", { project, receipt_sha256, destination: picked.filePath }, 0);
        if (receipt.receipt_sha256 !== receipt_sha256 || !/^[a-f0-9]{64}$/u.test(receipt.manifest_sha256) ||
            !Array.isArray(receipt.files) || !receipt.files.length || receipt.files.length > 32 ||
            !receipt.files.every(file => typeof file === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(file)))
          throw new Error("The engine returned an invalid experiment-effect export receipt.");
        return { receipt_sha256: receipt.receipt_sha256, files: receipt.files, manifest_sha256: receipt.manifest_sha256 };
      } finally { this.switching = false; }
    });
    handle("export-volume-figure", (value) => this.exportVolumeFigure(value));
    handle("export-source-annotations", async (value) => {
      const project = this.requireProject();
      const binding = requireSourceAnnotationBinding(value);
      const picked = await dialog.showSaveDialog({
        title: "Export raw source annotations",
        defaultPath: "Annotations.loci-annotations.json",
        filters: [{ name: "Loci source annotations", extensions: ["json"] }],
      });
      if (picked.canceled || !picked.filePath) return null;
      return this.control.request("research_source_annotations_export", {
        project,
        ...binding,
        destination: picked.filePath,
      }, 0);
    });
    handle("import-source-annotations", async (value) => {
      const project = this.requireProject();
      const binding = requireSourceAnnotationBinding(value);
      const picked = await dialog.showOpenDialog({
        title: "Import raw source annotations",
        properties: ["openFile"],
        filters: [{ name: "Loci source annotations", extensions: ["json"] }],
      });
      if (picked.canceled || !picked.filePaths[0]) return null;
      return this.control.request("research_source_annotations_import", {
        project,
        ...binding,
        path: picked.filePaths[0],
      }, 0);
    });
    handle("vision-handoff", async (value, sourceSha256) => {
      const project = this.requireProject();
      const request = checkedVisionRequest(value);
      if (typeof sourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(sourceSha256))
        throw new Error("Choose the exact source for this vision handoff.");
      if (this.running || this.switching) throw new Error("Finish the active study operation first.");
      this.switching = true;
      try {
        const picked = await dialog.showSaveDialog({
          title: "Export image for a vision assistant",
          defaultPath: "Loci image.loci-vision",
          buttonLabel: "Export image and context",
        });
        if (picked.canceled || !picked.filePath) return null;
        if (this.requireProject() !== project) throw new Error("The active study changed.");
        const result = await this.control.request("research_vision_handoff", {
          project, request, source_sha256: sourceSha256, destination: picked.filePath,
        }, 0);
        return checkedVisionReceipt(result, request.source_id, sourceSha256);
      } finally { this.switching = false; }
    });
    handle("agent-access", async (value) => {
      const project = this.requireProject();
      if (!value || typeof value !== "object" || Array.isArray(value) ||
          JSON.stringify(value).length > 1024 * 1024)
        throw new Error("Invalid agent access request.");
      if (this.running || this.switching)
        throw new Error("Finish or cancel the active study operation first.");
      const request = structuredClone(value) as Record<string, unknown>;
      this.switching = true;
      try {
        let exportRoot: string | null = null;
        if (request.allow_export === true || (request.interactive as Record<string, unknown> | undefined)?.allow_handoff === true) {
          const folder = await dialog.showOpenDialog({
            title: "Choose the permitted agent export folder",
            properties: ["openDirectory"],
          });
          if (folder.canceled || !folder.filePaths[0]) return null;
          exportRoot = folder.filePaths[0];
        }
        const picked = await dialog.showSaveDialog({
          title: "Create private MCP access bundle",
          defaultPath: "Loci agent access",
          buttonLabel: "Create access bundle",
        });
        if (picked.canceled || !picked.filePath) return null;
        if (this.requireProject() !== project) throw new Error("The active study changed.");
        return await this.control.request("research_agent_access", {
          project, request, destination: picked.filePath, export_root: exportRoot,
        }, 0);
      } finally { this.switching = false; }
    });
    handle("agent-session-control", async (value) => {
      const project = this.requireProject();
      if (!value || typeof value !== "object" || Array.isArray(value) ||
          JSON.stringify(value).length > 32 * 1024)
        throw new Error("Invalid agent session control request.");
      const request = structuredClone(value) as Record<string, unknown>;
      const validActions = new Set([
        "approve_request",
        "deny_request",
        "set_permission_mode",
        "pause_session",
        "resume_session",
        "stop_job",
        "disconnect_session",
        "revoke_policy",
      ]);
      if (typeof request.action !== "string" || !validActions.has(request.action))
        throw new Error("Invalid agent session control action.");
      return await this.control.request("research_agent_session_control", {
        project,
        request,
      }, 0);
    });
    handle("import", (kind) => this.addSources(kind));
    handle("import-model", async (working_bytes, recovery_model_id) => {
      if (recovery_model_id !== undefined &&
          (typeof recovery_model_id !== "string" || !/^[a-f0-9]{32}$/.test(recovery_model_id)))
        throw new Error("Select the exact managed model to recover.");
      if (
        typeof working_bytes !== "number" ||
        !Number.isSafeInteger(working_bytes) ||
        working_bytes < 1024 ** 2 ||
        working_bytes > 8 * 1024 ** 3
      )
        throw new Error(
          "Choose a model working-memory budget between 1 MiB and 8 GiB.",
        );
      const project = this.requireProject();
      const picked = await dialog.showOpenDialog({
        title: "Import a local model package",
        properties: ["openDirectory"],
      });
      if (picked.canceled || !picked.filePaths[0]) return null;
      return this.control.request(
        "research_import_model",
        { project, path: picked.filePaths[0], working_bytes,
          ...(recovery_model_id ? { recovery_model_id } : {}) },
        0,
      );
    });
    handle("execute", (operation, request, options) => this.execute(operation, request, options));
    handle("labels-import-preview", async (binding) => {
      const project = this.requireProject();
      if (this.running || this.switching) throw new Error("Finish the active study operation first.");
      if (!binding || typeof binding !== "object" || Array.isArray(binding))
        throw new Error("Select a valid native source plane.");
      const input = binding as Record<string, unknown>;
      if (Object.keys(input).sort().join(",") !== "selection,source_id,source_sha256,working_bytes" ||
          typeof input.source_id !== "string" || !/^[a-f0-9]{32}$/u.test(input.source_id) ||
          typeof input.source_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(input.source_sha256) ||
          !Number.isSafeInteger(input.working_bytes) || Number(input.working_bytes) < 1024 * 1024 ||
          Number(input.working_bytes) > 8 * 1024 ** 3)
        throw new Error("Invalid label-import binding or memory budget.");
      const plane = input.selection;
      if (!plane || typeof plane !== "object" || Array.isArray(plane) ||
          Object.keys(plane).sort().join(",") !== "c,height,level,t,width,x,y,z")
        throw new Error("Label import requires an explicit native YX plane.");
      const selection = plane as Record<string, unknown>;
      if (Object.values(selection).some((value) => !Number.isSafeInteger(value) || Number(value) < 0) ||
          selection.level !== 0 || selection.x !== 0 || selection.y !== 0 ||
          Number(selection.width) < 1 || Number(selection.height) < 1)
        throw new Error("Label import requires a full level-0 native YX grid.");
      // Reserve the captured document before awaiting the native picker or engine.
      this.switching = true;
      const epoch = this.viewDocumentEpoch;
      try {
        const picked = await dialog.showOpenDialog({
          title: "Import labels on this plane",
          properties: ["openFile"],
          filters: [{ name: "Integer label TIFF", extensions: ["tif", "tiff"] }],
        });
        if (picked.canceled || !picked.filePaths[0]) return null;
        if (this.project !== project || this.viewDocumentEpoch !== epoch)
          throw new Error("The label-import study changed while choosing the file.");
        const output = await this.control.request("research_labels_import_grant", {
          project, path: picked.filePaths[0], ...input,
        }, 0);
        if (this.project !== project || this.viewDocumentEpoch !== epoch)
          throw new Error("The label-import study changed while checking the file.");
        return output;
      } finally {
        this.switching = false;
      }
    });
    handle("batch-submit", (tasks) => this.submitBatch(tasks));
    handle("batch-run", (batchId, jobId) => this.runBatchJob(batchId, jobId));
    handle("batch-resume", (batchId) => this.prepareExistingBatch(batchId, "resume"));
    handle("batch-retry", (batchId) => this.prepareExistingBatch(batchId, "retry"));
    handle("batch-export", (bindings, options) => this.exportReviewedBatch(bindings, options));
    handle("review-package-export", (bindings, options) => this.exportReviewPackage(bindings, options));
    handle("data-export-plan", (request, key) => this.planDataExport(request, key));
    handle("data-export-package", (planJson, key) => this.exportDataPackage(planJson, key));
    handle("data-export-cancel", (key) => this.cancelDataExport(key));
    handle("intensity-export-plan", (reportId, key) => this.planIntensityExport(reportId, key));
    handle("intensity-export-package", (reportId, planHash, key) => this.exportIntensityReport(reportId, planHash, key));
    handle("cancel", (id) => this.cancel(id));
    handle("review", (result_id, revision_hash, disposition) =>
      this.control.request("research_review", {
        project: this.requireProject(),
        result_id,
        revision_hash,
        disposition,
      }),
    );
    handle("import-large-result", async (source_id) => {
      const project = this.requireProject();
      if (this.running || this.switching) {
        throw new Error("Finish the active study operation first.");
      }
      this.switching = true;
      try {
        const picked = await dialog.showOpenDialog({
          title: "Choose exported large result bundle directory",
          properties: ["openDirectory"],
        });
        if (picked.canceled || !picked.filePaths || picked.filePaths.length === 0) {
          return null;
        }
        const grant = await this.control.request<{
          grant_id: string;
          source_id: string;
          source_sha256: string;
          manifest_sha256: string;
          bundle_name: string;
        }>(
          "research_large_exchange_grant",
          {
            project,
            source_id,
            directory: picked.filePaths[0],
          },
          0,
        );
        this.running = { id: "submitting", project };
        this.switching = false;
        try {
          const job = await this.control.request<{ id: string }>(
            "research_submit",
            {
              project,
              request: {
                source_id,
                grant_id: grant.grant_id,
                manifest_sha256: grant.manifest_sha256,
              },
              request_key: randomUUID(),
              operation: "large_result_adopt",
            },
          );
          this.running.id = job.id;
          const outcome = await this.worker.request<{
            result: ResearchResult;
            measurements: Array<Record<string, unknown>>;
          }>(
            "research_run",
            { project, job_id: job.id },
            0,
          );
          const snapshot = await this.engineSnapshot(project);
          return {
            snapshot,
            result: outcome.result,
            measurements: outcome.measurements,
          };
        } finally {
          this.running = null;
        }
      } finally {
        this.switching = false;
      }
    });
    handle("export", async (result_id, revision_hash, workflow_run_id) => {
      const project = this.requireProject();
      if (workflow_run_id !== undefined &&
          (typeof workflow_run_id !== "string" || !/^[a-f0-9]{32}$/u.test(workflow_run_id))) {
        throw new Error("Choose an exact saved workflow run to export.");
      }
      if (this.running || this.switching) {
        throw new Error("Finish the active study operation first.");
      }
      this.switching = true;
      try {
        const snapshot = await this.engineSnapshot(project);
        const res = snapshot.results?.find((r) => r.id === result_id);
        if (workflow_run_id !== undefined && res?.schema === "loci.research-result/v2") {
          throw new Error("This workflow version exports ordinary quantitative results only.");
        }
        if (res?.schema === "loci.research-result/v2") {
          const picked = await dialog.showSaveDialog({
            title: "Export reviewed result bundle",
            defaultPath: "Loci result",
            buttonLabel: "Export bundle",
          });
          if (picked.canceled || !picked.filePath) return null;
          const grant = await this.control.request<{
            grant_id: string;
            result_id: string;
            revision_hash: string;
            export_name: string;
          }>(
            "research_large_export_grant",
            {
              project,
              result_id,
              revision_hash,
              destination: picked.filePath,
            },
            0,
          );
          this.running = { id: "submitting", project };
          this.switching = false;
          try {
            const job = await this.control.request<{ id: string }>(
              "research_submit",
              {
                project,
                request: {
                  result_id,
                  revision_hash,
                  grant_id: grant.grant_id,
                },
                request_key: randomUUID(),
                operation: "large_result_export",
              },
            );
            this.running.id = job.id;
            const receipt = await this.worker.request<Record<string, unknown>>(
              "research_run",
              { project, job_id: job.id },
              0,
            );
            return {
              ...receipt,
              destination: undefined,
              output_directory: undefined,
              name: grant.export_name,
            };
          } finally {
            this.running = null;
          }
        }
        const picked = await dialog.showSaveDialog({
          title: "Export reviewed result bundle",
          defaultPath: "Loci result",
          buttonLabel: "Export bundle",
        });
        if (picked.canceled || !picked.filePath) return null;
        const receipt = await this.control.request<Record<string, unknown>>(
          workflow_run_id === undefined ? "research_export" : "research_workflow_export",
          {
            project,
            result_id,
            revision_hash,
            destination: picked.filePath,
            ...(workflow_run_id === undefined ? {} : { run_id: workflow_run_id }),
          },
          0,
        );
        // Full output locators stay in main; the renderer receives a basename receipt.
        return {
          ...receipt,
          destination: undefined,
          output_directory: undefined,
          name: path.basename(picked.filePath),
        };
      } finally {
        this.switching = false;
      }
    });
  }

  async dispose(): Promise<void> {
    this.viewerQueue.cancelPending(new Error("Loci is closing."));
    const active = this.dataExportActive;
    if (active) {
      await this.cancelDataExport(active.key);
      // research_run also serves interruptible analyses. Drain this export here,
      // before disposing its worker/control, including picker/submission races.
      await active.finished;
    } else if (this.running && this.running.id !== "submitting") {
      await this.cancel(this.running.id);
    }
    await Promise.all([this.worker.dispose(), this.control.dispose(), this.viewer.dispose(), this.compute.dispose()]);
  }

  forceDispose(): void {
    this.viewerQueue.cancelPending(new Error("Loci is closing."));
    this.worker.forceDispose();
    this.control.forceDispose();
    this.viewer.forceDispose();
    this.compute.forceDispose();
  }
}
