import { describe, expect, it } from "vitest";
import { webcrypto } from "node:crypto";
import type { RawVolumePayload } from "./RawVolumeViewport";
import { compositeLabelPlane, labelAtWorld, labelBoundaryMesh, pickLabelRay, verifyVolumeLabels, type VolumeLabelPayload, type VerifiedVolumeLabels } from "./volume-label-display";
import { indexToWorld, mprPlanes, planeGrid, type Vec3 } from "./mpr-reslice";

const hash = async (bytes: Uint8Array) => Array.from(new Uint8Array(await webcrypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer))).map(n => n.toString(16).padStart(2, "0")).join("");
async function fixture() {
  const dimensions: Vec3 = [4, 3, 2], values = new Uint32Array(24);
  values[0] = 7; values[1] = 7; values[23] = 4294967295;
  const bytes = new Uint8Array(values.buffer);
  const prefix = new TextEncoder().encode('loci-label-array-v1\0{"dtype":"<u4","shape":[2,3,4]}\0');
  const canonical = new Uint8Array(prefix.length + bytes.length); canonical.set(prefix); canonical.set(bytes, prefix.length);
  const payload: VolumeLabelPayload = { schema: "loci.volume-labels/v1", source_id: "a".repeat(32), source_sha256: "b".repeat(64), t: 2,
    result: { result_id: "c".repeat(32), revision_hash: "d".repeat(64), label_sha256: await hash(canonical) },
    dimensions_xyz: dimensions, source_offset_xyz: [0, 0, 0], origin_xyz: [12, -3, 8], spacing_xyz: [2, 3, 5],
    direction_3x3: [0, 1, 0, -1, 0, 0, 0, 0, 1], affine_4x4: [[0, -3, 0, 12], [2, 0, 0, -3], [0, 0, 5, 8], [0, 0, 0, 1]],
    unit: "um", frame: "image", scalar_type: "uint32", interpolation: "nearest", sampling: "exact-native-grid", data_base64: Buffer.from(bytes).toString("base64"), data_sha256: await hash(bytes), byte_length: bytes.length };
  const source = { ...payload, source_dimensions_xyz: dimensions, dimensions_xyz: dimensions } as unknown as RawVolumePayload;
  return { payload, source, labels: { payload, values } satisfies VerifiedVolumeLabels };
}

describe("exact label geometry and categorical display", () => {
  it("verifies both data and canonical numerical hashes, retaining sparse uint32 IDs", async () => {
    const { payload, source } = await fixture();
    const checked = await verifyVolumeLabels(payload, source, payload.result);
    expect(checked.values[23]).toBe(4294967295);
    expect(labelAtWorld(checked, [6, 3, 13])).toBe(4294967295);
    expect(labelAtWorld(checked, [100, 100, 100])).toBe(0);
  });
  it("refuses changed source, time, revision, geometry, bytes and numerical identity", async () => {
    const { payload, source } = await fixture();
    for (const patch of [ { source_id: "e".repeat(32) }, { t: 1 }, { source_sha256: "e".repeat(64) },
      { result: { ...payload.result, revision_hash: "e".repeat(64) } }, { spacing_xyz: [1, 3, 5] }, { origin_xyz: [12, -3, 9] },
      { data_sha256: "e".repeat(64) }, { result: { ...payload.result, label_sha256: "e".repeat(64) } }, { byte_length: 1 } ]) {
      await expect(verifyVolumeLabels({ ...payload, ...patch } as VolumeLabelPayload, source, payload.result)).rejects.toThrow();
    }
  });
  it("does not blend IDs across a categorical boundary", async () => {
    const { labels, source } = await fixture();
    expect(labelAtWorld(labels, indexToWorld(source, [1.49, 0, 0]))).toBe(7);
    expect(labelAtWorld(labels, indexToWorld(source, [1.51, 0, 0]))).toBe(0);
    const plane = mprPlanes(source)[0], grid = planeGrid(source, plane, source.origin_xyz);
    const pixels = new Uint8ClampedArray(grid.width * grid.height * 4);
    compositeLabelPlane(pixels, labels, plane, grid, { visible: true, opacity: 1, selected_only: true }, 7);
    expect([...pixels].filter(n => n > 0).length).toBeGreaterThan(0);
    const hidden = new Uint8ClampedArray(pixels.length);
    compositeLabelPlane(hidden, labels, plane, grid, { visible: false, opacity: 1, selected_only: false }, null);
    expect(hidden.every(n => n === 0)).toBe(true);
  });
  it("picks native labels along calibrated rays and honors selection and clipping", async () => {
    const { labels, source } = await fixture();
    const a = indexToWorld(source, [-10, 0, 0]), b = indexToWorld(source, [10, 0, 0]);
    expect(pickLabelRay(labels, a, b)).toBe(7);
    expect(pickLabelRay(labels, a, b, 4294967295)).toBe(0);
    expect(pickLabelRay(labels, a, b, null, world => world[1] > 0)).toBe(0);
    expect(pickLabelRay(labels, a, a)).toBe(0);
    expect(pickLabelRay(labels, indexToWorld(source, [3, 2, -2]), indexToWorld(source, [3, 2, 4]))).toBe(4294967295);
  });
  it("constructs bounded surfaces in world coordinates, isolating the exact selected ID", async () => {
    const { labels } = await fixture();
    const mesh = labelBoundaryMesh(labels, 4294967295, true);
    expect(mesh.stride).toBe(1); expect(mesh.polys.length / 5).toBe(6);
    expect(new Set(Array.from(mesh.colors).filter((_, i) => i % 3 === 0))).toEqual(new Set([255]));
    const xyz = Array.from(mesh.points);
    expect(Math.min(...xyz.filter((_, i) => i % 3 === 0))).toBe(4.5);
    expect(Math.max(...xyz.filter((_, i) => i % 3 === 2))).toBe(15.5);
    expect(labelBoundaryMesh(labels, 9, true).polys.length).toBe(0);
  });
});
