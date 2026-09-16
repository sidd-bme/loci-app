// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const vtk = vi.hoisted(() => ({
  failInitialization: false,
  canvas: null as HTMLCanvasElement | null,
  render: vi.fn(),
  resetCamera: vi.fn(),
  resetCameraClippingRange: vi.fn(),
  azimuth: vi.fn(),
  elevation: vi.fn(),
  dolly: vi.fn(),
  orthogonalizeViewUp: vi.fn(),
  getPosition: vi.fn(() => [1, 2, 3]),
  getFocalPoint: vi.fn(() => [0, 0, 0]),
  getViewUp: vi.fn(() => [0, 1, 0]),
  getParallelScale: vi.fn(() => 4),
  getClippingRange: vi.fn(() => [0.1, 100]),
  getViewAngle: vi.fn(() => 30),
  getParallelProjection: vi.fn(() => false),
  setPosition: vi.fn(),
  setFocalPoint: vi.fn(),
  setViewUp: vi.fn(),
  setParallelScale: vi.fn(),
  addVolume: vi.fn(),
  addActor: vi.fn(),
  removeVolume: vi.fn(),
  removeActor: vi.fn(),
  resize: vi.fn(),
  deleted: vi.fn(),
  axesSetUserMatrix: vi.fn(),
  axesDelete: vi.fn(),
  orientationSetEnabled: vi.fn(),
  orientationUpdate: vi.fn(),
  orientationUpdateViewport: vi.fn(),
  orientationDelete: vi.fn(),
  interactorSetStyle: vi.fn(),
  interactorSetDesiredUpdateRate: vi.fn(),
  setContainer: vi.fn(),
  addMouseManipulator: vi.fn(),
  removeAllMouseManipulators: vi.fn(),
  interactorStyleDelete: vi.fn(),
  manipulatorDelete: vi.fn(),
  captureNextImage: vi.fn(),
}));

vi.mock("@kitware/vtk.js/Interaction/Style/InteractorStyleManipulator", () => ({
  default: {
    newInstance: () => ({
      addMouseManipulator: vtk.addMouseManipulator,
      removeAllMouseManipulators: vtk.removeAllMouseManipulators,
      delete: vtk.interactorStyleDelete,
    }),
  },
}));

vi.mock("@kitware/vtk.js/Interaction/Manipulators/MouseCameraTrackballPanManipulator", () => ({
  default: { newInstance: (values: unknown) => ({ values, delete: vtk.manipulatorDelete }) },
}));

vi.mock("@kitware/vtk.js/Interaction/Manipulators/MouseCameraTrackballRotateManipulator", () => ({
  default: { newInstance: (values: unknown) => ({ values, delete: vtk.manipulatorDelete }) },
}));

vi.mock("@kitware/vtk.js/Interaction/Manipulators/MouseCameraTrackballZoomManipulator", () => ({
  default: { newInstance: (values: unknown) => ({ values, delete: vtk.manipulatorDelete }) },
}));

vi.mock("@kitware/vtk.js/Rendering/Core/AxesActor", () => ({
  default: {
    newInstance: () => ({
      setUserMatrix: vtk.axesSetUserMatrix,
      delete: vtk.axesDelete,
    }),
  },
}));

vi.mock("@kitware/vtk.js/Interaction/Widgets/OrientationMarkerWidget", () => ({
  default: {
    newInstance: () => ({
      setEnabled: vtk.orientationSetEnabled,
      updateMarkerOrientation: vtk.orientationUpdate,
      updateViewport: vtk.orientationUpdateViewport,
      delete: vtk.orientationDelete,
    }),
  },
}));

