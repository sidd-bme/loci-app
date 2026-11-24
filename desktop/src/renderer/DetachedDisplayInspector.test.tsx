// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { DisplayInspectorApi, DisplayInspectorState } from "../shared/display-inspector-api";
import { DetachedDisplayInspector } from "./DetachedDisplayInspector";

afterEach(cleanup);

const binding = { generation: 1, studyGeneration: 2, documentGeneration: 3, sourceId: "source", sourceSha256: "a".repeat(64) };
const state: DisplayInspectorState = {
  binding, sequence: 0,
  snapshot: {
    source: { id: binding.sourceId, sha256: binding.sourceSha256, name: "Kidney volume.tif",
      metadata: { dimensions: { x: 32, y: 32, z: 5, t: 2, c: 2 }, physical_calibration: { spacing: [1, 2, 3], unit: "µm" } } },
    selection: { x: 0, y: 0, width: 32, height: 32, t: 0, c: 0, z: 0, level: 0 },
    channels: [{ channel: 0, visible: true, gamma: 1, low: 0, high: 255, opacity: 1, color: "#ffffff" }],
    interpretation: "medical", viewReady: true, projection: "plane", rgbMapping: null,
  },
};

it("uses shared Display controls, sends only field intents and discards a rejected numeric draft", async () => {
  let receive!: (value: DisplayInspectorState) => void;
  let read!: (value: DisplayInspectorState) => void;
  const api: DisplayInspectorApi = {
    state: () => new Promise((resolve) => { read = resolve; }),
    dock: vi.fn(async () => {}), edit: vi.fn(async () => {}),
    onState: (listener) => { receive = listener; return () => {}; },
  };
  render(<DetachedDisplayInspector api={api} />);
  act(() => receive({ ...state, sequence: 1, snapshot: { ...state.snapshot, selection: { ...state.snapshot.selection, z: 1 } } }));
  await act(async () => read(state));
  expect(screen.getByRole("heading", { name: "Display" })).toBeVisible();
  expect(document.title).toBe("Loci · Display");
  expect(screen.getByText("Kidney volume.tif")).toBeVisible();
  expect(screen.getByRole("button", { name: "Dock Display" })).toHaveFocus();
  expect(screen.getByLabelText("Z plane")).toHaveValue("1");
  act(() => receive({ ...state, sequence: 10, binding: { ...binding, generation: 2 } }));
  expect(screen.getByLabelText("Z plane")).toHaveValue("1");
  fireEvent.click(screen.getByText("Image info"));
  expect(screen.getByText("1 × 2 × 3 µm", { exact: false })).toBeVisible();
  expect(screen.queryByText("Analysis region")).toBeNull();
  expect(screen.queryByText("Histogram & levels")).toBeNull();

  fireEvent.change(screen.getByLabelText("Z plane"), { target: { value: "2" } });
  expect(api.edit).toHaveBeenLastCalledWith(binding, { kind: "plane", axis: "z", value: 2 });
  fireEvent.change(screen.getByLabelText("Display scope"), { target: { value: "mean" } });
  expect(api.edit).toHaveBeenLastCalledWith(binding, { kind: "projection", value: "mean" });

  const channel = screen.getByRole("checkbox", { name: "Channel 1 visible" }).closest("details")!;
  channel.open = true;
  fireEvent.change(screen.getByLabelText("Channel 1 opacity"), { target: { value: "0.35" } });
  expect(api.edit).toHaveBeenLastCalledWith(binding, { kind: "channel", channel: 0, edit: { field: "opacity", value: 0.35 } });
  const windowWidth = screen.getByLabelText("Channel 1 window");
  fireEvent.change(windowWidth, { target: { value: "123" } });
  fireEvent.keyDown(windowWidth, { key: "Enter" });
  expect(api.edit).toHaveBeenLastCalledWith(binding, { kind: "channel", channel: 0, edit: { field: "window", value: 123 } });
  act(() => receive({ ...state, sequence: 2, rejectedSequence: 2 }));
  expect(windowWidth).toHaveValue("255");
  expect(channel.open).toBe(true);
  const compare = screen.getByRole("button", { name: "Hold to show default display" });
  fireEvent.keyDown(compare, { key: " " });
  expect(api.edit).toHaveBeenLastCalledWith(binding, { kind: "compare", active: true });
  fireEvent.blur(window);
  expect(api.edit).toHaveBeenLastCalledWith(binding, { kind: "compare", active: false });
  fireEvent.click(screen.getByRole("button", { name: "Dock Display" }));
  expect(api.dock).toHaveBeenCalledExactlyOnceWith(binding);
});

