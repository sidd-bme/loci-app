// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { trimStudyNavigatorSource, type StudyNavigatorApi, type StudyNavigatorSource, type StudyNavigatorState } from "../shared/study-navigator-api";
import type { ResearchSource } from "../shared/research-contracts";
import { DetachedStudyNavigator } from "./DetachedStudyNavigator";

afterEach(cleanup);

const sourceA: StudyNavigatorSource = {
  id: "src-a",
  sha256: "a".repeat(64),
  name: "kidney_fluorescence.ome.tif",
  browser_location: { relative_path: "Kidney/kidney_fluorescence.ome.tif", root: null },
  size_bytes: 12_582_912,
  source_kind: "native",
  metadata: {
    format: "OME-TIFF",
    axes: "TCZYX",
    dimensions: { t: 1, c: 3, z: 16, y: 512, x: 512 },
    channel_names: ["DAPI", "Actin", "Tubulin"],
    channel_dtypes: ["uint16", "uint16", "uint16"],
    physical_calibration: { axes: "ZYX", spacing: [1.12525, 0.32, 0.24], unit: "µm" },
  },
};

const sourceB: StudyNavigatorSource = {
  id: "src-b",
  sha256: "b".repeat(64),
  name: "cellseg_organoid.tif",
  browser_location: { relative_path: "Organoid/cellseg_organoid.tif", root: null },
  size_bytes: 4_194_304,
  source_kind: "native",
  metadata: {
    dimensions: { t: 2, c: 1, z: 8, y: 256, x: 256 },
    channel_dtypes: ["uint8"],
  },
};

const binding = { generation: 1, projectId: "study-1", studyGeneration: 2, documentGeneration: 3 };
const initialState: StudyNavigatorState = {
  binding,
  sequence: 0,
  snapshot: {
    studyName: "Kidney fluorescence",
    sources: [sourceA, sourceB],
    activeSourceId: sourceA.id,
    activeSourceSha256: sourceA.sha256,
    selectedSourceIds: [sourceA.id],
    resultCounts: { [sourceA.id]: 2, [sourceB.id]: 0 },
    reorderDisabled: false,
    busy: false,
  },
};

it("reuses SourceTree, renders verified compact source metadata, sends typed commands and docks cleanly", async () => {
  let receive!: (value: StudyNavigatorState) => void;
  let read!: (value: StudyNavigatorState) => void;
  const api: StudyNavigatorApi = {
    state: () =>
      new Promise((resolve) => {
        read = resolve;
      }),
    act: vi.fn(async () => {}),
    dock: vi.fn(async () => {}),
    onState: (listener) => {
      receive = listener;
      return () => {};
    },
  };

  render(<DetachedStudyNavigator api={api} />);
  await act(async () => read(initialState));

  expect(document.title).toBe("Loci · Images");
  expect(screen.getByRole("heading", { name: /Images\s*\(2\)/ })).toBeVisible();
  expect(screen.getByText("Kidney fluorescence")).toBeVisible();
  expect(screen.getByRole("button", { name: "Dock Images" })).toHaveFocus();

  // Active row is clearly marked in SourceTree and metadata reflects verified source fields
  const activeLeaf = screen.getByRole("treeitem", { name: sourceA.name });
  expect(activeLeaf).toHaveAttribute("aria-current", "true");
  expect(screen.getByLabelText("Active image details")).toHaveTextContent("512 × 512 px · 3 C · 16 Z");
  expect(screen.getByLabelText("Active image details")).toHaveTextContent("1.12525 × 0.32 × 0.24 µm (ZYX)");
  expect(screen.getByLabelText("Active image details")).toHaveTextContent(/Axes\s*TCZYX/);
  expect(screen.getByLabelText("Active image details")).toHaveTextContent("OME-TIFF · uint16");
  expect(screen.getByLabelText("Active image details")).toHaveTextContent("DAPI, Actin, Tubulin");
  expect(screen.getByLabelText("Active image details")).toHaveTextContent("12 MiB");
  expect(screen.getByLabelText("Active image details")).toHaveTextContent("2 results");

  // Search filter works locally without emitting selection commands
  const search = screen.getByRole("searchbox", { name: "Search images and folders" });
  fireEvent.change(search, { target: { value: "organoid" } });
  expect(screen.getByRole("treeitem", { name: sourceB.name })).toBeVisible();
  expect(screen.queryByRole("treeitem", { name: sourceA.name })).not.toBeInTheDocument();
  expect(api.act).not.toHaveBeenCalled();

  // Clicking an image sends a typed activate command with opaque id + sha256
  fireEvent.click(screen.getByRole("treeitem", { name: sourceB.name }));
  expect(api.act).toHaveBeenLastCalledWith(binding, {
    kind: "activate",
    sourceId: sourceB.id,
    sourceSha256: sourceB.sha256,
    modifier: "none",
    visibleSourceIds: [sourceB.id],
  });

  // Clear search, test Space multi-select toggle
  fireEvent.click(screen.getByRole("button", { name: "Clear image search" }));
  fireEvent.keyDown(screen.getByRole("treeitem", { name: sourceB.name }), { key: " " });
  expect(api.act).toHaveBeenLastCalledWith(binding, {
    kind: "toggle-selection",
    sourceId: sourceB.id,
    sourceSha256: sourceB.sha256,
  });

  // Switch to flat list and test Alt+Arrow reorder command
  fireEvent.click(screen.getByRole("button", { name: "Flat list" }));
  const firstFlat = screen.getByRole("button", { name: sourceA.name });
  fireEvent.keyDown(firstFlat, { key: "ArrowDown", altKey: true });
  expect(api.act).toHaveBeenLastCalledWith(binding, {
    kind: "reorder",
    order: [
      { sourceId: sourceB.id, sourceSha256: sourceB.sha256 },
      { sourceId: sourceA.id, sourceSha256: sourceA.sha256 },
    ],
  });

  // Ignore stale generation update, accept newer sequence update
  act(() => receive({ ...initialState, sequence: 99, binding: { ...binding, generation: 2 } }));
  expect(screen.getByRole("button", { name: sourceA.name })).toHaveAttribute("aria-current", "true");

  act(() =>
    receive({
      binding,
      sequence: 1,
      snapshot: {
        ...initialState.snapshot,
        activeSourceId: sourceB.id,
        activeSourceSha256: sourceB.sha256,
        selectedSourceIds: [sourceA.id, sourceB.id],
      },
    }),
  );
  expect(screen.getByRole("button", { name: sourceB.name })).toHaveAttribute("aria-current", "true");
  expect(screen.getByText("2 selected")).toBeVisible();

  // Rejected sequence surfaces a clear alert
  act(() =>
    receive({
      binding,
      sequence: 2,
      rejectedSequence: 2,
      snapshot: initialState.snapshot,
    }),
  );
  expect(screen.getByRole("alert")).toHaveTextContent("The study changed before this action could apply.");

  // Dock button returns to workspace
  fireEvent.click(screen.getByRole("button", { name: "Dock Images" }));
  expect(api.dock).toHaveBeenCalledExactlyOnceWith(binding);
});

