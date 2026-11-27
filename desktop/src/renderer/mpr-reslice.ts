import type { RawVolumeComponent, RawVolumePayload } from "./RawVolumeViewport";

export type MprPayload = Pick<RawVolumePayload,
  "dimensions_xyz" | "origin_xyz" | "spacing_xyz" | "direction_3x3" | "frame" | "components">;

export type Vec3 = [number, number, number];
export type MprPlane = {
  id: "axial" | "coronal" | "sagittal";
  label: string;
  u: Vec3;
  v: Vec3;
  normal: Vec3;
  edges: [string, string, string, string]; // left, right, top, bottom
};
export type MprGrid = {
  width: number; height: number;
  uMin: number; uMax: number; vMin: number; vMax: number;
  normalPosition: number;
};
export type MprScalars = Uint8Array | Int8Array | Uint16Array | Int16Array | Uint32Array | Int32Array | Float32Array;

export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function indexToWorld(payload: MprPayload, index: Vec3): Vec3 {
  return [0, 1, 2].map((row) => payload.origin_xyz[row] + [0, 1, 2].reduce(
    (sum, col) => sum + payload.direction_3x3[col * 3 + row] * payload.spacing_xyz[col] * index[col], 0,
  )) as Vec3;
}

// The payload validator requires an orthonormal direction matrix. Its inverse
// is the transpose; anisotropic spacing is removed after this rotation.
export function worldToIndex(payload: MprPayload, world: Vec3): Vec3 {
  const delta = world.map((value, axis) => value - payload.origin_xyz[axis]);
  return [0, 1, 2].map((col) => [0, 1, 2].reduce(
    (sum, row) => sum + payload.direction_3x3[col * 3 + row] * delta[row], 0,
  ) / payload.spacing_xyz[col]) as Vec3;
}

export function sourceGridPlanes(direction: MprPayload["direction_3x3"]): (MprPlane & { sourcePlane: string })[] {
  const [x, y, z] = [0, 1, 2].map((axis) => direction.slice(axis * 3, axis * 3 + 3) as Vec3);
  const minusZ = z.map((value) => -value) as Vec3;
  return [
    { sourcePlane: "XY", id: "axial", label: "XY plane", u: x, v: y, normal: z, edges: ["−X", "+X", "−Y", "+Y"] },
    { sourcePlane: "XZ", id: "coronal", label: "XZ plane", u: x, v: minusZ, normal: y, edges: ["−X", "+X", "+Z", "−Z"] },
    { sourcePlane: "YZ", id: "sagittal", label: "YZ plane", u: y, v: minusZ, normal: x, edges: ["−Y", "+Y", "+Z", "−Z"] },
  ];
}

export function mprPlanes(payload: MprPayload): MprPlane[] {
  if (payload.frame === "image") return sourceGridPlanes(payload.direction_3x3);
  // Radiological convention, in the declared patient frame. These planes are
  // genuinely world-aligned even for oblique acquisition directions.
  const sign = payload.frame === "LPS" ? 1 : -1;
  return [
    { id: "axial", label: "Axial", u: [sign, 0, 0], v: [0, sign, 0], normal: [0, 0, 1], edges: ["R", "L", "A", "P"] },
    { id: "coronal", label: "Coronal", u: [sign, 0, 0], v: [0, 0, -1], normal: [0, sign, 0], edges: ["R", "L", "S", "I"] },
    { id: "sagittal", label: "Sagittal", u: [0, sign, 0], v: [0, 0, -1], normal: [sign, 0, 0], edges: ["A", "P", "S", "I"] },
  ];
}

export function planeGrid(payload: MprPayload, plane: MprPlane, crosshair: Vec3): MprGrid {
  const corners: Vec3[] = [];
  for (const x of [0, payload.dimensions_xyz[0] - 1])
    for (const y of [0, payload.dimensions_xyz[1] - 1])
      for (const z of [0, payload.dimensions_xyz[2] - 1]) corners.push(indexToWorld(payload, [x, y, z]));
  const us = corners.map((p) => dot(p, plane.u)), vs = corners.map((p) => dot(p, plane.v));
  const uMin = Math.min(...us), uMax = Math.max(...us), vMin = Math.min(...vs), vMax = Math.max(...vs);
  const span = Math.max(uMax - uMin, vMax - vMin, Math.min(...payload.spacing_xyz));
  const edge = Math.min(384, Math.max(...payload.dimensions_xyz));
  return { uMin, uMax, vMin, vMax, normalPosition: dot(crosshair, plane.normal),
    width: Math.max(1, Math.round((uMax - uMin) / span * (edge - 1)) + 1),
    height: Math.max(1, Math.round((vMax - vMin) / span * (edge - 1)) + 1) };
}

