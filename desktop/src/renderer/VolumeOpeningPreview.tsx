import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import vtkDataArray from "@kitware/vtk.js/Common/Core/DataArray";
import vtkImageData from "@kitware/vtk.js/Common/DataModel/ImageData";
import vtkInteractorStyleManipulator from "@kitware/vtk.js/Interaction/Style/InteractorStyleManipulator";
import vtkMouseCameraTrackballRotateManipulator from "@kitware/vtk.js/Interaction/Manipulators/MouseCameraTrackballRotateManipulator";
import vtkMouseCameraTrackballZoomManipulator from "@kitware/vtk.js/Interaction/Manipulators/MouseCameraTrackballZoomManipulator";
import vtkOrientationMarkerWidget from "@kitware/vtk.js/Interaction/Widgets/OrientationMarkerWidget";
import { Corners } from "@kitware/vtk.js/Interaction/Widgets/OrientationMarkerWidget/Constants";
import vtkAxesActor from "@kitware/vtk.js/Rendering/Core/AxesActor";
import vtkVolume from "@kitware/vtk.js/Rendering/Core/Volume";
import vtkVolumeMapper from "@kitware/vtk.js/Rendering/Core/VolumeMapper";
import { BlendMode } from "@kitware/vtk.js/Rendering/Core/VolumeMapper/Constants";
import vtkGenericRenderWindow from "@kitware/vtk.js/Rendering/Misc/GenericRenderWindow";
import {
  VOLUME_OPENING_PREVIEW_MAX_BYTES,
  VOLUME_OPENING_PREVIEW_MAX_EDGE,
  isVolumeOpeningPreviewRequestId,
  type VolumeOpeningPreviewPayload,
} from "../shared/volume-opening-preview";
import { createRawVolumeTransferFunctions } from "./RawVolumeViewport";
import { decodeVolumeBytes, volumeByteDigest, VOLUME_SCALAR_ENCODINGS } from "./volume-bytes";
import { indexToWorld, mprPlanes, planeGrid, renderMpr, type MprScalars } from "./mpr-reslice";
import { disposeVolumeRenderWindow } from "./dispose-volume-render-window";
import "./VolumeOpeningPreview.css";

type PreviewContext = VolumeOpeningPreviewPayload["context"];
type PreviewControls = (key: string) => boolean;

function finiteVector(value: unknown, length: number): value is number[] {
  return Array.isArray(value) && value.length === length && value.every(Number.isFinite);
}

function equalsGeometry(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= 1e-10 * Math.max(1, Math.abs(expected));
}

