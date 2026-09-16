// @vitest-environment node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { VolumeFigureExportRequest } from "../shared/research-contracts";
import {
  MAX_VOLUME_FIGURE_EDGE,
  publishVolumeFigureBundle,
} from "./volume-figure-export";

const sourceId = "b".repeat(32);
const sourceSha = "a".repeat(64);
let root: string;

function pngChunk(kind: string, data = Buffer.alloc(0)): Buffer {
  const output = Buffer.alloc(12 + data.byteLength);
  output.writeUInt32BE(data.byteLength, 0);
  output.write(kind, 4, 4, "ascii");
  data.copy(output, 8);
  output.writeUInt32BE(crc32(output.subarray(4, 8 + data.byteLength)), 8 + data.byteLength);
  return output;
}

function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const scanlines = Buffer.alloc(height * (1 + width * 4));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND"),
  ]);
}

function request(width = 4, height = 3): VolumeFigureExportRequest {
  const image = png(width, height);
  const payload = {
    role: "whole-volume-context" as const,
    data_sha256: "c".repeat(64),
    t: 0,
    level: 1,
    dimensions_xyz: [2, 1, 2] as [number, number, number],
    native_level_dimensions_xyz: [4, 2, 4] as [number, number, number],
    source_dimensions_xyz: [4, 2, 4] as [number, number, number],
    source_extent_xyzxyz: [0, 3, 0, 1, 0, 3] as [number, number, number, number, number, number],
    origin_xyz: [0, 0, 0] as [number, number, number],
    spacing_xyz: [0.5, 0.5, 2] as [number, number, number],
    direction_3x3: [1, 0, 0, 0, 1, 0, 0, 0, 1] as [number, number, number, number, number, number, number, number, number],
    affine_4x4: [[0.5, 0, 0, 0], [0, 0.5, 0, 0], [0, 0, 2, 0], [0, 0, 0, 1]],
    unit: "um" as const,
    frame: "image" as const,
    scalar_type: "uint8",
    source_dtypes: ["uint8"],
    component_indices: [0],
    encoding_basis: "native-common-dtype",
    byte_length: 4,
    sampling: {
      method: "nearest-whole-extent",
      source_indices_xyz: [[0, 3], [0], [0, 3]] as [number[], number[], number[]],
      level_zero_indices_xyz: [[0, 3], [0], [0, 3]] as [number[], number[], number[]],
    },
  };
  return {
    schema_version: "loci.volume-figure-request/v1",
    source_id: sourceId,
    source_sha256: sourceSha,
    width_px: width,
    height_px: height,
    png_base64: image.toString("base64"),
    manifest: {
      schema_version: "loci.volume-figure/v1",
      figure: {
        kind: "screen-resolution-rendered-figure",
        format: "png",
        width_px: width,
        height_px: height,
        device_pixel_ratio: 2,
        capture_scale: 1,
      },
      source: { source_id: sourceId, source_sha256: sourceSha, t: 0 },
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
        opacity_unit_distance: Math.hypot(0.5, 2) / 2,
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

async function publish(value = request(), destination = path.join(root, "Figure.loci-figure")) {
  return publishVolumeFigureBundle({
    destination,
    request: value,
    verifiedSource: { source_id: sourceId, source_sha256: sourceSha },
    applicationVersion: "0.1.0",
    publishStagedBundle: async ({ staging, destination: target }) => fs.rename(staging, target),
  });
}

describe("atomic volume figure publication", () => {
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "loci-volume-figure-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("publishes one complete bundle with verified PNG and manifest hashes", async () => {
    const receipt = await publish();
    const bundle = path.join(root, receipt.basename);
    expect((await fs.readdir(bundle)).sort()).toEqual(["image.png", "manifest.json"]);
    const image = await fs.readFile(path.join(bundle, "image.png"));
    const manifestBytes = await fs.readFile(path.join(bundle, "manifest.json"));
    const manifest = JSON.parse(manifestBytes.toString("utf8"));

    expect(receipt).toEqual({
      basename: "Figure.loci-figure",
      width: 4,
      height: 3,
      hashes: {
        "image.png": createHash("sha256").update(image).digest("hex"),
        "manifest.json": createHash("sha256").update(manifestBytes).digest("hex"),
      },
    });
    expect(manifest.source).toEqual({ source_id: sourceId, source_sha256: sourceSha, t: 0 });
    expect(manifest.artifact).toMatchObject({
      name: "image.png",
      sha256: receipt.hashes["image.png"],
      width_px: 4,
      height_px: 3,
    });
    expect(manifest.software).toMatchObject({ application: "Loci", application_version: "0.1.0" });
    expect(JSON.stringify(receipt)).not.toContain(root);
  });

  it("rejects stale source bindings and existing or symbolic-link destinations", async () => {
    await expect(publishVolumeFigureBundle({
      destination: path.join(root, "Stale.loci-figure"),
      request: request(),
      verifiedSource: { source_id: sourceId, source_sha256: "d".repeat(64) },
      applicationVersion: "0.1.0",
      publishStagedBundle: async ({ staging, destination: target }) => fs.rename(staging, target),
    })).rejects.toThrow(/source changed/i);

    const existing = path.join(root, "Existing.loci-figure");
    await fs.mkdir(existing);
    await expect(publish(request(), existing)).rejects.toThrow(/already exists/i);

    const target = path.join(root, "target");
    await fs.mkdir(target);
    const linked = path.join(root, "Linked.loci-figure");
    await fs.symlink(target, linked);
    await expect(publish(request(), linked)).rejects.toThrow(/already exists/i);
  });

  it("records bounded shaded lighting and refuses an incomplete or false lighting declaration", async () => {
    const shaded = request();
    shaded.manifest.representation.shading = true;
    await expect(publish(shaded)).rejects.toThrow(/lighting/i);
    shaded.manifest.representation.lighting = { ambient: 0.22, diffuse: 0.68, specular: 0.25, specular_power: 20, gradient_opacity: false };
    const receipt = await publish(shaded);
    const manifest = JSON.parse(await fs.readFile(path.join(root, receipt.basename, "manifest.json"), "utf8"));
    expect(manifest.representation).toEqual(shaded.manifest.representation);
    const falseDeclaration = request();
    falseDeclaration.manifest.representation.lighting = shaded.manifest.representation.lighting;
    await expect(publish(falseDeclaration, path.join(root, "Bad.loci-figure"))).rejects.toThrow(/Unshaded/);
    shaded.manifest.representation.lighting.specular_power = Number.NaN;
    await expect(publish(shaded, path.join(root, "Invalid.loci-figure"))).rejects.toThrow(/lighting/);
  });

  it("rejects a forged dimension and bounded-pixel violations before publication", async () => {
    const forged = request();
    forged.width_px = 5;
    forged.manifest.figure.width_px = 5;
    await expect(publish(forged)).rejects.toThrow(/PNG header disagrees/i);

    const oversized = request();
    oversized.width_px = MAX_VOLUME_FIGURE_EDGE + 1;
    oversized.manifest.figure.width_px = MAX_VOLUME_FIGURE_EDGE + 1;
    await expect(publish(oversized, path.join(root, "Large.loci-figure"))).rejects.toThrow(/width is invalid/i);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("removes staging when the single publication rename fails", async () => {
    const failed = publishVolumeFigureBundle({
      destination: path.join(root, "Figure.loci-figure"),
      request: request(),
      verifiedSource: { source_id: sourceId, source_sha256: sourceSha },
      applicationVersion: "0.1.0",
      publishStagedBundle: async () => { throw new Error("rename stopped"); },
    });
    await expect(failed).rejects.toThrow("rename stopped");
    expect(await fs.readdir(root)).toEqual([]);
  });
});
