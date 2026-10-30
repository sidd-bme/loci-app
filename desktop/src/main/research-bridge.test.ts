// @vitest-environment node

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  request: vi.fn(),
  open: vi.fn(),
  save: vi.fn(),
  prepareLegacy: vi.fn(),
  clients: [] as Array<{ request: ReturnType<typeof vi.fn>; cancelCurrent: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>; forceDispose: ReturnType<typeof vi.fn> }>,
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => process.env.LOCI_RESEARCH_BRIDGE_TEST_ROOT,
    getVersion: () => "0.1.0",
  },
  dialog: { showOpenDialog: mocks.open, showSaveDialog: mocks.save },
  ipcMain: {
    handle: (name: string, operation: (...args: unknown[]) => Promise<unknown>) =>
      mocks.handlers.set(name, operation),
  },
}));
vi.mock("./worker-client", () => ({
  EngineWorkerClient: class {
    request = vi.fn((...args: unknown[]) => mocks.request(...args));
    cancelCurrent = vi.fn(() => true);
    dispose = vi.fn(async () => undefined);
    forceDispose = vi.fn();
    constructor() { mocks.clients.push(this); }
  },
  sanitizedWorkerErrorMessage: (message: string) => message.replace(/\/[^\s]+/g, "<local path>"),
}));
vi.mock("./legacy-project-adapter", () => ({
  prepareLegacyProjectImport: (...args: unknown[]) => mocks.prepareLegacy(...args),
}));

import type { StatisticsFigureExportRequest } from "../shared/statistics-figure-contracts";
import { ResearchBridge } from "./research-bridge";
import type {
  ResearchJob,
  ResearchSnapshot,
  VolumeFigureExportRequest,
} from "../shared/research-contracts";

const call = (name: string, ...args: unknown[]) =>
  mocks.handlers.get(`loci-research:${name}`)!({}, ...args);
const sha = "a".repeat(64);
let root: string;
let bridge: ResearchBridge;

function figurePngChunk(kind: string, data = Buffer.alloc(0)): Buffer {
  const output = Buffer.alloc(12 + data.byteLength);
  output.writeUInt32BE(data.byteLength, 0);
  output.write(kind, 4, 4, "ascii");
  data.copy(output, 8);
  output.writeUInt32BE(crc32(output.subarray(4, 8 + data.byteLength)), 8 + data.byteLength);
  return output;
}

function figurePng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    figurePngChunk("IHDR", header),
    figurePngChunk("IDAT", deflateSync(Buffer.alloc(height * (1 + width * 4)))),
    figurePngChunk("IEND"),
  ]);
}

function volumeFigureRequest(): VolumeFigureExportRequest {
  const sourceId = "b".repeat(32);
  const payload = {
    role: "whole-volume-context" as const,
    data_sha256: "c".repeat(64),
    t: 0,
    level: 0,
    dimensions_xyz: [1, 1, 2] as [number, number, number],
    native_level_dimensions_xyz: [1, 1, 2] as [number, number, number],
    source_dimensions_xyz: [1, 1, 2] as [number, number, number],
    source_extent_xyzxyz: [0, 0, 0, 0, 0, 1] as [number, number, number, number, number, number],
    origin_xyz: [0, 0, 0] as [number, number, number],
    spacing_xyz: [1, 1, 1] as [number, number, number],
    direction_3x3: [1, 0, 0, 0, 1, 0, 0, 0, 1] as [number, number, number, number, number, number, number, number, number],
    affine_4x4: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]],
    unit: "pixel" as const,
    frame: "image" as const,
    scalar_type: "uint8",
    source_dtypes: ["uint8"],
    component_indices: [0],
    encoding_basis: "native-common-dtype",
    byte_length: 2,
    sampling: {
      method: "nearest-whole-extent",
      source_indices_xyz: [[0], [0], [0, 1]] as [number[], number[], number[]],
      level_zero_indices_xyz: [[0], [0], [0, 1]] as [number[], number[], number[]],
    },
  };
  return {
    schema_version: "loci.volume-figure-request/v1",
    source_id: sourceId,
    source_sha256: sha,
    width_px: 2,
    height_px: 2,
    png_base64: figurePng(2, 2).toString("base64"),
    manifest: {
      schema_version: "loci.volume-figure/v1",
      figure: {
        kind: "screen-resolution-rendered-figure",
        format: "png",
        width_px: 2,
        height_px: 2,
        device_pixel_ratio: 2,
        capture_scale: 1,
      },
      source: { source_id: sourceId, source_sha256: sha, t: 0 },
      payloads: { context: payload, focus: null },
      representation: {
        mode: "volume",
        extent: "context",
        interpolation: "linear",
        shading: false,
        orientation_axes: true,
      },
      camera: {
        projection: "perspective",
        position_xyz: [1, 2, 3],
        focal_point_xyz: [0, 0, 0],
        view_up_xyz: [0, 1, 0],
        clipping_range: [0.1, 100],
        view_angle_degrees: 30,
        parallel_scale: null,
      },
      transfers: [{
        channel_index: 0,
        name: "C1",
        color_rgb: [1, 1, 1],
        color_mode: "constant",
        window: { low: 0, high: 255, gamma: 1 },
        opacity: 1,
        visible: true,
        source_opacity_points: [[0, 0], [255, 1]],
        resolved_points: [0, 0.25, 0.5, 0.75, 1].map((value) => ({
          scalar: value * 255,
          opacity: value,
          color_rgb: [1, 1, 1] as [number, number, number],
        })),
        opacity_unit_distance: 0.5,
        provenance: { range: "native-dtype-range" },
      }],
      clipping: { enabled: false },
      mpr: null,
      background: { rgb: [0.082, 0.082, 0.082] },
      software: {
        renderer: "vtk.js",
        renderer_version: "36.12.0",
        capture_method: "captureNextImage",
      },
      provenance: {
        artifact_semantics: "Rendered display RGB at native canvas resolution; not original-value scientific data.",
        screen_resolution_only: true,
        scale_bar_included: false,
        high_resolution_claim: false,
        biological_or_clinical_validation_claim: false,
        metadata_contains_source_pixel_data: false,
      },
    },
  };
}

function nativeSnapshot(
  sources: ResearchSnapshot["sources"],
  jobs: ResearchJob[] = [],
): ResearchSnapshot {
  return {
    project: { title: "Study" },
    sources,
    results: [],
    samples: [],
    recipes: [],
    displays: [],
    selections: [],
    comparisons: [],
    jobs,
    operations: {},
  };
}

function durableJob({
  id,
  requestKey,
  requestHash,
  state = "queued",
  operation = "run_recipe",
  request,
}: {
  id: string;
  requestKey: string;
  requestHash: string;
  state?: ResearchJob["state"];
  operation?: string;
  request: Record<string, unknown>;
}): ResearchJob {
  return {
    id,
    operation,
    request,
    request_key: requestKey,
    request_hash: requestHash,
    state,
    created_at: "2026-09-08T00:00:00Z",
    updated_at: "2026-09-08T00:00:00Z",
    progress: state === "succeeded" ? 1 : 0,
    cancel_requested: state === "cancelled",
    result_ids: state === "succeeded" ? ["f".repeat(32)] : [],
    error: state === "failed" || state === "interrupted" ? "Execution stopped." : null,
  };
}

async function createEngineStudy(project: string): Promise<void> {
  await fs.mkdir(project, { mode: 0o700 });
  await fs.writeFile(path.join(project, "study.sqlite3"), "engine-study");
}

async function createAndInspect() {
  const project = path.join(root, "Study.loci-study");
  mocks.save.mockResolvedValueOnce({ canceled: false, filePath: project });
  await call("create");
  for (const file of ["sample.nd2", "reader.jar", "java"])
    mocks.open.mockResolvedValueOnce({ canceled: false, filePaths: [path.join(root, file)] });
  return await call("vendor-inspect") as { grant_id: string; source_sha256: string };
}

