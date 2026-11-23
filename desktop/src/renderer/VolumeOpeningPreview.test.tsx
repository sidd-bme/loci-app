// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { createHash, webcrypto } from "node:crypto";
import { BlendMode } from "@kitware/vtk.js/Rendering/Core/VolumeMapper/Constants";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VolumeOpeningPreviewPayload } from "../shared/volume-opening-preview";
import { decodeVolumeOpeningPreview, openingMipTransfer, VolumeOpeningPreview } from "./VolumeOpeningPreview";

const graphics = vi.hoisted(() => ({
  canvas: null as HTMLCanvasElement | null,
  addVolume: vi.fn(),
  removeVolume: vi.fn(),
  render: vi.fn(),
  dispose: vi.fn(),
  azimuth: vi.fn(),
  elevation: vi.fn(),
  dolly: vi.fn(),
  paint: vi.fn(),
}));

vi.mock("@kitware/vtk.js/Rendering/Misc/GenericRenderWindow", () => ({
  default: { newInstance: () => {
    graphics.canvas = document.createElement("canvas");
    return {
      setContainer: (element: HTMLElement) => element.append(graphics.canvas!),
      resize: vi.fn(),
      getRenderWindow: () => ({
        getInteractor: () => ({ setDesiredUpdateRate: vi.fn(), setInteractorStyle: vi.fn() }),
        render: graphics.render,
      }),
      getRenderer: () => ({
        addVolume: graphics.addVolume, removeVolume: graphics.removeVolume,
        resetCamera: vi.fn(), resetCameraClippingRange: vi.fn(),
        getActiveCamera: () => ({
          azimuth: graphics.azimuth, elevation: graphics.elevation, dolly: graphics.dolly,
          orthogonalizeViewUp: vi.fn(),
        }),
      }),
      getApiSpecificRenderWindow: () => ({ getCanvas: () => graphics.canvas }),
      delete: graphics.dispose,
    };
  } },
}));
vi.mock("@kitware/vtk.js/Interaction/Widgets/OrientationMarkerWidget", () => ({
  default: { newInstance: () => ({
    setEnabled: vi.fn(), updateViewport: vi.fn(), updateMarkerOrientation: vi.fn(), delete: vi.fn(),
  }) },
}));

