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
    new ResearchBridge().register(() => {});
  });

  afterEach(async () => {
    delete process.env.LOCI_RESEARCH_BRIDGE_TEST_ROOT;
    await fs.rm(root, { recursive: true, force: true });
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
    expect(mocks.clients[3].request).toHaveBeenCalled();
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
      paths: [image], relative_paths: [path.join("day-1", "field.tif")], kind: "files",
    }), 0);

    const zarr = path.join(root, "volume.zarr");
    await fs.mkdir(zarr);
    await call("open-dropped", [zarr], "files");
    expect(mocks.request).toHaveBeenLastCalledWith("research_import", expect.objectContaining({
      paths: [zarr], relative_paths: ["volume.zarr"], kind: "ome_zarr",
    }), 0);

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
});