/** Check display bytes and geometry before allocating graphics resources. */
export async function decodeVolumeOpeningPreview(payload: VolumeOpeningPreviewPayload): Promise<MprScalars> {
  const invalid = () => new Error("Invalid temporary volume preview.");
  if (payload?.schema_version !== "loci.volume-opening-preview/v1" ||
      !isVolumeOpeningPreviewRequestId(payload.opening_id) ||
      typeof payload.source_inventory_sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(payload.source_inventory_sha256)) throw invalid();
  const context = payload.context;
  if (!context || context.frame !== "image" || !["pixel", "um"].includes(context.unit) ||
      context.interleave !== "voxel-major" || !Number.isSafeInteger(context.level) ||
      context.level < 0 || context.level > 31 || context.t !== 0 ||
      !finiteVector(context.dimensions_xyz, 3) || !finiteVector(context.native_level_dimensions_xyz, 3) ||
      !finiteVector(context.source_dimensions_xyz, 3) || context.dimensions_xyz[2] < 2 ||
      context.dimensions_xyz.some((n, axis) => !Number.isSafeInteger(n) || n < 1 ||
        n > VOLUME_OPENING_PREVIEW_MAX_EDGE || n > context.native_level_dimensions_xyz[axis]) ||
      context.native_level_dimensions_xyz.some((n, axis) => !Number.isSafeInteger(n) ||
        n > context.source_dimensions_xyz[axis]) ||
      context.source_dimensions_xyz.some((n) => !Number.isSafeInteger(n)) ||
      !finiteVector(context.origin_xyz, 3) || !finiteVector(context.spacing_xyz, 3) ||
      context.spacing_xyz.some((n, axis) => n <= 0 ||
        !Number.isFinite(context.origin_xyz[axis] + n * (context.dimensions_xyz[axis] - 1))) ||
      !Number.isFinite(Math.hypot(...context.spacing_xyz.map((n, axis) => n * (context.dimensions_xyz[axis] - 1)))) ||
      !finiteVector(context.direction_3x3, 9) ||
      context.direction_3x3.some((n, index) => !equalsGeometry(n, index % 4 === 0 ? 1 : 0)) ||
      !Array.isArray(context.affine_4x4) || context.affine_4x4.length !== 4 ||
      context.affine_4x4.some((row) => !finiteVector(row, 4))) throw invalid();
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      const expected = row === 3 ? Number(column === 3) :
        column === 3 ? context.origin_xyz[row] : context.direction_3x3[column * 3 + row] * context.spacing_xyz[column];
      if (!equalsGeometry(context.affine_4x4[row][column], expected)) throw invalid();
    }
  }

  const transfer = context.components?.[0];
  if (!Array.isArray(context.components) || context.components.length !== 1 || !transfer ||
      transfer.channel_index !== 0 || !finiteVector(transfer.color_rgb, 3) ||
      transfer.color_rgb.some((n) => n < 0 || n > 1) ||
      !finiteVector([transfer.window?.low, transfer.window?.high, transfer.window?.gamma], 3) ||
      transfer.window.high <= transfer.window.low || !Number.isFinite(transfer.window.high - transfer.window.low) ||
      transfer.window.gamma < 0.1 || transfer.window.gamma > 10 ||
      !Number.isFinite(transfer.opacity) || transfer.opacity < 0 || transfer.opacity > 1 ||
      typeof transfer.visible !== "boolean" || !Object.hasOwn(VOLUME_SCALAR_ENCODINGS, context.scalar_type)) {
    throw invalid();
  }
  const [itemSize, scalarArray] = VOLUME_SCALAR_ENCODINGS[context.scalar_type];
  const expectedBytes = itemSize * context.dimensions_xyz.reduce((total, n) => total * n, 1);
  if (expectedBytes > VOLUME_OPENING_PREVIEW_MAX_BYTES || context.byte_length !== expectedBytes ||
      typeof context.data_base64 !== "string" || context.data_base64.length !== 4 * Math.ceil(expectedBytes / 3) ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(context.data_base64) || !/^[0-9a-f]{64}$/.test(context.data_sha256)) {
    throw invalid();
  }
  const bytes = decodeVolumeBytes(context.data_base64, expectedBytes);
  if (await volumeByteDigest(bytes) !== context.data_sha256) throw invalid();
  const values = scalarArray(bytes.buffer);
  if (values instanceof Float32Array && !values.every(Number.isFinite)) throw invalid();
  return values;
}

/** Widen the preview-only MIP window using the pooled p99 of X, Y and Z ray maxima. */
export function openingMipTransfer(context: PreviewContext, values: MprScalars): PreviewContext["components"][0] {
  const component = context.components[0];
  const [width, height, depth] = context.dimensions_xyz;
  const xy = width * height;
  const xz = width * depth;
  const rayCount = xy + xz + height * depth;
  // A single hot voxel affects three rays. Below this count it can dominate p99.
  if (rayCount < 300) return component;

  const maxima = new Float64Array(rayCount).fill(-Infinity);
  for (let z = 0; z < depth; z += 1) {
    const alongY = xy + z * width;
    const alongX = xy + xz + z * height;
    for (let y = 0; y < height; y += 1) {
      const row = y * width;
      let rowMax = -Infinity;
      for (let x = 0; x < width; x += 1) {
        const value = values[z * xy + row + x];
        maxima[row + x] = Math.max(maxima[row + x], value);
        maxima[alongY + x] = Math.max(maxima[alongY + x], value);
        rowMax = Math.max(rowMax, value);
      }
      maxima[alongX + y] = rowMax;
    }
  }
  const high = maxima.sort()[Math.ceil(rayCount * 0.99) - 1];
  const { low } = component.window;
  if (high <= component.window.high || !Number.isFinite(high - low)) return component;
  return {
    ...component,
    window: { ...component.window, high },
    opacity_points: [[low, 0], [high, component.opacity]],
    provenance: { ...component.provenance, opening_mip_high: "pooled-orthogonal-ray-maxima-p99" },
  };
}

