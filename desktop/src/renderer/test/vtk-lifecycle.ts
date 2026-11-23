import vtkRenderWindow from "@kitware/vtk.js/Rendering/Core/RenderWindow";
import type vtkGenericRenderWindow from "@kitware/vtk.js/Rendering/Misc/GenericRenderWindow";
import vtkOpenGLRenderWindow from "@kitware/vtk.js/Rendering/OpenGL/RenderWindow";
import { act } from "@testing-library/react";
import { vi } from "vitest";

export function headlessVtkWindow(
  vtk: typeof vtkGenericRenderWindow,
  options: Parameters<typeof vtk.newInstance>[0],
) {
  const defaultViewAPI = "Loci headless OpenGL";
  vtkRenderWindow.registerViewConstructor(defaultViewAPI, () => {
    const view = vtkOpenGLRenderWindow.newInstance();
    // Keep the actual OpenGL view and teardown but skip the passes that need a GPU.
    view.set({ renderPasses: [] });
    return view;
  });
  const headlessOptions = { ...options, defaultViewAPI };
  return vtk.newInstance(headlessOptions);
}

export function controlAnimationFrames() {
  let nextId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextId, callback);
    return nextId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
  return {
    pending: () => frames.size,
    step: () => act(() => {
      for (const id of [...frames.keys()]) {
        const callback = frames.get(id);
        frames.delete(id);
        callback?.(0);
      }
    }),
  };
}
