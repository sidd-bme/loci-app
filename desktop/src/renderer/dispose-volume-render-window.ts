import type vtkRenderWindowInteractor from "@kitware/vtk.js/Rendering/Core/RenderWindowInteractor";
import type vtkGenericRenderWindow from "@kitware/vtk.js/Rendering/Misc/GenericRenderWindow";

export function disposeVolumeRenderWindow(generic: vtkGenericRenderWindow): void {
  const interactor = generic.getRenderWindow().getInteractor() as vtkRenderWindowInteractor & {
    // vtk.js 36.12 exposes this method under its XR name; the declarations still say VR.
    switchToXRAnimation(): void;
  };
  // Stop the browser animation loop before freeing the view. Deleting the
  // interactor alone can leave a frame queued during the wheel-end extension.
  interactor.switchToXRAnimation();
  try {
    generic.delete(); // Unbinds DOM events and timers while the interactor is still alive.
  } finally {
    interactor.delete();
  }
}