function preview(): VolumeOpeningPreviewPayload {
  const bytes = Buffer.from([0, 1, 2, 3]);
  return {
    schema_version: "loci.volume-opening-preview/v1",
    opening_id: "00000000-0000-4000-8000-000000000001",
    source_inventory_sha256: "1".repeat(64),
    context: {
      dimensions_xyz: [2, 1, 2],
      native_level_dimensions_xyz: [2, 1, 2],
      source_dimensions_xyz: [5, 1, 2],
      level: 1, t: 0,
      origin_xyz: [10, 20, 30], spacing_xyz: [0.8, 0.8, 2.5],
      direction_3x3: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      affine_4x4: [[0.8, 0, 0, 10], [0, 0.8, 0, 20], [0, 0, 2.5, 30], [0, 0, 0, 1]],
      unit: "um", frame: "image", scalar_type: "uint8",
      source_dtypes: ["uint8"], encoding_basis: "native-common-dtype", interleave: "voxel-major",
      components: [{
        channel_index: 0, name: "Channel 1", color_rgb: [1, 1, 1],
        window: { low: 0, high: 3, gamma: 1 }, opacity: 1, visible: true,
        opacity_points: [[0, 0], [3, 1]],
        provenance: { range: "bounded-context-min-max" },
      }],
      data_base64: bytes.toString("base64"),
      byte_length: bytes.length,
      data_sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
}

function twoPlanePreview() {
  const payload = preview();
  const bytes = Buffer.alloc(16 * 16 * 2);
  bytes.fill(25, 0, 256);
  bytes.fill(200, 256);
  payload.context.dimensions_xyz = [16, 16, 2];
  payload.context.native_level_dimensions_xyz = [16, 16, 2];
  payload.context.source_dimensions_xyz = [32, 32, 2];
  payload.context.components[0].window = { low: 0, high: 100, gamma: 1 };
  payload.context.components[0].opacity_points = [[0, 0], [100, 1]];
  payload.context.data_base64 = bytes.toString("base64");
  payload.context.data_sha256 = createHash("sha256").update(bytes).digest("hex");
  payload.context.byte_length = bytes.length;
  return payload;
}

describe("opening MIP transfer", () => {
  it("uses a robust projected high and preserves the declared transfer and data", () => {
    const { context } = twoPlanePreview();
    const original = context.components[0];
    original.window = { low: 10, high: 150, gamma: 1.5 };
    original.opacity = 0.8;
    original.opacity_points = [[10, 0], [150, 0.8]];
    const snapshot = structuredClone(original);
    const values = new Uint16Array(512).fill(200);
    values[0] = 10_000;
    const projected = openingMipTransfer(context, values);
    expect(projected.window).toEqual({ low: 10, high: 200, gamma: 1.5 });
    expect(projected.opacity_points).toEqual([[10, 0], [200, 0.8]]);
    expect(projected.provenance).toEqual({
      ...snapshot.provenance, opening_mip_high: "pooled-orthogonal-ray-maxima-p99",
    });
    expect(original).toEqual(snapshot);
    expect([...values]).toEqual([10_000, ...Array(511).fill(200)]);
  });

  it("keeps a wider window and handles sparse, tiny, and negative previews", () => {
    const { context } = twoPlanePreview();
    const original = context.components[0];
    const sparse = new Uint16Array(512);
    sparse[45] = 5000;
    expect(openingMipTransfer(context, sparse)).toBe(original);
    expect(openingMipTransfer(context, new Uint16Array(512).fill(80))).toBe(original);

    original.window = { low: -35, high: -10, gamma: 1 };
    expect(openingMipTransfer(context, new Float32Array(512).fill(-15))).toBe(original);
    expect(openingMipTransfer(context, new Float32Array(512).fill(-5.5)).window.high).toBe(-5.5);

    const tiny = preview().context;
    expect(openingMipTransfer(tiny, Uint8Array.from([0, 0, 0, 100]))).toBe(tiny.components[0]);
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ({
    createImageData: (width: number, height: number) => ({
      data: new Uint8ClampedArray(width * height * 4), width, height,
    }),
    putImageData: graphics.paint,
  }) as unknown as CanvasRenderingContext2D);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("temporary 3D preview", () => {
  it("checks transfer bounds, source geometry and byte hash before opening graphics", async () => {
    const valid = preview();
    expect(await decodeVolumeOpeningPreview(valid)).toEqual(Uint8Array.from([0, 1, 2, 3]));
    for (const invalidate of [
      (record: VolumeOpeningPreviewPayload) => { record.context.dimensions_xyz[0] = 97; },
      (record: VolumeOpeningPreviewPayload) => { record.context.affine_4x4[0][3] += 1; },
      (record: VolumeOpeningPreviewPayload) => { record.context.components[0].window.high = Number.NaN; },
      (record: VolumeOpeningPreviewPayload) => { record.context.data_base64 = "AAECAA=="; },
    ]) {
      const malformed = structuredClone(valid);
      invalidate(malformed);
      await expect(decodeVolumeOpeningPreview(malformed)).rejects.toThrow(/invalid temporary volume preview/i);
    }
    const invalidFloat = preview();
    const bytes = Buffer.alloc(16);
    bytes.writeFloatLE(Number.NaN, 0);
    invalidFloat.context.scalar_type = "float32";
    invalidFloat.context.data_base64 = bytes.toString("base64");
    invalidFloat.context.data_sha256 = createHash("sha256").update(bytes).digest("hex");
    invalidFloat.context.byte_length = bytes.length;
    await expect(decodeVolumeOpeningPreview(invalidFloat)).rejects.toThrow(/invalid temporary volume preview/i);
    expect(graphics.addVolume).not.toHaveBeenCalled();
  });

  it("binds actual voxels, exposes keyboard orbit and zoom, and paints sampled XY slices", async () => {
    const onHide = vi.fn();
    const mounted = render(<VolumeOpeningPreview payload={preview()} onHide={onHide} />);
    const stage = await screen.findByLabelText("Interactive 3D preview");
    await waitFor(() => expect(stage).toBeVisible());
    expect(screen.getByText("Verifying source")).toBeVisible();
    expect(graphics.addVolume).toHaveBeenCalledOnce();
    const actor = graphics.addVolume.mock.calls[0][0];
    const mapper = actor.getMapper();
    expect(mapper.getBlendMode()).toBe(BlendMode.MAXIMUM_INTENSITY_BLEND);
    const colors = actor.getProperty().getRGBTransferFunction(0);
    expect(colors.getRedValue(0)).toBe(0);
    expect(colors.getRedValue(1.5)).toBeCloseTo(0.5);
    expect(colors.getRedValue(3)).toBe(1);
    expect(screen.getByText("First-channel maximum-intensity preview")).toBeVisible();
    expect(mapper.getInputData().getPointData().getScalars().getData()).toEqual(Uint8Array.from([0, 1, 2, 3]));
    fireEvent.keyDown(stage, { key: "ArrowRight" });
    fireEvent.keyDown(stage, { key: "+" });
    expect(graphics.azimuth).toHaveBeenLastCalledWith(5);
    expect(graphics.dolly).toHaveBeenLastCalledWith(1.1);
    fireEvent.click(screen.getByRole("button", { name: "XY slice" }));
    expect(screen.getByLabelText("XY preview slice")).toBeVisible();
    await waitFor(() => expect(graphics.paint).toHaveBeenCalledOnce());
    expect([...graphics.paint.mock.calls[0][0].data]).toEqual([170, 170, 170, 255, 255, 255, 255, 255]);
    fireEvent.change(screen.getByRole("slider", { name: "Preview Z" }), { target: { value: "0" } });
    expect([...graphics.paint.mock.lastCall![0].data]).toEqual([0, 0, 0, 255, 85, 85, 85, 255]);
    fireEvent.keyDown(screen.getByRole("region", { name: "Opening 3D preview" }), { key: "Escape" });
    expect(onHide).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000001");
    mounted.unmount();
    expect(graphics.removeVolume).toHaveBeenCalledOnce();
    expect(graphics.dispose).toHaveBeenCalledOnce();
  });

  it("uses the projected window only in 3D and paints XY with the worker window", async () => {
    const payload = twoPlanePreview();
    const original = structuredClone(payload);
    render(<VolumeOpeningPreview payload={payload} onHide={vi.fn()} />);
    await waitFor(() => expect(graphics.addVolume).toHaveBeenCalledOnce());
    const actor = graphics.addVolume.mock.calls[0][0];
    const colors = actor.getProperty().getRGBTransferFunction(0);
    expect(colors.getRedValue(100)).toBeCloseTo(0.5);
    expect(colors.getRedValue(200)).toBeCloseTo(1);
    const bound = actor.getMapper().getInputData().getPointData().getScalars().getData();
    expect(bound).toEqual(Uint8Array.from(Buffer.from(payload.context.data_base64, "base64")));

    fireEvent.click(screen.getByRole("button", { name: "XY slice" }));
    fireEvent.change(screen.getByRole("slider", { name: "Preview Z" }), { target: { value: "0" } });
    expect([...graphics.paint.mock.lastCall![0].data.slice(0, 4)]).toEqual([64, 64, 64, 255]);
    expect(payload).toEqual(original);
  });

  it("releases a failed graphics stage and dismisses it while verification continues", async () => {
    graphics.render.mockImplementationOnce(() => { throw new Error("Unavailable graphics context."); });
    const payload = preview();
    const onHide = vi.fn();
    render(<VolumeOpeningPreview payload={payload} onHide={onHide} />);
    await waitFor(() => expect(onHide).toHaveBeenCalledWith(payload.opening_id));
    expect(graphics.removeVolume).toHaveBeenCalledOnce();
    expect(graphics.dispose).toHaveBeenCalledOnce();
    expect(screen.queryByRole("region", { name: "Opening 3D preview" })).toBeNull();
  });

  it("fails open to verification without ever drawing a corrupt preview", async () => {
    const payload = preview();
    payload.context.data_sha256 = "0".repeat(64);
    const onHide = vi.fn();
    render(<VolumeOpeningPreview payload={payload} onHide={onHide} />);
    await waitFor(() => expect(onHide).toHaveBeenCalledWith(payload.opening_id));
    expect(graphics.addVolume).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Opening 3D preview" })).toBeNull();
  });
});
