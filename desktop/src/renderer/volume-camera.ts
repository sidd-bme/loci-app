import { cross, normalize } from "@kitware/vtk.js/Common/Core/Math";
import type vtkCamera from "@kitware/vtk.js/Rendering/Core/Camera";
import type { MprPlane, Vec3 } from "./mpr-reslice";

/** u is screen-right and v is screen-down in the source slice. Their winding,
 * including a reflected acquisition, determines which side faces the camera. */
export function orientToSourcePlane(camera: vtkCamera, plane: MprPlane) {
  const up = plane.v.map(value => -value) as Vec3;
  const back: Vec3 = [0, 0, 0];
  cross(plane.u, up, back);
  normalize(up);
  normalize(back);
  const focal = camera.getFocalPoint();
  const distance = camera.getDistance();
  camera.setPosition(...back.map((value, axis) => focal[axis] + value * distance) as Vec3);
  camera.setViewUp(...up);
}

export function zoomVolumeCamera(camera: vtkCamera, factor: number) {
  if (camera.getParallelProjection()) camera.setParallelScale(camera.getParallelScale() / factor);
  else camera.dolly(factor);
}

/** Move the image one twentieth of the visible height in a screen direction. */
export function panVolumeCamera(camera: vtkCamera, right: number, up: number) {
  const halfHeight = camera.getParallelProjection() ? camera.getParallelScale()
    : camera.getDistance() * Math.tan(camera.getViewAngle() * Math.PI / 360);
  const view = camera.getViewMatrix();
  const offset = [0, 1, 2].map(axis => -0.1 * halfHeight * (right * view[axis] + up * view[4 + axis])) as Vec3;
  camera.translate(...offset);
}

export function wheelZoomFactor(event: WheelEvent, viewportHeight: number): number {
  const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16
    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? viewportHeight : 1;
  // Chromium emits pixel-mode Ctrl+wheel for a touchpad pinch. Preserve
  // fractional input and cap a single coarse notch on both projection types.
  const amount = -event.deltaY * unit * (event.ctrlKey ? 0.01 : 0.0025);
  return Math.exp(Math.max(-0.5, Math.min(0.5, amount)));
}