it.each([
  { metadata: { shape: [4, 20, 35], axes: "CYX" }, summary: "35 × 20 px · 4 C" },
  { metadata: { shape: [20, 35, 4], axes: "YXS", sample_semantics: "RGBA" }, summary: "35 × 20 px · 4 RGBA components" },
  { metadata: { shape: [3, 20, 35], axes: "CYX", sample_semantics: "RGB" }, summary: "35 × 20 px · RGB components" },
  { metadata: { shape: [4, 20, 35], axes: "TYX" }, summary: "35 × 20 px · 4 T" },
  { metadata: { shape: [4, 20, 35], axes: "QYX" }, summary: "35 × 20 px" },
  { metadata: { shape: [4, 20, 35], geometry: { axes: "ZYX", affine: [] } }, summary: "35 × 20 px · 4 Z" },
  { metadata: { shape: [4, 20, 35], axes: "YX" }, summary: "Not recorded" },
  { metadata: { shape: [4, 20, 35] }, summary: "Not recorded" },
])("uses only declared dimensions for image metadata $metadata", async ({ metadata, summary }) => {
  const source = trimStudyNavigatorSource({ ...sourceA, metadata });
  expect(source.metadata).not.toHaveProperty("dimensions");
  expect(source.metadata).not.toHaveProperty("geometry");
  render(<DetachedStudyNavigator api={{
    state: async () => ({ ...initialState, snapshot: { ...initialState.snapshot, sources: [source] } }),
    act: vi.fn(async () => {}),
    dock: vi.fn(async () => {}),
    onState: () => () => {},
  }} />);
  const dimensions = await screen.findByText("Dimensions");
  expect(dimensions.nextElementSibling?.textContent).toBe(summary);
});

it("preserves explicit dimensions, calibration order and unit while separating RGB from channels", async () => {
  const metadata: ResearchSource["metadata"] & { physical_calibration: { axes: string } } = {
    axes: "TCZYXS",
    dimensions: { x: 35, y: 20, z: 3, t: 2, c: 1, s: 3 },
    sample_semantics: "RGB",
    channel_names: ["Channel 1"],
    physical_calibration: { axes: "ZYX", spacing: [1.24, 0.32135, 0.25], unit: "um" },
  };
  const source = trimStudyNavigatorSource({ ...sourceA, metadata });
  expect(source.metadata.dimensions).toEqual(metadata.dimensions);
  expect(source.metadata.physical_calibration).toEqual(metadata.physical_calibration);

  render(<DetachedStudyNavigator api={{
    state: async () => ({ ...initialState, snapshot: { ...initialState.snapshot, sources: [source] } }),
    act: vi.fn(async () => {}),
    dock: vi.fn(async () => {}),
    onState: () => () => {},
  }} />);
  const dimensions = await screen.findByText("Dimensions");
  expect(dimensions.nextElementSibling).toHaveTextContent("35 × 20 px · 3 RGB components · 3 Z · 2 T");
  expect(screen.getByText("Calibration").nextElementSibling).toHaveTextContent("1.24 × 0.32135 × 0.25 um (ZYX)");
  expect(screen.queryByText("Channels")).not.toBeInTheDocument();
});

it("shows relink status and empty study messaging safely without leaking paths", async () => {
  const relinkSource: StudyNavigatorSource = {
    ...sourceA,
    locator_state: "relink-required",
  };
  let receive!: (value: StudyNavigatorState) => void;
  const api: StudyNavigatorApi = {
    state: async () => ({
      binding,
      sequence: 0,
      snapshot: {
        ...initialState.snapshot,
        sources: [relinkSource],
        activeSourceId: relinkSource.id,
        activeSourceSha256: relinkSource.sha256,
        selectedSourceIds: [relinkSource.id],
      },
    }),
    act: vi.fn(async () => {}),
    dock: vi.fn(async () => {}),
    onState: (listener) => {
      receive = listener;
      return () => {};
    },
  };

  render(<DetachedStudyNavigator api={api} />);
  expect(await screen.findByText("Relink required in main window")).toBeVisible();

  act(() =>
    receive({
      binding,
      sequence: 1,
      snapshot: {
        ...initialState.snapshot,
        sources: [],
        activeSourceId: null,
        activeSourceSha256: null,
        selectedSourceIds: [],
      },
    }),
  );
  expect(screen.getByRole("status")).toHaveTextContent("No images in this study. Add images from the main window.");
});
