// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ResearchDesktopApi, ResearchSource } from "../shared/research-contracts";
import { VirtualStainPanel } from "./VirtualStainPanel";

afterEach(cleanup);

const source: ResearchSource = {
  id: "a".repeat(32), sha256: "1".repeat(64), name: "WTC11.ome.tif",
  metadata: { format: "OME-TIFF", dimensions: { t: 2, c: 2, z: 40, y: 512, x: 512 }, sample_semantics: "none",
    channel_names: ["Nuclei", "Phase3D"], channel_dtypes: ["float32", "float32"],
    physical_calibration: { unit: "µm", spacing: [0.29, 0.108, 0.108] } },
};
it("requires explicit installation and an eligible declared phase channel before running", async () => {
  let installed = false;
  const run = vi.fn(async () => {});
  const api = {
    dynacellStatus: async () => installed ? "ready" : "missing",
    installDynacell: vi.fn(async () => { installed = true; return true; }), runVirtualStain: vi.fn(),
  } as unknown as ResearchDesktopApi;
  render(<VirtualStainPanel api={api} source={source} timepoint={1} busy={false} onRun={run} />);
  await waitFor(() => expect(screen.getByText("Install from Biohub")).toBeEnabled());
  expect(api.installDynacell).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Import checkpoint…" }));
  await screen.findByText("Verified checkpoint available offline");
  expect(run).not.toHaveBeenCalled();
  const predict = screen.getByRole("button", { name: "Predict nuclear stain…" });
  expect(predict).toBeDisabled();
  const channel = screen.getByLabelText("Reconstructed phase channel");
  expect(channel).toHaveValue("1");
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.change(channel, { target: { value: "0" } });
  expect(screen.getByText(/recorded as Phase3D/)).toBeVisible();
  expect(predict).toBeDisabled();
  fireEvent.change(channel, { target: { value: "1" } });
  expect(predict).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(predict);
  await waitFor(() => expect(run).toHaveBeenCalledWith({
    source_id: source.id, source_sha256: source.sha256, channel: 1, timepoint: 1, phase_confirmed: true,
  }));
});

it("keeps prediction unavailable on a different grid", async () => {
  const api = { dynacellStatus: async () => "ready", runVirtualStain: vi.fn() } as unknown as ResearchDesktopApi;
  render(<VirtualStainPanel api={api} source={{ ...source, metadata: { ...source.metadata, physical_calibration: null } }}
    timepoint={0} busy={false} onRun={vi.fn()} />);
  await screen.findByText("Verified checkpoint available offline");
  expect(screen.getByText(/native spacing/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Predict nuclear stain…" })).toBeDisabled();
});