vi.mock("@kitware/vtk.js/Rendering/Misc/GenericRenderWindow", () => ({
  default: {
    newInstance: () => {
      if (vtk.failInitialization) throw new Error("No compatible graphics device");
      vtk.canvas = document.createElement("canvas");
      vtk.canvas.width = 4;
      vtk.canvas.height = 3;
      let currentContainer: HTMLElement | null = null;
      return {
        setContainer: (container: HTMLElement) => {
          currentContainer = container;
          vtk.setContainer(container);
          if (vtk.canvas && container && !container.contains(vtk.canvas)) {
            container.append(vtk.canvas);
          }
        },
        getContainer: () => currentContainer,
        resize: vtk.resize,
        getRenderer: () => ({
          addVolume: vtk.addVolume,
          addActor: vtk.addActor,
          removeVolume: vtk.removeVolume,
          removeActor: vtk.removeActor,
          resetCamera: vtk.resetCamera,
          resetCameraClippingRange: vtk.resetCameraClippingRange,
          getActiveCamera: () => ({ azimuth: vtk.azimuth, elevation: vtk.elevation,
            dolly: vtk.dolly, orthogonalizeViewUp: vtk.orthogonalizeViewUp,
            getPosition: vtk.getPosition, getFocalPoint: vtk.getFocalPoint,
            getViewUp: vtk.getViewUp, getParallelScale: vtk.getParallelScale,
            getClippingRange: vtk.getClippingRange, getViewAngle: vtk.getViewAngle,
            getParallelProjection: vtk.getParallelProjection,
            setPosition: vtk.setPosition, setFocalPoint: vtk.setFocalPoint,
            setViewUp: vtk.setViewUp, setParallelScale: vtk.setParallelScale }),
        }),
        getRenderWindow: () => ({ render: vtk.render,
          getInteractor: () => ({ setInteractorStyle: vtk.interactorSetStyle, setDesiredUpdateRate: vtk.interactorSetDesiredUpdateRate }) }),
        getApiSpecificRenderWindow: () => ({ getCanvas: () => vtk.canvas,
          captureNextImage: vtk.captureNextImage }),
        delete: vtk.deleted,
      };
    },
  },
}));

import {
  RawVolumeViewport,
  type RawVolumePayload,
  type RawVolumeResponse,
} from "./RawVolumeViewport";

function context(): RawVolumePayload {
  return {
    schema_version: 1,
    role: "whole-volume-context",
    source_id: "source-1",
    source_sha256: "a".repeat(64),
    t: 0,
    level: 0,
    dimensions_xyz: [2, 1, 2],
    native_level_dimensions_xyz: [2, 1, 2],
    source_dimensions_xyz: [2, 1, 2],
    source_extent_xyzxyz: [0, 1, 0, 0, 0, 1],
    origin_xyz: [10, 20, 30],
    spacing_xyz: [0.4, 0.8, 2.5],
    direction_3x3: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    affine_4x4: [[0.4, 0, 0, 10], [0, 0.8, 0, 20], [0, 0, 2.5, 30], [0, 0, 0, 1]],
    unit: "um",
    frame: "image",
    scalar_type: "uint8",
    source_dtypes: ["uint8"],
    encoding_basis: "native-common-dtype",
    interleave: "voxel-major",
    components: [{
      channel_index: 0,
      name: "C1",
      color_rgb: [1, 1, 1],
      window: { low: 0, high: 255, gamma: 1 },
      opacity: 1,
      visible: true,
      opacity_points: [[0, 0], [255, 1]],
      provenance: { range: "native-dtype-range" },
    }],
    data_base64: "AAECAw==",
    data_sha256: "054edec1d0211f624fed0cbca9d4f9400b0e491c43742af2c5b0abebf0c990d8",
    byte_length: 4,
    sampling: {
      method: "nearest-whole-extent",
      source_indices_xyz: [[0, 1], [0], [0, 1]],
      level_zero_indices_xyz: [[0, 1], [0], [0, 1]],
      aggregate_budget_bytes: 128 * 1024 * 1024,
      estimated_aggregate_bytes: 18,
    },
    refinement: { available: false, maximum_target_long_axis: 256, focus_supported: true },
  };
}