export function planePoint(plane: MprPlane, grid: MprGrid, x: number, y: number): Vec3 {
  const u = grid.uMin + x * (grid.uMax - grid.uMin);
  const v = grid.vMin + y * (grid.vMax - grid.vMin);
  return [0, 1, 2].map((axis) => plane.u[axis] * u + plane.v[axis] * v + plane.normal[axis] * grid.normalPosition) as Vec3;
}

export function sampleTrilinear(payload: MprPayload, values: MprScalars, index: Vec3, component: number): number | null {
  const dims = payload.dimensions_xyz;
  if (index.some((value, axis) => !Number.isFinite(value) || value < -1e-6 || value > dims[axis] - 1 + 1e-6)) return null;
  const p = index.map((value, axis) => Math.max(0, Math.min(dims[axis] - 1, value)));
  const lo = p.map(Math.floor), hi = lo.map((value, axis) => Math.min(value + 1, dims[axis] - 1));
  const f = p.map((value, axis) => value - lo[axis]);
  let sum = 0;
  for (let z = 0; z < 2; z++) for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
    const offset = (((z ? hi[2] : lo[2]) * dims[1] + (y ? hi[1] : lo[1])) * dims[0] + (x ? hi[0] : lo[0])) * payload.components.length + component;
    sum += values[offset] * (x ? f[0] : 1 - f[0]) * (y ? f[1] : 1 - f[1]) * (z ? f[2] : 1 - f[2]);
  }
  return sum;
}

export function renderMpr(payload: MprPayload, values: MprScalars, plane: MprPlane, grid: MprGrid, transfers: RawVolumeComponent[]): Uint8ClampedArray {
  const output = new Uint8ClampedArray(grid.width * grid.height * 4);
  // The world-to-index mapping is affine. Transform three points once instead
  // of allocating and multiplying matrices for every rendered pixel.
  const origin = worldToIndex(payload, planePoint(plane, grid, grid.width > 1 ? 0 : 0.5, grid.height > 1 ? 0 : 0.5));
  const endU = worldToIndex(payload, planePoint(plane, grid, grid.width > 1 ? 1 : 0.5, grid.height > 1 ? 0 : 0.5));
  const endV = worldToIndex(payload, planePoint(plane, grid, grid.width > 1 ? 0 : 0.5, grid.height > 1 ? 1 : 0.5));
  const du = origin.map((value, axis) => (endU[axis] - value) / Math.max(1, grid.width - 1));
  const dv = origin.map((value, axis) => (endV[axis] - value) / Math.max(1, grid.height - 1));
  const p: Vec3 = [0, 0, 0];
  for (let y = 0; y < grid.height; y++) for (let x = 0; x < grid.width; x++) {
    for (let axis = 0; axis < 3; axis++) p[axis] = origin[axis] + x * du[axis] + y * dv[axis];
    const offset = (y * grid.width + x) * 4;
    output[offset + 3] = 255;
    const rgb = [0, 0, 0];
    transfers.forEach((transfer, component) => {
      if (!transfer.visible || transfer.opacity <= 0) return;
      const scalar = sampleTrilinear(payload, values, p, component);
      if (scalar === null) return;
      const { low, high, gamma } = transfer.window;
      const intensity = Math.pow(Math.max(0, Math.min(1, (scalar - low) / (high - low))), 1 / gamma) * transfer.opacity;
      for (let c = 0; c < 3; c++) rgb[c] += intensity * transfer.color_rgb[c];
    });
    for (let c = 0; c < 3; c++) output[offset + c] = Math.round(Math.min(1, rgb[c]) * 255);
  }
  return output;
}
