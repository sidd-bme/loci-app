import { contextBridge, ipcRenderer, webUtils } from "electron";

import type { LociDesktopApi } from "./shared/contracts";
import type { ResearchDesktopApi } from "./shared/research-contracts";

const api: LociDesktopApi = {
  pickImages: () => ipcRenderer.invoke("loci:pick-images"),
  pickFolder: () => ipcRenderer.invoke("loci:pick-folder"),
  createProject: (manifest) =>
    ipcRenderer.invoke("loci:create-project", manifest),
  openProject: () => ipcRenderer.invoke("loci:open-project"),
  openRecentProject: (recentId) =>
    ipcRenderer.invoke("loci:open-recent-project", recentId),
  saveProject: (manifest, quitRequestId) =>
    ipcRenderer.invoke("loci:save-project", manifest, quitRequestId),
  confirmDiscardUnsavedProject: () =>
    ipcRenderer.invoke("loci:confirm-discard-unsaved-project"),
  listRecentProjects: () => ipcRenderer.invoke("loci:list-recent-projects"),
  listJobs: () => ipcRenderer.invoke("loci:list-jobs"),
  importDroppedFiles: (files) =>
    ipcRenderer.invoke(
      "loci:import-dropped-files",
      files.map((file) => webUtils.getPathForFile(file)).filter(Boolean),
    ),
  inspectSource: (sourceId) =>
    ipcRenderer.invoke("loci:inspect-source", sourceId),
  restoreProjectResult: (sourceId) =>
    ipcRenderer.invoke("loci:restore-project-result", sourceId),
  removeSource: (sourceId) =>
    ipcRenderer.invoke("loci:remove-source", sourceId),
  revealSource: (sourceId) =>
    ipcRenderer.invoke("loci:reveal-source", sourceId),
  discardResult: (sourceId, resultId) =>
    ipcRenderer.invoke("loci:discard-result", sourceId, resultId),
  discardAllResults: () => ipcRenderer.invoke("loci:discard-all-results"),
  deleteInstance: (sourceId, resultId, point) =>
    ipcRenderer.invoke("loci:delete-instance", sourceId, resultId, point),
  addPolygon: (sourceId, resultId, points) =>
    ipcRenderer.invoke("loci:add-polygon", sourceId, resultId, points),
  splitInstance: (sourceId, resultId, target, points) =>
    ipcRenderer.invoke(
      "loci:split-instance",
      sourceId,
      resultId,
      target,
      points,
    ),
  mergeInstances: (sourceId, resultId, first, second) =>
    ipcRenderer.invoke(
      "loci:merge-instances",
      sourceId,
      resultId,
      first,
      second,
    ),
  replaceInstanceBoundary: (sourceId, resultId, target, points) =>
    ipcRenderer.invoke(
      "loci:replace-instance-boundary",
      sourceId,
      resultId,
      target,
      points,
    ),
  getInstanceBoundary: (sourceId, resultId, target) =>
    ipcRenderer.invoke(
      "loci:get-instance-boundary",
      sourceId,
      resultId,
      target,
    ),
  paintMask: (sourceId, resultId, points, radiusPx) =>
    ipcRenderer.invoke("loci:paint-mask", sourceId, resultId, points, radiusPx),
  eraseMask: (sourceId, resultId, points, radiusPx) =>
    ipcRenderer.invoke("loci:erase-mask", sourceId, resultId, points, radiusPx),
  moveBoundaryVertex: (sourceId, resultId, target, vertices) =>
    ipcRenderer.invoke(
      "loci:move-boundary-vertex",
      sourceId,
      resultId,
      target,
      vertices,
    ),
  undoCorrection: (sourceId, resultId) =>
    ipcRenderer.invoke("loci:undo-correction", sourceId, resultId),
  redoCorrection: (sourceId, resultId) =>
    ipcRenderer.invoke("loci:redo-correction", sourceId, resultId),
  listProfiles: () => ipcRenderer.invoke("loci:list-profiles"),
  getCellposeStatus: (profileId) =>
    ipcRenderer.invoke("loci:cellpose-status", profileId),
  importCellposeModel: (profileId) =>
    ipcRenderer.invoke("loci:import-cellpose-model", profileId),
  openCellposeModelPage: (profileId) =>
    ipcRenderer.invoke("loci:open-cellpose-model-page", profileId),
  openCellposeModelFolder: (profileId) =>
    ipcRenderer.invoke("loci:open-cellpose-model-folder", profileId),
  segment: (request) => ipcRenderer.invoke("loci:segment", request),
  createBatchRun: (request) =>
    ipcRenderer.invoke("loci:create-batch-run", request),
  listRecoverableBatchRuns: () =>
    ipcRenderer.invoke("loci:list-recoverable-batch-runs"),
  resumeBatchRun: (batchId) =>
    ipcRenderer.invoke("loci:resume-batch-run", batchId),
  beginBatchRunItem: (batchId, sourceId) =>
    ipcRenderer.invoke("loci:begin-batch-run-item", batchId, sourceId),
  completeBatchRunItem: (batchId, sourceId, resultId) =>
    ipcRenderer.invoke(
      "loci:complete-batch-run-item",
      batchId,
      sourceId,
      resultId,
    ),
  failBatchRunItem: (batchId, sourceId, failureSummary) =>
    ipcRenderer.invoke(
      "loci:fail-batch-run-item",
      batchId,
      sourceId,
      failureSummary,
    ),
  finishBatchRun: (batchId, cancelled) =>
    ipcRenderer.invoke("loci:finish-batch-run", batchId, cancelled),
  cancelAnalysis: () => ipcRenderer.invoke("loci:cancel-analysis"),
  exportResult: (sourceId, resultId, options) =>
    ipcRenderer.invoke("loci:export-result", sourceId, resultId, options),
  exportView: (sourceId, options) =>
    ipcRenderer.invoke("loci:export-view", sourceId, options),
  beginBatchExport: (options) =>
    ipcRenderer.invoke("loci:begin-batch-export", options),
  exportBatchResult: (batchId, sourceId, resultId) =>
    ipcRenderer.invoke("loci:export-batch-result", batchId, sourceId, resultId),
  finishBatchExport: (batchId, failures, cancelled) =>
    ipcRenderer.invoke(
      "loci:finish-batch-export",
      batchId,
      failures,
      cancelled,
    ),
  onImportRequested: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("loci:import-requested", listener);
    return () => ipcRenderer.removeListener("loci:import-requested", listener);
  },
  onFolderImportRequested: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("loci:folder-import-requested", listener);
    return () =>
      ipcRenderer.removeListener("loci:folder-import-requested", listener);
  },
  onOpenProjectRequested: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("loci:open-project-requested", listener);
    return () =>
      ipcRenderer.removeListener("loci:open-project-requested", listener);
  },
  onSaveProjectRequested: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("loci:save-project-requested", listener);
    return () =>
      ipcRenderer.removeListener("loci:save-project-requested", listener);
  },
  onJobsChanged: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      jobs: Parameters<typeof callback>[0],
    ) => callback(jobs);
    ipcRenderer.on("loci:jobs-changed", listener);
    return () => ipcRenderer.removeListener("loci:jobs-changed", listener);
  },
  onSettingsRequested: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("loci:settings-requested", listener);
    return () =>
      ipcRenderer.removeListener("loci:settings-requested", listener);
  },
  onEngineInvalidated: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: { generation: number; message: string },
    ) => callback(payload);
    ipcRenderer.on("loci:engine-invalidated", listener);
    return () =>
      ipcRenderer.removeListener("loci:engine-invalidated", listener);
  },
  onQuitProjectSaveRequested: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      request: { requestId?: unknown },
    ) => {
      if (
        !request ||
        typeof request !== "object" ||
        Object.keys(request).length !== 1 ||
        typeof request.requestId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          request.requestId,
        )
      )
        return;
      const requestId = request.requestId;
      void Promise.resolve()
        .then(() => callback({ requestId }))
        .then((saved) => {
          ipcRenderer.send("loci:quit-project-save-completed", {
            requestId,
            status: saved === true ? "saved" : "failed",
          });
        })
        .catch(() => {
          ipcRenderer.send("loci:quit-project-save-completed", {
            requestId,
            status: "failed",
          });
        });
    };
    ipcRenderer.on("loci:quit-project-save-requested", listener);
    return () =>
      ipcRenderer.removeListener("loci:quit-project-save-requested", listener);
  },
  onQuitProjectSaveCancelled: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      request: { requestId?: unknown },
    ) => {
      if (
        !request ||
        typeof request !== "object" ||
        Object.keys(request).length !== 1 ||
        typeof request.requestId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          request.requestId,
        )
      )
        return;
      callback({ requestId: request.requestId });
    };
    ipcRenderer.on("loci:quit-project-save-cancelled", listener);
    return () =>
      ipcRenderer.removeListener("loci:quit-project-save-cancelled", listener);
  },
  updateSessionState: (state) => ipcRenderer.send("loci:session-state", state),
  requestQuit: () => ipcRenderer.send("loci:request-quit"),
  getWindowPresentation: () =>
    ipcRenderer.invoke("loci:get-window-presentation"),
  onWindowPresentationChanged: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      state: { fullscreen: boolean; maximized: boolean },
    ) => callback(state);
    ipcRenderer.on("loci:window-presentation-changed", listener);
    return () =>
      ipcRenderer.removeListener("loci:window-presentation-changed", listener);
  },
  platform: process.platform,
};

