import type { RawVolumePayload } from "./RawVolumeViewport";
import { indexToWorld, planePoint, worldToIndex, type MprGrid, type MprPlane, type Vec3 } from "./mpr-reslice";

export type VolumeLabelBinding = { result_id: string; revision_hash: string; label_sha256: string };
export type VolumeLabelPayload = {
  schema: "loci.volume-labels/v1"; source_id: string; source_sha256: string; t: number;
  result: VolumeLabelBinding; dimensions_xyz: Vec3; source_offset_xyz: Vec3;
  origin_xyz: Vec3; spacing_xyz: Vec3; direction_3x3: number[]; affine_4x4: number[][];
  unit: RawVolumePayload["unit"]; frame: RawVolumePayload["frame"];
  scalar_type: "uint32"; interpolation: "nearest"; sampling: "exact-native-grid";
  data_base64: string; data_sha256: string; byte_length: number;
};
export type VerifiedVolumeLabels = { payload: VolumeLabelPayload; values: Uint32Array };
export type VolumeLabelStyle = { visible: boolean; opacity: number; selected_only: boolean };
export function mprCanvasSignature(payload: RawVolumePayload, plane: MprPlane, crosshair: Vec3, transfers: unknown,
  labels: VerifiedVolumeLabels | null | undefined, style: VolumeLabelStyle | undefined, selected: number | null) {
  return JSON.stringify([payload.data_sha256, plane.id, crosshair, transfers, labels?.payload.data_sha256 ?? null, style ?? null, selected]);
}
const sha = async (data: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(data).buffer)))
  .map((n) => n.toString(16).padStart(2, "0")).join("");
const finite = (v: unknown, size: number): v is number[] => Array.isArray(v) && v.length === size && v.every(Number.isFinite);
const hash = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
// Coordinate helpers only read these geometry fields.
export const labelGeometry = (payload: VolumeLabelPayload) => payload as unknown as RawVolumePayload;

export async function verifyVolumeLabels(payload: VolumeLabelPayload, source: RawVolumePayload, expected: { result_id: string; revision_hash: string }): Promise<VerifiedVolumeLabels> {
  if (payload.schema !== "loci.volume-labels/v1" || payload.scalar_type !== "uint32" || payload.sampling !== "exact-native-grid" ||
      payload.interpolation !== "nearest" || payload.source_id !== source.source_id || payload.source_sha256 !== source.source_sha256 || payload.t !== source.t ||
      payload.result?.result_id !== expected.result_id || payload.result?.revision_hash !== expected.revision_hash || !hash(payload.result?.label_sha256) ||
      !hash(payload.data_sha256) || !finite(payload.dimensions_xyz, 3) || payload.dimensions_xyz.some(n => !Number.isSafeInteger(n) || n < 1) || payload.dimensions_xyz[2] < 2 ||
      !finite(payload.source_offset_xyz, 3) || payload.source_offset_xyz.some((n, i) => !Number.isSafeInteger(n) || n < 0 || n + payload.dimensions_xyz[i] > source.source_dimensions_xyz[i]) ||
      !finite(payload.origin_xyz, 3) || !finite(payload.spacing_xyz, 3) || payload.spacing_xyz.some(n => n <= 0) || !finite(payload.direction_3x3, 9) ||
      payload.unit !== source.unit || payload.frame !== source.frame) throw new Error("The label grid does not match the exact source, time, geometry and result.");
  const bytes = payload.dimensions_xyz.reduce((a, b) => a * b, 4);
  if (bytes !== payload.byte_length || bytes > 32 * 1024 ** 2 || payload.data_base64.length !== 4 * Math.ceil(bytes / 3)) throw new Error("The label grid exceeds its exact bounded byte size.");
  // Native source geometry reconstructed from the whole-extent raw payload.
  const spacing = source.spacing_xyz.map((n, i) => source.source_dimensions_xyz[i] <= 1 ? n : n * (source.dimensions_xyz[i] - 1) / (source.source_dimensions_xyz[i] - 1));
  const origin = [0, 1, 2].map(row => source.origin_xyz[row] + payload.source_offset_xyz.reduce((sum, n, col) => sum + n * spacing[col] * source.direction_3x3[col * 3 + row], 0));
  if (payload.direction_3x3.some((n, i) => Math.abs(n - source.direction_3x3[i]) > 1e-7) ||
      payload.spacing_xyz.some((n, i) => Math.abs(n - spacing[i]) > 1e-6 * Math.max(1, n)) ||
      payload.origin_xyz.some((n, i) => Math.abs(n - origin[i]) > 1e-6 * Math.max(1, Math.abs(n)))) throw new Error("The label calibration is inconsistent with the raw volume.");
  if (!Array.isArray(payload.affine_4x4) || payload.affine_4x4.length !== 4 || payload.affine_4x4.some(row => !finite(row, 4)) ||
      payload.affine_4x4.some((row, r) => row.some((n, c) => Math.abs(n - (r === 3 ? (c === 3 ? 1 : 0) : c === 3 ? payload.origin_xyz[r] : payload.direction_3x3[c * 3 + r] * payload.spacing_xyz[c])) > 1e-7)))
    throw new Error("The label affine disagrees with its calibrated grid.");
  const data = Uint8Array.from(atob(payload.data_base64), c => c.charCodeAt(0));
  if (data.length !== bytes || await sha(data) !== payload.data_sha256) throw new Error("Label bytes failed their SHA-256 check.");
  // Validate the canonical numerical label hash, independently of file bytes.
  const prefix = new TextEncoder().encode(`loci-label-array-v1\0${JSON.stringify({ dtype: "<u4", shape: [...payload.dimensions_xyz].reverse() })}\0`);
  // canonical_json uses sorted compact keys, which are dtype then shape.
  const canonical = new Uint8Array(prefix.length + data.length); canonical.set(prefix); canonical.set(data, prefix.length);
  if (await sha(canonical) !== payload.result.label_sha256) throw new Error("The numerical label identity is inconsistent.");
  return { payload, values: new Uint32Array(data.buffer) };
}