const preprocessBinding = { ...binding, kind: "preprocess" as const };
const preprocessSnapshot = {
  kind: "preprocess" as const, source: { id: binding.sourceId, sha256: binding.sourceSha256, name: "Kidney volume.tif" },
  selection: { x: 2, y: 4, width: 12, height: 14, t: 0, c: 0, z: 1, level: 0 },
  dimensions: { x: 32, y: 32, z: 5, t: 1, c: 1 }, spatialUnit: "µm", drawing: false, revision: 4,
  editor: { rows: [{ id: 8, op: "gaussian", parameter: "sigma" as const, value: 2.5 }], selected: 8,
    focus: { kind: "input" as const, id: 8, revision: 2 } },
  previewDisabled: false,
};

it("shows the source Preprocess panel and keeps an unacknowledged number visible during a native dock request", async () => {
  const snapshot = preprocessSnapshot;
  let receive!: (value: DisplayInspectorState) => void;
  const api: DisplayInspectorApi = {
    state: async () => ({ binding: preprocessBinding, sequence: 0, snapshot }),
    dock: vi.fn(async () => {}), edit: vi.fn(async () => {}),
    onState: (listener) => { receive = listener; return () => {}; },
  };
  render(<DetachedDisplayInspector api={api} />);
  expect(await screen.findByRole("heading", { name: "Preprocess" })).toBeVisible();
  expect(document.title).toBe("Loci · Preprocess");
  const dock = screen.getByRole("button", { name: "Dock Preprocess" });
  expect(dock).toHaveFocus();
  expect(screen.getByText("Kidney volume.tif")).toBeVisible();
  expect(screen.getByRole("button", { name: /^Region$/ })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByText("12 × 14 px · 1 plane · X 2, Y 4")).toBeVisible();
  expect(screen.getByText("µm")).toBeVisible();
  expect(screen.queryByLabelText("Z plane")).toBeNull();
  const input = screen.getByLabelText("Step 1 sigma");
  fireEvent.change(input, { target: { value: "1e" } });
  fireEvent.change(input, { target: { value: "1e-" } });
  expect(dock).toBeDisabled();
  expect(screen.getByRole("button", { name: "Preview selected crop" })).toBeDisabled();
  expect(api.edit).toHaveBeenLastCalledWith(preprocessBinding, { kind: "preprocess", request: 2, edit: { kind: "draft", id: 8, text: "1e-" } });
  act(() => receive({ binding: preprocessBinding, sequence: 1, snapshot, acknowledgedRequest: 1, dockRequested: true }));
  expect(input).toHaveValue("1e-");
  expect(api.dock).not.toHaveBeenCalled();
  act(() => receive({ binding: preprocessBinding, sequence: 2, acknowledgedRequest: 2, dockRequested: true,
    snapshot: { ...snapshot, previewDisabled: true, editor: { ...snapshot.editor,
      rows: [{ ...snapshot.editor.rows[0], draft: { text: "1e-", error: "Enter a finite value" } }] } } }));
  expect(input).toHaveAttribute("aria-invalid", "true");
  expect(api.dock).toHaveBeenCalledExactlyOnceWith(preprocessBinding);
});

it("offers numeric recovery only while the owner reports blocked fields", async () => {
  const blocked = { ...preprocessSnapshot, previewDisabled: true, restoreNumbers: true };
  let receive!: (value: DisplayInspectorState) => void;
  const api: DisplayInspectorApi = {
    state: async () => ({ binding: preprocessBinding, sequence: 0, snapshot: blocked }),
    dock: vi.fn(async () => {}), edit: vi.fn(async () => {}),
    onState: (listener) => { receive = listener; return () => {}; },
  };
  render(<DetachedDisplayInspector api={api} />);
  const restore = await screen.findByRole("button", { name: "Restore applied numbers" });
  const preview = screen.getByRole("button", { name: "Preview selected crop" });
  expect(screen.getByRole("status")).toHaveTextContent("Finish numeric fields before previewing or running a recipe.");
  expect(preview).toBeDisabled();
  fireEvent.click(restore);
  expect(api.edit).toHaveBeenCalledExactlyOnceWith(preprocessBinding,
    { kind: "preprocess", request: 1, edit: { kind: "restore-numbers", revision: 4 } });
  expect(restore).toBeDisabled();
  act(() => receive({ binding: preprocessBinding, sequence: 1, snapshot: blocked }));
  expect(restore).toBeDisabled();
  act(() => receive({ binding: preprocessBinding, sequence: 2, acknowledgedRequest: 1, snapshot: preprocessSnapshot }));
  expect(restore).not.toBeInTheDocument();
  expect(preview).toBeEnabled();
});