contextBridge.exposeInMainWorld("loci", api);

const researchApi: ResearchDesktopApi = {
  exportSourceView: (request) => ipcRenderer.invoke("loci-research:export-source-view", request),
  exportVolumeFigure: (request) => ipcRenderer.invoke("loci-research:export-volume-figure", request),
  exportSourceAnnotations: (binding) => ipcRenderer.invoke("loci-research:export-source-annotations", binding),
  importSourceAnnotations: (binding) => ipcRenderer.invoke("loci-research:import-source-annotations", binding),
  importLegacyProject: () => ipcRenderer.invoke("loci-research:import-legacy-project"),
  openImages: (kind = "files") => ipcRenderer.invoke("loci-research:open-images", kind),
  openDropped: (files) => ipcRenderer.invoke("loci-research:open-dropped",
    files.map((file) => webUtils.getPathForFile(file)), "files"),
  sessionState: () => ipcRenderer.invoke("loci-research:session-state"),
  newSession: () => ipcRenderer.invoke("loci-research:new-session"),
  saveAs: () => ipcRenderer.invoke("loci-research:save-as"),
  recoveryList: () => ipcRenderer.invoke("loci-research:recovery-list"),
  recoveryKeep: (sessionId) => ipcRenderer.invoke("loci-research:recovery-keep", sessionId),
  recoveryDiscard: (sessionId) => ipcRenderer.invoke("loci-research:recovery-discard", sessionId),
  recoveryUndo: (undoToken) => ipcRenderer.invoke("loci-research:recovery-undo", undoToken),
  cancelView: () => ipcRenderer.invoke("loci-research:cancel-view"),
  inspectVendor: () => ipcRenderer.invoke("loci-research:vendor-inspect"),
  convertVendor: (request) => ipcRenderer.invoke("loci-research:vendor-convert", request),
  exportStudy: () => ipcRenderer.invoke("loci-research:export-study"),
  importStudy: () => ipcRenderer.invoke("loci-research:import-study"),
  relinkSource: (sourceId, kind) => ipcRenderer.invoke("loci-research:relink-source", sourceId, kind),
  exportRecipe: (recipeId, sourceId) => ipcRenderer.invoke("loci-research:export-recipe", recipeId, sourceId),
  importRecipe: (bindings) => ipcRenderer.invoke("loci-research:import-recipe", bindings),
  createAgentAccess: (request) =>
    ipcRenderer.invoke("loci-research:agent-access", request),
  importModel: (workingBytes, recoveryModelId) =>
    ipcRenderer.invoke("loci-research:import-model", workingBytes, recoveryModelId),
  createStudy: () => ipcRenderer.invoke("loci-research:create"),
  openStudy: () => ipcRenderer.invoke("loci-research:open"),
  getSnapshot: () => ipcRenderer.invoke("loci-research:snapshot"),
  updateWorkspace: (request) => ipcRenderer.invoke("loci-research:workspace-visibility", request),
  reorderSources: (request) => ipcRenderer.invoke("loci-research:source-order", request),
  addSources: (kind) => ipcRenderer.invoke("loci-research:import", kind),
  execute: (operation, request, options) => options === undefined
    ? ipcRenderer.invoke("loci-research:execute", operation, request)
    : ipcRenderer.invoke("loci-research:execute", operation, request, options),
  submitBatch: (tasks) => ipcRenderer.invoke("loci-research:batch-submit", tasks),
  runBatchJob: (batchId, jobId) =>
    ipcRenderer.invoke("loci-research:batch-run", batchId, jobId),
  resumeBatch: (batchId) =>
    ipcRenderer.invoke("loci-research:batch-resume", batchId),
  retryBatch: (batchId) =>
    ipcRenderer.invoke("loci-research:batch-retry", batchId),
  exportBatch: (bindings, options) =>
    ipcRenderer.invoke("loci-research:batch-export", bindings, options),
  reviewResult: (id, revision, disposition) =>
    ipcRenderer.invoke("loci-research:review", id, revision, disposition),
  exportResult: (id, revision) =>
    ipcRenderer.invoke("loci-research:export", id, revision),
  cancelJob: (id) => ipcRenderer.invoke("loci-research:cancel", id),
};
contextBridge.exposeInMainWorld("lociResearch", researchApi);
