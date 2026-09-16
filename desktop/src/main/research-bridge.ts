import { app, dialog, ipcMain } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
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
import { publishVolumeFigureBundle, checkedVolumeFigureRequest } from "./volume-figure-export";
import { VIEW_OPERATIONS, ViewerRequestQueue } from "./viewer-request-queue";
import type {
  ResearchBatchReceipt,
  ResearchJob,
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
  private viewerQueue = this.createViewerQueue();
  private readonly sessions = new ManagedResearchSessionStore(app.getPath("userData"));
  private project: string | null = null;
  private sessionId: string | null = null;
  private running: { id: string; project: string } | null = null;
  private switching = false;
  private vendorGrants = new Map<string, {
    project: string; source: string; jar: string; java: string; sourceSha256: string;
  }>();

  private requireProject(): string {
    if (!this.project) throw new Error("Create or open a study first.");
    return this.project;
  }

  private createViewerQueue(): ViewerRequestQueue {
    return new ViewerRequestQueue((_operation, params) =>
      this.viewer.request("research_execute", params as Record<string, unknown>, 0));
  }

  private async remember(project: string): Promise<void> {
    const state = await this.sessions.rememberOpened(
      project,
      path.basename(project, ".loci-study"),
    );
    this.project = project;
    this.sessionId = state.sessionId;
    this.vendorGrants.clear();
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
      this.project = resolved.projectPath;
      this.sessionId = resolved.state.sessionId;
      return candidate;
    }
    return this.control.request("research_snapshot", {
      project: this.requireProject(),
    });
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
      return { paths, relativePaths: paths.map((item) => path.relative(picked.filePaths[0], item)) };
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
      this.project = project;
      this.sessionId = state.sessionId;
      this.vendorGrants.clear();
    }
    return await this.control.request(
      "research_import",
      {
        project,
        paths,
        relative_paths: relativePaths,
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
        relativePaths: sources.map((item) => path.relative(selected, item)),
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
      this.project = project;
      this.sessionId = state.sessionId;
      this.vendorGrants.clear();
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
    if (this.switching)
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
    if (options !== undefined) {
      if (!VIEW_OPERATIONS.has(operation) || !options || typeof options !== "object" ||
          Array.isArray(options) || Object.keys(options).join(",") !== "viewer_lane")
        throw new Error("Invalid viewer scheduling options.");
      const lane = (options as Record<string, unknown>).viewer_lane;
      if (typeof lane !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(lane))
        throw new Error("Invalid viewer scheduling lane.");
      viewerLane = lane;
    }
    assertResearchRequestBound(operation, request);
    if (operation === "viewer_defaults") {
      return this.control.request("research_execute", { project, operation, request });
    }
    if (VIEW_OPERATIONS.has(operation)) {
      return this.viewerQueue.request(operation, { project, operation, request }, viewerLane);
    }
    const taskOperations = new Set([
      "run_recipe",
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
          request_key: randomUUID(),
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
      for (const candidate of candidates) {
        const task = originalResearchBatchTask(candidate, snapshot.sources);
        assertResearchRequestBound(task.operation, task.request);
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

  private async cancel(id: unknown): Promise<unknown> {
    if (typeof id !== "string" || !/^[0-9a-f]{32}$/.test(id))
      throw new Error("Invalid job identity.");
    const project = this.requireProject();
    const result = await this.control.request("research_cancel", {
      project,
      job_id: id,
    });
    if (this.running?.id === id && this.running.project === project)
      this.worker.cancelCurrent();
    return result;
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
        this.project = null;
        this.sessionId = null;
        this.vendorGrants.clear();
        return { status: "empty" };
      } finally {
        this.switching = false;
      }
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
        this.project = candidate;
        this.sessionId = remembered.sessionId;
        this.vendorGrants.clear();
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
        this.project = kept.projectPath;
        this.sessionId = sessionId;
        this.vendorGrants.clear();
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
        this.project = null;
        this.sessionId = null;
        this.vendorGrants.clear();
      }
      return { discarded: true, undoToken: receipt.undoToken };
    });
    handle("recovery-undo", async (token) => {
      const state = await this.sessions.undoDiscard(token);
      const resolved = await this.sessions.resolveActive();
      this.project = resolved.projectPath;
      this.sessionId = state.sessionId;
      this.vendorGrants.clear();
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
    handle("export-volume-figure", async (value) => {
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
        const request = checkedVolumeFigureRequest(value, registeredSource);
        const picked = await dialog.showSaveDialog({
          title: "Export volume figure",
          defaultPath: "Volume figure.loci-figure",
          filters: [{ name: "Loci figure bundle", extensions: ["loci-figure"] }],
        });
        if (picked.canceled || !picked.filePath) return null;
        // Verify the original bytes after the picker before publishing the
        // captured display and manifest. Saved preferences are not a source check.
        const verifiedSource = await this.control.request("research_execute", {
          project, operation: "verify_source", request: { source_id: expected.source_id },
        }, 0) as typeof expected;
        return await publishVolumeFigureBundle({
          destination: picked.filePath,
          request,
          verifiedSource,
          applicationVersion: app.getVersion(),
          publishStagedBundle: async (publication) => {
            const result = await this.control.request(
              "publish_volume_figure", { ...publication }, 0,
            );
            if (!result || typeof result !== "object" ||
                (result as Record<string, unknown>).published !== true)
              throw new Error("The engine did not confirm volume figure publication.");
          },
        });
      } finally { this.switching = false; }
    });
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
    handle("agent-access", async (request) => {
      const project = this.requireProject();
      if (!request || typeof request !== "object" || Array.isArray(request) ||
          JSON.stringify(request).length > 1024 * 1024)
        throw new Error("Invalid agent access request.");
      if (this.running || this.switching)
        throw new Error("Finish or cancel the active study operation first.");
      const scope = request as Record<string, unknown>;
      let exportRoot: string | null = null;
      if (scope.allow_export === true) {
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
      return this.control.request("research_agent_access", {
        project, request, destination: picked.filePath, export_root: exportRoot,
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
    handle("batch-submit", (tasks) => this.submitBatch(tasks));
    handle("batch-run", (batchId, jobId) => this.runBatchJob(batchId, jobId));
    handle("batch-resume", (batchId) => this.prepareExistingBatch(batchId, "resume"));
    handle("batch-retry", (batchId) => this.prepareExistingBatch(batchId, "retry"));
    handle("batch-export", (bindings, options) => this.exportReviewedBatch(bindings, options));
    handle("cancel", (id) => this.cancel(id));
    handle("review", (result_id, revision_hash, disposition) =>
      this.control.request("research_review", {
        project: this.requireProject(),
        result_id,
        revision_hash,
        disposition,
      }),
    );
    handle("export", async (result_id, revision_hash) => {
      const project = this.requireProject();
      const picked = await dialog.showSaveDialog({
        title: "Export reviewed result bundle",
        defaultPath: "Loci result",
        buttonLabel: "Export bundle",
      });
      if (picked.canceled || !picked.filePath) return null;
      const receipt = await this.control.request<Record<string, unknown>>(
        "research_export",
        {
          project,
          result_id,
          revision_hash,
          destination: picked.filePath,
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
    });
  }

  async dispose(): Promise<void> {
    this.viewerQueue.cancelPending(new Error("Loci is closing."));
    if (this.running && this.running.id !== "submitting")
      await this.cancel(this.running.id);
    await Promise.all([this.worker.dispose(), this.control.dispose(), this.viewer.dispose()]);
  }

  forceDispose(): void {
    this.viewerQueue.cancelPending(new Error("Loci is closing."));
    this.worker.forceDispose();
    this.control.forceDispose();
    this.viewer.forceDispose();
  }
}
