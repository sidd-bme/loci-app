// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LociDesktopApi } from "./shared/contracts";
import type { ResearchDesktopApi } from "./shared/research-contracts";

const electronMocks = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  send: vi.fn(),
  getPathForFile: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: electronMocks.exposeInMainWorld },
  ipcRenderer: {
    invoke: electronMocks.invoke,
    on: electronMocks.on,
    removeListener: electronMocks.removeListener,
    send: electronMocks.send,
  },
  webUtils: { getPathForFile: electronMocks.getPathForFile },
}));

await import("./preload");

const api = electronMocks.exposeInMainWorld.mock.calls[0]?.[1] as LociDesktopApi;
const researchApi = electronMocks.exposeInMainWorld.mock.calls[1]?.[1] as ResearchDesktopApi;

describe("preload Cellpose bridge", () => {
  beforeEach(() => {
    electronMocks.invoke.mockReset();
  });

  it("exposes the desktop API in the isolated renderer world", () => {
    expect(electronMocks.exposeInMainWorld).toHaveBeenCalledWith("loci", expect.any(Object));
  });

  it("forwards a volume figure through the isolated research bridge", async () => {
    const request = { schema_version: "loci.volume-figure-request/v1" } as Parameters<
      NonNullable<ResearchDesktopApi["exportVolumeFigure"]>
    >[0];
    electronMocks.invoke.mockResolvedValueOnce(null);

    await researchApi.exportVolumeFigure?.(request);

    expect(electronMocks.invoke).toHaveBeenCalledWith(
      "loci-research:export-volume-figure",
      request,
    );
  });

  it("forwards an exact source order through the isolated research bridge", async () => {
    const request = {
      expected_revision: 4,
      sources: [{ id: "b".repeat(32), sha256: "c".repeat(64) }],
    };
    electronMocks.invoke.mockResolvedValueOnce({ project: { title: "Study" } });

    await researchApi.reorderSources?.(request);

    expect(electronMocks.invoke).toHaveBeenCalledWith(
      "loci-research:source-order",
      request,
    );
  });

  it("forwards a viewer scheduling lane separately from the engine request", async () => {
    const request = { source_id: "a".repeat(32), overview: true };
    const options = { viewer_lane: "comparison-a" };
    electronMocks.invoke.mockResolvedValueOnce({ image: "data:image/png;base64," });

    await researchApi.execute("viewer_tile", request, options);

    expect(electronMocks.invoke).toHaveBeenCalledWith(
      "loci-research:execute",
      "viewer_tile",
      request,
      options,
    );
  });

  it("correlates the bounded quit-save request and reports a successful save", async () => {
    const callback = vi.fn().mockResolvedValue(true);
    const unsubscribe = api.onQuitProjectSaveRequested(callback);
    const registration = electronMocks.on.mock.calls.find(
      ([channel]) => channel === "loci:quit-project-save-requested",
    );
    const listener = registration?.[1] as (
      event: unknown,
      request: { requestId: string },
    ) => void;
    const requestId = "11111111-1111-4111-8111-111111111111";

    listener({}, { requestId });
    await vi.waitFor(() => expect(electronMocks.send).toHaveBeenCalledWith(
      "loci:quit-project-save-completed",
      { requestId, status: "saved" },
    ));
    expect(callback).toHaveBeenCalledWith({ requestId });

    unsubscribe();
    expect(electronMocks.removeListener).toHaveBeenCalledWith(
      "loci:quit-project-save-requested",
      listener,
    );
  });

  it("reports quit-save rejection as failed without exposing the error", async () => {
    const callback = vi.fn().mockRejectedValue(new Error("/private/source/project.loci"));
    api.onQuitProjectSaveRequested(callback);
    const registrations = electronMocks.on.mock.calls.filter(
      ([channel]) => channel === "loci:quit-project-save-requested",
    );
    const listener = registrations.at(-1)?.[1] as (
      event: unknown,
      request: { requestId: string },
    ) => void;
    const requestId = "22222222-2222-4222-8222-222222222222";

    listener({}, { requestId });
    await vi.waitFor(() => expect(electronMocks.send).toHaveBeenCalledWith(
      "loci:quit-project-save-completed",
      { requestId, status: "failed" },
    ));
    expect(JSON.stringify(electronMocks.send.mock.calls)).not.toContain("/private/source");
  });

  it("ignores malformed quit-save requests", async () => {
    const callback = vi.fn().mockResolvedValue(true);
    api.onQuitProjectSaveRequested(callback);
    const registrations = electronMocks.on.mock.calls.filter(
      ([channel]) => channel === "loci:quit-project-save-requested",
    );
    const listener = registrations.at(-1)?.[1] as (
      event: unknown,
      request: { requestId: string; extra?: boolean },
    ) => void;

    listener({}, { requestId: "../escape", extra: true });
    await Promise.resolve();
    expect(callback).not.toHaveBeenCalled();
  });

  it("forwards only an exact correlated quit-save cancellation", () => {
    const callback = vi.fn();
    const unsubscribe = api.onQuitProjectSaveCancelled(callback);
    const registrations = electronMocks.on.mock.calls.filter(
      ([channel]) => channel === "loci:quit-project-save-cancelled",
    );
    const listener = registrations.at(-1)?.[1] as (
      event: unknown,
      request: { requestId: string; extra?: boolean },
    ) => void;
    const requestId = "33333333-3333-4333-8333-333333333333";

    listener({}, { requestId });
    listener({}, { requestId: "../escape", extra: true });

    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith({ requestId });
    unsubscribe();
    expect(electronMocks.removeListener).toHaveBeenCalledWith(
      "loci:quit-project-save-cancelled",
      listener,
    );
  });

  it("binds a quit-save request id to the project-save IPC transaction", async () => {
    electronMocks.invoke.mockResolvedValue(undefined);
    const requestId = "44444444-4444-4444-8444-444444444444";
    const manifest = { schemaVersion: "loci.project/v1" } as never;

    await api.saveProject(manifest, requestId);

    expect(electronMocks.invoke).toHaveBeenCalledWith(
      "loci:save-project",
      manifest,
      requestId,
    );
  });

  it.each([
    ["getCellposeStatus", "loci:cellpose-status"],
    ["importCellposeModel", "loci:import-cellpose-model"],
    ["openCellposeModelPage", "loci:open-cellpose-model-page"],
    ["openCellposeModelFolder", "loci:open-cellpose-model-folder"],
  ] as const)("forwards the selected profile through %s", async (method, channel) => {
    electronMocks.invoke.mockResolvedValue(undefined);

    await api[method]("cellpose-sam-v2");

    expect(electronMocks.invoke).toHaveBeenCalledWith(channel, "cellpose-sam-v2");
  });

  it("uses one IPC transaction to durably discard all active results", async () => {
    electronMocks.invoke.mockResolvedValue({ discarded: [] });

    await api.discardAllResults();

    expect(electronMocks.invoke).toHaveBeenCalledWith("loci:discard-all-results");
  });

  it("forwards a source-only rendered-view export", async () => {
    const options = {
      format: "png" as const,
      settings: {
        blackPoint: 0,
        whitePoint: 1,
        brightness: 0,
        contrast: 100,
        gamma: 1,
        saturation: 100,
        red: true,
        green: true,
        blue: true,
      },
    };

    await api.exportView("source-1", options);

    expect(electronMocks.invoke).toHaveBeenCalledWith(
      "loci:export-view",
      "source-1",
      options,
    );
  });

  it("forwards lazy project-result restoration without exposing a local path", async () => {
    await api.restoreProjectResult("source-1");

    expect(electronMocks.invoke).toHaveBeenCalledWith(
      "loci:restore-project-result",
      "source-1",
    );
  });

  it("forwards durable batch lifecycle requests without adding filesystem data", async () => {
    const request = {
      sourceIds: ["source-1", "source-2"],
      settings: {
        image_mode: "auto" as const,
        polarity: "auto" as const,
        expected_diameter_px: 34,
        min_area_px: 80,
        sensitivity: 0,
        smoothing_px: 1.2,
        split_touching: true,
        exclude_border: false,
      },
      profileId: "loci-classical",
    };

    await api.createBatchRun(request);
    expect(electronMocks.invoke).toHaveBeenLastCalledWith("loci:create-batch-run", request);
    await api.listRecoverableBatchRuns();
    expect(electronMocks.invoke).toHaveBeenLastCalledWith("loci:list-recoverable-batch-runs");
    await api.resumeBatchRun("batch-1");
    expect(electronMocks.invoke).toHaveBeenLastCalledWith("loci:resume-batch-run", "batch-1");
    await api.beginBatchRunItem("batch-1", "source-1");
    expect(electronMocks.invoke).toHaveBeenLastCalledWith(
      "loci:begin-batch-run-item", "batch-1", "source-1",
    );
    await api.completeBatchRunItem("batch-1", "source-1", "result-1");
    expect(electronMocks.invoke).toHaveBeenLastCalledWith(
      "loci:complete-batch-run-item", "batch-1", "source-1", "result-1",
    );
    await api.failBatchRunItem("batch-1", "source-2", "Decoder failed.");
    expect(electronMocks.invoke).toHaveBeenLastCalledWith(
      "loci:fail-batch-run-item", "batch-1", "source-2", "Decoder failed.",
    );
    await api.finishBatchRun("batch-1", false);
    expect(electronMocks.invoke).toHaveBeenLastCalledWith(
      "loci:finish-batch-run", "batch-1", false,
    );
  });

  it("forwards transactional topology, brush, eraser, and vertex inputs", async () => {
    const first = { x: 10, y: 11 };
    const second = { x: 20, y: 21 };
    const stroke = [first, { x: 15, y: 16 }, second];

    await api.splitInstance("source-1", "result-1", first, stroke);
    expect(electronMocks.invoke).toHaveBeenLastCalledWith(
      "loci:split-instance", "source-1", "result-1", first, stroke,
    );
    await api.mergeInstances("source-1", "result-1", first, second);
    expect(electronMocks.invoke).toHaveBeenLastCalledWith(
      "loci:merge-instances", "source-1", "result-1", first, second,
    );
    await api.replaceInstanceBoundary("source-1", "result-1", first, stroke);
    expect(electronMocks.invoke).toHaveBeenLastCalledWith(
      "loci:replace-instance-boundary", "source-1", "result-1", first, stroke,
    );
    await api.getInstanceBoundary("source-1", "result-1", first);
    expect(electronMocks.invoke).toHaveBeenLastCalledWith(
      "loci:get-instance-boundary", "source-1", "result-1", first,
    );
    await api.paintMask("source-1", "result-1", stroke, 8);
    expect(electronMocks.invoke).toHaveBeenLastCalledWith(
      "loci:paint-mask", "source-1", "result-1", stroke, 8,
    );
    await api.eraseMask("source-1", "result-1", stroke, 6);
    expect(electronMocks.invoke).toHaveBeenLastCalledWith(
      "loci:erase-mask", "source-1", "result-1", stroke, 6,
    );
    await api.moveBoundaryVertex("source-1", "result-1", first, stroke);
    expect(electronMocks.invoke).toHaveBeenLastCalledWith(
      "loci:move-boundary-vertex", "source-1", "result-1", first, stroke,
    );
  });
});