describe("native research bridge", () => {
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "loci-research-bridge-"));
    process.env.LOCI_RESEARCH_BRIDGE_TEST_ROOT = root;
    vi.clearAllMocks();
    mocks.handlers.clear();
    mocks.clients.length = 0;
    mocks.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === "research_create") await createEngineStudy(params.path as string);
      if (method === "research_vendor_inspect") return { source_sha256: sha, series: [] };
      if (method === "research_vendor_convert")
        return { snapshot: {}, conversion: { source_sha256: sha } };
      if (method === "research_project_clone") {
        if (await fs.lstat(params.destination as string).then(() => true, () => false))
          throw new Error("Choose an absent study destination");
        await fs.cp(params.project as string, params.destination as string, {
          recursive: true, errorOnExist: true, force: false,
        });
      }
      return {};
    });
    bridge = new ResearchBridge();
    bridge.register(() => {});
  });

  afterEach(async () => {
    delete process.env.LOCI_RESEARCH_BRIDGE_TEST_ROOT;
    await fs.rm(root, { recursive: true, force: true });
  });

  const labelBinding = () => ({ source_id: "b".repeat(32), source_sha256: sha,
    selection: { x: 0, y: 0, width: 8, height: 4, t: 0, c: 1, z: 0, level: 0 }, working_bytes: 64 * 1024 ** 2 });

  it("keeps compute settings in the main-owned application directory and restricts operations", async () => {
    await call("compute-targets", "list", {});
    expect(mocks.request).toHaveBeenCalledWith("research_compute_targets", {
      directory: path.join(root, "compute-targets-v1.loci-study"), operation: "list", request: {}, project: null,
    }, 0);
    await expect(call("compute-targets", "use", { id: "a".repeat(32), revision: 1 })).rejects.toThrow("study first");
    await expect(call("compute-targets", "shell", {})).rejects.toThrow("Invalid compute settings");
    new ResearchBridge().register(() => { throw new Error("Untrusted sender"); });
    mocks.request.mockClear();
    await expect(call("compute-targets", "list", {})).rejects.toThrow("Untrusted sender");
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("exports the exact correction receipt through a trusted native destination and returns only bounded fields", async () => {
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: path.join(root, "Effect.loci-study") });
    await call("create"); mocks.request.mockClear();
    const destination = path.join(root, "Effect report");
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: destination });
    mocks.request.mockResolvedValueOnce({ receipt_sha256: sha, manifest_sha256: sha,
      files: ["receipt.json", "conditions.csv"], destination, input_path: "/private/input" });
    expect(await call("export-correction-effect", sha)).toEqual({ receipt_sha256: sha, manifest_sha256: sha, files: ["receipt.json", "conditions.csv"] });
    expect(mocks.request).toHaveBeenCalledWith("research_export_correction_effect", {
      project: path.join(root, "Effect.loci-study"), receipt_sha256: sha, destination,
    }, 0);
  });

  it("rejects renderer paths and invalid correction receipt hashes before picking; cancellation publishes nothing", async () => {
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: path.join(root, "Effect.loci-study") });
    await call("create"); mocks.request.mockClear(); mocks.save.mockClear();
    await expect(call("export-correction-effect", { receipt_sha256: sha, destination: "/private/output" })).rejects.toThrow(/exact saved/);
    await expect(call("export-correction-effect", "bad hash")).rejects.toThrow(/exact saved/);
    expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.request).not.toHaveBeenCalled();
    mocks.save.mockResolvedValueOnce({ canceled: true });
    expect(await call("export-correction-effect", sha)).toBeNull(); expect(mocks.request).not.toHaveBeenCalled();
  });

  it("pins the correction report picker to its study and rejects mismatched engine export identities", async () => {
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: path.join(root, "Effect.loci-study") });
    await call("create"); mocks.request.mockClear();
    let finish!: (value: unknown) => void;
    mocks.save.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const exporting = call("export-correction-effect", sha);
    await expect(call("create")).rejects.toThrow(/active study operation/);
    finish({ canceled: false, filePath: path.join(root, "Report") });
    mocks.request.mockResolvedValueOnce({ receipt_sha256: "b".repeat(64), manifest_sha256: sha, files: ["receipt.json"] });
    await expect(exporting).rejects.toThrow(/invalid experiment-effect export receipt/);
  });

  it("keeps label picker cancellation unpublished and rejects renderer paths before picking", async () => {
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: path.join(root, "Labels.loci-study") });
    await call("create"); mocks.request.mockClear(); mocks.open.mockResolvedValue({ canceled: true, filePaths: [] });
    expect(await call("labels-import-preview", labelBinding())).toBeNull(); expect(mocks.request).not.toHaveBeenCalled();
    mocks.open.mockClear();
    await expect(call("labels-import-preview", { ...labelBinding(), path: "/private/labels.tif" })).rejects.toThrow(/Invalid label-import/);
    expect(mocks.open).not.toHaveBeenCalled(); expect(mocks.request).not.toHaveBeenCalled();
  });

  it("pins the TIFF picker and grant to the captured study and blocks document switching while pending", async () => {
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: path.join(root, "Labels.loci-study") });
    await call("create"); const project = mocks.request.mock.calls.find(([method]) => method === "research_create")![1].path;
    mocks.request.mockClear();
    let finish!: (value: { canceled: boolean; filePaths: string[] }) => void;
    mocks.open.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const pending = call("labels-import-preview", labelBinding());
    await expect(call("create")).rejects.toThrow(/Finish|Wait/);
    await expect(call("execute", "labels_import", { source_id: "b".repeat(32) })).rejects.toThrow(/finish opening/);
    finish({ canceled: false, filePaths: ["/selected/sparse.tif"] }); await pending;
    expect(mocks.request).toHaveBeenCalledWith("research_labels_import_grant", { project, path: "/selected/sparse.tif", ...labelBinding() }, 0);
  });

  it("routes label adoption through the durable worker task instead of the control execute route", async () => {
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: path.join(root, "Labels.loci-study") });
    await call("create"); mocks.request.mockClear();
    mocks.request.mockImplementation(async (method: string) => method === "research_submit" ? { id: "c".repeat(32) } : { result: {} });
    const request = { source_id: "b".repeat(32), source_sha256: sha, grant_id: "d".repeat(32), alignment: "same-native-yx-grid" };
    await call("execute", "labels_import", request);
    expect(mocks.request).toHaveBeenCalledWith("research_submit", expect.objectContaining({ request, operation: "labels_import" }));
    expect(mocks.request).toHaveBeenCalledWith("research_run", expect.objectContaining({ job_id: "c".repeat(32) }), 0);
    expect(mocks.request.mock.calls.some(([method]) => method === "research_execute")).toBe(false);
  });


  it("binds native vision handoff publication to the selected source and sanitizes its receipt", async () => {
    const project = path.join(root, "Vision study.loci-study");
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: project }); await call("create");
    const request = { source_id: "b".repeat(32), selection: { x: 0, y: 0, width: 10, height: 10, t: 0, c: 0, z: 0, level: 0 },
      channels: [{ channel: 0, low: 0, high: 255, gamma: 1, color: "#ffffff", opacity: 1, visible: true }], projection: "plane", max_size: 512 };
    const receipt = { schema: "loci.vision-handoff-receipt/v1", source_id: request.source_id, source_sha256: sha,
      basename: "candidate.loci-vision", status: "provisional-visualization", artifacts: Object.fromEntries(
        ["image.png", "context.json", "README.md", "manifest.json"].map((name) => [name, { sha256: sha, size_bytes: 10 }])) };
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: path.join(root, receipt.basename) });
    mocks.request.mockResolvedValueOnce(receipt);
    expect(await call("vision-handoff", request, sha)).toEqual(receipt);
    expect(mocks.request).toHaveBeenLastCalledWith("research_vision_handoff", {
      project, request, source_sha256: sha, destination: path.join(root, receipt.basename),
    }, 0);
    const calls = mocks.save.mock.calls.length;
    await expect(call("vision-handoff", { ...request, path: "/private/file" }, sha)).rejects.toThrow();
    expect(mocks.save.mock.calls).toHaveLength(calls);
    mocks.save.mockResolvedValueOnce({ canceled: true });
    expect(await call("vision-handoff", request, sha)).toBeNull();
  });

  it("requests an export root for a handoff-only agent grant and freezes the clicked request", async () => {
    const project = path.join(root, "Agent study.loci-study");
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: project }); await call("create");
    const value = { allow_export: false, interactive: { allow_handoff: true }, source_id: "b".repeat(32) };
    let folderReady!: (value: unknown) => void;
    mocks.open.mockImplementationOnce(() => new Promise((done) => { folderReady = done; }));
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: path.join(root, "access") });
    const pending = call("agent-access", value);
    value.interactive.allow_handoff = false;
    folderReady({ canceled: false, filePaths: [root] });
    await pending;
    expect(mocks.request).toHaveBeenLastCalledWith("research_agent_access", {
      project, request: { ...value, interactive: { allow_handoff: true } }, export_root: root, destination: path.join(root, "access"),
    }, 0);
  });

  it("preflights every workflow target before any batch submission", async () => {
    const project = path.join(root, "Workflow study.loci-study");
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: project });
    await call("create");
    const sources = ["a", "b"].map((id) => ({
      id: id.repeat(32), sha256: id.repeat(64), name: id, metadata: {},
    }));
    const tasks = sources.map((source) => ({
      operation: "workflow_run" as const,
      source: { id: source.id, sha256: source.sha256 },
      request: { source_id: source.id, source_sha256: source.sha256,
        workflow_id: "c".repeat(32), workflow_revision: 1, definition_sha256: "d".repeat(64), selection: {} },
    }));
    const events: string[] = [];
    let rejectSecond = true;
    mocks.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === "research_snapshot") return nativeSnapshot(sources);
      if (method === "research_execute") {
        expect(params.operation).toBe("workflow_preflight");
        const request = params.request as Record<string, unknown>;
        events.push(`preflight:${request.source_id}`);
        if (rejectSecond && request.source_id === sources[1].id) throw new Error("Incompatible channel count");
        return {};
      }
      if (method === "research_submit") {
        events.push("submit");
        return { id: "e".repeat(32) };
      }
      return {};
    });
    await expect(call("batch-submit", tasks)).rejects.toThrow("Incompatible channel count");
    expect(events).toEqual(sources.map((source) => `preflight:${source.id}`));
    expect(mocks.request.mock.calls.some(([method]) => method === "research_submit")).toBe(false);
    rejectSecond = false;
    events.length = 0;
    await call("batch-submit", tasks);
    expect(events).toEqual([...sources.map((source) => `preflight:${source.id}`), "submit", "submit"]);
  });

  it("exports exact workflow runs only through the native destination picker", async () => {
    const project = path.join(root, "Workflow export study.loci-study");
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: project });
    await call("create");
    const resultId = "a".repeat(32), revision = "b".repeat(64), runId = "c".repeat(32);
    const destination = path.join(root, "Reviewed workflow");
    mocks.request.mockImplementation(async (method: string) => {
      if (method === "research_snapshot") return nativeSnapshot([]);
      if (method === "research_workflow_export") return {
        export_name: "Reviewed workflow", manifest_sha256: "d".repeat(64), destination,
      };
      return {};
    });
    await expect(call("export", resultId, revision, "invalid")).rejects.toThrow("exact saved workflow run");
    mocks.save.mockResolvedValueOnce({ canceled: true });
    await expect(call("export", resultId, revision, runId)).resolves.toBeNull();
    expect(mocks.request.mock.calls.some(([method]) => method === "research_workflow_export")).toBe(false);
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: destination });
    const receipt = await call("export", resultId, revision, runId);
    expect(mocks.request).toHaveBeenLastCalledWith("research_workflow_export", {
      project, run_id: runId, result_id: resultId, revision_hash: revision, destination,
    }, 0);
    expect(receipt).toMatchObject({ name: "Reviewed workflow", manifest_sha256: "d".repeat(64) });
    expect(JSON.stringify(receipt)).not.toContain(root);
  });

  it("returns installed-memory guidance without a study and enforces sender trust", async () => {
    expect(await call("recipe-resources")).toMatchObject({
      total_memory_bytes: os.totalmem(), maximum_working_bytes: 8 * 1024 ** 3,
      recommendation_basis: "quarter-installed-memory/v1",
    });
    expect(mocks.request).not.toHaveBeenCalled();
    new ResearchBridge().register(() => { throw new Error("Untrusted sender"); });
    await expect(call("recipe-resources")).rejects.toThrow("Untrusted sender");
  });

  it("keeps vendor paths in main and binds conversion to the inspected source hash", async () => {
    const grant = await createAndInspect();
    expect(JSON.stringify(grant)).not.toContain(root);
    expect(grant.source_sha256).toBe(sha);
    const destination = path.join(root, "Converted");
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: destination });
    const selection = { series: 0, c: 1, z: 2, t: 0, crop: null,
      heap_mib: 768, timeout_seconds: 300, max_output_bytes: 1024 ** 2 };
    await call("vendor-convert", { grant_id: grant.grant_id, ...selection });
    expect(mocks.request).toHaveBeenLastCalledWith("research_vendor_convert", {
      project: path.join(root, "Study.loci-study"), source: path.join(root, "sample.nd2"),
      jar: path.join(root, "reader.jar"), java: path.join(root, "java"), destination,
      request: selection, expected_source_sha256: sha,
    }, 0);
  });

  it("forwards bounded source ordering to the active engine study", async () => {
    const project = path.join(root, "Ordered study.loci-study");
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: project });
    await call("create");
    const sources = [
      { id: "b".repeat(32), name: "First", sha256: "c".repeat(64), metadata: {} },
      { id: "d".repeat(32), name: "Second", sha256: "e".repeat(64), metadata: {} },
    ];
    mocks.request.mockImplementation(async (method: string) =>
      method === "research_source_order" ? nativeSnapshot([...sources].reverse()) : {});
    const request = {
      expected_revision: 0,
      sources: [...sources].reverse().map(({ id, sha256 }) => ({ id, sha256 })),
    };

    const reordered = await call("source-order", request) as ResearchSnapshot;

    expect(reordered.sources.map(({ id }) => id)).toEqual([sources[1].id, sources[0].id]);
    expect(mocks.request).toHaveBeenLastCalledWith("research_source_order", {
      project,
      request,
    });
  });

  it("exports pending review material through a native parent picker without changing review", async () => {
    const project = path.join(root, "Study.loci-study");
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: project });
    await call("create");
    const output = path.join(root, "outputs");
    await fs.mkdir(output);
    mocks.open.mockResolvedValueOnce({ canceled: false, filePaths: [output] });
    const bindings = [{ source_id: "b".repeat(32), source_sha256: sha,
      result_id: "c".repeat(32), revision_hash: "d".repeat(64) }];
    const expected = { schema: "loci.review-package-receipt/v1", status: "provisional-review-material",
      basename: "Synthetic RGB collection", image_count: 1, summary_name: "counts.csv", manifest_sha256: sha };
    mocks.request.mockResolvedValueOnce(expected);
    const receipt = await call("review-package-export", bindings, { rootLabel: expected.basename });
    expect(receipt).toEqual(expected);
    expect(mocks.request).toHaveBeenLastCalledWith("research_review_package_export", {
      project, request: { bindings, root_label: expected.basename },
      destination: path.join(output, expected.basename),
    }, 0);
    expect(mocks.request.mock.calls.some(([method]) => method === "research_review")).toBe(false);
    expect(JSON.stringify(receipt)).not.toContain(root);
  });

  it("rejects review package path injection before opening a destination picker", async () => {
    const project = path.join(root, "Study.loci-study");
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: project });
    await call("create");
    const bindings = [{ source_id: "b".repeat(32), source_sha256: sha,
      result_id: "c".repeat(32), revision_hash: "d".repeat(64) }];
    for (const rootLabel of ["../escape", "/absolute", "a\\b", ".hidden", "CON", "bad "]) {
      await expect(call("review-package-export", bindings, { rootLabel })).rejects.toThrow("portable");
    }
    await expect(call("review-package-export", bindings, {
      rootLabel: "review", destination: "/renderer/path",
    })).rejects.toThrow("explicit");
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("exports exact reviewed revisions into mirrored bundles and commits aggregate metadata last", async () => {
    const project = path.join(root, "Study.loci-study");
    const output = path.join(root, "export");
    await fs.mkdir(output);
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: project });
    await call("create");
    mocks.open.mockResolvedValueOnce({ canceled: false, filePaths: [output] });
    const sourceId = "b".repeat(32);
    const resultId = "c".repeat(32);
    const revision = "d".repeat(64);
    mocks.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === "research_batch_export_plan") return { items: [{
        source_id: sourceId, result_id: resultId, revision_hash: revision,
        source_relative_path: "day-2/repeat/=formula.png", export_basename: "formula_loci",
        object_count: 7,
      }] };
      if (method === "research_export") {
        const destination = params.destination as string;
        await fs.mkdir(destination);
        await fs.writeFile(path.join(destination, "manifest.json"), "{}\n");
        return {
          export_name: path.basename(destination), manifest_sha256: sha,
          files: [{ name: "manifest.json", sha256: sha, size_bytes: 3 }],
          result_id: resultId, revision_hash: revision,
        };
      }
      if (method === "publish_batch_metadata") return { files: {} };
      return {};
    });

    const receipt = await call("batch-export", [{
      source_id: sourceId, source_sha256: sha, result_id: resultId, revision_hash: revision,
    }], { mode: "bundles+summary" }) as { exportedCount: number; summaryName: string };

    expect(receipt.exportedCount).toBe(1);
    expect(receipt.summaryName).toMatch(/^loci_count_summary_/u);
    expect(await fs.stat(path.join(output, "day-2", "repeat", "formula_loci")))
      .toMatchObject({});
    const publish = mocks.request.mock.calls
      .findLast(([method]) => method === "publish_batch_metadata")![1] as {
        files: Record<string, string>;
      };
    const csv = Object.entries(publish.files).find(([name]) => name.startsWith("loci_count_summary_"))![1];
    expect(csv).toContain("day-2/repeat/=formula.png,7");
    const manifest = JSON.parse(Object.entries(publish.files)
      .find(([name]) => name.startsWith("loci_batch_manifest_"))![1]);
    expect(manifest.outputs[0]).toMatchObject({
      source_relative_path: "day-2/repeat/=formula.png",
      output_directory: "day-2/repeat/formula_loci",
      result_id: resultId,
      revision_hash: revision,
    });
  });

  it("publishes summary-only batch metadata without creating result bundles", async () => {
    const project = path.join(root, "Study.loci-study");
    const output = path.join(root, "summary-export");
    await fs.mkdir(output);
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: project });
    await call("create");
    mocks.open.mockResolvedValueOnce({ canceled: false, filePaths: [output] });
    const sourceId = "b".repeat(32);
    const resultId = "c".repeat(32);
    const revision = "d".repeat(64);
    mocks.request.mockImplementation(async (method: string) => {
      if (method === "research_batch_export_plan") return { items: [{
        source_id: sourceId, result_id: resultId, revision_hash: revision,
        source_relative_path: "=formula.png", export_basename: "formula_loci", object_count: 7,
      }] };
      if (method === "publish_batch_metadata") return { files: {} };
      return {};
    });

    const receipt = await call("batch-export", [{
      source_id: sourceId, source_sha256: sha, result_id: resultId, revision_hash: revision,
    }], { mode: "summary-only" }) as { exportedCount: number; selectedCount: number };

    expect(receipt).toMatchObject({ exportedCount: 0, selectedCount: 1 });
    expect(mocks.request.mock.calls.some(([method]) => method === "research_export")).toBe(false);
    expect(await fs.readdir(output)).toEqual([]);
    const publish = mocks.request.mock.calls
      .findLast(([method]) => method === "publish_batch_metadata")![1] as {
        files: Record<string, string>;
      };
    const csv = Object.entries(publish.files).find(([name]) => name.startsWith("loci_count_summary_"))![1];
    expect(csv).toContain("'=formula.png,7");
  });

  it("rejects colliding sanitized bundle targets before publishing either result", async () => {
    const project = path.join(root, "Study.loci-study");
    const output = path.join(root, "collision-export");
    await fs.mkdir(output);
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: project });
    await call("create");
    mocks.open.mockResolvedValueOnce({ canceled: false, filePaths: [output] });
    const sourceA = "b".repeat(32);
    const sourceB = "e".repeat(32);
    const resultA = "c".repeat(32);
    const resultB = "f".repeat(32);
    const revision = "d".repeat(64);
    mocks.request.mockImplementation(async (method: string) => method === "research_batch_export_plan"
      ? { items: [
          { source_id: sourceA, result_id: resultA, revision_hash: revision,
            source_relative_path: "first image.png", export_basename: "same_loci", object_count: 1 },
          { source_id: sourceB, result_id: resultB, revision_hash: revision,
            source_relative_path: "other image.tif", export_basename: "same_loci", object_count: 2 },
        ] }
      : {});

    await expect(call("batch-export", [
      { source_id: sourceA, source_sha256: sha, result_id: resultA, revision_hash: revision },
      { source_id: sourceB, source_sha256: "9".repeat(64), result_id: resultB, revision_hash: revision },
    ], { mode: "bundles" })).rejects.toThrow("same mirrored batch output");
    expect(mocks.request.mock.calls.some(([method]) => method === "research_export")).toBe(false);
    expect(await fs.readdir(output)).toEqual([]);
  });

  it("uses the engine's exact maximum-length portable bundle basename", async () => {
    const project = path.join(root, "Study.loci-study");
    const output = path.join(root, "long-name-export");
    await fs.mkdir(output);
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: project });
    await call("create");
    mocks.open.mockResolvedValueOnce({ canceled: false, filePaths: [output] });
    const sourceId = "b".repeat(32);
    const resultId = "c".repeat(32);
    const revision = "d".repeat(64);
    const exportBasename = `${"a".repeat(75)}_loci`;
    expect(exportBasename).toHaveLength(80);
    mocks.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === "research_batch_export_plan") return { items: [{
        source_id: sourceId, result_id: resultId, revision_hash: revision,
        source_relative_path: "nested/a very long original acquisition name.ome.tiff",
        export_basename: exportBasename, object_count: 4,
      }] };
      if (method === "research_export") {
        const destination = params.destination as string;
        await fs.mkdir(destination);
        await fs.writeFile(path.join(destination, "manifest.json"), "{}\n");
        return {
          export_name: path.basename(destination), manifest_sha256: sha,
          files: [{ name: "manifest.json", sha256: sha, size_bytes: 3 }],
          result_id: resultId, revision_hash: revision,
        };
      }
      if (method === "publish_batch_metadata") return { files: {} };
      return {};
    });

    const receipt = await call("batch-export", [{
      source_id: sourceId, source_sha256: sha, result_id: resultId, revision_hash: revision,
    }], { mode: "bundles" }) as { exportedCount: number };

    expect(receipt.exportedCount).toBe(1);
    expect(await fs.stat(path.join(output, "nested", exportBasename))).toMatchObject({});
    const exportRequest = mocks.request.mock.calls
      .find(([method]) => method === "research_export")![1] as { destination: string };
    expect(exportRequest.destination).toBe(path.join(
      await fs.realpath(output), "nested", exportBasename,
    ));
  });

  it("rejects an unsafe engine bundle basename before exporting any result", async () => {
    const project = path.join(root, "Study.loci-study");
    const output = path.join(root, "unsafe-name-export");
    await fs.mkdir(output);
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: project });
    await call("create");
    mocks.open.mockResolvedValueOnce({ canceled: false, filePaths: [output] });
    const sourceId = "b".repeat(32);
    const resultId = "c".repeat(32);
    const revision = "d".repeat(64);
    mocks.request.mockImplementation(async (method: string) => method === "research_batch_export_plan"
      ? { items: [{
          source_id: sourceId, result_id: resultId, revision_hash: revision,
          source_relative_path: "safe/input.png", export_basename: "../escaped_loci", object_count: 1,
        }] }
      : {});

    await expect(call("batch-export", [{
      source_id: sourceId, source_sha256: sha, result_id: resultId, revision_hash: revision,
    }], { mode: "bundles" })).rejects.toThrow("invalid reviewed bundle name");
    expect(mocks.request.mock.calls.some(([method]) => method === "research_export")).toBe(false);
    expect(await fs.readdir(output)).toEqual([]);
  });

  it("keeps the selected rendered source format exact across the native dialog boundary", async () => {
    const project = path.join(root, "Study.loci-study");
    const destination = path.join(root, "Rendered source.tiff");
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: project });
    await call("create");
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: destination });
    const request = {
      source_id: "b".repeat(32), source_sha256: sha, format: "tiff",
      view: { source_id: "b".repeat(32), selection: {
        x: 0, y: 0, width: 16, height: 16, t: 0, c: 0, z: 0, level: 0,
      } },
    };

    await call("export-source-view", request);

    expect(mocks.save).toHaveBeenLastCalledWith({
      title: "Export rendered source TIFF",
      defaultPath: "Rendered source.tiff",
      filters: [{ name: "Rendered TIFF", extensions: ["tiff"] }],
    });
    expect(mocks.request).toHaveBeenLastCalledWith("research_source_rendered_export", {
      project, request, destination,
    }, 0);
  });

  it("cancels a volume-figure picker without publishing artifacts", async () => {
    const project = path.join(root, "Study.loci-study");
    const request = volumeFigureRequest();
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: project });
    await call("create");
    mocks.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === "research_execute" && params.operation === "source_view")
        return { source_id: request.source_id, source_sha256: request.source_sha256 };
      throw new Error(`Unexpected engine call: ${method}`);
    });
    mocks.save.mockResolvedValueOnce({ canceled: true });

    await expect(call("export-volume-figure", request)).resolves.toBeNull();

    expect(mocks.request.mock.calls.filter(([, params]) =>
      params.operation === "verify_source")).toHaveLength(0);
    expect((await fs.readdir(root)).filter((name) =>
      name.endsWith(".loci-figure") || name.startsWith(".loci-volume-figure-"))).toEqual([]);
  });

  it("rejects untrusted statistics export senders before touching a project or picker", async () => {
    new ResearchBridge().register(() => { throw new Error("Untrusted sender"); });
    await expect(call("export-statistics-figure", {})).rejects.toThrow("Untrusted sender");
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("keeps study switches locked during statistics picker and uses dedicated export RPC", async () => {
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: path.join(root, "Study.loci-study") });
    await call("create");
    const request: StatisticsFigureExportRequest = {
      schema_version: "loci.statistics-figure-request/v1", source_id: "b".repeat(32), source_sha256: sha,
      result_id: "c".repeat(32), revision_hash: "d".repeat(64), query_sha256: "e".repeat(64), membership_sha256: "f".repeat(64),
      query: { x_metric: "measure", y_metric: "voxel_count", filters: [], sort: null, offset: 0, limit: 25, plot_limit: 500, bins: 16, selected_label: null },
      chart: "histogram", domain: { mode: "full" }, width_mm: 85, height_mm: 65, preset: "publication-monochrome",
    };
    const destination = path.join(root, "Statistics.loci-figure");
    const receipt = {
      schema_version: "loci.statistics-figure-receipt/v1", basename: "Statistics.loci-figure",
      source_id: request.source_id, source_sha256: sha, result_id: request.result_id, revision_hash: request.revision_hash,
      query_sha256: request.query_sha256, membership_sha256: request.membership_sha256,
      width_mm: 85, height_mm: 65, width_px: 2008, height_px: 1535, dpi: 600,
      artifacts: Object.fromEntries(["figure.svg", "figure.png", "manifest.json"].map((name) => [name, { sha256: sha, size_bytes: 12 }])),
    };
    mocks.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === "research_execute" && params.operation === "population_query") return { schema: "loci.population/v1", ...request };
      if (method === "research_statistics_figure_export") return receipt;
      throw new Error(`Unexpected method ${method}`);
    });
    let closePicker!: (value: { canceled: false; filePath: string }) => void;
    mocks.save.mockImplementationOnce(() => new Promise((resolve) => { closePicker = resolve; }));
    const pending = call("export-statistics-figure", request);
    await vi.waitFor(() => expect(closePicker).toBeTypeOf("function"));
    await expect(call("new-session")).rejects.toThrow(/active study operation/);
    closePicker({ canceled: false, filePath: destination });
    await expect(pending).resolves.toEqual(receipt);
    expect(mocks.request.mock.calls.filter(([method, params]) => method === "research_execute" && params.operation === "population_query")).toHaveLength(2);
    expect(mocks.request).toHaveBeenCalledWith("research_statistics_figure_export", expect.objectContaining({ request, destination, application_version: "0.1.0" }), 0);
    await expect(call("export-statistics-figure", { ...request, membership_sha256: "9".repeat(64) })).rejects.toThrow(/changed/);
  });

  it("rejects a volume figure when the post-picker source verification is stale", async () => {
    const project = path.join(root, "Study.loci-study");
    const destination = path.join(root, "Stale.loci-figure");
    const request = volumeFigureRequest();
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: project });
    await call("create");
    mocks.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === "research_execute" && params.operation === "source_view")
        return { source_id: request.source_id, source_sha256: request.source_sha256 };
      if (method === "research_execute" && params.operation === "verify_source")
        return { source_id: request.source_id, source_sha256: "d".repeat(64) };
      throw new Error(`Unexpected engine call: ${method}`);
    });
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: destination });

    await expect(call("export-volume-figure", request)).rejects.toThrow(/source changed/i);
    await expect(fs.lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.readdir(root)).filter((name) =>
      name.endsWith(".loci-figure") || name.startsWith(".loci-volume-figure-"))).toEqual([]);
  });

  it("keeps study switching locked while a volume-figure picker is open", async () => {
    const project = path.join(root, "Study.loci-study");
    const request = volumeFigureRequest();
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: project });
    await call("create");
    mocks.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === "research_execute" && params.operation === "source_view")
        return { source_id: request.source_id, source_sha256: request.source_sha256 };
      throw new Error(`Unexpected engine call: ${method}`);
    });
    let closePicker!: (value: { canceled: true }) => void;
    mocks.save.mockImplementationOnce(() => new Promise((resolve) => { closePicker = resolve; }));

    const pending = call("export-volume-figure", request);
    await vi.waitFor(() => expect(closePicker).toBeTypeOf("function"));
    await expect(call("new-session")).rejects.toThrow("Finish or cancel the active study operation first.");
    closePicker({ canceled: true });

    await expect(pending).resolves.toBeNull();
    await expect(call("session-state")).resolves.toMatchObject({ status: "ready" });
  });

  it("publishes a path-redacted atomic volume-figure bundle after both source checks", async () => {
    const project = path.join(root, "Study.loci-study");
    const destination = path.join(root, "Volume figure.loci-figure");
    const request = volumeFigureRequest();
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: project });
    await call("create");
    mocks.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === "research_execute" && ["source_view", "verify_source"].includes(String(params.operation)))
        return { source_id: request.source_id, source_sha256: request.source_sha256 };
      if (method === "publish_volume_figure") {
        await fs.rename(String(params.staging), String(params.destination));
        return { published: true };
      }
      throw new Error(`Unexpected engine call: ${method}`);
    });
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: destination });

    const receipt = await call("export-volume-figure", request) as {
      basename: string;
      width: number;
      height: number;
      hashes: Record<string, string>;
    };

    expect(receipt).toMatchObject({ basename: "Volume figure.loci-figure", width: 2, height: 2 });
    expect(receipt.hashes).toEqual({
      "image.png": expect.stringMatching(/^[a-f0-9]{64}$/),
      "manifest.json": expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(receipt)).not.toContain(root);
    expect((await fs.readdir(destination)).sort()).toEqual(["image.png", "manifest.json"]);
    const operations = mocks.request.mock.calls
      .filter(([method]) => method === "research_execute")
      .map(([, params]) => params.operation);
    expect(operations).toEqual(["source_view", "verify_source"]);
    expect(mocks.request.mock.calls.some(([method, params]) =>
      method === "publish_volume_figure" &&
      Array.isArray(params.artifacts) && params.artifacts.length === 2)).toBe(true);
  });

  it("rejects invented and stale grants and preserves cancellation", async () => {
    await expect(call("vendor-convert", { grant_id: "forged" })).rejects.toThrow("Create or open");
    const grant = await createAndInspect();
    await expect(call("vendor-convert", { grant_id: "forged" })).rejects.toThrow("Inspect");
    mocks.save.mockResolvedValueOnce({ canceled: true });
    expect(await call("vendor-convert", { grant_id: grant.grant_id })).toBeNull();
    expect(mocks.request.mock.calls.some(([method]) => method === "research_vendor_convert")).toBe(false);
    const other = path.join(root, "Other.loci-study");
    await createEngineStudy(other);
    mocks.open.mockResolvedValueOnce({ canceled: false, filePaths: [other] });
    await call("open");
    await expect(call("vendor-convert", { grant_id: grant.grant_id })).rejects.toThrow("Inspect");
  });

  it("checks the sender before opening a native picker", async () => {
    new ResearchBridge().register(() => { throw new Error("Untrusted sender"); });
    await expect(call("vendor-inspect")).rejects.toThrow("Untrusted sender");
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("creates a fixed offline example without renderer path authority", async () => {
    mocks.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === "research_create_example") {
        await createEngineStudy(params.path as string);
        return { project: { title: "Synthetic shapes practice" }, sources: [{ id: "b".repeat(32) }], results: [] };
      }
      return {};
    });
    await expect(call("try-example", "/arbitrary/source")).rejects.toThrow("does not accept source paths");
    expect(mocks.request).not.toHaveBeenCalled();
    const next = await call("try-example") as ResearchSnapshot;
    expect(next.results).toEqual([]);
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(await call("session-state")).toMatchObject({ status: "ready", storage: "managed", title: "Synthetic shapes practice" });
    const request = mocks.request.mock.calls.find(([method]) => method === "research_create_example")![1];
    expect(Object.keys(request)).toEqual(["path"]);
    expect(path.dirname(request.path)).toBe(path.join(root, "sessions"));
    expect(JSON.stringify(next)).not.toContain(root);
  });

  it("keeps the app-owned example source after Save As and managed-session discard", async () => {
    let sourcePath = "";
    mocks.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === "research_create_example") {
        await createEngineStudy(params.path as string);
        sourcePath = `${params.path}.source`;
        await fs.mkdir(sourcePath);
        await fs.writeFile(path.join(sourcePath, "synthetic-shapes-v1.ome.tiff"), "immutable source");
      }
      if (method === "research_project_clone") await fs.cp(params.project as string, params.destination as string, { recursive: true, errorOnExist: true, force: false });
      return {};
    });
    await call("try-example");
    const session = await call("session-state") as { sessionId: string };
    const saved = path.join(root, "Saved.loci-study");
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: saved });
    await call("save-as");
    await call("new-session");
    await call("recovery-discard", session.sessionId);
    expect(await fs.readFile(path.join(sourcePath, "synthetic-shapes-v1.ome.tiff"), "utf8")).toBe("immutable source");
    expect(await fs.readFile(path.join(saved, "study.sqlite3"), "utf8")).toBe("engine-study");
  });

  it("preserves the previous active session when offline creation fails", async () => {
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: path.join(root, "Prior.loci-study") });
    await call("create");
    const prior = await call("session-state");
    mocks.request.mockRejectedValueOnce(new Error("Example import rejected"));
    await expect(call("try-example")).rejects.toThrow("Example import rejected");
    expect(await call("session-state")).toEqual(prior);
    await expect(call("snapshot")).resolves.toEqual({});
  });

  it("holds the study lock through exact relink and preserves the study on picker cancellation", async () => {
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: path.join(root, "Prior.loci-study") });
    await call("create");
    const prior = await call("session-state");
    let finish!: (value: { canceled: boolean; filePaths: string[] }) => void;
    mocks.open.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = call("relink-source", "b".repeat(32), "file");
    await vi.waitFor(() => expect(finish).toBeDefined());
    await expect(call("new-session")).rejects.toThrow("Finish or cancel");
    await expect(call("try-example")).rejects.toThrow("Finish or cancel");
    finish({ canceled: true, filePaths: [] });
    await expect(pending).resolves.toBeNull();
    expect(await call("session-state")).toEqual(prior);
    await expect(call("new-session")).resolves.toEqual({ status: "empty" });
  });

  it.each([
    ["file", ["openFile"], "/exact.tiff"],
    ["dicom", ["openFile", "multiSelections"], ["/exact-1.dcm", "/exact-2.dcm"]],
    ["ome_zarr", ["openDirectory"], "/exact.zarr"],
  ])("keeps the native %s relink route and propagates mismatches", async (kind, properties, candidate) => {
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: path.join(root, "Study.loci-study") });
    await call("create");
    mocks.request.mockClear();
    mocks.open.mockResolvedValueOnce({ canceled: false, filePaths: Array.isArray(candidate) ? candidate : [candidate] });
    mocks.request.mockRejectedValueOnce(new Error("Relink rejected: selected bytes do not exactly match the source"));
    await expect(call("relink-source", "b".repeat(32), kind)).rejects.toThrow("do not exactly match");
    expect(mocks.open).toHaveBeenLastCalledWith(expect.objectContaining({ properties }));
    expect(mocks.request).toHaveBeenCalledWith("research_relink", expect.objectContaining({ source_id: "b".repeat(32), candidate }), 0);
    expect(mocks.request).not.toHaveBeenCalledWith("research_snapshot", expect.anything());
  });

  it("does not allocate a managed session when the image picker is cancelled", async () => {
    mocks.open.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    await expect(call("open-images", "files")).resolves.toBeNull();
    expect(mocks.request).not.toHaveBeenCalled();
    await expect(fs.lstat(path.join(root, "sessions"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(call("session-state")).resolves.toEqual({ status: "empty" });
  });

  it("recursively enumerates a bounded image folder before importing files", async () => {
    const folder = path.join(root, "Acquisition");
    await fs.mkdir(path.join(folder, "field-2"), { recursive: true });
    await fs.mkdir(path.join(folder, ".hidden"));
    const first = path.join(folder, "field-2", "image-2.tif");
    const second = path.join(folder, "field-2", "image-10.png");
    await Promise.all([
      fs.writeFile(first, "pixels"),
      fs.writeFile(second, "pixels"),
      fs.writeFile(path.join(folder, ".hidden", "ignored.tif"), "pixels"),
      fs.writeFile(path.join(folder, "notes.txt"), "notes"),
    ]);
    mocks.open.mockResolvedValueOnce({ canceled: false, filePaths: [folder] });

    await call("open-images", "folder");
    expect(mocks.request).toHaveBeenLastCalledWith("research_import", expect.objectContaining({
      paths: [first, second],
      relative_paths: ["field-2/image-2.tif", "field-2/image-10.png"],
      import_root: folder,
      kind: "files",
    }), 0);
  });

  it("excludes prior Loci export bundles while retaining ordinary similarly named folders", async () => {
    const folder = path.join(root, "Acquisition");
    const priorExport = path.join(folder, "previous_loci");
    const ordinary = path.join(folder, "control_loci");
    await Promise.all([
      fs.mkdir(priorExport, { recursive: true }),
      fs.mkdir(ordinary, { recursive: true }),
    ]);
    const source = path.join(folder, "field.png");
    const ignored = path.join(priorExport, "old-overlay.png");
    const retained = path.join(ordinary, "control.png");
    await Promise.all([
      fs.writeFile(source, "pixels"),
      fs.writeFile(ignored, "export pixels"),
      fs.writeFile(retained, "control pixels"),
      fs.writeFile(path.join(priorExport, "loci-export.json"), JSON.stringify({
        bundle_kind: "loci-export",
      })),
    ]);
    mocks.open.mockResolvedValueOnce({ canceled: false, filePaths: [folder] });

    await call("open-images", "folder");
    expect(mocks.request).toHaveBeenLastCalledWith("research_import", expect.objectContaining({
      paths: [retained, source],
      kind: "files",
    }), 0);
    expect(JSON.stringify(mocks.request.mock.calls)).not.toContain(ignored);
  });

  it("rejects ambiguous directory routes before allocating a managed study", async () => {
    const dicomFolder = path.join(root, "DICOM");
    await fs.mkdir(dicomFolder);
    await fs.writeFile(path.join(dicomFolder, "slice.dcm"), "dicom");
    mocks.open.mockResolvedValueOnce({ canceled: false, filePaths: [dicomFolder] });
    await expect(call("open-images", "folder")).rejects.toThrow("DICOM import route");

    const zarrFolder = path.join(root, "volume.zarr");
    await fs.mkdir(zarrFolder);
    mocks.open.mockResolvedValueOnce({ canceled: false, filePaths: [zarrFolder] });
    await expect(call("open-images", "folder")).rejects.toThrow("OME-Zarr import route");
    expect(mocks.request).not.toHaveBeenCalled();
    await expect(call("session-state")).resolves.toEqual({ status: "empty" });
  });

  it("retains a managed recovery session when first-image import fails", async () => {
    const source = path.join(root, "cells.tif");
    await fs.writeFile(source, "source pixels");
    mocks.open.mockResolvedValueOnce({ canceled: false, filePaths: [source] });
    mocks.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === "research_create") {
        await createEngineStudy(params.path as string);
        return {};
      }
      if (method === "research_import") throw new Error("decoder rejected the image");
      return {};
    });

    await expect(call("open-images", "files")).rejects.toThrow("decoder rejected");
    const state = await call("session-state") as Record<string, unknown>;
    expect(state).toMatchObject({ status: "ready", storage: "managed", saved: false });
    expect(JSON.stringify(state)).not.toContain(root);
    expect(await call("recovery-list") as unknown[]).toHaveLength(1);
    expect(await fs.readFile(source, "utf8")).toBe("source pixels");
  });

  it("persists an eleven-source queue before execution and rediscovers untouched work after restart", async () => {
    const project = path.join(root, "Batch study.loci-study");
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: project });
    await call("create");
    const sources = Array.from({ length: 11 }, (_, index) => ({
      id: (index + 1).toString(16).padStart(32, "0"),
      name: `Field ${index + 1}`,
      sha256: (index + 17).toString(16).padStart(64, "0"),
      metadata: {},
    }));
    const jobs: ResearchJob[] = [];
    mocks.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === "research_snapshot") return nativeSnapshot(sources, jobs);
      if (method === "research_submit") {
        const created = durableJob({
          id: (jobs.length + 101).toString(16).padStart(32, "0"),
          requestKey: params.request_key as string,
          requestHash: (jobs.length + 201).toString(16).padStart(64, "0"),
          operation: params.operation as string,
          request: params.request as Record<string, unknown>,
        });
        jobs.push(created);
        return created;
      }
      if (method === "research_run") {
        const active = jobs.find((job) => job.id === params.job_id)!;
        active.state = "succeeded";
        active.progress = 1;
        active.result_ids = ["f".repeat(32)];
        return { job: active };
      }
      return {};
    });
    const tasks = sources.map((source) => ({
      operation: "run_recipe" as const,
      source: { id: source.id, sha256: source.sha256 },
      request: { source_id: source.id, selection: {}, recipe: {} },
    }));

    const submitted = await call("batch-submit", tasks) as { batch_id: string; jobs: ResearchJob[] };
    expect(submitted.jobs).toHaveLength(11);
    expect(mocks.request.mock.calls.filter(([method]) => method === "research_submit"))
      .toHaveLength(11);
    expect(mocks.request.mock.calls.some(([method]) => method === "research_run")).toBe(false);

    mocks.handlers.clear();
    new ResearchBridge().register(() => {});
    const reopened = await call("snapshot") as ResearchSnapshot;
    expect(reopened.jobs.map((job) => job.state)).toEqual(Array(11).fill("queued"));
    const resumed = await call("batch-resume", submitted.batch_id) as { jobs: ResearchJob[] };
    expect(resumed.jobs).toHaveLength(11);
    expect(mocks.request.mock.calls.filter(([method]) => method === "research_submit"))
      .toHaveLength(11);
    await call("batch-run", submitted.batch_id, resumed.jobs[0].id);
    expect(jobs.filter((job) => job.state === "succeeded")).toHaveLength(1);
    expect(jobs.filter((job) => job.state === "queued")).toHaveLength(10);
  });

  it("resumes only interrupted work and retries failed or cancelled exact requests without duplicating success", async () => {
    const project = path.join(root, "Retry study.loci-study");
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: project });
    await call("create");
    const source = {
      id: "b".repeat(32), name: "Cells", sha256: "c".repeat(64), metadata: {},
    };
    const batchId = "a".repeat(32);
    const recipeRequest = { source_id: source.id, selection: {}, recipe: {} };
    const cellposeRequest = {
      source_id: source.id,
      selection: {},
      profile_id: "cellpose-sam-v2",
      settings: { device: "mps" },
      measurement_channels: [0],
      working_bytes: 512 * 1024 ** 2,
    };
    const jobs = [
      durableJob({ id: "1".repeat(32), requestKey: `loci-batch:${batchId}:initial:00000`,
        requestHash: "1".repeat(64), state: "interrupted", request: recipeRequest }),
      durableJob({ id: "2".repeat(32), requestKey: `loci-batch:${batchId}:initial:00001`,
        requestHash: "2".repeat(64), state: "failed", operation: "cellpose_run",
        request: { source_id: source.id, task_request: cellposeRequest } }),
      durableJob({ id: "3".repeat(32), requestKey: `loci-batch:${batchId}:initial:00002`,
        requestHash: "3".repeat(64), state: "cancelled", request: recipeRequest }),
      durableJob({ id: "4".repeat(32), requestKey: `loci-batch:${batchId}:initial:00003`,
        requestHash: "4".repeat(64), state: "succeeded", request: recipeRequest }),
    ];
    let created = 0;
    mocks.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === "research_snapshot") return nativeSnapshot([source], jobs);
      if (method === "research_submit") {
        created += 1;
        const added = durableJob({
          id: (created + 10).toString(16).padStart(32, "0"),
          requestKey: params.request_key as string,
          requestHash: params.operation === "cellpose_run" ? "2".repeat(64) :
            (params.request_key as string).includes(":resume:") ? "1".repeat(64) : "3".repeat(64),
          operation: params.operation as string,
          request: params.operation === "cellpose_run"
            ? { source_id: source.id, task_request: params.request }
            : params.request as Record<string, unknown>,
        });
        jobs.push(added);
        return added;
      }
      return {};
    });

    await call("batch-resume", batchId);
    const resumeCalls = mocks.request.mock.calls.filter(
      ([method, params]) => method === "research_submit" &&
        ((params as Record<string, unknown>).request_key as string).includes(":resume:"),
    );
    expect(resumeCalls).toHaveLength(1);
    expect(resumeCalls[0][1]).toMatchObject({ operation: "run_recipe", request: recipeRequest });

    await call("batch-retry", batchId);
    const retryCalls = mocks.request.mock.calls.filter(
      ([method, params]) => method === "research_submit" &&
        ((params as Record<string, unknown>).request_key as string).includes(":retry:"),
    );
    expect(retryCalls).toHaveLength(2);
    expect(retryCalls.find(([, params]) =>
      (params as Record<string, unknown>).operation === "cellpose_run")?.[1])
      .toMatchObject({ request: cellposeRequest });
    expect(retryCalls.some(([, params]) =>
      (params as Record<string, unknown>).request_key ===
        `loci-batch:${batchId}:initial:00003`)).toBe(false);

    await call("batch-retry", batchId);
    expect(mocks.request.mock.calls.filter(
      ([method, params]) => method === "research_submit" &&
        ((params as Record<string, unknown>).request_key as string).includes(":retry:"),
    )).toHaveLength(2);
  });

  it("returns null plus structured recovery state when a remembered saved study moved", async () => {
    const source = path.join(root, "cells.tif");
    await fs.writeFile(source, "source pixels");
    mocks.open.mockResolvedValueOnce({ canceled: false, filePaths: [source] });
    await call("open-images", "files");
    const saved = path.join(root, "Named study.loci-study");
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: saved });
    await call("save-as");
    await fs.rm(saved, { recursive: true });

    mocks.handlers.clear();
    new ResearchBridge().register(() => {});
    await expect(call("snapshot")).resolves.toBeNull();
    await expect(call("session-state")).resolves.toMatchObject({
      status: "recoverable", reason: "saved-study-missing", canKeep: true,
    });
  });

  it("leaves work in Recent, keeps cancelled image opening empty, and starts the next import separately", async () => {
    const saved = path.join(root, "Prior saved.loci-study");
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: saved });
    await call("create");

    await expect(call("new-session")).resolves.toEqual({ status: "empty" });
    await expect(call("session-state")).resolves.toEqual({ status: "empty" });
    const recent = await call("recovery-list") as Array<{ sessionId: string; storage: string }>;
    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({ storage: "saved" });

    mocks.open.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    await expect(call("open-images", "files")).resolves.toBeNull();
    await expect(call("session-state")).resolves.toEqual({ status: "empty" });
    await expect(call("recovery-list") as Promise<unknown[]>).resolves.toHaveLength(1);

    const source = path.join(root, "next-image.tif");
    await fs.writeFile(source, "next source pixels");
    mocks.open.mockResolvedValueOnce({ canceled: false, filePaths: [source] });
    await call("open-images", "files");
    const importCall = mocks.request.mock.calls.findLast(([method]) => method === "research_import");
    const nextProject = importCall?.[1].project as string;
    expect(nextProject).not.toBe(saved);
    expect(nextProject).toMatch(new RegExp(`${path.join(root, "sessions").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*\\.loci-study$`));
    expect(importCall?.[1]).toMatchObject({ paths: [source], kind: "files" });
    await expect(call("recovery-list") as Promise<unknown[]>).resolves.toHaveLength(2);
  });

  it("reopens a ready recent saved study from its saved location", async () => {
    const saved = path.join(root, "Ready saved.loci-study");
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: saved });
    await call("create");
    await call("new-session");
    const [recent] = await call("recovery-list") as Array<{ sessionId: string }>;

    await call("recovery-keep", recent.sessionId);
    expect(mocks.request).toHaveBeenLastCalledWith("research_snapshot", { project: saved });
    await expect(call("session-state")).resolves.toMatchObject({
      status: "ready",
      storage: "saved",
      sessionId: recent.sessionId,
    });
  });

  it("rejects leaving the active session while a main-process job is running", async () => {
    const project = path.join(root, "Busy.loci-study");
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: project });
    await call("create");
    const jobId = "b".repeat(32);
    let finishRun!: (value: unknown) => void;
    mocks.request.mockImplementation(async (method: string) => {
      if (method === "research_submit") return { id: jobId };
      if (method === "research_run") return new Promise((resolve) => {
        finishRun = resolve;
      });
      return {};
    });
    const running = call("execute", "cellpose_run", { source_id: "a".repeat(32) });
    await vi.waitFor(() => expect(finishRun).toBeTypeOf("function"));

    await expect(call("new-session")).rejects.toThrow(
      "Finish or cancel the active study operation first.",
    );
    await expect(call("session-state")).resolves.toMatchObject({
      status: "ready",
      storage: "saved",
    });
    finishRun({});
    await running;
  });

  it("preserves the prior active study when an explicitly opened path is unsafe", async () => {
    const project = path.join(root, "Prior.loci-study");
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: project });
    await call("create");
    const linked = path.join(root, "Linked.loci-study");
    await fs.symlink(project, linked, process.platform === "win32" ? "junction" : "dir");
    mocks.open.mockResolvedValueOnce({ canceled: false, filePaths: [linked] });

    await expect(call("open")).rejects.toThrow("plain study directory");
    await expect(call("session-state")).resolves.toMatchObject({
      status: "ready", title: "Prior", storage: "saved",
    });
    await call("snapshot");
    expect(mocks.request).toHaveBeenLastCalledWith("research_snapshot", { project });
  });

  it("does not switch the active study when Save As collides", async () => {
    const project = path.join(root, "Prior.loci-study");
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: project });
    await call("create");
    const collision = path.join(root, "Existing.loci-study");
    await fs.mkdir(collision);
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: collision });

    await expect(call("save-as")).rejects.toThrow();
    await call("snapshot");
    expect(mocks.request).toHaveBeenLastCalledWith("research_snapshot", { project });
  });

  it("imports a main-validated legacy project into a fresh managed study", async () => {
    const legacy = path.join(root, "Legacy.loci-project");
    mocks.open.mockResolvedValueOnce({ canceled: false, filePaths: [legacy] });
    const prepared = {
      legacy_project: { project_id: "project_1", title: "Legacy", revision: 2, sha256: sha },
      items: [{ legacy_source_id: "source_1" }],
    };
    mocks.prepareLegacy.mockResolvedValueOnce(prepared);
    mocks.request.mockImplementationOnce(async (method: string, params: Record<string, unknown>) => {
      expect(method).toBe("research_create");
      await createEngineStudy(params.path as string);
      return {};
    });
    mocks.request.mockResolvedValueOnce({ snapshot: {}, receipt: { sources: [] } });

    await expect(call("import-legacy-project")).resolves.toEqual({
      snapshot: {}, receipt: { sources: [] },
    });
    expect(mocks.prepareLegacy).toHaveBeenCalledWith(
      legacy, path.join(root, "working-results"),
    );
    const state = await call("session-state") as { status: string; storage?: string };
    expect(state).toMatchObject({ status: "ready", storage: "managed" });
    const project = mocks.request.mock.calls.find(([method]) => method === "research_create")![1]
      .path as string;
    expect(mocks.request).toHaveBeenLastCalledWith("research_import_legacy_project", {
      project,
      ...prepared,
    }, 0);
  });

  it("does not allocate a managed study when legacy import selection is cancelled", async () => {
    mocks.open.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    await expect(call("import-legacy-project")).resolves.toBeNull();
    expect(mocks.prepareLegacy).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
    await expect(fs.lstat(path.join(root, "sessions"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("describes only an exact result revision on the read-only control worker", async () => {
    const project = path.join(root, "Study.loci-study");
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: project });
    await call("create");
    const binding = { result_id: "a".repeat(32), revision_hash: "b".repeat(64) };
    const control = mocks.clients[1];
    await call("execute", "describe_result", binding);
    expect(control.request).toHaveBeenLastCalledWith("research_execute", {
      project, operation: "describe_result", request: binding,
    });
    expect(mocks.request.mock.calls.some(([method]) => method === "research_submit")).toBe(false);
    for (const invalid of [
      { result_id: binding.result_id },
      { ...binding, revision_hash: "stale" },
      { ...binding, private_path: "/private/source" },
    ]) {
      await expect(call("execute", "describe_result", invalid)).rejects.toThrow("exact result");
    }
  });

  it("rejects a result description after its captured study closes", async () => {
    const project = path.join(root, "Study.loci-study");
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: project });
    await call("create");
    let finish!: (value: unknown) => void;
    mocks.request.mockImplementation((method: string) => method === "research_execute"
      ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve({}));
    const pending = call("execute", "describe_result", {
      result_id: "a".repeat(32), revision_hash: "b".repeat(64),
    });
    const rejected = expect(pending).rejects.toThrow("study changed during inspection");
    await call("new-session");
    finish({ schema: "loci.result-context/v1" });
    await rejected;
  });

  it("uses an isolated restartable viewer worker and never cancels the analysis worker", async () => {
    const project = path.join(root, "Study.loci-study");
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: project });
    await call("create");
    const worker = mocks.clients[0];
    const control = mocks.clients[1];
    const viewer = mocks.clients[2];

    await call("execute", "viewer_tile", { source_id: "a".repeat(32) }, {
      viewer_lane: "comparison-a",
    });
    expect(viewer.request).toHaveBeenCalledWith("research_execute", {
      project, operation: "viewer_tile", request: { source_id: "a".repeat(32) },
    }, 0);
    const histogramRequest = { source_id: "a".repeat(32), t: 1, z: 2, bins: 256 };
    await call("execute", "viewer_histogram", histogramRequest);
    expect(viewer.request).toHaveBeenLastCalledWith("research_execute", {
      project, operation: "viewer_histogram", request: histogramRequest,
    }, 0);
    expect(control.request).not.toHaveBeenCalledWith("research_execute", expect.objectContaining({
      operation: "viewer_histogram",
    }));
    await expect(call("execute", "viewer_tile", { source_id: "a".repeat(32) }, {
      viewer_lane: "../unbounded",
    })).rejects.toThrow("Invalid viewer scheduling lane");
    await expect(call("execute", "source_view", { source_id: "a".repeat(32) }, {
      viewer_lane: "comparison-a",
    })).rejects.toThrow("Invalid viewer scheduling options");
    await call("execute", "viewer_defaults", { source_id: "a".repeat(32) });
    expect(control.request).toHaveBeenLastCalledWith("research_execute", {
      project, operation: "viewer_defaults", request: { source_id: "a".repeat(32) },
    });
    await expect(call("cancel-view")).resolves.toEqual({ cancelled: true });
    expect(viewer.forceDispose).toHaveBeenCalledWith(expect.any(Error));
    expect(worker.forceDispose).not.toHaveBeenCalled();
    expect(control.forceDispose).not.toHaveBeenCalled();

    await call("execute", "view", { source_id: "b".repeat(32) });
    expect(mocks.clients.at(-1)!.request).toHaveBeenCalled();
  });

  it("isolates remote transport from local control and rejects responses after a study switch", async () => {
    const project = path.join(root, "Remote.loci-study");
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: project });
    await call("create");
    const control = mocks.clients[1], compute = mocks.clients[3];
    let finish!: (value: unknown) => void;
    compute.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = call("execute", "remote_analysis_start", { analysis: { project_id: "a".repeat(32) } });
    const rejected = expect(pending).rejects.toThrow("study that is no longer open");
    await vi.waitFor(() => expect(compute.request).toHaveBeenCalled());
    await call("snapshot");
    expect(control.request).toHaveBeenLastCalledWith("research_snapshot", { project });
    await call("new-session");
    finish({ run: { state: "submitted" } });
    await rejected;
  });

  it("isolates large result decoding so control requests settle while a view is pending", async () => {
    const project = path.join(root, "Large.loci-study");
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: project });
    await call("create");
    const control = mocks.clients[1];
    const viewer = mocks.clients[2];
    let finish!: (value: unknown) => void;
    viewer.request.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const view = call("execute", "large_result_view", { result_id: "a".repeat(32), revision_hash: "b".repeat(64) });
    await vi.waitFor(() => expect(viewer.request).toHaveBeenCalled());
    await call("snapshot");
    expect(control.request).toHaveBeenLastCalledWith("research_snapshot", { project });
    expect(control.request).not.toHaveBeenCalledWith("research_execute", expect.objectContaining({ operation: "large_result_view" }));
    finish({ image: "exact" });
    await expect(view).resolves.toEqual({ image: "exact" });
  });

  it("preserves a unique guided-exploration task key for exact cancellation", async () => {
    const project = path.join(root, "Study.loci-study");
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: project });
    await call("create");
    mocks.request.mockImplementation(async (method: string) => method === "research_submit" ? { id: "b".repeat(32) } : {});
    const request = { source_id: "a".repeat(32), source_sha256: "c".repeat(64) };
    const requestKey = "exploration:12345678-1234-1234-1234-123456789abc";
    await call("execute", "exploration_preview", request, { request_key: requestKey });
    expect(mocks.clients[1].request).toHaveBeenCalledWith("research_submit", { project, request, request_key: requestKey, operation: "exploration_preview" });
    await expect(call("execute", "exploration_preview", request, { request_key: "../unbounded" })).rejects.toThrow("Invalid exploration task key");
    await expect(call("execute", "run_recipe", request, { request_key: requestKey })).rejects.toThrow("Invalid viewer scheduling options");
  });

  it("routes a local Cellpose run through the cancellable durable-job worker", async () => {
    const project = path.join(root, "Study.loci-study");
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: project });
    await call("create");
    const worker = mocks.clients[0];
    const control = mocks.clients[1];
    const jobId = "b".repeat(32);
    mocks.request.mockImplementation(async (method: string) =>
      method === "research_submit" ? { id: jobId } : {});

    await call("execute", "cellpose_run", { source_id: "a".repeat(32) });

    expect(control.request).toHaveBeenLastCalledWith("research_submit", {
      project,
      request: { source_id: "a".repeat(32) },
      request_key: expect.any(String),
      operation: "cellpose_run",
    });
    expect(worker.request).toHaveBeenLastCalledWith(
      "research_run",
      { project, job_id: jobId },
      0,
    );
  });

  it.each(["field_assay_preview", "field_assay_run"])(
    "routes %s through the engine's required durable-task path",
    async (operation) => {
      const project = path.join(root, "Field assay.loci-study");
      mocks.save.mockResolvedValueOnce({ canceled: false, filePath: project });
      await call("create");
      const worker = mocks.clients[0];
      const control = mocks.clients[1];
      const jobId = "f".repeat(32);
      mocks.request.mockImplementation(async (method: string) =>
        method === "research_submit" ? { id: jobId } : {});
      const request = { source_id: "a".repeat(32), nuclei_channel: 0, signal_channel: 1 };

      await call("execute", operation, request);

      expect(control.request).toHaveBeenLastCalledWith("research_submit", {
        project,
        request,
        request_key: expect.any(String),
        operation,
      });
      expect(worker.request).toHaveBeenLastCalledWith(
        "research_run",
        { project, job_id: jobId },
        0,
      );
      expect(control.request).not.toHaveBeenCalledWith(
        "research_execute",
        expect.objectContaining({ operation }),
      );
    },
  );

  it("routes perinuclear_run through durable submission with the exact nucleus revision and signal request", async () => {
    const project = path.join(root, "Perinuclear.loci-study");
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: project });
    await call("create");
    const worker = mocks.clients[0];
    const control = mocks.clients[1];
    const jobId = "d".repeat(32);
    const request = Object.freeze({
      result_id: "a".repeat(32), revision_hash: "b".repeat(64), signal_channel: 0,
      radius_px: 5, working_bytes: 256 * 1024 ** 2, control: "Synthetic paired-control fixture",
    });
    const output = { result: { id: "c".repeat(32), parent_id: request.result_id } };
    control.request.mockImplementation(async (method: string) => {
      // Mirror the engine's task-only RPC guard, so an omitted registration
      // reproduces the packaged GUI failure instead of silently returning {}.
      if (method === "research_execute") throw new Error("Submit a durable task before execution");
      if (method === "research_submit") return { id: jobId };
      throw new Error(`Unexpected control method: ${method}`);
    });
    worker.request.mockResolvedValueOnce(output);

    await expect(call("execute", "perinuclear_run", request)).resolves.toBe(output);

    expect(control.request).toHaveBeenLastCalledWith("research_submit", {
      project, operation: "perinuclear_run", request, request_key: expect.any(String),
    });
    expect(worker.request).toHaveBeenLastCalledWith("research_run", { project, job_id: jobId }, 0);
    expect(control.request).not.toHaveBeenCalledWith(
      "research_execute", expect.objectContaining({ operation: "perinuclear_run" }),
    );
  });

  it("serializes perinuclear jobs, cancels the exact durable job and permits retry after cancellation", async () => {
    const project = path.join(root, "Perinuclear cancellation.loci-study");
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: project });
    await call("create");
    const worker = mocks.clients[0];
    const control = mocks.clients[1];
    const jobId = "d".repeat(32), retryId = "e".repeat(32);
    const request = {
      result_id: "a".repeat(32), revision_hash: "b".repeat(64), signal_channel: 0,
      radius_px: 5, working_bytes: 256 * 1024 ** 2, control: "Synthetic paired-control fixture",
    };
    let submissions = 0;
    let finishCancel!: () => void;
    control.request.mockImplementation(async (method: string) => {
      if (method === "research_submit") return { id: submissions++ === 0 ? jobId : retryId };
      if (method === "research_cancel") return new Promise((resolve) => {
        finishCancel = () => resolve({ id: jobId, state: "cancelled", cancel_requested: true });
      });
      if (method === "research_snapshot") return {};
      throw new Error(`Unexpected control method: ${method}`);
    });
    let rejectRun!: (error: Error) => void;
    worker.request.mockImplementationOnce(() => new Promise((_, reject) => { rejectRun = reject; }));
    const pending = call("execute", "perinuclear_run", request);
    const cancelled = expect(pending).rejects.toThrow("Perinuclear job cancelled");
    await vi.waitFor(() => expect(worker.request).toHaveBeenCalledWith(
      "research_run", { project, job_id: jobId }, 0,
    ));
    await expect(call("execute", "perinuclear_run", request)).rejects.toThrow("already running");
    expect(submissions).toBe(1);
    await call("snapshot");
    expect(control.request).toHaveBeenLastCalledWith("research_snapshot", { project });
    const cancellation = call("cancel", jobId);
    await vi.waitFor(() => expect(control.request).toHaveBeenLastCalledWith(
      "research_cancel", { project, job_id: jobId },
    ));
    expect(worker.cancelCurrent).not.toHaveBeenCalled();
    finishCancel();
    await cancellation;
    expect(control.request).toHaveBeenLastCalledWith("research_cancel", { project, job_id: jobId });
    expect(worker.cancelCurrent).toHaveBeenCalledOnce();
    rejectRun(new Error("Perinuclear job cancelled"));
    await cancelled;

    const output = { result: { id: "f".repeat(32), parent_id: request.result_id } };
    worker.request.mockResolvedValueOnce(output);
    await expect(call("execute", "perinuclear_run", request)).resolves.toBe(output);
    expect(submissions).toBe(2);
    expect(worker.request).toHaveBeenLastCalledWith("research_run", { project, job_id: retryId }, 0);
  });

  it("routes large result remote adoption through private grant and durable worker without path exposure", async () => {
    const project = path.join(root, "Study.loci-study");
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: project });
    await call("create");
    const worker = mocks.clients[0];
    const control = mocks.clients[1];
    const sourceId = "a".repeat(32);
    const bundleDir = path.join(root, "remote_bundle");
    const grantId = "g".repeat(32);
    const manifestSha = "m".repeat(64);
    const jobId = "j".repeat(32);
    const adoptedResult = { id: "r".repeat(32), kind: "large-components" };
    const adoptedMeasurements = [{ id: 1, area: 100 }];

    // Dialog cancelled
    mocks.open.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    await expect(call("import-large-result", sourceId)).resolves.toBeNull();

    // Dialog selected
    mocks.open.mockResolvedValueOnce({ canceled: false, filePaths: [bundleDir] });
    mocks.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === "research_large_exchange_grant") {
        return {
          grant_id: grantId,
          source_id: sourceId,
          source_sha256: sha,
          manifest_sha256: manifestSha,
          bundle_name: "remote_bundle",
        };
      }
      if (method === "research_submit") {
        return { id: jobId };
      }
      if (method === "research_run") {
        return { result: adoptedResult, measurements: adoptedMeasurements };
      }
      if (method === "research_snapshot") {
        return nativeSnapshot([]);
      }
      return {};
    });

    const res = await call("import-large-result", sourceId) as {
      snapshot: ResearchSnapshot;
      result: typeof adoptedResult;
      measurements: typeof adoptedMeasurements;
    };

    expect(control.request).toHaveBeenCalledWith(
      "research_large_exchange_grant",
      { project, source_id: sourceId, directory: bundleDir },
      0,
    );
    expect(control.request).toHaveBeenCalledWith(
      "research_submit",
      {
        project,
        request: {
          source_id: sourceId,
          grant_id: grantId,
          manifest_sha256: manifestSha,
        },
        request_key: expect.any(String),
        operation: "large_result_adopt",
      },
    );
    // Ensure native bundleDir path is NOT sent in public submit request
    const submitCall = mocks.request.mock.calls.find(
      ([method]) => method === "research_submit",
    );
    expect(JSON.stringify(submitCall)).not.toContain(bundleDir);

    expect(worker.request).toHaveBeenCalledWith(
      "research_run",
      { project, job_id: jobId },
      0,
    );
    expect(res.result).toEqual(adoptedResult);
    expect(res.measurements).toEqual(adoptedMeasurements);
  });

  it("holds the study through large import grant and durable execution", async () => {
    const project = path.join(root, "Study.loci-study");
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: project });
    await call("create");
    const bundle = path.join(root, "bundle");
    mocks.open.mockResolvedValueOnce({ canceled: false, filePaths: [bundle] });
    let releaseGrant!: (value: unknown) => void;
    let grantEntered!: () => void;
    const entered = new Promise<void>((resolve) => { grantEntered = resolve; });
    let releaseWorker!: (value: unknown) => void;
    let workerEntered!: () => void;
    const executing = new Promise<void>((resolve) => { workerEntered = resolve; });
    mocks.request.mockImplementation(async (method: string) => {
      if (method === "research_large_exchange_grant") {
        grantEntered();
        return new Promise((resolve) => { releaseGrant = resolve; });
      }
      if (method === "research_submit") return { id: "j".repeat(32) };
      if (method === "research_run") {
        workerEntered();
        return new Promise((resolve) => { releaseWorker = resolve; });
      }
      if (method === "research_snapshot") return nativeSnapshot([]);
      return {};
    });
    const importing = call("import-large-result", "s".repeat(32));
    await entered;
    await expect(call("create")).rejects.toThrow(/active study operation/);
    await expect(call("import-large-result", "s".repeat(32))).rejects.toThrow(/active study operation/);
    releaseGrant({ grant_id: "g".repeat(32), source_id: "s".repeat(32),
      source_sha256: sha, manifest_sha256: "m".repeat(64), bundle_name: "bundle" });
    await executing;
    await expect(call("create")).rejects.toThrow(/active study operation/);
    releaseWorker({ result: { id: "r".repeat(32) }, measurements: [] });
    await importing;
  });

  it("routes large-components export through private grant and durable worker, redacting paths", async () => {
    const project = path.join(root, "Study.loci-study");
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: project });
    await call("create");
    const worker = mocks.clients[0];
    const control = mocks.clients[1];
    const resultId = "r".repeat(32);
    const revisionHash = "h".repeat(64);
    const exportDest = path.join(root, "Exported Large Result");
    const grantId = "g".repeat(32);
    const jobId = "j".repeat(32);

    // Provide a snapshot with a large-components result
    const snapshotWithLargeResult = nativeSnapshot([]);
    snapshotWithLargeResult.results = [
      {
        id: resultId,
        schema: "loci.research-result/v2" as const,
        kind: "large-components" as const,
        source_id: "s".repeat(32),
        source_sha256: sha,
        created_at: "2026-09-08T00:00:00Z",
        revision_hash: revisionHash,
        object_count: 100,
      },
    ];

    mocks.request.mockImplementation(async (method: string) => {
      if (method === "research_snapshot") return snapshotWithLargeResult;
      if (method === "research_large_export_grant") {
        return {
          grant_id: grantId,
          result_id: resultId,
          revision_hash: revisionHash,
          export_name: "Exported Large Result",
        };
      }
      if (method === "research_submit") return { id: jobId };
      if (method === "research_run") {
        return {
          ok: true,
          manifest_sha256: "m".repeat(64),
          destination: exportDest,
          output_directory: exportDest,
        };
      }
      return {};
    });

    // Save dialog canceled
    mocks.save.mockResolvedValueOnce({ canceled: true, filePath: undefined });
    await expect(call("export", resultId, revisionHash)).resolves.toBeNull();

    // Save dialog selected
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: exportDest });
    const receipt = await call("export", resultId, revisionHash) as Record<string, unknown>;

    expect(control.request).toHaveBeenCalledWith(
      "research_large_export_grant",
      {
        project,
        result_id: resultId,
        revision_hash: revisionHash,
        destination: exportDest,
      },
      0,
    );
    expect(control.request).toHaveBeenCalledWith(
      "research_submit",
      {
        project,
        request: {
          result_id: resultId,
          revision_hash: revisionHash,
          grant_id: grantId,
        },
        request_key: expect.any(String),
        operation: "large_result_export",
      },
    );
    expect(worker.request).toHaveBeenCalledWith(
      "research_run",
      { project, job_id: jobId },
      0,
    );
    // Destination/output_directory must be redacted from renderer return
    expect(receipt.destination).toBeUndefined();
    expect(receipt.output_directory).toBeUndefined();
    expect(receipt.name).toBe("Exported Large Result");
  });

  it("reserves the corrected v2 export across its picker and grant", async () => {
    const project = path.join(root, "Study.loci-study");
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: project });
    await call("create");
    const resultId = "r".repeat(32);
    const revisionHash = "h".repeat(64);
    const destination = path.join(root, "Corrected export");
    const snapshot = nativeSnapshot([]);
    snapshot.results = [{ id: resultId, schema: "loci.research-result/v2",
      kind: "large-corrected-labels", source_id: "s".repeat(32),
      source_sha256: sha, created_at: "2026-09-08T00:00:00Z",
      revision_hash: revisionHash, object_count: 1 }];
    let releasePicker!: (value: { canceled: boolean; filePath: string }) => void;
    let pickerEntered!: () => void;
    const entered = new Promise<void>((resolve) => { pickerEntered = resolve; });
    mocks.save.mockImplementationOnce(() => {
      pickerEntered();
      return new Promise((resolve) => { releasePicker = resolve; });
    });
    mocks.request.mockImplementation(async (method: string) => {
      if (method === "research_snapshot") return snapshot;
      if (method === "research_large_export_grant") return {
        grant_id: "g".repeat(32), result_id: resultId,
        revision_hash: revisionHash, export_name: "Corrected export",
      };
      if (method === "research_submit") return { id: "j".repeat(32) };
      if (method === "research_run") return { destination, output_directory: destination };
      return {};
    });
    const exporting = call("export", resultId, revisionHash);
    await entered;
    await expect(call("create")).rejects.toThrow(/active study operation/);
    await expect(call("export", resultId, revisionHash)).rejects.toThrow(/active study operation/);
    releasePicker({ canceled: false, filePath: destination });
    await exporting;
    expect(mocks.request).toHaveBeenCalledWith("research_large_export_grant", {
      project, result_id: resultId, revision_hash: revisionHash, destination,
    }, 0);
    expect(mocks.request).toHaveBeenCalledWith("research_submit", expect.objectContaining({
      operation: "large_result_export",
    }));
    expect(mocks.request).not.toHaveBeenCalledWith("research_export", expect.anything(), 0);
  });

  it("keeps annotation interchange paths behind native pickers and exact source bindings", async () => {
    const project = path.join(root, "Study.loci-study");
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: project });
    await call("create");
    const binding = {
      source_id: "a".repeat(32),
      source_sha256: "b".repeat(64),
      expected_revision: 3,
    };
    const exported = path.join(root, "annotations.loci-annotations.json");
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: exported });
    await call("export-source-annotations", binding);
    expect(mocks.request).toHaveBeenLastCalledWith(
      "research_source_annotations_export",
      { project, ...binding, destination: exported },
      0,
    );

    const imported = path.join(root, "imported.loci-annotations.json");
    mocks.open.mockResolvedValueOnce({ canceled: false, filePaths: [imported] });
    await call("import-source-annotations", binding);
    expect(mocks.request).toHaveBeenLastCalledWith(
      "research_source_annotations_import",
      { project, ...binding, path: imported },
      0,
    );

    mocks.open.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    await expect(call("import-source-annotations", binding)).resolves.toBeNull();
    await expect(call("export-source-annotations", {
      ...binding,
      path: "/renderer/invented.json",
    })).rejects.toThrow("current source annotation revision");
  });

  it("accepts only bounded plain paths from the trusted dropped-file wrapper", async () => {
    const source = path.join(root, "drop.tif");
    await fs.writeFile(source, "immutable");
    await call("open-dropped", [source], "files");
    expect(mocks.request).toHaveBeenLastCalledWith("research_import", expect.objectContaining({
      paths: [source],
    }), 0);

    const outside = path.join(root, "outside.tif");
    const linked = path.join(root, "linked.tif");
    await fs.writeFile(outside, "outside");
    await fs.symlink(outside, linked);
    await expect(call("open-dropped", [linked], "files")).rejects.toThrow("plain local files");
    await expect(call("open-dropped", ["relative.tif"], "files")).rejects.toThrow("invalid");
  });

  it("routes one dropped folder, Zarr store, saved study, or legacy project by exact local type", async () => {
    const folder = path.join(root, "images");
    const nested = path.join(folder, "day-1");
    await fs.mkdir(nested, { recursive: true });
    const image = path.join(nested, "field.tif");
    await fs.writeFile(image, "image");
    await call("open-dropped", [folder], "files");
    expect(mocks.request).toHaveBeenLastCalledWith("research_import", expect.objectContaining({
      paths: [image], relative_paths: ["day-1/field.tif"], import_root: folder, kind: "files",
    }), 0);

    const zarr = path.join(root, "volume.zarr");
    await fs.mkdir(zarr);
    await call("open-dropped", [zarr], "files");
    expect(mocks.request).toHaveBeenLastCalledWith("research_import", expect.objectContaining({
      paths: [zarr], relative_paths: ["volume.zarr"], kind: "ome_zarr",
    }), 0);
    const zarrImport = mocks.request.mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(zarrImport).not.toHaveProperty("import_root");

    const study = path.join(root, "Dropped.loci-study");
    await createEngineStudy(study);
    await call("open-dropped", [study], "files");
    expect(mocks.request).toHaveBeenCalledWith("research_snapshot", { project: study });

    const legacy = path.join(root, "legacy.loci-project");
    await fs.writeFile(legacy, "legacy");
    mocks.prepareLegacy.mockResolvedValueOnce({
      legacy_project: { project_id: "old", title: "Legacy", revision: 1, sha256: sha },
      items: [],
    });
    await call("open-dropped", [legacy], "files");
    expect(mocks.prepareLegacy).toHaveBeenLastCalledWith(
      legacy, path.join(root, "working-results"),
    );
    expect(mocks.request).toHaveBeenLastCalledWith("research_import_legacy_project", {
      project: study,
      legacy_project: { project_id: "old", title: "Legacy", revision: 1, sha256: sha },
      items: [],
    }, 0);
  });

  it("validates every multi-file drop before creating or importing a study", async () => {
    const image = path.join(root, "field.tif");
    const unsupported = path.join(root, "notes.txt");
    await Promise.all([fs.writeFile(image, "image"), fs.writeFile(unsupported, "notes")]);
    mocks.request.mockClear();

    await expect(call("open-dropped", [image, unsupported], "files"))
      .rejects.toThrow("every item is a supported image file");
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("does not auto-open an idle previous session on startup, leaving it for recovery", async () => {
    const project = path.join(root, "Idle.loci-study");
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: project });
    await call("create");
    mocks.handlers.clear();

    new ResearchBridge().register(() => {});
    await expect(call("snapshot")).resolves.toBeNull();

    const recent = await call("recovery-list") as Array<{ sessionId: string; title: string }>;
    const idleEntry = recent.find((s) => s.title === "Idle");
    expect(idleEntry).toBeDefined();

    const restored = await call("recovery-keep", idleEntry!.sessionId) as ResearchSnapshot;
    expect(restored).toBeDefined();
  });
  it("preserves opaque data plans and only cancels their exact active request key", async () => {
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: path.join(root, "Data.loci-study") });
    await call("create"); mocks.request.mockClear();
    const key = "scientific-export:11111111-1111-4111-8111-111111111111";
    let finish!: (value: unknown) => void;
    mocks.request.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const payload = { purpose: "provisional", bindings: [] };
    const pending = call("data-export-plan", payload, key);
    expect(await call("data-export-cancel", "scientific-export:22222222-2222-4222-8222-222222222222")).toEqual({ cancelled: false });
    expect(mocks.clients[0].cancelCurrent).not.toHaveBeenCalled();
    const response = { plan: { plan_sha256: sha }, plan_json: '{"exact_float":64.0}' };
    finish(response);
    expect(await pending).toEqual(response);
    expect(mocks.request).toHaveBeenCalledWith("research_data_export_plan", { project: path.join(root, "Data.loci-study"), request: payload }, 0);
    expect(await call("data-export-cancel", key)).toEqual({ cancelled: false });
  });

  it("discards a cancelled data preparation even if its worker response arrives", async () => {
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: path.join(root, "Data.loci-study") });
    await call("create"); mocks.request.mockClear();
    const key = "scientific-export:11111111-1111-4111-8111-111111111111";
    let finish!: (value: unknown) => void;
    mocks.request.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const pending = call("data-export-plan", { purpose: "provisional", bindings: [] }, key);
    expect(await call("data-export-cancel", key)).toEqual({ cancelled: true });
    expect(mocks.clients[0].cancelCurrent).toHaveBeenCalledOnce();
    finish({ plan: { plan_sha256: sha }, plan_json: '{"exact_float":64.0}' });
    await expect(pending).rejects.toThrow(/preparation cancelled/);
    await expect(call("data-export-plan", {}, "not a key")).rejects.toThrow(/unique/);
  });

  it("routes a retained density preview token through its exact durable job", async () => {
    const project = path.join(root, "Density.loci-study");
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: project });
    await call("create"); mocks.request.mockClear();
    const token = { preview_id: "a".repeat(32), preview_hash: "a".repeat(64) }, jobId = "d".repeat(32);
    mocks.request.mockResolvedValueOnce({ id: jobId }).mockResolvedValueOnce({ report_id: "a".repeat(32) });
    await call("execute", "spatial_density_save", token);
    expect(mocks.request).toHaveBeenCalledWith("research_submit", expect.objectContaining({ project, operation: "spatial_density_save", request: token }));
    expect(mocks.request).toHaveBeenCalledWith("research_run", { project, job_id: jobId }, 0);
    expect(mocks.request).not.toHaveBeenCalledWith("research_execute", expect.anything());
  });

  it("validates and minimizes a density export plan at the native boundary", async () => {
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: path.join(root, "Density.loci-study") });
    await call("create"); mocks.request.mockClear();
    const reportHash = "a".repeat(64), key = "scientific-export:11111111-1111-4111-8111-111111111111";
    const plan = { schema: "loci.spatial-density-export-plan/v1", report_id: reportHash.slice(0, 32), report_hash: reportHash,
      plan_hash: sha, status: { current: false, changes: [{ result_id: "b".repeat(32), reason: "sample_metadata_changed" }] } };
    mocks.request.mockResolvedValueOnce({ ...plan, export_software: { engine: "test" }, private_path: "/private/secret" });
    expect(await call("spatial-density-export-plan", plan.report_id, key)).toEqual(plan);
    expect(mocks.request).toHaveBeenCalledWith("research_spatial_density_export_plan", expect.objectContaining({ report_id: plan.report_id }), 0);
    mocks.request.mockResolvedValueOnce({ ...plan, report_hash: "b".repeat(64) });
    await expect(call("spatial-density-export-plan", plan.report_id, key)).rejects.toThrow(/invalid spatial density export preview/);
  });

  it("publishes a density report only through the native destination grant and strips private receipt fields", async () => {
    const project = path.join(root, "Density.loci-study"), destination = path.join(root, "Density report");
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: project });
    await call("create"); mocks.request.mockClear();
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: destination });
    const reportHash = "a".repeat(64), reportId = reportHash.slice(0, 32);
    const grant = { grant_id: "b".repeat(32), plan_hash: sha, basename: "Density report" };
    const receipt = { schema: "loci.spatial-density-export-receipt/v1", basename: grant.basename, report_hash: reportHash, manifest_sha256: sha };
    mocks.request.mockResolvedValueOnce(grant).mockResolvedValueOnce({ id: "d".repeat(32) })
      .mockResolvedValueOnce({ ...receipt, destination, private_path: "/private/secret", grant_id: grant.grant_id });
    const key = "scientific-export:11111111-1111-4111-8111-111111111111";
    expect(await call("spatial-density-export-package", reportId, sha, key)).toEqual(receipt);
    expect(mocks.request).toHaveBeenCalledWith("research_spatial_density_export_grant", { project, report_id: reportId, plan_hash: sha, destination }, 0);
    expect(mocks.request).toHaveBeenCalledWith("research_submit", { project, operation: "spatial_density_export", request: { grant_id: grant.grant_id, plan_hash: sha }, request_key: key });
  });

  it("does not submit density export after picker cancellation, existing destination refusal, or a mismatched grant", async () => {
    const project = path.join(root, "Density.loci-study"), destination = path.join(root, "Density report");
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: project });
    await call("create"); mocks.request.mockClear();
    const key = "scientific-export:11111111-1111-4111-8111-111111111111", reportId = "a".repeat(32);
    mocks.save.mockResolvedValueOnce({ canceled: true });
    expect(await call("spatial-density-export-package", reportId, sha, key)).toBeNull();
    expect(mocks.request).not.toHaveBeenCalled();
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: destination });
    mocks.request.mockRejectedValueOnce(new Error("Destination already exists; choose a new package name"));
    await expect(call("spatial-density-export-package", reportId, sha, key)).rejects.toThrow(/already exists/);
    expect(mocks.request).not.toHaveBeenCalledWith("research_submit", expect.anything());
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: destination });
    mocks.request.mockResolvedValueOnce({ grant_id: "b".repeat(32), plan_hash: "0".repeat(64), basename: "Density report" });
    await expect(call("spatial-density-export-package", reportId, sha, key)).rejects.toThrow(/invalid report export grant/);
    expect(mocks.request).not.toHaveBeenCalledWith("research_submit", expect.anything());
  });

  it("cooperatively cancels a density export without killing its publication worker", async () => {
    const project = path.join(root, "Density.loci-study");
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: project });
    await call("create"); mocks.request.mockClear();
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: path.join(root, "Density report") });
    let fail!: (reason: Error) => void;
    mocks.request.mockResolvedValueOnce({ grant_id: "b".repeat(32), plan_hash: sha, basename: "Density report" })
      .mockResolvedValueOnce({ id: "d".repeat(32) }).mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject; }));
    const key = "scientific-export:11111111-1111-4111-8111-111111111111";
    const pending = call("spatial-density-export-package", "a".repeat(32), sha, key);
    await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledWith("research_run", { project, job_id: "d".repeat(32) }, 0));
    mocks.request.mockResolvedValueOnce({ state: "running", cancel_requested: true });
    expect(await call("data-export-cancel", key)).toEqual({ cancelled: true });
    expect(mocks.clients[0].cancelCurrent).not.toHaveBeenCalled();
    const rejected = expect(pending).rejects.toThrow(/cancelled before publication/);
    fail(new Error("Density export cancelled before publication")); await rejected;
  });

  it("validates and minimizes an intensity export plan at the native boundary", async () => {
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: path.join(root, "Intensity.loci-study") });
    await call("create"); mocks.request.mockClear();
    const reportHash = "a".repeat(64), key = "scientific-export:11111111-1111-4111-8111-111111111111";
    const plan = { schema: "loci.intensity-export-plan/v1", report_id: reportHash.slice(0, 32), report_hash: reportHash,
      plan_hash: sha, status: { current: true, changes: [] } };
    mocks.request.mockResolvedValueOnce({ ...plan, private_path: "/private/secret" });
    expect(await call("intensity-export-plan", plan.report_id, key)).toEqual(plan);
    mocks.request.mockResolvedValueOnce({ ...plan, report_hash: "b".repeat(64) });
    await expect(call("intensity-export-plan", plan.report_id, key)).rejects.toThrow(/invalid intensity export preview/);
  });

  it("publishes an exact saved intensity report with a native destination and strips private receipt fields", async () => {
    const project = path.join(root, "Intensity.loci-study"), destination = path.join(root, "Intensity report");
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: project });
    await call("create"); mocks.request.mockClear();
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: destination });
    const reportHash = "a".repeat(64), reportId = reportHash.slice(0, 32);
    const grant = { grant_id: "b".repeat(32), plan_hash: sha, basename: "Intensity report" };
    const receipt = { schema: "loci.intensity-export-receipt/v1", basename: grant.basename, report_hash: reportHash, manifest_sha256: sha };
    mocks.request.mockResolvedValueOnce(grant).mockResolvedValueOnce({ id: "d".repeat(32) })
      .mockResolvedValueOnce({ ...receipt, destination, private_path: "/private/secret", grant_id: grant.grant_id });
    const key = "scientific-export:11111111-1111-4111-8111-111111111111";
    expect(await call("intensity-export-package", reportId, sha, key)).toEqual(receipt);
    expect(mocks.request).toHaveBeenCalledWith("research_intensity_export_grant", { project, report_id: reportId, plan_hash: sha, destination }, 0);
    expect(mocks.request).toHaveBeenCalledWith("research_submit", { project, operation: "intensity_export", request: { grant_id: grant.grant_id, plan_hash: sha }, request_key: key });
    await expect(call("intensity-export-package", "bad", sha, key)).rejects.toThrow(/exact saved/);
  });

  it.each(["panel", "jobs", "shutdown"])("drains cooperative intensity export cancellation from %s", async (route) => {
    const project = path.join(root, "Intensity.loci-study");
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: project });
    await call("create"); mocks.request.mockClear();
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: path.join(root, "Intensity report") });
    let fail!: (reason: Error) => void;
    mocks.request.mockResolvedValueOnce({ grant_id: "b".repeat(32), plan_hash: sha, basename: "Intensity report" })
      .mockResolvedValueOnce({ id: "d".repeat(32) })
      .mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject; }));
    const key = "scientific-export:11111111-1111-4111-8111-111111111111";
    const pending = call("intensity-export-package", "a".repeat(32), sha, key);
    await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledWith("research_run", { project, job_id: "d".repeat(32) }, 0));
    mocks.request.mockResolvedValueOnce({ state: "running", cancel_requested: true });
    const shutdown = route === "shutdown" ? bridge.dispose() : null;
    if (route === "panel") expect(await call("data-export-cancel", key)).toEqual({ cancelled: true });
    if (route === "jobs") await call("cancel", "d".repeat(32));
    if (shutdown) await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledWith("research_cancel", { project, job_id: "d".repeat(32) }));
    expect(mocks.clients[0].cancelCurrent).not.toHaveBeenCalled();
    expect(mocks.clients[0].dispose).not.toHaveBeenCalled();
    const rejected = expect(pending).rejects.toThrow(/cancelled before publication/);
    fail(new Error("Intensity export cancelled before publication"));
    await rejected;
    if (shutdown) await shutdown;
  });

  it("uses a main-owned data destination and removes paths from the returned receipt", async () => {
    const project = path.join(root, "Data.loci-study"), destination = path.join(root, "Scientific data");
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: project });
    await call("create"); mocks.request.mockClear();
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: destination });
    const grant = { grant_id: "b".repeat(32), source_id: "c".repeat(32), plan_sha256: sha, export_name: "Scientific data" };
    const receipt = { schema: "loci.data-export-receipt/v1", basename: "Scientific data", purpose: "provisional", manifest_sha256: sha, result_count: 1, source_count: 1, selected_count: 3 };
    mocks.request.mockResolvedValueOnce(grant).mockResolvedValueOnce({ id: "d".repeat(32) })
      .mockResolvedValueOnce({ ...receipt, destination, grant_id: grant.grant_id, private_path: "/private/secret" });
    const key = "scientific-export:11111111-1111-4111-8111-111111111111", planJson = '{"exact_float":64.0}';
    expect(await call("data-export-package", planJson, key)).toEqual(receipt);
    expect(mocks.request).toHaveBeenCalledWith("research_data_export_grant", { project, plan_json: planJson, destination }, 0);
    expect(mocks.request).toHaveBeenCalledWith("research_submit", { project, operation: "scientific_data_export", request: { grant_id: grant.grant_id, plan_sha256: sha }, request_key: key });
    expect(mocks.request).toHaveBeenCalledWith("research_run", { project, job_id: "d".repeat(32) }, 0);
  });

  it("cancels a data export picker before any destination grant is written", async () => {
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: path.join(root, "Data.loci-study") });
    await call("create"); mocks.request.mockClear();
    let finish!: (value: unknown) => void;
    mocks.save.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const key = "scientific-export:11111111-1111-4111-8111-111111111111";
    const pending = call("data-export-package", "{}", key);
    expect(await call("data-export-cancel", key)).toEqual({ cancelled: true });
    finish({ canceled: false, filePath: path.join(root, "Never written") });
    await expect(pending).rejects.toThrow(/cancelled/);
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it.each(["panel", "jobs", "shutdown"])("preserves the receipt when %s cancellation arrives after publication", async (route) => {
    const project = path.join(root, "Data.loci-study");
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: project });
    await call("create"); mocks.request.mockClear();
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: path.join(root, "Scientific data") });
    const grant = { grant_id: "b".repeat(32), source_id: "c".repeat(32), plan_sha256: sha, export_name: "Scientific data" };
    let finish!: (value: unknown) => void;
    mocks.request.mockResolvedValueOnce(grant).mockResolvedValueOnce({ id: "d".repeat(32) })
      .mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const key = "scientific-export:11111111-1111-4111-8111-111111111111";
    const pending = call("data-export-package", "{}", key);
    await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledWith("research_run", { project, job_id: "d".repeat(32) }, 0));
    mocks.request.mockResolvedValueOnce({ state: "succeeded", cancel_requested: false });
    const shutdown = route === "shutdown" ? bridge.dispose() : null;
    if (route === "panel") expect(await call("data-export-cancel", key)).toEqual({ cancelled: false });
    if (route === "jobs") expect(await call("cancel", "d".repeat(32))).toEqual({ state: "succeeded", cancel_requested: false });
    if (shutdown) {
      await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledWith("research_cancel", { project, job_id: "d".repeat(32) }));
      expect(mocks.clients[0].dispose).not.toHaveBeenCalled();
    }
    expect(mocks.clients[0].cancelCurrent).not.toHaveBeenCalled();
    const receipt = { schema: "loci.data-export-receipt/v1", basename: grant.export_name, purpose: "provisional", manifest_sha256: sha, result_count: 1, source_count: 1, selected_count: 3 };
    finish(receipt);
    expect(await pending).toEqual(receipt);
    if (shutdown) await shutdown;
  });

  it.each(["panel", "jobs", "shutdown"])("requests cooperative data cancellation from %s so the exporter can clean its stage", async (route) => {
    const project = path.join(root, "Data.loci-study");
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: project });
    await call("create"); mocks.request.mockClear();
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: path.join(root, "Scientific data") });
    let fail!: (reason: Error) => void;
    mocks.request.mockResolvedValueOnce({ grant_id: "b".repeat(32), source_id: "c".repeat(32), plan_sha256: sha, export_name: "Scientific data" })
      .mockResolvedValueOnce({ id: "d".repeat(32) })
      .mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject; }));
    const key = "scientific-export:11111111-1111-4111-8111-111111111111";
    const pending = call("data-export-package", "{}", key);
    await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledWith("research_run", { project, job_id: "d".repeat(32) }, 0));
    mocks.request.mockResolvedValueOnce({ state: "running", cancel_requested: true });
    const shutdown = route === "shutdown" ? bridge.dispose() : null;
    if (route === "panel") expect(await call("data-export-cancel", key)).toEqual({ cancelled: true });
    if (route === "jobs") expect(await call("cancel", "d".repeat(32))).toEqual({ state: "running", cancel_requested: true });
    if (shutdown) {
      await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledWith("research_cancel", { project, job_id: "d".repeat(32) }));
      expect(mocks.clients[0].dispose).not.toHaveBeenCalled();
    }
    expect(mocks.clients[0].cancelCurrent).not.toHaveBeenCalled();
    const rejected = expect(pending).rejects.toThrow("cancelled before publication");
    fail(new Error("Data export cancelled before publication"));
    await rejected;
    if (shutdown) await shutdown;
  });

  it.each(["plan", "picker"])("drains %s cancellation before disposing export workers", async (stage) => {
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: path.join(root, "Data.loci-study") });
    await call("create"); mocks.request.mockClear();
    let finish!: (value: unknown) => void;
    const response = new Promise(resolve => { finish = resolve; });
    if (stage === "plan") mocks.request.mockReturnValueOnce(response);
    else mocks.save.mockReturnValueOnce(response);
    const key = "scientific-export:11111111-1111-4111-8111-111111111111";
    const pending = stage === "plan" ? call("data-export-plan", {}, key) : call("data-export-package", "{}", key);
    const rejected = expect(pending).rejects.toThrow(/cancelled/);
    const shutdown = bridge.dispose();
    await Promise.resolve();
    expect(mocks.clients[0].dispose).not.toHaveBeenCalled();
    expect(mocks.clients[0].cancelCurrent).toHaveBeenCalledTimes(stage === "plan" ? 1 : 0);
    finish(stage === "plan" ? { plan: { plan_sha256: sha }, plan_json: "{}" } : { canceled: false, filePath: path.join(root, "Never written") });
    await rejected; await shutdown;
    expect(mocks.clients[0].dispose).toHaveBeenCalledOnce();
    expect(mocks.request.mock.calls.some(([method]) => method === "research_cancel" || method === "research_data_export_grant")).toBe(false);
  });

  it("keeps hard cancellation for an unrelated analysis job", async () => {
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: path.join(root, "Data.loci-study") });
    await call("create"); mocks.request.mockClear();
    let finish!: (value: unknown) => void;
    mocks.request.mockResolvedValueOnce({ id: "d".repeat(32) }).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const pending = call("execute", "cellpose_run", { source_id: "c".repeat(32) });
    await vi.waitFor(() => expect(mocks.request.mock.calls.some(([method]) => method === "research_run")).toBe(true));
    mocks.request.mockResolvedValueOnce({ state: "running", cancel_requested: true });
    await call("cancel", "d".repeat(32));
    expect(mocks.clients[0].cancelCurrent).toHaveBeenCalledOnce();
    finish({}); await pending;
  });

  it("preserves bound view autosaves during an export picker while keeping document guards", async () => {
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: path.join(root, "Data.loci-study") });
    await call("create"); mocks.request.mockClear();
    let closePicker!: (value: unknown) => void;
    mocks.save.mockReturnValueOnce(new Promise(resolve => { closePicker = resolve; }));
    const key = "scientific-export:11111111-1111-4111-8111-111111111111";
    const pending = call("data-export-package", "{}", key);
    const view = { source_id: "b".repeat(32), source_sha256: sha, expected_revision: 0, state: {} };
    await expect(call("execute", "save_source_view", view)).resolves.toEqual({});
    expect(mocks.request).toHaveBeenCalledWith("research_execute", { project: path.join(root, "Data.loci-study"), operation: "save_source_view", request: view });
    await expect(call("execute", "cellpose_run", { source_id: "b".repeat(32) })).rejects.toThrow("finish opening");
    await expect(call("open")).rejects.toThrow("active study operation");
    closePicker({ canceled: true }); await pending;
    let closeOpen!: (value: unknown) => void;
    mocks.open.mockReturnValueOnce(new Promise(resolve => { closeOpen = resolve; }));
    const opening = call("open");
    await expect(call("execute", "save_source_view", view)).rejects.toThrow("finish opening");
    closeOpen({ canceled: true, filePaths: [] }); await opening;
  });

  function graphFixture(state: "queued" | "succeeded" = "queued", owner: null | { policy_sha256: string; session_id: string | null } = null) {
    const runId = "a".repeat(32), jobId = "b".repeat(32), sourceId = "c".repeat(32);
    const request = { source_id: sourceId, selection: {}, recipe: {} };
    const key = `graph-v2:${runId}:labels`;
    const job = { id: jobId, operation: "run_recipe", request, request_key: key, request_hash: sha,
      state, created_at: "2026-10-30", updated_at: "2026-10-30", progress: 0, cancel_requested: false, result_ids: [], error: null };
    const run = { id: runId, kind: "workflow_run", revision: 1, data: { schema: "loci.workflow-run/v2", workflow_id: "d".repeat(32), workflow_revision: 1, project_id: "e".repeat(32), definition_sha256: sha, run_sha256: sha, plan: { plan_sha256: sha }, owner,
      state: state === "queued" ? "running" : "succeeded", cancel_requested: false, outputs: {},
      nodes: { labels: { state, intent: { operation: "run_recipe", request, request_key: key, request_sha256: sha, job_id: jobId }, output: state === "succeeded" ? { result_id: "f".repeat(32), revision_hash: sha } : null } } } };
    return { runId, jobId, job, status: { run, state: run.data.state, partial_results: [] } };
  }

  it("advances composed workflows through exact separate native jobs and never reruns completed nodes", async () => {
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: path.join(root, "Graph.loci-study") });
    await call("create"); mocks.request.mockClear();
    let done = false;
    mocks.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      const fixture = graphFixture(done ? "succeeded" : "queued");
      if (method === "research_snapshot") return { jobs: [fixture.job] };
      if (method === "research_execute") return fixture.status;
      if (method === "research_run") { expect(params.job_id).toBe(fixture.jobId); done = true; return { job: { ...fixture.job, state: "succeeded" } }; }
      throw new Error(method);
    });
    const first = await call("execute", "workflow_graph_advance", { run_id: graphFixture().runId });
    expect(first).toMatchObject({ state: "succeeded" });
    await call("execute", "workflow_graph_advance", { run_id: graphFixture().runId });
    expect(mocks.request.mock.calls.filter(([method]) => method === "research_run")).toHaveLength(1);
    expect(mocks.request.mock.calls.some(([method]) => method === "research_submit")).toBe(false);
  });

  it("refuses agent-owned or mismatched composed child jobs before native execution", async () => {
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: path.join(root, "Graph.loci-study") });
    await call("create"); mocks.request.mockClear();
    const agent = graphFixture("queued", { policy_sha256: sha, session_id: "1".repeat(32) });
    mocks.request.mockImplementation(async (method: string) => method === "research_snapshot" ? { jobs: [agent.job] } : agent.status);
    await expect(call("execute", "workflow_graph_advance", { run_id: agent.runId })).rejects.toThrow("Agent-owned");
    const fixture = graphFixture();
    mocks.request.mockImplementation(async (method: string) => method === "research_snapshot" ? { jobs: [{ ...fixture.job, request_key: "another-job" }] } : fixture.status);
    await expect(call("execute", "workflow_graph_advance", { run_id: fixture.runId })).rejects.toThrow("exact composed workflow node");
    expect(mocks.request.mock.calls.some(([method]) => method === "research_run")).toBe(false);
  });

  it("keeps composed cancellation available while one native child owns the worker", async () => {
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: path.join(root, "Graph.loci-study") });
    await call("create"); mocks.request.mockClear();
    let finish!: () => void, cancelled = false;
    const fixture = graphFixture();
    mocks.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === "research_snapshot") return { jobs: [fixture.job] };
      if (method === "research_run") return new Promise<void>((resolve) => { finish = resolve; });
      if (params.operation === "workflow_graph_cancel") { cancelled = true; return { ...fixture.status, state: "cancelling", run: { ...fixture.status.run, data: { ...fixture.status.run.data, state: "cancelling", cancel_requested: true } } }; }
      if (cancelled) return { ...fixture.status, state: "cancelled", run: { ...fixture.status.run, data: { ...fixture.status.run.data, state: "cancelled", cancel_requested: true } } };
      return fixture.status;
    });
    const advancing = call("execute", "workflow_graph_advance", { run_id: fixture.runId });
    await vi.waitFor(() => expect(finish).toBeDefined());
    await expect(call("execute", "workflow_graph_advance", { run_id: fixture.runId })).rejects.toThrow("already running");
    await expect(call("execute", "workflow_graph_cancel", { run_id: fixture.runId })).resolves.toMatchObject({ state: "cancelling" });
    expect(mocks.clients[0].cancelCurrent).toHaveBeenCalled();
    finish(); await expect(advancing).resolves.toMatchObject({ state: "cancelled" });
  });

});
