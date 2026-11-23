// @vitest-environment jsdom
import { createHash, webcrypto } from "node:crypto";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IMouseCameraTrackballRotateManipulatorInitialValues } from "@kitware/vtk.js/Interaction/Manipulators/MouseCameraTrackballRotateManipulator";
import type vtkCamera from "@kitware/vtk.js/Rendering/Core/Camera";
import type vtkRenderer from "@kitware/vtk.js/Rendering/Core/Renderer";
import type vtkRenderWindowInteractor from "@kitware/vtk.js/Rendering/Core/RenderWindowInteractor";
import type { vtkGenericRenderWindow } from "@kitware/vtk.js/Rendering/Misc/GenericRenderWindow";
import type { VolumeSceneAdapter } from "./volume-scene-types";
import { controlAnimationFrames, headlessVtkWindow } from "./test/vtk-lifecycle";

const vtk = vi.hoisted(() => ({
  headlessWindows: null as vtkGenericRenderWindow[] | null,
  failInitialization: false,
  canvas: null as HTMLCanvasElement | null,
  render: vi.fn(),
  resetCamera: vi.fn(),
  actualCamera: null as vtkCamera | null,
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
  setParallelProjection: vi.fn(),
  setViewAngle: vi.fn(),
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
      getInteractor: () => null,
      setInteractor: vi.fn(),
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

vi.mock("@kitware/vtk.js/Rendering/Misc/GenericRenderWindow", async (importOriginal) => {
  const { default: vtkWindow } = await importOriginal<typeof import("@kitware/vtk.js/Rendering/Misc/GenericRenderWindow")>();
  return { default: {
    newInstance: (options: Parameters<typeof vtkWindow.newInstance>[0]) => {
      if (vtk.failInitialization) throw new Error("No compatible graphics device");
      if (vtk.headlessWindows) {
        const generic = headlessVtkWindow(vtkWindow, options);
        vtk.headlessWindows.push(generic);
        return generic;
      }
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
          getActiveCamera: () => (vtk.actualCamera ?? { azimuth: vtk.azimuth, elevation: vtk.elevation,
            dolly: vtk.dolly, orthogonalizeViewUp: vtk.orthogonalizeViewUp,
            getPosition: vtk.getPosition, getFocalPoint: vtk.getFocalPoint,
            getViewUp: vtk.getViewUp, getParallelScale: vtk.getParallelScale,
            getClippingRange: vtk.getClippingRange, getViewAngle: vtk.getViewAngle,
            getParallelProjection: vtk.getParallelProjection,
            setPosition: vtk.setPosition, setFocalPoint: vtk.setFocalPoint,
            setViewUp: vtk.setViewUp, setParallelScale: vtk.setParallelScale,
            setParallelProjection: vtk.setParallelProjection, setViewAngle: vtk.setViewAngle }),
        }),
        getRenderWindow: () => ({ render: vtk.render,
          getInteractor: () => ({ setInteractorStyle: vtk.interactorSetStyle, setDesiredUpdateRate: vtk.interactorSetDesiredUpdateRate,
            switchToXRAnimation: vi.fn(), delete: vi.fn() }) }),
        getApiSpecificRenderWindow: () => ({ getCanvas: () => vtk.canvas,
          captureNextImage: vtk.captureNextImage }),
        delete: vtk.deleted,
      };
    },
  } };
});

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

  it("round-trips a shared scene only after verified rendering and keeps its locked human epoch", async () => {
    const handle: { current: VolumeSceneAdapter | null } = { current: null };
    const volume = { schema_version: 1 as const, context: sparseContext(), focus: null };
    render(<RawVolumeViewport volume={volume} sceneHandleRef={handle} />);
    await waitFor(() => expect(handle.current?.snapshot()?.available).toBe(true));
    const before = handle.current!.snapshot()!;
    const target = structuredClone(before.state);
    target.crosshair_source_xyz = [1, 0, 2]; target.layout.col_split = 60;
    target.clipping = { enabled: true, axis: "x", position_percent: 35 };
    target.representation.render_mode = "mip";
    await expect(handle.current!.apply(target)).rejects.toThrow(/locked/);
    act(() => handle.current!.lock(true));
    let applied!: Promise<void>;
    act(() => { applied = handle.current!.apply(target); });
    await act(async () => { await applied; });
    expect(handle.current!.snapshot()?.state).toEqual(target);
    expect(handle.current!.snapshot()?.liveEpoch).toBe(before.liveEpoch);
    act(() => handle.current!.lock(false));
    fireEvent.change(screen.getByLabelText("Z slice"), { target: { value: "1" } });
    expect(handle.current!.snapshot()?.state.crosshair_source_xyz).toEqual([1, 0, 1]);
    expect(handle.current!.snapshot()!.liveEpoch).toBeGreaterThan(before.liveEpoch);
    act(() => handle.current!.lock(true));
    await expect(handle.current!.apply({ ...target, channels: [3] })).rejects.toThrow(/exact source/);
    act(() => handle.current!.lock(false));
  });

  it("withdraws shared availability on context loss and refuses hidden-pane capture", async () => {
    const handle: { current: VolumeSceneAdapter | null } = { current: null };
    render(<RawVolumeViewport volume={{ schema_version: 1, context: context(), focus: null }} sceneHandleRef={handle} />);
    await waitFor(() => expect(handle.current?.snapshot()?.available).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: /^3D view$/ }));
    act(() => handle.current!.lock(true));
    await expect(handle.current!.capture(["axial"], 512)).rejects.toThrow(/hidden/);
    act(() => { vtk.canvas!.dispatchEvent(new Event("webglcontextlost", { cancelable: true })); });
    expect(handle.current!.snapshot()).toBeNull();
  });
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

  it("keeps primary volume actions visible and advanced settings collapsed until requested", async () => {
    const display = vi.fn(), refine = vi.fn();
    render(<RawVolumeViewport volume={{ schema_version: 1, context: context(), focus: null }}
      onDisplayChange={display} onRequestRefinement={refine} />);
    await waitFor(() => expect(vtk.addVolume).toHaveBeenCalledOnce());
    const initialCameraResets = vtk.resetCamera.mock.calls.length;
    expect(screen.getByRole("button", { name: "Four panes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reset camera" })).toBeTruthy();
    expect(screen.getByLabelText("3D rendering mode")).toBeTruthy();
    const summary = screen.getByText("Rendering & detail", { exact: true });
    const disclosure = summary.closest("details")!;
    expect(disclosure.open).toBe(false);
    expect(screen.getByLabelText("3D rendering quality").closest("details")).toBe(disclosure);
    expect(screen.getByLabelText("Detail span").closest("details")).toBe(disclosure);
    fireEvent.click(summary);
    expect(disclosure.open).toBe(true);
    fireEvent.change(screen.getByRole("slider", { name: "3D rendering quality" }), { target: { value: "80" } });
    expect(display).toHaveBeenCalledWith(expect.objectContaining({ quality: 80 }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Clip" }));
    fireEvent.click(summary);
    expect(disclosure.open).toBe(false);
    expect(screen.getByText(/Clip Z ·/)).toBeTruthy();
    expect(vtk.resetCamera).toHaveBeenCalledTimes(initialCameraResets);
  });

  it("requests a wide native field with a bounded 64-plane depth", async () => {
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
    const value = context();
    value.native_level_dimensions_xyz = value.source_dimensions_xyz = [320, 310, 90];
    value.dimensions_xyz = [2, 2, 2];
    value.source_extent_xyzxyz = [0, 319, 0, 309, 0, 89];
    value.sampling.source_indices_xyz = value.sampling.level_zero_indices_xyz = [[0, 319], [0, 309], [0, 89]];
    value.data_base64 = "AAAAAAAAAAA=";
    value.data_sha256 = "af5570f5a1810b7af78caf4bc70a660f0df51e42baf91d4de5b2328de0e83dfc";
    value.byte_length = 8;
    value.sampling.estimated_aggregate_bytes = 35;
    const refine = vi.fn();
    render(<RawVolumeViewport volume={{ schema_version: 1, context: value, focus: null }} onRequestRefinement={refine} />);
    await waitFor(() => expect(vtk.addVolume).toHaveBeenCalled());
    fireEvent.click(screen.getByText("Rendering & detail", { exact: true }));
    fireEvent.change(screen.getByLabelText("Detail span"), { target: { value: "wide" } });
    fireEvent.click(screen.getByRole("button", { name: "Detail at crosshair" }));
    const { focus_region_xyzxyz: [x0, x1, y0, y1, z0, z1], target_long_axis } = refine.mock.lastCall![0];
    expect(target_long_axis).toBe(256);
    expect([x1 - x0 + 1, y1 - y0 + 1, z1 - z0 + 1]).toEqual([256, 256, 64]);
    expect(x0 >= 0 && x1 < 320 && y0 >= 0 && y1 < 310 && z0 >= 0 && z1 < 90).toBe(true);
  });

  it("keeps interaction help outside the image canvases and preserves per-plane sampling context", async () => {
    render(<RawVolumeViewport volume={{ schema_version: 1, context: context(), focus: null }} />);
    await waitFor(() => expect(vtk.addVolume).toHaveBeenCalledOnce());
    const initialCameraResets = vtk.resetCamera.mock.calls.length;
    const summary = screen.getByText("Controls & sampling", { exact: true });
    expect(summary.closest("details")!.open).toBe(false);
    expect(within(screen.getByLabelText("Interactive three-dimensional volume")).queryByText(/Left-drag/)).toBeNull();
    expect(screen.getByLabelText("3D display sampling").textContent).toContain("Rotating source XYZ axes · image frame");
    for (const plane of ["XY plane", "XZ plane", "YZ plane"]) {
      expect(screen.getByLabelText(`${plane} sampling`).textContent).toBe("Raw: linear · L0");
    }
    fireEvent.click(summary);
    expect(summary.closest("details")!.open).toBe(true);
    expect(screen.getByText(/Drag the crosshair/)).toBeTruthy();
    expect(screen.getByText(/resliced display samples, not native measurements/)).toBeTruthy();
    expect(vtk.resetCamera).toHaveBeenCalledTimes(initialCameraResets);
  });

  it("reports graphics initialization failure inside the viewport", async () => {
    vtk.failInitialization = true;
    render(<RawVolumeViewport volume={{ schema_version: 1, context: context(), focus: null }} />);
    expect(await screen.findByText("No compatible graphics device")).toBeTruthy();
  });

  it.each([
    { name: "left drag", button: 1, alt: false },
    { name: "middle drag", button: 2, alt: false },
    { name: "Alt-left drag", button: 1, alt: true },
  ])("keeps fractional $name centered on the current off-origin focal point, including after pan", async ({ button, alt }) => {
    render(<RawVolumeViewport volume={{ schema_version: 1, context: context(), focus: null }} />);
    // Exercise the real locked VTK implementation with the viewport's actual
    // constructor settings. The lifecycle harness replaces only the GPU scene.
    const { default: vtkCamera } = await vi.importActual<typeof import("@kitware/vtk.js/Rendering/Core/Camera")>("@kitware/vtk.js/Rendering/Core/Camera");
    const { default: vtkRotate } = await vi.importActual<typeof import("@kitware/vtk.js/Interaction/Manipulators/MouseCameraTrackballRotateManipulator")>("@kitware/vtk.js/Interaction/Manipulators/MouseCameraTrackballRotateManipulator");
    const { default: vtkPan } = await vi.importActual<typeof import("@kitware/vtk.js/Interaction/Manipulators/MouseCameraTrackballPanManipulator")>("@kitware/vtk.js/Interaction/Manipulators/MouseCameraTrackballPanManipulator");
    const settings = vtk.addMouseManipulator.mock.calls.map(([manipulator]) =>
      manipulator.values as IMouseCameraTrackballRotateManipulatorInitialValues);
    const rotateSettings = settings.find((values) => values.button === button &&
      Boolean(values.alt) === alt && !values.shift && !values.control && values.dragEnabled !== false);
    expect(rotateSettings).toBeDefined();
    const rotate = vtkRotate.newInstance(rotateSettings);
    const camera = vtkCamera.newInstance({
      focalPoint: [1024.5, -512.25, 7.75],
      position: [1024.5, -512.25, 130.875],
      viewUp: [0, 1, 0],
      parallelScale: 40,
    });
    const renderer = {
      getActiveCamera: () => camera,
      resetCameraClippingRange: vi.fn(),
    } as unknown as vtkRenderer;
    const interactor = {
      getView: () => ({ getViewportSize: () => [1024, 768] }),
      getLightFollowCamera: () => false,
    } as unknown as vtkRenderWindowInteractor;
    const distance = () => Math.hypot(...camera.getPosition().map((value, axis) => value - camera.getFocalPoint()[axis]));
    const expectCentered = (focalPoint: number[], radius: number) => {
      camera.getFocalPoint().forEach((value, axis) => expect(value).toBeCloseTo(focalPoint[axis], 9));
      expect(distance()).toBeCloseTo(radius, 9);
      expect([...camera.getPosition(), ...camera.getViewUp()].every(Number.isFinite)).toBe(true);
      expect(Math.hypot(...camera.getViewUp())).toBeCloseTo(1, 10);
      const direction = camera.getDirectionOfProjection();
      expect(camera.getViewUp().reduce((sum, value, axis) => sum + value * direction[axis], 0)).toBeCloseTo(0, 10);
    };
    try {
      const initialFocal = [...camera.getFocalPoint()];
      const initialRadius = distance();
      rotate.onButtonDown(interactor, renderer, { x: 512, y: 384 });
      rotate.onMouseMove(interactor, renderer, { x: 512.25, y: 384 });
      expectCentered(initialFocal, initialRadius);
      // Independent trigonometric oracle also rejects a no-op or rounded drag.
      const angle = -2 * Math.PI * 0.25 / 1024;
      expect(camera.getPosition()[0]).toBeCloseTo(initialFocal[0] + initialRadius * Math.sin(angle), 9);
      expect(camera.getPosition()[2]).toBeCloseTo(initialFocal[2] + initialRadius * Math.cos(angle), 9);
      for (let step = 2; step <= 32; step += 1) {
        rotate.onMouseMove(interactor, renderer, { x: 512 + step * 0.25, y: 384 + (step - 1) * 0.125 });
        expectCentered(initialFocal, initialRadius);
      }

      // Real VTK parallel pan translates both camera and focal point. Switch
      // back to the viewport's perspective projection before the next orbit.
      for (const panSettings of settings.filter((values) => values.shift || (values.button === 3 && !values.control))) {
        const pan = vtkPan.newInstance(panSettings);
        try {
          const beforePan = [...camera.getFocalPoint()];
          camera.setParallelProjection(true);
          pan.onButtonDown(interactor, renderer, { x: 512, y: 384 });
          pan.onMouseMove(interactor, renderer, { x: 544.5, y: 368.75 });
          camera.setParallelProjection(false);
          const pannedFocal = [...camera.getFocalPoint()];
          expect(Math.hypot(...pannedFocal.map((value, axis) => value - beforePan[axis]))).toBeGreaterThan(1);
          expect(distance()).toBeCloseTo(initialRadius, 9);
          const beforeOrbit = [...camera.getPosition()];
          // The real interactor style sets its default center on each press.
          // The rotate option must follow the current focal point nonetheless.
          rotate.setCenter(0, 0, 0);
          rotate.onButtonDown(interactor, renderer, { x: 512, y: 384 });
          for (let step = 1; step <= 32; step += 1) {
            rotate.onMouseMove(interactor, renderer, { x: 512 + step * 0.25, y: 384 + step * 0.125 });
            expectCentered(pannedFocal, initialRadius);
          }
          expect(camera.getPosition()).not.toEqual(beforeOrbit);
        } finally { pan.delete(); }
      }
    } finally { rotate.delete(); camera.delete(); }
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

  it("picks source coordinates through a translated pyramid and records the rendered MPR sample", async () => {
    const coarse = context();
    coarse.level = 1;
    coarse.source_dimensions_xyz[0] = 5;
    coarse.origin_xyz[0] = 10.5;
    coarse.spacing_xyz[0] = 0.8;
    coarse.affine_4x4[0] = [0.8, 0, 0, 10.5];
    coarse.sampling.method = "nearest-whole-extent-ngff-transform";
    coarse.sampling.level_zero_indices_xyz[0] = [1, 3];
    coarse.sampling.level_zero_index_transform = { scale_xyz: [2, 1, 1], translation_xyz: [1.25, 0, 0] };
    const exportFigure = vi.fn().mockResolvedValue(null);
    render(<RawVolumeViewport volume={{ schema_version: 1, context: coarse, focus: null }}
      onExportFigure={exportFigure} />);
    const canvas = await screen.findByLabelText("XY plane resliced image");
    expect(screen.getByLabelText("X source index").textContent).toBe("3");
    expect(screen.getByText(/World 11.200, 20.000, 32.500 um/)).toBeTruthy();

    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 100, 100));
    const pick = new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 50, clientY: 50 });
    fireEvent(canvas, pick);
    expect(screen.getByLabelText("X source index").textContent).toBe("2");
    expect(screen.getByText(/World 10.800, 20.000, 32.500 um/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "MPR" }));
    fireEvent.click(screen.getByRole("button", { name: "Export PNG…" }));
    await waitFor(() => expect(exportFigure).toHaveBeenCalledOnce());
    expect(exportFigure.mock.calls[0][0].manifest).toMatchObject({
      payloads: { context: { sampling: { level_zero_index_transform: coarse.sampling.level_zero_index_transform } } },
      mpr: {
        context_display_indices_xyz: [0, 0, 1],
        active_payload_indices_xyz: [0, 0, 1],
        source_indices_xyz: [1, 0, 1],
        world_xyz: [10.5, 20, 32.5],
      },
    });
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

  it("fits the active focus actor and retains independent orbit, zoom, and display settings", async () => {
    const { default: VtkRenderer } = await vi.importActual<
      typeof import("@kitware/vtk.js/Rendering/Core/Renderer")
    >("@kitware/vtk.js/Rendering/Core/Renderer");
    const renderer = VtkRenderer.newInstance();
    const camera = renderer.getActiveCamera();
    vtk.actualCamera = camera;
    vtk.resetCamera.mockImplementation(renderer.resetCamera);
    const pose = () => ({
      position: [...camera.getPosition()], focal: [...camera.getFocalPoint()],
      up: [...camera.getViewUp()], scale: camera.getParallelScale(), angle: camera.getViewAngle(),
    });
    const distance = () => Math.hypot(...camera.getPosition().map((n, axis) => n - camera.getFocalPoint()[axis]));
    const whole = sparseContext();
    const focus = focusAt(2);

    try {
      const rendered = render(<RawVolumeViewport volume={{ schema_version: 1, context: whole, focus: null }} />);
      await waitFor(() => expect(vtk.resetCamera).toHaveBeenCalledTimes(1));
      const wholeActor = vtk.addVolume.mock.calls[0][0];
      expect(vtk.resetCamera).toHaveBeenLastCalledWith(wholeActor.getBounds());
      camera.azimuth(24); camera.dolly(1.25);
      const wholePose = pose(), wholeDistance = distance();
      const direction = [...camera.getDirectionOfProjection()];

      rendered.rerender(<RawVolumeViewport volume={{ schema_version: 1, context: whole, focus }} />);
      await waitFor(() => expect(vtk.resetCamera).toHaveBeenCalledTimes(2));
      const activeActor = vtk.addVolume.mock.calls.at(-1)![0];
      expect(activeActor.getVisibility()).toBe(true);
      const bounds = activeActor.getBounds();
      expect(vtk.resetCamera).toHaveBeenLastCalledWith(bounds);
      expect(camera.getFocalPoint()).toEqual([
        (bounds[0] + bounds[1]) / 2, (bounds[2] + bounds[3]) / 2, (bounds[4] + bounds[5]) / 2,
      ]);
      camera.getDirectionOfProjection().forEach((value, axis) => expect(value).toBeCloseTo(direction[axis], 9));
      expect(distance()).toBeLessThan(wholeDistance);
      const fittedFocus = pose();

      camera.azimuth(-9); camera.dolly(1.3);
      const focusPose = pose();
      const scalars = activeActor.getMapper().getInputData().getPointData().getScalars().getData();
      const original = [...scalars];
      const activeWindow = rendered.container.querySelector(".raw-volume")?.getAttribute("data-transfer-ranges");
      fireEvent.change(screen.getByLabelText("3D rendering mode"), { target: { value: "mip" } });
      expect(pose()).toEqual(focusPose);
      expect(activeActor.getMapper().getInputData().getPointData().getScalars().getData()).toBe(scalars);
      expect([...scalars]).toEqual(original);
      expect(rendered.container.querySelector(".raw-volume")?.getAttribute("data-transfer-ranges")).toBe(activeWindow);

      fireEvent.click(screen.getByRole("button", { name: "Whole" }));
      expect(pose()).toEqual(wholePose);
      fireEvent.click(screen.getByRole("button", { name: "Focus" }));
      expect(pose()).toEqual(focusPose);
      fireEvent.click(screen.getByRole("button", { name: "Reset camera" }));
      expect(pose()).toEqual(fittedFocus);
      expect(vtk.resetCamera).toHaveBeenCalledTimes(2);
    } finally {
      cleanup();
      vtk.actualCamera = null;
      vtk.resetCamera.mockReset();
      renderer.delete();
    }
  });

  it("announces the first rendered context after a browser frame and only then permits automatic refinement", async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 0;
    const schedule = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      const id = ++nextFrameId;
      frames.set(id, callback);
      return id;
    });
    const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
    const stepFrame = () => act(() => {
      const ready = [...frames.values()];
      frames.clear();
      ready.forEach((callback) => callback(0));
    });
    const coarse = context();
    coarse.refinement = { available: true, maximum_target_long_axis: 256, focus_supported: true };
    const volume: RawVolumeResponse = { schema_version: 1, context: coarse, focus: null };
    const onOpeningVolumeRender = vi.fn();
    const refine = vi.fn();
    const mounted = render(<RawVolumeViewport volume={volume} onOpeningVolumeRender={onOpeningVolumeRender}
      onRequestRefinement={refine} />);
    try {
      await screen.findByLabelText("XY plane resliced image");
      expect(vtk.addVolume).toHaveBeenCalledOnce();
      await waitFor(() => expect(schedule.mock.calls.length).toBeGreaterThan(1));
      expect(onOpeningVolumeRender).not.toHaveBeenCalled();
      stepFrame();
      expect(onOpeningVolumeRender).not.toHaveBeenCalled();
      stepFrame();
      expect(onOpeningVolumeRender).toHaveBeenCalledExactlyOnceWith({ kind: "painted", volume });
      expect(refine).not.toHaveBeenCalled();

      mounted.rerender(<RawVolumeViewport volume={volume} onRequestRefinement={refine} />);
      await waitFor(() => expect(refine).toHaveBeenCalledWith({ target_long_axis: 128 }), { timeout: 1_500 });
    } finally {
      mounted.unmount();
      cancel.mockRestore();
      schedule.mockRestore();
    }
  });

  it("reports graphics failure before a pending frame can acknowledge the opening", async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 0;
    const schedule = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.set(++nextFrameId, callback);
      return nextFrameId;
    });
    const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
    const onOpeningVolumeRender = vi.fn();
    const volume: RawVolumeResponse = { schema_version: 1, context: context(), focus: null };
    const mounted = render(<RawVolumeViewport volume={volume} onOpeningVolumeRender={onOpeningVolumeRender} />);
    try {
      await screen.findByLabelText("XY plane resliced image");
      expect(onOpeningVolumeRender).not.toHaveBeenCalled();
      act(() => { vtk.canvas!.dispatchEvent(new Event("webglcontextlost", { cancelable: true })); });
      expect(onOpeningVolumeRender).toHaveBeenCalledExactlyOnceWith({ kind: "failed" });
      act(() => frames.forEach((callback) => callback(0)));
      expect(onOpeningVolumeRender.mock.calls.every(([status]) => status.kind === "failed")).toBe(true);
    } finally {
      mounted.unmount();
      cancel.mockRestore();
      schedule.mockRestore();
    }
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

  it("anchors the linked crosshair to level zero across noncoincident overview grids", async () => {
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
    const overview = (indices: number[]): RawVolumePayload => {
      const payload = context();
      const count = indices.length;
      const stride = 6 / (count - 1);
      const bytes = Buffer.from(indices.flatMap(z => indices.map(x => z * 7 + x)));
      payload.dimensions_xyz = [count, 1, count];
      payload.native_level_dimensions_xyz = [7, 1, 7];
      payload.source_dimensions_xyz = [7, 1, 7];
      payload.source_extent_xyzxyz = [0, 6, 0, 0, 0, 6];
      payload.spacing_xyz = [0.4 * stride, 0.8, 2.5 * stride];
      payload.affine_4x4[0][0] = payload.spacing_xyz[0];
      payload.affine_4x4[2][2] = payload.spacing_xyz[2];
      payload.sampling.source_indices_xyz = [indices, [0], indices];
      payload.sampling.level_zero_indices_xyz = [indices, [0], indices];
      payload.sampling.estimated_aggregate_bytes = Math.ceil(bytes.length * (3 + 4 / 3));
      payload.byte_length = bytes.length;
      payload.data_base64 = bytes.toString("base64");
      payload.data_sha256 = createHash("sha256").update(bytes).digest("hex");
      return payload;
    };
    const coarse = overview([0, 3, 6]);
    const refined = overview([0, 2, 4, 6]);
    const handle: { current: VolumeSceneAdapter | null } = { current: null };
    const exportFigure = vi.fn().mockResolvedValue(null);
    const viewport = (context: RawVolumePayload) => (
      <RawVolumeViewport volume={{ schema_version: 1, context, focus: null }}
        sceneHandleRef={handle} onExportFigure={exportFigure} />
    );
    const expectCrosshair = async (source: number[]) => {
      await waitFor(() => expect(handle.current?.snapshot()).toMatchObject({
        available: true, state: { crosshair_source_xyz: source },
      }));
    };

    const mounted = render(viewport(coarse));
    await expectCrosshair([3, 0, 3]);
    mounted.rerender(viewport(refined));
    await expectCrosshair([3, 0, 3]);
    expect(screen.getByText(/World 11.200, 20.000, 37.500 um/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "MPR" }));
    fireEvent.click(screen.getByRole("button", { name: "Export PNG…" }));
    await waitFor(() => expect(exportFigure).toHaveBeenCalledOnce());
    expect(exportFigure.mock.calls[0][0].manifest.mpr).toEqual({
      context_display_indices_xyz: [1, 0, 1],
      active_payload_indices_xyz: [1, 0, 1],
      source_indices_xyz: [2, 0, 2],
      world_xyz: [10.8, 20, 35],
    });

    fireEvent.change(screen.getByRole("slider", { name: "X slice" }), { target: { value: "5" } });
    mounted.rerender(viewport(coarse));
    await expectCrosshair([5, 0, 3]);

    const newFingerprint = "b".repeat(64);
    mounted.rerender(viewport({ ...refined, source_sha256: newFingerprint }));
    await expectCrosshair([4, 0, 4]);
    mounted.rerender(viewport({ ...coarse, source_sha256: newFingerprint, t: 1 }));
    await expectCrosshair([3, 0, 3]);
  });

  it("keeps controls and camera state across verified refinement and reports context recovery", async () => {
    const initial: RawVolumeResponse = { schema_version: 1, context: context(), focus: null };
    const rendered = render(<RawVolumeViewport volume={initial} />);
    await waitFor(() => expect(vtk.resetCamera).toHaveBeenCalledTimes(1));
    expect(vtk.render).toHaveBeenCalled();
    expect(vtk.addMouseManipulator.mock.calls.slice(0, 4).map(([item]) => item.values)).toEqual([
      { button: 1, useFocalPointAsCenterOfRotation: true },
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
    fireEvent.click(screen.getByText("Rendering & detail", { exact: true }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Clip" }));
    const opacity = screen.getByRole("slider", { name: "C1 opacity" }) as HTMLInputElement;
    fireEvent.change(opacity, { target: { value: "0.25" } });
    expect(screen.getByLabelText("C1 opacity value").textContent).toBe("0.25");
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

    fireEvent(vtk.canvas!, new Event("webglcontextlost", { cancelable: true }));
    expect(await screen.findByText(/Graphics context lost/)).toBeTruthy();
    const lostCanvas = vtk.canvas;
    const priorAddVolumeCalls = vtk.addVolume.mock.calls.length;
    const priorSetPositionCalls = vtk.setPosition.mock.calls.length;
    fireEvent(vtk.canvas!, new Event("webglcontextrestored"));
    await waitFor(() => {
      expect(vtk.canvas).not.toBe(lostCanvas);
      expect(vtk.addVolume.mock.calls.length).toBeGreaterThan(priorAddVolumeCalls);
      expect(vtk.setPosition.mock.calls.length).toBeGreaterThan(priorSetPositionCalls);
    });
    expect(await screen.findByText(/source voxels/)).toBeTruthy();
  });

  it("blocks a deferred verified payload and display updates after context loss until a fresh renderer binds", async () => {
    const initial: RawVolumeResponse = { schema_version: 1, context: context(), focus: null };
    const verifiedDigest = await crypto.subtle.digest("SHA-256", new Uint8Array([0, 1, 2, 3]));
    let finishDigest!: (value: ArrayBuffer) => void;
    const digest = vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(() =>
      new Promise<ArrayBuffer>((resolve) => { finishDigest = resolve; }));
    const exportFigure = vi.fn().mockResolvedValue(null);
    render(<RawVolumeViewport volume={initial} onExportFigure={exportFigure} />);
    expect(digest).toHaveBeenCalledOnce();
    const lostCanvas = vtk.canvas!;
    fireEvent(lostCanvas, new Event("webglcontextlost", { cancelable: true }));
    expect(screen.getByText(/Graphics context lost/)).toBeTruthy();
    const rendersAtLoss = vtk.render.mock.calls.length;
    fireEvent.change(screen.getByRole("slider", { name: "C1 opacity" }), { target: { value: "0.25" } });
    fireEvent.keyDown(screen.getByLabelText("Interactive three-dimensional volume"), { key: "ArrowLeft" });
    fireEvent.click(screen.getByRole("button", { name: "Reset camera" }));
    await act(async () => { finishDigest(verifiedDigest); });
    expect(vtk.addVolume).not.toHaveBeenCalled();
    expect(vtk.render).toHaveBeenCalledTimes(rendersAtLoss);
    expect(screen.getByText(/Graphics context lost/)).toBeTruthy();
    const exportButton = screen.getByRole("button", { name: "Export PNG…" });
    expect(exportButton.hasAttribute("disabled")).toBe(true);
    fireEvent.click(exportButton);
    expect(vtk.captureNextImage).not.toHaveBeenCalled();
    expect(exportFigure).not.toHaveBeenCalled();

    fireEvent(lostCanvas, new Event("webglcontextrestored"));
    await waitFor(() => {
      expect(vtk.canvas).not.toBe(lostCanvas);
      expect(vtk.addVolume).toHaveBeenCalledOnce();
      expect(vtk.render.mock.calls.length).toBeGreaterThan(rendersAtLoss);
      expect(exportButton.hasAttribute("disabled")).toBe(false);
    });
    expect(digest).toHaveBeenCalledTimes(2);
    expect((screen.getByRole("slider", { name: "C1 opacity" }) as HTMLInputElement).value).toBe("0.25");
    expect(screen.queryByText(/Graphics context lost/)).toBeNull();
  });

  it("retires queued vtk.js frames on context recovery and close", async () => {
    const windows: vtkGenericRenderWindow[] = [];
    vtk.headlessWindows = windows;
    const frames = controlAnimationFrames();
    const volume: RawVolumeResponse = { schema_version: 1, context: context(), focus: null };
    const mounted = render(<RawVolumeViewport volume={volume} />);
    try {
      await screen.findByText(/source voxels/);
      frames.step();
      const original = windows[0];
      const originalView = original.getApiSpecificRenderWindow();
      const originalInteractor = original.getInteractor();
      const originalAnimation = vi.fn();
      originalInteractor.onAnimation(originalAnimation);
      originalInteractor.requestAnimation(originalAnimation);
      frames.step();
      expect(originalAnimation).toHaveBeenCalledOnce();
      expect(frames.pending()).toBe(1);

      const canvas = originalView.getCanvas()!;
      fireEvent(canvas, new Event("webglcontextlost", { cancelable: true }));
      expect(await screen.findByText(/Graphics context lost/)).toBeTruthy();
      fireEvent(canvas, new Event("webglcontextrestored"));
      frames.step();
      expect(windows).toHaveLength(2);
      expect(originalView.isDeleted()).toBe(true);
      const callsAtTeardown = originalAnimation.mock.calls.length;
      frames.step(); // A successor queued before restoration must be cancelled by teardown.
      expect(originalAnimation).toHaveBeenCalledTimes(callsAtTeardown);
      expect(originalInteractor.isDeleted()).toBe(true);

      await screen.findByText(/source voxels/);
      const recovered = windows[1].getInteractor();
      const recoveredAnimation = vi.fn();
      recovered.onAnimation(recoveredAnimation);
      recovered.requestAnimation(recoveredAnimation);
      frames.step();
      expect(recoveredAnimation).toHaveBeenCalledOnce();
      expect(frames.pending()).toBe(1);

      mounted.unmount();
      frames.step();
      expect(recoveredAnimation).toHaveBeenCalledOnce();
      expect(frames.pending()).toBe(0);
      expect(recovered.isDeleted()).toBe(true);
    } finally {
      cleanup();
      vtk.headlessWindows = null;
      vi.unstubAllGlobals();
    }
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

    fireEvent.click(screen.getByText("Rendering & detail", { exact: true }));
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
    fireEvent.click(screen.getByText("Rendering & detail", { exact: true }));
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
        schema_version: "loci.volume-figure/v2",
        figure: { kind: "screen-resolution-rendered-figure", capture_scale: 1 },
        representation: {
          mode: "mpr",
          extent: "context",
          channel_compositing: null,
          shading: false,
          blend_mode: null,
          quality: null,
          lighting: null,
        },
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
    const volumeActor = vtk.addVolume.mock.calls[0][0];
    expect(volumeActor.getProperty().getColorMixPreset?.()).toBe(3);
    expect(volumeActor.getMapper().getViewSpecificProperties?.().OpenGL?.ShaderReplacements?.[0]?.originalValue)
      .toBe("//VTK::CustomColorMix");

    fireEvent.change(screen.getByLabelText("3D rendering mode"), { target: { value: "normal_shading" } });
    fireEvent.click(screen.getByRole("button", { name: "Export PNG…" }));
    await waitFor(() => expect(exportFigure).toHaveBeenCalledOnce());
    expect(exportFigure.mock.calls[0][0].manifest).toMatchObject({
      schema_version: "loci.volume-figure/v2",
      representation: {
        mode: "volume",
        channel_compositing: "opacity-weighted-channels/v1",
        shading: true,
        blend_mode: "normal_shading",
        quality: 50,
        lighting: { ambient: 0.22, diffuse: 0.68, specular: 0.25, specular_power: 20, gradient_opacity: false },
      },
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
    expect(volumeActor.getProperty().getColorMixPreset?.()).toBe(3);

    // Change quality slider from 50 to 80 through its explicit disclosure.
    fireEvent.click(screen.getByText("Rendering & detail", { exact: true }));
    const qualitySlider = screen.getByRole("slider", { name: "3D rendering quality" });
    fireEvent.change(qualitySlider, { target: { value: "80" } });
    expect(screen.getByText("80%")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Export PNG…" }));
    await waitFor(() => expect(exportFigure).toHaveBeenCalledOnce());
    expect(exportFigure.mock.calls[0][0].manifest).toMatchObject({
      schema_version: "loci.volume-figure/v2",
      representation: {
        mode: "volume",
        channel_compositing: "opacity-weighted-channels/v1",
        shading: false,
        blend_mode: "mip",
        quality: 80,
        lighting: null,
      },
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
