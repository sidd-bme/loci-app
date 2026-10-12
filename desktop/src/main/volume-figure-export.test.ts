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

  it("preserves compatible legacy v1 MPR publication", async () => {
    const legacyMpr = request();
    legacyMpr.manifest.representation.mode = "mpr";
    legacyMpr.manifest.transfers[0].color_mode = "intensity";
    legacyMpr.manifest.transfers[0].resolved_points = [0, 0.25, 0.5, 0.75, 1].map((value) => ({
      scalar: value * 255,
      opacity: value,
      color_rgb: [value, value, value] as [number, number, number],
    }));
    legacyMpr.manifest.transfers[0].opacity_unit_distance = null;
    legacyMpr.manifest.mpr = {
      context_display_indices_xyz: [0, 0, 0],
      active_payload_indices_xyz: [0, 0, 0],
      source_indices_xyz: [0, 0, 0],
      world_xyz: [0, 0, 0],
    };

    const destination = path.join(root, "Legacy-MPR.loci-figure");
    const receipt = await publish(legacyMpr, destination);
    const manifest = JSON.parse(await fs.readFile(path.join(destination, "manifest.json"), "utf8"));
    expect(receipt.basename).toBe("Legacy-MPR.loci-figure");
    expect(manifest.schema_version).toBe("loci.volume-figure/v1");
    expect(manifest.representation.mode).toBe("mpr");
    expect(manifest.transfers[0].color_mode).toBe("intensity");
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

describe("loci.volume-figure/v2 export validation", () => {
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "loci-volume-figure-v2-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  function requestV2(
    mode: "volume" | "mpr" = "volume",
    blendMode: "blend" | "normal_shading" | "mip" | "average" | "minip" = "blend",
    quality = 50,
  ): any {
    const base = request();
    const isNormalShading = mode === "volume" && blendMode === "normal_shading";
    return {
      ...base,
      manifest: {
        ...base.manifest,
        schema_version: "loci.volume-figure/v2",
        representation: {
          mode,
          extent: "context",
          interpolation: "linear",
          channel_compositing: mode === "volume" ? "opacity-weighted-channels/v1" : null,
          shading: isNormalShading,
          blend_mode: mode === "volume" ? blendMode : null,
          projection_reducer: mode === "volume" && blendMode === "average"
            ? "sample-distance-weighted-mean/v1"
            : null,
          quality: mode === "volume" ? quality : null,
          lighting: isNormalShading
            ? { ambient: 0.22, diffuse: 0.68, specular: 0.25, specular_power: 20, gradient_opacity: false }
            : null,
          orientation_axes: true,
        },
        transfers: base.manifest.transfers.map((transfer) => ({
          ...transfer,
          color_mode: mode === "volume" ? "constant" : "intensity",
          resolved_points: [0, 0.25, 0.5, 0.75, 1].map((value) => ({
            scalar: value * 255,
            opacity: value,
            color_rgb: (mode === "volume" ? [1, 1, 1] : [value, value, value]) as [number, number, number],
          })),
          opacity_unit_distance: mode === "volume" ? transfer.opacity_unit_distance : null,
        })),
        mpr: mode === "mpr" ? {
          context_display_indices_xyz: [0, 0, 0],
          active_payload_indices_xyz: [0, 0, 0],
          source_indices_xyz: [0, 0, 0],
          world_xyz: [0, 0, 0],
        } : null,
      },
    };
  }

  it("publishes valid v2 figures across all 5 volume modes", async () => {
    const modes: Array<"blend" | "normal_shading" | "mip" | "average" | "minip"> = [
      "blend", "normal_shading", "mip", "average", "minip",
    ];
    for (const mode of modes) {
      const dest = path.join(root, `Fig-${mode}.loci-figure`);
      const req = requestV2("volume", mode, 60);
      const receipt = await publish(req, dest);
      expect(receipt.basename).toBe(`Fig-${mode}.loci-figure`);
      const manifestBytes = await fs.readFile(path.join(dest, "manifest.json"));
      const manifest = JSON.parse(manifestBytes.toString("utf8"));
      expect(manifest.schema_version).toBe("loci.volume-figure/v2");
      expect(manifest.representation.channel_compositing).toBe("opacity-weighted-channels/v1");
      expect(manifest.representation.blend_mode).toBe(mode);
      expect(manifest.representation.projection_reducer).toBe(
        mode === "average" ? "sample-distance-weighted-mean/v1" : null,
      );
      expect(manifest.representation.quality).toBe(60);
      expect(manifest.representation.shading).toBe(mode === "normal_shading");
      if (mode === "normal_shading") {
        expect(manifest.representation.lighting).toEqual({
          ambient: 0.22, diffuse: 0.68, specular: 0.25, specular_power: 20, gradient_opacity: false,
        });
      } else {
        expect(manifest.representation.lighting).toBeNull();
      }
    }
  });

  it("publishes valid v2 figures for MPR mode", async () => {
    const dest = path.join(root, "Fig-mpr.loci-figure");
    const req = requestV2("mpr");
    const receipt = await publish(req, dest);
    expect(receipt.basename).toBe("Fig-mpr.loci-figure");
    const manifest = JSON.parse(await fs.readFile(path.join(dest, "manifest.json"), "utf8"));
    expect(manifest.schema_version).toBe("loci.volume-figure/v2");
    expect(manifest.representation.channel_compositing).toBeNull();
    expect(manifest.representation.blend_mode).toBeNull();
    expect(manifest.representation.projection_reducer).toBeNull();
    expect(manifest.representation.quality).toBeNull();
    expect(manifest.representation.shading).toBe(false);
    expect(manifest.representation.lighting).toBeNull();
  });

  it("rejects unknown channel compositing algorithms in v2", async () => {
    const req = requestV2("volume");
    req.manifest.representation.channel_compositing = "additive/v1";
    await expect(publish(req)).rejects.toThrow(/channel compositing algorithm is unsupported/i);
  });

  it("rejects volume mode missing channel compositing", async () => {
    const req = requestV2("volume");
    req.manifest.representation.channel_compositing = null;
    await expect(publish(req)).rejects.toThrow(/channel compositing algorithm is unsupported/i);
  });

  it("rejects invalid volume blend mode in v2", async () => {
    const req = requestV2("volume");
    req.manifest.representation.blend_mode = "unknown_mode";
    await expect(publish(req)).rejects.toThrow(/blend mode is unsupported/i);
  });

  it("rejects boxed mode, extent, and blend-mode values after structured clone", async () => {
    const boxedMode = requestV2("mpr");
    boxedMode.manifest.representation.mode = structuredClone(Object("mpr"));
    boxedMode.manifest.mpr = null;
    await expect(publish(boxedMode)).rejects.toThrow(/representation is invalid/i);

    const boxedExtent = requestV2("volume");
    boxedExtent.manifest.representation.extent = structuredClone(Object("context"));
    await expect(publish(boxedExtent)).rejects.toThrow(/representation is invalid/i);

    const boxedBlendMode = requestV2("volume");
    boxedBlendMode.manifest.representation.blend_mode = structuredClone(Object("normal_shading"));
    await expect(publish(boxedBlendMode)).rejects.toThrow(/blend mode is unsupported/i);
  });

  it("rejects missing required v2 representation fields", async () => {
    for (const field of ["channel_compositing", "blend_mode", "projection_reducer", "quality", "lighting"]) {
      const req = requestV2("volume");
      delete req.manifest.representation[field];
      await expect(publish(req)).rejects.toThrow(/unsupported fields/i);
    }
  });

  it("requires the exact projection reducer only for average volume mode", async () => {
    const unknown = requestV2("volume", "average");
    unknown.manifest.representation.projection_reducer = "sample-count-mean/v1";
    await expect(publish(unknown)).rejects.toThrow(/average volume projection reducer is unsupported/i);

    const missingForAverage = requestV2("volume", "average");
    missingForAverage.manifest.representation.projection_reducer = null;
    await expect(publish(missingForAverage)).rejects.toThrow(/average volume projection reducer is unsupported/i);

    const wrongMode = requestV2("volume", "blend");
    wrongMode.manifest.representation.projection_reducer = "sample-distance-weighted-mean/v1";
    await expect(publish(wrongMode)).rejects.toThrow(/must not declare a projection reducer/i);
  });

  it("rejects altered v2 resolved transfer knots", async () => {
    const alterations = [
      (req: any) => { req.manifest.transfers[0].resolved_points[2].scalar += 1; },
      (req: any) => { req.manifest.transfers[0].resolved_points[2].opacity += 0.1; },
      (req: any) => { req.manifest.transfers[0].resolved_points[2].color_rgb[0] -= 0.1; },
    ];
    for (const alter of alterations) {
      const req = requestV2("volume");
      alter(req);
      await expect(publish(req)).rejects.toThrow(/resolved points disagree/i);
    }
  });

  it("rejects non-finite and out-of-range quality in v2", async () => {
    const tooLow = requestV2("volume", "blend", 5);
    await expect(publish(tooLow)).rejects.toThrow(/Volume quality is invalid/i);

    const tooHigh = requestV2("volume", "blend", 105);
    await expect(publish(tooHigh)).rejects.toThrow(/Volume quality is invalid/i);

    const nonFinite = requestV2("volume", "blend", Number.NaN);
    await expect(publish(nonFinite)).rejects.toThrow(/Volume quality is invalid/i);
  });

  it("rejects inconsistent shading and lighting combinations in v2", async () => {
    // Normal shading must have shading: true
    const badNormalShading = requestV2("volume", "normal_shading");
    badNormalShading.manifest.representation.shading = false;
    await expect(publish(badNormalShading)).rejects.toThrow(/Normal shading requires shading enabled/i);

    // Unshaded blend mode cannot have shading: true
    const badBlendShading = requestV2("volume", "blend");
    badBlendShading.manifest.representation.shading = true;
    badBlendShading.manifest.representation.lighting = {
      ambient: 0.22, diffuse: 0.68, specular: 0.25, specular_power: 20, gradient_opacity: false,
    };
    await expect(publish(badBlendShading)).rejects.toThrow(/Unshaded volume modes cannot enable shading/i);

    // Unshaded blend mode cannot declare lighting
    const badBlendLighting = requestV2("volume", "blend");
    badBlendLighting.manifest.representation.lighting = {
      ambient: 0.22, diffuse: 0.68, specular: 0.25, specular_power: 20, gradient_opacity: false,
    };
    await expect(publish(badBlendLighting)).rejects.toThrow(/Unshaded figures cannot declare lighting/i);
  });

  it("rejects MPR declaring volume-only fields in v2", async () => {
    const mprCompositing = requestV2("mpr");
    mprCompositing.manifest.representation.channel_compositing = "opacity-weighted-channels/v1";
    await expect(publish(mprCompositing)).rejects.toThrow(/MPR figures must not declare channel compositing/i);

    const mprBlend = requestV2("mpr");
    mprBlend.manifest.representation.blend_mode = "mip";
    await expect(publish(mprBlend)).rejects.toThrow(/MPR figures must not declare a blend mode/i);

    const mprReducer = requestV2("mpr");
    mprReducer.manifest.representation.projection_reducer = "sample-distance-weighted-mean/v1";
    await expect(publish(mprReducer)).rejects.toThrow(/MPR figures must not declare a projection reducer/i);

    const mprQuality = requestV2("mpr");
    mprQuality.manifest.representation.quality = 50;
    await expect(publish(mprQuality)).rejects.toThrow(/MPR figures must not declare volume quality/i);

    const mprShading = requestV2("mpr");
    mprShading.manifest.representation.shading = true;
    await expect(publish(mprShading)).rejects.toThrow(/MPR figures cannot enable shading/i);

    const mprLighting = requestV2("mpr");
    mprLighting.manifest.representation.lighting = {
      ambient: 0.22, diffuse: 0.68, specular: 0.25, specular_power: 20, gradient_opacity: false,
    };
    await expect(publish(mprLighting)).rejects.toThrow(/Unshaded figures cannot declare lighting/i);
  });

  it("rejects unsupported manifest schema versions", async () => {
    const req = requestV2();
    req.manifest.schema_version = "loci.volume-figure/v3";
    await expect(publish(req)).rejects.toThrow(/manifest schema is unsupported/i);
  });

  it("ensures legacy v1 requests cannot bypass exact keys with v2 fields", async () => {
    const v1WithV2Fields = request();
    // Adding blend_mode to v1 representation must fail closed
    (v1WithV2Fields.manifest.representation as any).blend_mode = "blend";
    await expect(publish(v1WithV2Fields)).rejects.toThrow(/unsupported fields/i);

    const v1WithProjectionReducer = request();
    (v1WithProjectionReducer.manifest.representation as any).projection_reducer =
      "sample-distance-weighted-mean/v1";
    await expect(publish(v1WithProjectionReducer)).rejects.toThrow(/unsupported fields/i);
  });
});