function attachOpeningVolume(
  container: HTMLDivElement,
  context: PreviewContext,
  values: MprScalars,
  onUnavailable: () => void,
  registerDisposer: (disposer: () => void) => void,
): PreviewControls {
  const generic = vtkGenericRenderWindow.newInstance({ background: [0.082, 0.082, 0.082], listenWindowResize: false });
  registerDisposer(() => disposeVolumeRenderWindow(generic));
  generic.setContainer(container);
  const renderer = generic.getRenderer();
  const renderWindow = generic.getRenderWindow();
  const interactor = renderWindow.getInteractor();
  const style = vtkInteractorStyleManipulator.newInstance();
  registerDisposer(() => style.delete());
  const rotate = vtkMouseCameraTrackballRotateManipulator.newInstance({ button: 1, useFocalPointAsCenterOfRotation: true });
  const zoom = vtkMouseCameraTrackballZoomManipulator.newInstance({ dragEnabled: false, scrollEnabled: true });
  registerDisposer(() => { style.removeAllMouseManipulators(); rotate.delete(); zoom.delete(); });
  style.addMouseManipulator(rotate);
  style.addMouseManipulator(zoom);
  interactor.setDesiredUpdateRate(45);
  interactor.setInteractorStyle(style);

  const image = vtkImageData.newInstance();
  registerDisposer(() => image.delete());
  image.setDimensions(...context.dimensions_xyz);
  image.setOrigin(context.origin_xyz);
  image.setSpacing(context.spacing_xyz);
  image.setDirection(context.direction_3x3);
  const data = vtkDataArray.newInstance({ name: "preview-scalars", numberOfComponents: 1, values });
  registerDisposer(() => data.delete());
  image.getPointData().setScalars(data);
  const mapper = vtkVolumeMapper.newInstance({ autoAdjustSampleDistances: true });
  registerDisposer(() => mapper.delete());
  mapper.setInputData(image);
  mapper.setBlendMode(BlendMode.MAXIMUM_INTENSITY_BLEND);
  mapper.setInitialInteractionScale(4);
  mapper.setInteractionSampleDistanceFactor(2);
  mapper.setSampleDistance(Math.min(...context.spacing_xyz));
  const actor = vtkVolume.newInstance();
  registerDisposer(() => actor.delete());
  actor.setMapper(mapper);
  const property = actor.getProperty();
  const { color, opacity } = createRawVolumeTransferFunctions(openingMipTransfer(context, values), "intensity");
  registerDisposer(() => { color.delete(); opacity.delete(); });
  property.setIndependentComponents(true);
  property.setInterpolationTypeToLinear();
  property.setShade(false);
  property.setRGBTransferFunction(0, color);
  property.setScalarOpacity(0, opacity);
  const diagonal = Math.hypot(...context.dimensions_xyz.map((n, axis) => (n - 1) * context.spacing_xyz[axis]));
  property.setScalarOpacityUnitDistance(0, diagonal / Math.max(...context.dimensions_xyz));
  renderer.addVolume(actor);
  registerDisposer(() => renderer.removeVolume(actor));

  const canvas = generic.getApiSpecificRenderWindow().getCanvas();
  if (!canvas) throw new Error("Could not create a preview graphics context.");
  canvas.addEventListener("webglcontextlost", onUnavailable);
  registerDisposer(() => canvas.removeEventListener("webglcontextlost", onUnavailable));
  const axes = vtkAxesActor.newInstance();
  registerDisposer(() => axes.delete());
  const orientation = vtkOrientationMarkerWidget.newInstance({
    actor: axes, interactor, parentRenderer: renderer,
    viewportCorner: Corners.BOTTOM_LEFT, viewportSize: 0.1, minPixelSize: 48, maxPixelSize: 80,
  });
  registerDisposer(() => { orientation.setEnabled(false); orientation.delete(); });
  orientation.setEnabled(true);
  orientation.updateViewport();

  let frame = 0;
  const resize = new ResizeObserver(() => {
    if (frame) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      if (!container.clientWidth || !container.clientHeight) return;
      try { generic.resize(); renderWindow.render(); } catch { onUnavailable(); }
    });
  });
  resize.observe(container);
  registerDisposer(() => { resize.disconnect(); window.cancelAnimationFrame(frame); });
  generic.resize();
  renderer.resetCamera();
  const camera = renderer.getActiveCamera();
  camera.azimuth(-20);
  camera.elevation(15);
  camera.orthogonalizeViewUp();
  renderer.resetCameraClippingRange();
  orientation.updateMarkerOrientation();
  renderWindow.render();

  return (key) => {
    if (key === "ArrowLeft" || key === "ArrowRight") camera.azimuth(key === "ArrowLeft" ? -5 : 5);
    else if (key === "ArrowUp" || key === "ArrowDown") camera.elevation(key === "ArrowUp" ? 5 : -5);
    else if (key === "+" || key === "=" || key === "-") camera.dolly(key === "-" ? 1 / 1.1 : 1.1);
    else return false;
    camera.orthogonalizeViewUp();
    renderer.resetCameraClippingRange();
    orientation.updateMarkerOrientation();
    renderWindow.render();
    return true;
  };
}