describe("preload research batch bridge", () => {
  beforeEach(() => {
    electronMocks.invoke.mockReset();
  });

  it("forwards durable submit, run, resume, and retry requests without paths", async () => {
    const batchId = "a".repeat(32);
    const jobId = "b".repeat(32);
    const tasks = [{
      operation: "run_recipe" as const,
      source: { id: "c".repeat(32), sha256: "d".repeat(64) },
      request: { source_id: "c".repeat(32), selection: {}, recipe: {} },
    }];

    await researchApi.submitBatch!(tasks);
    expect(electronMocks.invoke).toHaveBeenLastCalledWith(
      "loci-research:batch-submit", tasks,
    );
    await researchApi.runBatchJob!(batchId, jobId);
    expect(electronMocks.invoke).toHaveBeenLastCalledWith(
      "loci-research:batch-run", batchId, jobId,
    );
    await researchApi.resumeBatch!(batchId);
    expect(electronMocks.invoke).toHaveBeenLastCalledWith(
      "loci-research:batch-resume", batchId,
    );
    await researchApi.retryBatch!(batchId);
    expect(electronMocks.invoke).toHaveBeenLastCalledWith(
      "loci-research:batch-retry", batchId,
    );
    const bindings = [{
      source_id: "c".repeat(32), source_sha256: "d".repeat(64),
      result_id: "e".repeat(32), revision_hash: "f".repeat(64),
    }];
    await researchApi.exportBatch!(bindings, { mode: "summary-only" });
    expect(electronMocks.invoke).toHaveBeenLastCalledWith(
      "loci-research:batch-export", bindings, { mode: "summary-only" },
    );
  });
});