function sparseContext(): RawVolumePayload {
  const value = context();
  value.native_level_dimensions_xyz = [4, 1, 4];
  value.source_dimensions_xyz = [4, 1, 4];
  value.source_extent_xyzxyz = [0, 3, 0, 0, 0, 3];
  value.spacing_xyz = [1.2, 0.8, 7.5];
  value.affine_4x4 = [[1.2, 0, 0, 10], [0, 0.8, 0, 20], [0, 0, 7.5, 30], [0, 0, 0, 1]];
  value.sampling.source_indices_xyz = [[0, 3], [0], [0, 3]];
  value.sampling.level_zero_indices_xyz = [[0, 3], [0], [0, 3]];
  return value;
}

function focusAt(low: 0 | 2): RawVolumePayload {
  const value = context();
  value.role = "level-zero-focus";
  value.native_level_dimensions_xyz = [4, 1, 4];
  value.source_dimensions_xyz = [4, 1, 4];
  value.source_extent_xyzxyz = [low, low + 1, 0, 0, low, low + 1];
  value.origin_xyz = [10 + low * 0.4, 20, 30 + low * 2.5];
  value.affine_4x4 = [[0.4, 0, 0, value.origin_xyz[0]], [0, 0.8, 0, 20], [0, 0, 2.5, value.origin_xyz[2]], [0, 0, 0, 1]];
  value.sampling.source_indices_xyz = [[low, low + 1], [0], [low, low + 1]];
  value.sampling.level_zero_indices_xyz = [[low, low + 1], [0], [low, low + 1]];
  return value;
}

