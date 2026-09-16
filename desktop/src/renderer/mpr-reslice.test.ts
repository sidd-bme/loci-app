import { describe, expect, it } from "vitest";
import type { RawVolumePayload } from "./RawVolumeViewport";
import { indexToWorld, mprPlanes, planeGrid, planePoint, renderMpr, sampleTrilinear, worldToIndex } from "./mpr-reslice";

function fixture(): RawVolumePayload {
  return { dimensions_xyz: [4, 4, 4], origin_xyz: [10, 20, 30], spacing_xyz: [2, 3, 4],
    direction_3x3: [1, 0, 0, 0, 1, 0, 0, 0, 1], frame: "LPS", unit: "mm",
    components: [{ channel_index: 0, color_rgb: [1, 1, 1], visible: true, opacity: 1, window: { low: 0, high: 333, gamma: 1 } }],
  } as RawVolumePayload;
}
const ramp = () => Float32Array.from({ length: 64 }, (_, i) => (i % 4) + 10 * (Math.floor(i / 4) % 4) + 100 * Math.floor(i / 16));

describe("patient-frame MPR geometry and pixels", () => {
  it("preserves an independently calculated anisotropic oblique coordinate and linear-ramp intensity", () => {
    const p = fixture(), c = Math.SQRT1_2;
    p.direction_3x3 = [c, c, 0, -c, c, 0, 0, 0, 1];
    const world: [number, number, number] = [10 - 2 * c, 20 + 7 * c, 38];
    const index = worldToIndex(p, world);
    [1.25, 1.5, 2].forEach((value, axis) => expect(index[axis]).toBeCloseTo(value, 12));
    expect(sampleTrilinear(p, ramp(), index, 0)).toBeCloseTo(216.25, 10);
    indexToWorld(p, index).forEach((value, axis) => expect(value).toBeCloseTo(world[axis], 12));
    expect(mprPlanes(p)[0].normal).toEqual([0, 0, 1]);
    expect(mprPlanes(p)[1].normal).toEqual([0, 1, 0]);
  });

  it("renders the same anatomical orientation for equivalent LPS and RAS volumes", () => {
    const lps = fixture(), ras = fixture();
    ras.frame = "RAS"; ras.origin_xyz = [-10, -20, 30];
    ras.direction_3x3 = [-1, 0, 0, 0, -1, 0, 0, 0, 1];
    const a = indexToWorld(lps, [1, 1, 1]), b = indexToWorld(ras, [1, 1, 1]);
    for (let i = 0; i < 3; i++) {
      const pa = mprPlanes(lps)[i], pb = mprPlanes(ras)[i];
      expect(renderMpr(lps, ramp(), pa, planeGrid(lps, pa, a), lps.components)).toEqual(
        renderMpr(ras, ramp(), pb, planeGrid(ras, pb, b), ras.components));
      expect(pa.edges).toEqual(pb.edges);
      const steppedA = a.map((value, axis) => value + pa.normal[axis]) as [number, number, number];
      const steppedB = b.map((value, axis) => value + pb.normal[axis]) as [number, number, number];
      worldToIndex(lps, steppedA).forEach((value, axis) =>
        expect(worldToIndex(ras, steppedB)[axis]).toBeCloseTo(value, 12));
    }
  });

  it("keeps an oblique axial plane at one physical Z and excludes samples outside the acquired box", () => {
    const p = fixture(), c = Math.SQRT1_2;
    p.direction_3x3 = [c, 0, c, 0, 1, 0, -c, 0, c];
    const plane = mprPlanes(p)[0], crosshair = indexToWorld(p, [1, 1, 1]);
    const grid = planeGrid(p, plane, crosshair);
    expect(planePoint(plane, grid, 0, 0)[2]).toBeCloseTo(crosshair[2]);
    expect(planePoint(plane, grid, 1, 1)[2]).toBeCloseTo(crosshair[2]);
    expect(sampleTrilinear(p, ramp(), [-0.1, 0, 0], 0)).toBeNull();
    expect(sampleTrilinear(p, ramp(), [0, Number.NaN, 0], 0)).toBeNull();
    expect(sampleTrilinear(p, ramp(), [3, 3, 3], 0)).toBe(333);
  });

  it("uses source-plane names without anatomical metadata and does not mutate original samples", () => {
    const p = fixture(); p.frame = "image";
    const values = ramp(), before = values.slice();
    expect(mprPlanes(p).map((plane) => plane.label)).toEqual(["XY plane", "XZ plane", "YZ plane"]);
    const plane = mprPlanes(p)[0], grid = planeGrid(p, plane, indexToWorld(p, [1, 1, 1]));
    const normal = renderMpr(p, values, plane, grid, p.components);
    const hidden = renderMpr(p, values, plane, grid, p.components.map((item) => ({ ...item, visible: false })));
    expect(normal.some((value, i) => i % 4 !== 3 && value > 0)).toBe(true);
    expect(hidden.every((value, i) => value === (i % 4 === 3 ? 255 : 0))).toBe(true);
    expect(values).toEqual(before);
    expect(grid.width).toBeLessThanOrEqual(384); expect(grid.height).toBeLessThanOrEqual(384);
  });
});