function OpeningXYSlice({ context, values, slice, onUnavailable }: {
  context: PreviewContext; values: MprScalars; slice: number; onUnavailable: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const plane = mprPlanes(context)[0];
    const center = indexToWorld(context, [0, 0, slice]);
    const grid = planeGrid(context, plane, center);
    try {
      const element = canvas.current!;
      const painter = element.getContext("2d");
      if (!painter) throw new Error("The slice canvas is unavailable.");
      element.width = grid.width;
      element.height = grid.height;
      const frame = painter.createImageData(grid.width, grid.height);
      frame.data.set(renderMpr(context, values, plane, grid, context.components));
      painter.putImageData(frame, 0, 0);
    } catch { onUnavailable(); }
  }, [context, onUnavailable, values, slice]);
  const [width, height] = context.dimensions_xyz.slice(0, 2).map((n, axis) =>
    Math.max(1, n - 1) * context.spacing_xyz[axis]);
  return <canvas ref={canvas} aria-label="XY preview slice" style={{ aspectRatio: width / height }} />;
}

export function VolumeOpeningPreview({
  payload,
  preparingVerifiedVolume = false,
  onHide,
}: {
  payload: VolumeOpeningPreviewPayload;
  preparingVerifiedVolume?: boolean;
  onHide: (openingId: string) => void;
}) {
  const headingId = useId();
  const controlsId = useId();
  const sliceLabelId = useId();
  const stage = useRef<HTMLDivElement>(null);
  const controls = useRef<PreviewControls | null>(null);
  const [values, setValues] = useState<MprScalars | null>(null);
  const [mode, setMode] = useState<"volume" | "xy">("volume");
  const [slice, setSlice] = useState(() => Math.floor((payload.context?.dimensions_xyz?.[2] ?? 2) / 2));
  const dismiss = useCallback(() => onHide(payload.opening_id), [onHide, payload.opening_id]);

  useEffect(() => {
    let active = true;
    const resources: (() => void)[] = [];
    const hide = () => { if (active) dismiss(); };
    const release = () => {
      controls.current = null;
      for (const dispose of resources.splice(0).reverse()) {
        try { dispose(); } catch { /* continue releasing graphics resources after a device failure */ }
      }
    };
    void (async () => {
      try {
        const decoded = await decodeVolumeOpeningPreview(payload);
        if (!active || !stage.current) return;
        controls.current = attachOpeningVolume(stage.current, payload.context, decoded, hide,
          (disposer) => resources.push(disposer));
        setValues(decoded);
      } catch { release(); hide(); }
    })();
    return () => { active = false; release(); };
  }, [payload, dismiss]);

  useEffect(() => { if (values) stage.current?.focus({ preventScroll: true }); }, [values]);
  const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    try {
      if (controls.current?.(event.key)) event.preventDefault();
    } catch { dismiss(); }
  };
  const depth = values ? payload.context.dimensions_xyz[2] : 0;
  return (
    <div className="volume-opening-backdrop" data-ready={Boolean(values)}
      data-phase={preparingVerifiedVolume ? "preparing" : "verifying"} inert={!values} aria-hidden={!values}>
      <section className="volume-opening-preview" aria-label="Opening 3D preview" aria-describedby={headingId}
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.stopPropagation(); dismiss(); }
        }}>
        <header className="volume-opening-header">
          <div>
            <h2 id={headingId} role="status">{preparingVerifiedVolume ? "Source verified" : "Verifying source"}</h2>
            <p>{preparingVerifiedVolume && "Preparing full 3D view · "}
              {mode === "volume" ? "First-channel maximum-intensity preview" : "First-channel XY preview"}</p>
          </div>
          <button type="button" onClick={dismiss}>Hide preview</button>
        </header>
        <div className="volume-opening-viewer">
          <div ref={stage} className="volume-opening-stage" tabIndex={0}
            aria-label="Interactive 3D preview" aria-describedby={controlsId} onKeyDown={keyboard} hidden={mode !== "volume"} />
          {values && mode === "xy" && <div className="volume-opening-slice">
            <OpeningXYSlice context={payload.context} values={values} slice={slice} onUnavailable={dismiss} />
          </div>}
        </div>
        <footer className="volume-opening-footer">
          <div className="volume-opening-modes" role="group" aria-label="Preview view">
            <button type="button" aria-pressed={mode === "volume"} onClick={() => setMode("volume")}>3D</button>
            <button type="button" aria-pressed={mode === "xy"} onClick={() => setMode("xy")}>XY slice</button>
          </div>
          {mode === "xy" && <div className="volume-opening-z">
            <span id={sliceLabelId}>Preview Z</span>
            <input aria-labelledby={sliceLabelId} aria-valuetext={`${slice + 1} of ${depth}`}
              type="range" min={0} max={depth - 1} value={slice}
              onChange={(event) => setSlice(Number(event.target.value))} />
            <output aria-hidden="true">{slice + 1} / {depth}</output>
          </div>}
          <span id={controlsId}>{mode === "volume" && "Drag or use arrow keys to rotate. Scroll to zoom."}</span>
          {values && <span className="volume-opening-dimensions">{payload.context.dimensions_xyz.join(" × ")} preview voxels</span>}
        </footer>
      </section>
    </div>
  );
}