export function labelAtWorld(labels: VerifiedVolumeLabels, world: Vec3): number {
  const index = worldToIndex(labelGeometry(labels.payload), world).map(Math.round);
  const [nx, ny, nz] = labels.payload.dimensions_xyz;
  if (index.some((n, axis) => !Number.isFinite(n) || n < 0 || n >= [nx, ny, nz][axis])) return 0;
  return labels.values[(index[2] * ny + index[1]) * nx + index[0]];
}

export function labelColor(id: number, selected: boolean): Vec3 {
  return selected ? [255, 238, 132] : [67, 97, 137].map(n => id * n % 223 + 32) as Vec3;
}

export function compositeLabelPlane(pixels: Uint8ClampedArray, labels: VerifiedVolumeLabels, plane: MprPlane, grid: MprGrid, style: VolumeLabelStyle, selected: number | null): void {
  if (!style.visible || style.opacity <= 0) return;
  for (let y = 0; y < grid.height; y++) for (let x = 0; x < grid.width; x++) {
    const id = labelAtWorld(labels, planePoint(plane, grid, grid.width > 1 ? x / (grid.width - 1) : 0.5, grid.height > 1 ? y / (grid.height - 1) : 0.5));
    if (!id || style.selected_only && id !== selected) continue;
    const rgb = labelColor(id, id === selected), alpha = id === selected ? Math.max(0.65, style.opacity) : style.opacity;
    const offset = (y * grid.width + x) * 4;
    for (let c = 0; c < 3; c++) pixels[offset + c] = Math.round(pixels[offset + c] * (1 - alpha) + rgb[c] * alpha);
  }
}

