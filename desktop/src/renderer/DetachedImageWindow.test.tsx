// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImageWindowApi, ImageWindowPresentation, ImageWindowState } from "../shared/image-window-api";
import type { ImageViewTargetSnapshot } from "../shared/image-view-contracts";

vi.mock("./ImageViewport", () => ({
  ImageViewport: (props: {
    source: { name: string };
    onDraftChange: (points: Array<{ x: number; y: number }>) => void;
    onCamera: (camera: { x: number; y: number; scale: number }) => void;
  }) => <div aria-label={`Mock image viewer: ${props.source.name}`}>
    <button onClick={() => props.onDraftChange([{ x: 12, y: 24 }])}>Draw draft</button>
    <button onClick={() => props.onCamera({ x: 31, y: 17, scale: 2 })}>Move camera</button>
  </div>,
}));

vi.mock("./RawVolumeViewport", () => ({
  RawVolumeViewport: (props: { volume: { context: { t: number } } | null; error?: string | null }) =>
    <div>{props.error ? `volume-error:${props.error}` : props.volume ? `volume-t-${props.volume.context.t}` : "volume-loading"}</div>,
}));

import { DetachedImageWindow } from "./DetachedImageWindow";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const target: ImageViewTargetSnapshot = {
  viewId: "view-a",
  sessionEpoch: "epoch-a",
  generation: 1,
  sourceId: "a".repeat(32),
  sourceSha256: "1".repeat(64),
  resultId: null,
  resultRevisionHash: null,
};

const source = {
  id: target.sourceId,
  name: "Stack A",
  sha256: target.sourceSha256,
  metadata: {
    format: "OME-TIFF",
    dimensions: { x: 128, y: 96, z: 3, t: 2, c: 1 },
    levels: [{ index: 0, dimensions: { x: 128, y: 96, z: 3, t: 2, c: 1 } }],
    channel_names: ["Signal"],
  },
};

function presentation(t = 0, mode: ImageWindowPresentation["mode"] = "plane"): ImageWindowPresentation {
  return {
    mode,
    selection: { x: 0, y: 0, width: 128, height: 96, t, c: 0, z: 1, level: 0 },
    channels: [{ channel: 0, low: 0, high: 4095, gamma: 1, visible: true, color: "#ffffff" }],
    projection: "plane",
    tool: "navigate",
    draft: [],
    annotations: [],
    camera: null,
    showScaleBar: true,
    showNavigator: true,
  };
}

function mockApi(initialPresentation = presentation()) {
  let presentationListener: ((event: { target: ImageViewTargetSnapshot; presentation: ImageWindowPresentation }) => void) | undefined;
  const state: ImageWindowState = {
    role: "image",
    views: [{ target, source, label: "View A", status: "ready" }],
    target,
    pinned: false,
  };
  const api = {
    state: vi.fn(async () => state),
    presentation: vi.fn(async () => ({ target, presentation: initialPresentation })),
    onState: vi.fn(() => () => {}),
    onPresentation: vi.fn((listener) => { presentationListener = listener; return () => {}; }),
    onInteraction: vi.fn(() => () => {}),
    interact: vi.fn(async () => {}),
    execute: vi.fn(async () => ({})),
    cancel: vi.fn(async () => {}),
    open: vi.fn(),
    restore: vi.fn(),
    close: vi.fn(),
    closeAll: vi.fn(),
    reopen: vi.fn(),
    pin: vi.fn(),
    focus: vi.fn(),
    fullscreen: vi.fn(),
    publish: vi.fn(),
  } as unknown as ImageWindowApi;
  return { api, emitPresentation: (next: ImageWindowPresentation) => presentationListener?.({ target, presentation: next }) };
}

describe("DetachedImageWindow", () => {
  it("does not overwrite a newer plane with a delayed startup snapshot", async () => {
    const { api, emitPresentation } = mockApi();
    let resolveInitial!: (value: Awaited<ReturnType<ImageWindowApi["presentation"]>>) => void;
    vi.mocked(api.presentation).mockImplementation(() => new Promise((resolve) => { resolveInitial = resolve; }));
    render(<DetachedImageWindow api={api} />);
    act(() => emitPresentation(presentation(1)));
    await act(async () => resolveInitial({ target, presentation: presentation(0) }));
    fireEvent.click(await screen.findByRole("button", { name: "Draw draft" }));
    expect(api.interact).toHaveBeenCalledWith(target, expect.objectContaining({ plane: { t: 1, z: 1 } }));
  });

  it("binds draft and camera interactions to its immutable target", async () => {
    const { api } = mockApi();
    render(<DetachedImageWindow api={api} />);

    await screen.findByLabelText("Mock image viewer: Stack A");
    fireEvent.click(screen.getByRole("button", { name: "Draw draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Move camera" }));
    fireEvent.click(screen.getByRole("button", { name: "Move camera" }));

    expect(api.interact).toHaveBeenCalledWith(target, {
      kind: "draft",
      plane: { t: 0, z: 1 },
      points: [{ x: 12, y: 24 }],
    });
    expect(api.interact).toHaveBeenCalledWith(target, {
      kind: "camera",
      camera: { x: 31, y: 17, scale: 2 },
    });
    expect(vi.mocked(api.interact).mock.calls.filter(([, event]) => event.kind === "camera")).toHaveLength(1);
  });

  it("keeps the newer verified volume when an older request fails late", async () => {
    let rejectOld!: (reason: Error) => void;
    const oldRequest = new Promise((_, reject) => { rejectOld = reject; });
    const { api, emitPresentation } = mockApi(presentation(0, "volume"));
    vi.mocked(api.execute).mockImplementation(async (_target, operation, request) => {
      if (operation !== "viewer_volume") return {};
      const t = (request as { t: number }).t;
      if (t === 0) return oldRequest;
      return {
        schema_version: 1,
        context: { source_id: source.id, source_sha256: source.sha256, t: 1 },
        focus: null,
      };
    });
    render(<DetachedImageWindow api={api} />);

    await waitFor(() => expect(api.execute).toHaveBeenCalledWith(
      target,
      "viewer_volume",
      expect.objectContaining({
        source_id: source.id,
        t: 0,
        target_long_axis: 128,
        max_decoded_bytes: 32 * 1024 ** 2,
      }),
      { viewer_lane: "detached-volume" },
    ));
    act(() => emitPresentation(presentation(1, "volume")));
    await screen.findByText("volume-t-1");

    await act(async () => { rejectOld(new Error("old volume failed")); });
    expect(screen.getByText("volume-t-1")).toBeVisible();
    expect(screen.queryByText(/old volume failed/)).not.toBeInTheDocument();
  });
});