describe("RawVolumeViewport lifecycle", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ({
      createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }),
      putImageData: vi.fn(),
    }) as unknown as CanvasRenderingContext2D);
    vtk.failInitialization = false;
    vtk.captureNextImage.mockResolvedValue("data:image/png;base64,iVBORw0KGgo=");
    const digest = "054edec1d0211f624fed0cbca9d4f9400b0e491c43742af2c5b0abebf0c990d8";
    Object.defineProperty(globalThis, "crypto", {
      value: {
        subtle: {
          digest: async () => Uint8Array.from(
            digest.match(/../g)!.map((value) => Number.parseInt(value, 16)),
          ).buffer,
        },
      },
      configurable: true,
    });
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }) as typeof requestAnimationFrame;
  });

  it("reports graphics initialization failure inside the viewport", async () => {
    vtk.failInitialization = true;
    render(<RawVolumeViewport volume={{ schema_version: 1, context: context(), focus: null }} />);
    expect(await screen.findByText("No compatible graphics device")).toBeTruthy();
  });

  it("links three verified slice panes and expands/restores each without recreating the 3D camera", async () => {
    const rendered = render(<RawVolumeViewport volume={{ schema_version: 1, context: context(), focus: null }} />);
    await screen.findByLabelText("XY plane resliced image");
    expect(screen.getByLabelText("XZ plane resliced image")).toBeTruthy();
    expect(screen.getByLabelText("YZ plane resliced image")).toBeTruthy();
    const stage = screen.getByLabelText("Interactive three-dimensional volume");
    expect(stage.contains(vtk.canvas)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Expand XY plane view" }));
    expect(rendered.container.querySelector(".raw-volume")?.getAttribute("data-expanded-pane")).toBe("axial");
    expect(rendered.container.querySelector(".mpr-pane-volume")?.hasAttribute("hidden")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Restore XY plane view" }));
    expect(rendered.container.querySelector(".mpr-pane-volume")?.hasAttribute("hidden")).toBe(false);
    expect(stage.contains(vtk.canvas)).toBe(true);
    fireEvent.keyDown(screen.getByLabelText("XY plane slice navigation"), { key: "ArrowDown" });
    expect(screen.getByLabelText("Z source index").textContent).toBe("0");
    fireEvent.click(screen.getByRole("button", { name: /^3D view$/ }));
    expect(screen.queryByLabelText("XY plane resliced image")).toBeNull();
    expect(screen.getByLabelText("Interactive three-dimensional volume").contains(vtk.canvas)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Four panes" }));
    await screen.findByLabelText("XY plane resliced image");
    expect(screen.getByLabelText("Interactive three-dimensional volume").contains(vtk.canvas)).toBe(true);
    expect(vtk.resetCamera).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Swap 3D view position" }));
    expect(screen.getByLabelText("Interactive three-dimensional volume").contains(vtk.canvas)).toBe(true);
    rendered.rerender(<RawVolumeViewport volume={null} />);
    expect(screen.queryByLabelText("XY plane resliced image")).toBeNull();
  });

  it("keeps the user in Whole for an excluding delayed focus and returns there when the crosshair leaves", async () => {
    const whole = sparseContext();
    const rendered = render(<RawVolumeViewport volume={{ schema_version: 1, context: whole, focus: null }} />);
    await screen.findByLabelText("XY plane resliced image");
    expect(screen.getByLabelText("X source index").textContent).toBe("3");

    rendered.rerender(<RawVolumeViewport volume={{ schema_version: 1, context: whole, focus: focusAt(0) }} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Whole" }).getAttribute("aria-pressed")).toBe("true"));
    expect(rendered.container.querySelector(".raw-volume")?.getAttribute("data-active-view")).toBe("whole-volume-context");
    expect(screen.getByLabelText("X source index").textContent).toBe("3");

    rendered.rerender(<RawVolumeViewport volume={{ schema_version: 1, context: whole, focus: focusAt(2) }} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Focus" }).getAttribute("aria-pressed")).toBe("true"));
    expect(rendered.container.querySelector(".raw-volume")?.getAttribute("data-active-view")).toBe("level-zero-focus");
    fireEvent.change(screen.getByRole("slider", { name: "X slice" }), { target: { value: "0" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Whole" }).getAttribute("aria-pressed")).toBe("true"));
    expect(screen.getByLabelText("X source index").textContent).toBe("0");
    expect(screen.getByRole("button", { name: "Focus" }).hasAttribute("disabled")).toBe(true);
    expect(rendered.container.querySelector(".raw-volume")?.getAttribute("data-active-view")).toBe("whole-volume-context");
  });

  it("starts automatic refinement only after the coarse context is bound", async () => {
    const coarse = context();
    coarse.refinement = { available: true, maximum_target_long_axis: 256, focus_supported: true };
    const request = vi.fn();
    render(<RawVolumeViewport volume={{ schema_version: 1, context: coarse, focus: null }}
      onRequestRefinement={request} />);
    expect(request).not.toHaveBeenCalled();
    await waitFor(() => expect(vtk.addVolume).toHaveBeenCalledTimes(1));
    expect(request).not.toHaveBeenCalled();
    await waitFor(() => expect(request).toHaveBeenCalledWith({ target_long_axis: 128 }), { timeout: 1_500 });
  });

  it("keeps controls and camera state across verified refinement and reports context recovery", async () => {
    const initial: RawVolumeResponse = { schema_version: 1, context: context(), focus: null };
    const rendered = render(<RawVolumeViewport volume={initial} />);
    await waitFor(() => expect(vtk.resetCamera).toHaveBeenCalledTimes(1));
    expect(vtk.render).toHaveBeenCalled();
    expect(vtk.addMouseManipulator.mock.calls.slice(0, 4).map(([item]) => item.values)).toEqual([
      { button: 1 },
      { button: 3 },
      { button: 1, shift: true },
      { dragEnabled: false, scrollEnabled: true },
    ]);
    expect(vtk.interactorSetStyle).toHaveBeenCalled();
    expect(vtk.axesSetUserMatrix).toHaveBeenCalledWith([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ]);
    expect(vtk.orientationSetEnabled).toHaveBeenCalledWith(true);
    expect(vtk.orientationUpdateViewport).toHaveBeenCalled();
    const volumeActor = vtk.addVolume.mock.calls[0][0];
    await waitFor(() => expect(volumeActor.getProperty().getRGBTransferFunction(0)).toBeTruthy());
    const volumeMidpointColor = [0, 0, 0];
    volumeActor.getProperty().getRGBTransferFunction(0).getColor(127.5, volumeMidpointColor);
    expect(volumeMidpointColor).toEqual([1, 1, 1]);
    expect(volumeActor.getProperty().getScalarOpacityUnitDistance(0)).toBeCloseTo(
      Math.hypot(0.4, 2.5) / 2,
    );

    fireEvent.keyDown(screen.getByLabelText("Interactive three-dimensional volume"), { key: "ArrowLeft" });
    expect(vtk.azimuth).toHaveBeenCalledWith(-5);
    fireEvent.click(screen.getByRole("button", { name: "Reset camera" }));
    expect(vtk.resetCamera).toHaveBeenCalledTimes(1);
    expect(vtk.setPosition).toHaveBeenCalledWith(1, 2, 3);
    expect(vtk.setFocalPoint).toHaveBeenCalledWith(0, 0, 0);
    expect(vtk.setViewUp).toHaveBeenCalledWith(0, 1, 0);
    expect(vtk.setParallelScale).toHaveBeenCalledWith(4);

    fireEvent.click(screen.getByRole("button", { name: "MPR" }));
    const sliceActor = vtk.addActor.mock.calls[0][0];
    await waitFor(() => expect(sliceActor.getVisibility()).toBe(true));
    const sliceMidpointColor = [0, 0, 0];
    sliceActor.getProperty().getRGBTransferFunction(0).getColor(127.5, sliceMidpointColor);
    expect(sliceMidpointColor).toEqual([0.5, 0.5, 0.5]);
    fireEvent.click(screen.getByRole("checkbox", { name: "Clip" }));
    const opacity = screen.getByRole("slider", { name: "C1 opacity" }) as HTMLInputElement;
    fireEvent.change(opacity, { target: { value: "0.25" } });
    fireEvent.change(screen.getByLabelText("C1 colour"), { target: { value: "#336699" } });
    const low = screen.getByLabelText("C1 low") as HTMLInputElement;
    fireEvent.change(low, { target: { value: "12" } });
    fireEvent.blur(low);
    const gamma = screen.getByLabelText("C1 gamma") as HTMLInputElement;
    fireEvent.change(gamma, { target: { value: "1.7" } });
    fireEvent.blur(gamma);

    rendered.rerender(
      <RawVolumeViewport volume={{ ...initial, context: { ...initial.context } }} />,
    );
    await waitFor(() => expect(vtk.removeVolume).toHaveBeenCalled());
    expect(vtk.resetCamera).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("slider", { name: "C1 opacity" }) as HTMLInputElement).value).toBe("0.25");
    expect((screen.getByLabelText("C1 colour") as HTMLInputElement).value).toBe("#336699");
    expect((screen.getByLabelText("C1 low") as HTMLInputElement).value).toBe("12");
    expect((screen.getByLabelText("C1 gamma") as HTMLInputElement).value).toBe("1.7");

    vtk.canvas!.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    expect(await screen.findByText(/Graphics context lost/)).toBeTruthy();
    const lostCanvas = vtk.canvas;
    const priorAddVolumeCalls = vtk.addVolume.mock.calls.length;
    const priorSetPositionCalls = vtk.setPosition.mock.calls.length;
    vtk.canvas!.dispatchEvent(new Event("webglcontextrestored"));
    expect(await screen.findByText(/source voxels/)).toBeTruthy();
    expect(vtk.canvas).not.toBe(lostCanvas);
    expect(vtk.addVolume.mock.calls.length).toBeGreaterThan(priorAddVolumeCalls);
    expect(vtk.setPosition.mock.calls.length).toBeGreaterThan(priorSetPositionCalls);
  });

  it("shows focus separately and applies one context-world clipping plane to both payloads", async () => {
    const whole = context();
    const focus = { ...context(), role: "level-zero-focus" as const,
      source_extent_xyzxyz: [0, 1, 0, 0, 0, 1] as [number, number, number, number, number, number] };
    const rendered = render(<RawVolumeViewport volume={{ schema_version: 1, context: whole, focus: null }} />);
    await waitFor(() => expect(vtk.addVolume).toHaveBeenCalledTimes(1));
    rendered.rerender(<RawVolumeViewport volume={{ schema_version: 1, context: whole, focus }} />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Focus" }).getAttribute("aria-pressed")).toBe("true");
      expect(vtk.addVolume).toHaveBeenCalledTimes(3);
    });
    const activeActors = vtk.addVolume.mock.calls.slice(-2).map(([actor]) => actor);
    await waitFor(() => expect(activeActors.map((actor) => actor.getVisibility())).toEqual([false, true]));

    fireEvent.click(screen.getByRole("checkbox", { name: "Clip" }));
    await waitFor(() => {
      const planes = activeActors.map((actor) => actor.getMapper().getClippingPlanes());
      expect(planes[0]).toHaveLength(1);
      expect(planes[1]).toHaveLength(1);
      expect(planes[0][0]).toBe(planes[1][0]);
    });
    fireEvent.click(screen.getByRole("button", { name: "Whole" }));
    expect(activeActors.map((actor) => actor.getVisibility())).toEqual([true, false]);

    rendered.rerender(<RawVolumeViewport volume={null} />);
    await waitFor(() => expect(activeActors.map((actor) => actor.getVisibility())).toEqual([false, false]));
  });

  it("keeps a bounded whole-context histogram and only changes its window on an explicit action", async () => {
    const whole = context();
    const focus = { ...context(), role: "level-zero-focus" as const };
    const rendered = render(<RawVolumeViewport volume={{ schema_version: 1, context: whole, focus: null }} />);

    expect(await screen.findByRole("img", { name: "C1 whole-context display volume histogram" })).toBeTruthy();
    expect(screen.getByText(/Whole-context display sample/).textContent).toMatch(/level 0.*T 0.*4 values/);
    fireEvent.click(screen.getByRole("button", { name: "Trim 1–99%" }));
    await waitFor(() => expect(rendered.container.querySelector(".raw-volume")
      ?.getAttribute("data-transfer-ranges")).toBe("0:3"));

    rendered.rerender(<RawVolumeViewport volume={{ schema_version: 1, context: whole, focus }} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Focus" })
      .getAttribute("aria-pressed")).toBe("true"));
    expect(rendered.container.querySelector(".raw-volume")
      ?.getAttribute("data-transfer-ranges")).toBe("0:3");
    expect(screen.getByText(/Whole-context display sample/).textContent).toMatch(/level 0.*T 0.*4 values/);
  });

  it("captures the native vtk canvas and sends exact display provenance only on user action", async () => {
    const exportFigure = vi.fn().mockResolvedValue({
      basename: "Figure.loci-figure",
      width: 4,
      height: 3,
      hashes: { "image.png": "b".repeat(64), "manifest.json": "c".repeat(64) },
    });
    render(<RawVolumeViewport volume={{ schema_version: 1, context: context(), focus: null }}
      onExportFigure={exportFigure} />);
    expect(exportFigure).not.toHaveBeenCalled();
    await waitFor(() => expect(vtk.addVolume).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "MPR" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Clip" }));
    fireEvent.click(screen.getByRole("button", { name: "Export PNG…" }));

    await waitFor(() => expect(exportFigure).toHaveBeenCalledTimes(1));
    expect(vtk.captureNextImage).toHaveBeenCalledWith("image/png", {
      resetCamera: false,
      size: null,
      scale: 1,
    });
    const request = exportFigure.mock.calls[0][0];
    expect(request).toMatchObject({
      schema_version: "loci.volume-figure-request/v1",
      source_id: "source-1",
      source_sha256: "a".repeat(64),
      width_px: 4,
      height_px: 3,
      png_base64: "iVBORw0KGgo=",
      manifest: {
        figure: { kind: "screen-resolution-rendered-figure", capture_scale: 1 },
        representation: { mode: "mpr", extent: "context", shading: false },
        camera: { projection: "perspective", parallel_scale: null },
        clipping: { enabled: true, axis: "z", position_percent: 50 },
        mpr: {
          context_display_indices_xyz: [1, 0, 1],
          active_payload_indices_xyz: [1, 0, 1],
          source_indices_xyz: [1, 0, 1],
        },
        provenance: { screen_resolution_only: true, scale_bar_included: false,
          high_resolution_claim: false, biological_or_clinical_validation_claim: false },
      },
    });
    expect(JSON.stringify(request.manifest)).not.toContain("data_base64");
    expect(JSON.stringify(request.manifest)).not.toContain("AAECAw==");
    expect((await screen.findByText("Saved 4 × 3 · Figure.loci-figure")).classList)
      .toContain("raw-volume-export-status");
  });

  it("exports the actual optional shading with fixed lighting and no intensity-dependent gradient filter", async () => {
    const exportFigure = vi.fn().mockResolvedValue(null);
    render(<RawVolumeViewport volume={{ schema_version: 1, context: context(), focus: null }} onExportFigure={exportFigure} />);
    await waitFor(() => expect(vtk.addVolume).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText("3D rendering mode"), { target: { value: "normal_shading" } });
    fireEvent.click(screen.getByRole("button", { name: "Export PNG…" }));
    await waitFor(() => expect(exportFigure).toHaveBeenCalledOnce());
    expect(exportFigure.mock.calls[0][0].manifest.representation).toMatchObject({
      mode: "volume",
      shading: true,
      blend_mode: "normal_shading",
      quality: 50,
      lighting: { ambient: 0.22, diffuse: 0.68, specular: 0.25, specular_power: 20, gradient_opacity: false },
    });
  });

  it("updates 3D rendering mode to MIP and adjusts quality slider sampling distance", async () => {
    const exportFigure = vi.fn().mockResolvedValue(null);
    render(<RawVolumeViewport volume={{ schema_version: 1, context: context(), focus: null }} onExportFigure={exportFigure} />);
    await waitFor(() => expect(vtk.addVolume).toHaveBeenCalledTimes(1));
    const volumeActor = vtk.addVolume.mock.calls[0][0];

    // Switch to MIP mode
    fireEvent.change(screen.getByLabelText("3D rendering mode"), { target: { value: "mip" } });
    expect(volumeActor.getProperty().getShade?.()).toBe(false);

    // Change quality slider from 50 to 80
    const qualitySlider = screen.getByRole("slider", { name: "3D rendering quality" });
    fireEvent.change(qualitySlider, { target: { value: "80" } });
    expect(screen.getByText("80%")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Export PNG…" }));
    await waitFor(() => expect(exportFigure).toHaveBeenCalledOnce());
    expect(exportFigure.mock.calls[0][0].manifest.representation).toMatchObject({
      mode: "volume",
      shading: false,
      blend_mode: "mip",
      quality: 80,
    });
  });

  it("binds the VTK generic render window to the stage container and keeps canvas attached across layout changes", async () => {
    const { container } = render(<RawVolumeViewport volume={{ schema_version: 1, context: context(), focus: null }} />);
    await waitFor(() => expect(vtk.addVolume).toHaveBeenCalledTimes(1));
    const stage = container.querySelector(".raw-volume-stage");
    expect(stage).toBeTruthy();
    expect(vtk.setContainer).toHaveBeenCalledWith(stage);
    expect(stage?.querySelector("canvas")).toBe(vtk.canvas);

    // Toggle between 4-pane and single-view layout
    const layoutGroup = screen.getByRole("group", { name: "Volume layout" });
    const singleButton = within(layoutGroup).getByRole("button", { name: "3D view" });
    fireEvent.click(singleButton);
    await waitFor(() => expect(vtk.resize).toHaveBeenCalled());
    expect(stage?.querySelector("canvas")).toBe(vtk.canvas);

    const fourButton = within(layoutGroup).getByRole("button", { name: "Four panes" });
    fireEvent.click(fourButton);
    await waitFor(() => expect(vtk.resize).toHaveBeenCalled());
    expect(stage?.querySelector("canvas")).toBe(vtk.canvas);
  });
});