/** A nearest-sampled categorical boundary surface. All selection/measurement uses native labels. */
export function labelBoundaryMesh(labels: VerifiedVolumeLabels, selected: number | null, selectedOnly: boolean, maxEdge = 96) {
  const dims = labels.payload.dimensions_xyz;
  const step = Math.max(1, Math.ceil(Math.max(...dims) / maxEdge));
  const counts = dims.map(n => Math.ceil(n / step));
  const points: number[] = [], polys: number[] = [], colors: number[] = [];
  const value = (x: number, y: number, z: number) => x < 0 || y < 0 || z < 0 || x >= counts[0] || y >= counts[1] || z >= counts[2] ? 0 : labels.values[(Math.min(dims[2] - 1, z * step) * dims[1] + Math.min(dims[1] - 1, y * step)) * dims[0] + Math.min(dims[0] - 1, x * step)];
  for (let z = 0; z < counts[2]; z++) for (let y = 0; y < counts[1]; y++) for (let x = 0; x < counts[0]; x++) {
    const id = value(x, y, z); if (!id || selectedOnly && id !== selected) continue;
    const cell = [x, y, z];
    for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
      const neighbor = [...cell]; neighbor[axis] += sign;
      const other = value(neighbor[0], neighbor[1], neighbor[2]);
      if (other === id || !selectedOnly && other > 0 && other < id) continue;
      if (polys.length / 5 >= 180000) throw new Error("The 3D label surface is too dense. Select an object and enable Selected only; exact slice labels remain available.");
      const offset = points.length / 3, u = (axis + 1) % 3, v = (axis + 2) % 3;
      for (const [du, dv] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]) {
        const p = cell.map((n, i) => Math.min(dims[i] - 1, n * step));
        p[axis] += sign * step / 2; p[u] += du * step; p[v] += dv * step;
        for (let i = 0; i < 3; i++) p[i] = Math.max(-0.5, Math.min(dims[i] - 0.5, p[i]));
        points.push(...indexToWorld(labelGeometry(labels.payload), p as Vec3));
      }
      polys.push(4, offset, offset + 1, offset + 2, offset + 3);
      colors.push(...labelColor(id, id === selected));
    }
  }
  return { points: new Float32Array(points), polys: new Uint32Array(polys), colors: new Uint8Array(colors), stride: step };
}

/** Exact native-voxel ray traversal, independent of the sampled display surface. */
export function pickLabelRay(labels: VerifiedVolumeLabels, startWorld: Vec3, endWorld: Vec3, selectedOnly: number | null = null, accept?: (world: Vec3) => boolean): number {
  const geometry = labelGeometry(labels.payload), dims = labels.payload.dimensions_xyz;
  const start = worldToIndex(geometry, startWorld), end = worldToIndex(geometry, endWorld);
  const delta = end.map((n, i) => n - start[i]);
  if (![...start, ...delta].every(Number.isFinite) || delta.every(n => Math.abs(n) < 1e-12)) return 0;
  let lo = 0, hi = 1;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(delta[i]) < 1e-12) { if (start[i] < -0.5 || start[i] > dims[i] - 0.5) return 0; continue; }
    const a = (-0.5 - start[i]) / delta[i], b = (dims[i] - 0.5 - start[i]) / delta[i]; lo = Math.max(lo, Math.min(a, b)); hi = Math.min(hi, Math.max(a, b));
  }
  if (lo > hi) return 0;
  const cell = start.map((n, i) => Math.max(0, Math.min(dims[i] - 1, Math.floor(n + (lo + 1e-10) * delta[i] + 0.5))));
  const step = delta.map(Math.sign);
  const next = cell.map((n, i) => delta[i] === 0 ? Infinity : (n + step[i] * 0.5 - start[i]) / delta[i]);
  const interval = delta.map(n => n === 0 ? Infinity : Math.abs(1 / n));
  for (let count = 0; count < dims.reduce((a, b) => a + b, 3); count++) {
    const id = labels.values[(cell[2] * dims[1] + cell[1]) * dims[0] + cell[0]];
    if (id && (selectedOnly === null || id === selectedOnly) && (!accept || accept(indexToWorld(geometry, cell as Vec3)))) return id;
    const crossing = Math.min(...next); if (crossing > hi) return 0;
    for (let axis = 0; axis < 3; axis++) if (Math.abs(next[axis] - crossing) <= 1e-12) {
      cell[axis] += step[axis]; if (cell[axis] < 0 || cell[axis] >= dims[axis]) return 0; next[axis] += interval[axis];
    }
  }
  return 0;
}
