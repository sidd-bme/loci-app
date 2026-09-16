import { describe, expect, it } from "vitest";
import type { ResearchResult, ResearchSource } from "../shared/research-contracts";
import {
  resolveResultPlaneOverlay,
  resultPixelToSourcePoint,
  sourcePointToResultPixel,
  type ExactResultPlane,
} from "./result-plane-overlay";

const source: ResearchSource = {
  id: "a".repeat(32),
  name: "Pyramid",
  sha256: "b".repeat(64),
  source_kind: "native",
  metadata: {
    dimensions: { t: 1, c: 1, z: 1, y: 300, x: 400 },
    levels: [
      { index: 0, dimensions: { t: 1, c: 1, z: 1, y: 300, x: 400 },
        calibration: { axes: "YX", spacing: [1, 1], unit: "µm" } },
      { index: 1, dimensions: { t: 1, c: 1, z: 1, y: 150, x: 200 },
        calibration: { axes: "YX", spacing: [2, 2], unit: "µm" } },
    ],
  },
};
const geometry = {
  axes: "YX",
  affine: [
    [2, 0, 0, 20],
    [0, 2, 0, 40],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ],
  unit: "um",
  frame: "image",
};
const result: ResearchResult = {
  id: "c".repeat(32),
  source_id: source.id,
  source_sha256: source.sha256,
  kind: "segmentation",
  created_at: "2026-09-08T00:00:00Z",
  revision_hash: "d".repeat(64),
  object_count: 2,
  arrays: { image: { shape: [40, 50], dtype: "float64", sha256: "e".repeat(64) } },
  geometry,
  selection: { x: 10, y: 20, width: 50, height: 40, t: 0, c: 0, z: 0, level: 1 },
};
const plane: ExactResultPlane = {
  image: "data:image/png;base64,AA==",
  shape: [40, 50],
  resultId: result.id,
  revisionHash: result.revision_hash,
  axis: "z",
  index: 0,
  geometry,
};

describe("result plane overlay mapping", () => {
  it("places a geometry-verified pyramid crop in level-zero source coordinates", () => {
    const resolved = resolveResultPlaneOverlay(source, result, plane);
    expect(resolved).toEqual({
      ok: true,
      overlay: expect.objectContaining({
        key: `${result.id}:${result.revision_hash}`,
        sourceId: source.id,
        sourceSha256: source.sha256,
        left: 20,
        top: 40,
        width: 100,
        height: 80,
        pixelWidth: 50,
        pixelHeight: 40,
        opacity: 0.62,
      }),
    });
  });

  it("maps correction pixels through the exact crop while rejecting points outside it", () => {
    const resolved = resolveResultPlaneOverlay(source, result, plane);
    if (!resolved.ok) throw new Error(resolved.reason);
    const sourcePoint = resultPixelToSourcePoint(resolved.overlay, { u: 12, v: 7 });
    expect(sourcePoint).toEqual({ x: 45, y: 55 });
    expect(sourcePointToResultPixel(resolved.overlay, sourcePoint!)).toEqual({ u: 12, v: 7 });
    expect(sourcePointToResultPixel(resolved.overlay, { x: 19.99, y: 55 })).toBeNull();
    expect(resultPixelToSourcePoint(resolved.overlay, { u: 50, v: 7 })).toBeNull();
  });

  it.each([
    ["source identity", { ...result, source_sha256: "0".repeat(64) }, plane],
    ["registered geometry", result, { ...plane, geometry: {
      ...geometry, affine: geometry.affine.map((row) => [...row]),
    } }],
    ["orthogonal plane", result, { ...plane, axis: "x" as const }],
    ["resampled shape", { ...result, arrays: { image: { shape: [20, 25] } } }, plane],
  ])("rejects an unrepresentable %s instead of inventing a source mapping", (_name, candidate, candidatePlane) => {
    if (_name === "registered geometry") candidatePlane.geometry.affine![0][1] = 0.1;
    expect(resolveResultPlaneOverlay(source, candidate as ResearchResult, candidatePlane as ExactResultPlane).ok).toBe(false);
  });

  it("uses the exact OpenSlide downsample and half-pixel geometry for a whole-slide crop", () => {
    const slideSource = {
      ...source,
      source_kind: "whole_slide" as const,
      metadata: {
        ...source.metadata,
        whole_slide: {
          micrometres_per_pixel_xy: [0.5, 0.25],
          levels: [{ index: 0, downsample: 1 }, { index: 1, downsample: 4 }],
        },
      },
    } as ResearchSource;
    const slideGeometry = {
      axes: "YX",
      affine: [
        [2, 0, 0, 21],
        [0, 1, 0, 20.5],
        [0, 0, 1, 0],
        [0, 0, 0, 1],
      ],
      unit: "um",
      frame: "image",
    };
    const slideResult = { ...result, source_id: slideSource.id, source_sha256: slideSource.sha256,
      geometry: slideGeometry };
    const slidePlane = { ...plane, geometry: slideGeometry };
    const resolved = resolveResultPlaneOverlay(slideSource, slideResult, slidePlane);
    expect(resolved).toEqual({ ok: true, overlay: expect.objectContaining({
      left: 40, top: 80, width: 200, height: 160,
    }) });
  });
});
