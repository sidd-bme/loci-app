// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ResearchDesktopApi, ResearchResult } from "../shared/research-contracts";
import { PERINUCLEAR_VIEWS, type ResearchPerinuclearViewField } from "../shared/perinuclear-contracts";
import { PerinuclearQC } from "./PerinuclearQC";
import { ViewerRequestQueue } from "../main/viewer-request-queue";

afterEach(cleanup);
const geometry = { axes: "YX", unit: "pixel", frame: "image", affine: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]] };
const result: ResearchResult = { id: "a".repeat(32), revision_hash: "b".repeat(64), source_id: "c".repeat(32), source_sha256: "d".repeat(64), kind: "perinuclear-enrichment", created_at: "2026-10-23", object_count: 2,
  arrays: { labels: { shape: [8, 10] } }, geometry };
const view = (field: ResearchPerinuclearViewField) => ({ result_id: result.id, revision_hash: result.revision_hash, geometry,
  shape: [8, 10], axis: "z", index: 0, label_field: field, label_field_basis: PERINUCLEAR_VIEWS[field].basis,
  image: `data:image/png;base64,${field === "nuclei" ? "AA==" : field === "rings" ? "AQ==" : "Ag=="}`, label_image: "data:image/png;base64,AA==" });

it("inspects all three saved masks with honest labels and enlarges them with keyboard focus restoration", async () => {
  const execute = vi.fn(async (_operation: string, request: Record<string, unknown>) => view(request.label_field as ResearchPerinuclearViewField));
  render(<PerinuclearQC api={{ execute } as unknown as ResearchDesktopApi} result={result} />);
  expect(await screen.findByRole("img", { name: "Nuclei (all) over the saved raw signal channel" })).toHaveAttribute("src", view("nuclei").image);
  const field = screen.getByRole("combobox", { name: "Perinuclear overlay" });
  expect(field).toHaveValue("nuclei");
  field.focus(); expect(field).toHaveFocus();
  fireEvent.change(field, { target: { value: "rings" } });
  expect(await screen.findByRole("img", { name: "Perinuclear rings (proxy) over the saved raw signal channel" })).toHaveAttribute("src", view("rings").image);
  expect(execute).toHaveBeenLastCalledWith("result_view", { result_id: result.id, axis: "z", index: 0, labels: true, label_field: "rings" }, { viewer_lane: expect.stringMatching(/^perinuclear-qc-[a-z0-9_-]+$/u) });
  expect(screen.getByText(PERINUCLEAR_VIEWS.rings.basis)).toBeVisible();
  const enlarge = screen.getByRole("button", { name: "Enlarge label inspection" });
  enlarge.focus(); fireEvent.click(enlarge);
  expect(await screen.findByRole("dialog", { name: "Perinuclear label inspection" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Close perinuclear label inspection" })).toHaveFocus();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument(); expect(enlarge).toHaveFocus();
  fireEvent.change(field, { target: { value: "ambiguous" } });
  expect(await screen.findByRole("img", { name: "Shared ring pixels (excluded) over the saved raw signal channel" })).toHaveAttribute("src", view("ambiguous").image);
  expect(screen.getByText(PERINUCLEAR_VIEWS.ambiguous.basis)).toBeVisible();
});

it("suppresses stale mask responses and rejects an overlay for another saved revision", async () => {
  let finish!: (value: unknown) => void;
  const execute = vi.fn((_operation: string, request: Record<string, unknown>) => request.label_field === "nuclei"
    ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve(view("rings")));
  render(<PerinuclearQC api={{ execute } as unknown as ResearchDesktopApi} result={result} />);
  fireEvent.change(screen.getByRole("combobox", { name: "Perinuclear overlay" }), { target: { value: "rings" } });
  await screen.findByRole("img", { name: "Perinuclear rings (proxy) over the saved raw signal channel" });
  await act(async () => { finish(view("nuclei")); });
  expect(screen.queryByRole("img", { name: /Nuclei \(all\)/ })).not.toBeInTheDocument();
  execute.mockResolvedValue({ ...view("ambiguous"), revision_hash: "0".repeat(64) });
  fireEvent.change(screen.getByRole("combobox", { name: "Perinuclear overlay" }), { target: { value: "ambiguous" } });
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("does not match this saved revision"));
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
});

it.each(["history-first", "qc-first"])("keeps history and QC views independent behind a busy decoder (%s)", async (order) => {
  let finishSource!: (value: unknown) => void;
  const sourceDecode = new Promise((resolve) => { finishSource = resolve; });
  const run = vi.fn(async (operation: string, request: unknown) => {
    if (operation === "viewer_tile") return sourceDecode;
    const field = (request as Record<string, unknown>).label_field;
    return field ? view(field as ResearchPerinuclearViewField) : { history: true };
  });
  const queue = new ViewerRequestQueue(run);
  const source = queue.request("viewer_tile", {});
  const historyRequest = { result_id: result.id, axis: "z", index: 0, labels: true };
  const history = () => queue.request("result_view", historyRequest).then(
    value => ({ status: "fulfilled", value }),
    error => ({ status: "rejected", message: (error as Error).message }),
  );
  const execute = vi.fn((operation: string, request: unknown, options?: { viewer_lane: string }) =>
    queue.request(operation, request, options?.viewer_lane));
  let historyOutcome;
  if (order === "history-first") historyOutcome = history();
  render(<PerinuclearQC api={{ execute } as unknown as ResearchDesktopApi} result={result} />);
  if (order === "qc-first") historyOutcome = history();
  await act(async () => { finishSource({ tile: true }); await source; });
  await expect(historyOutcome).resolves.toEqual({ status: "fulfilled", value: { history: true } });
  expect(await screen.findByRole("img", { name: "Nuclei (all) over the saved raw signal channel" })).toHaveAttribute("src", view("nuclei").image);
  expect(screen.getByText(PERINUCLEAR_VIEWS.nuclei.basis)).toBeVisible();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(run).toHaveBeenCalledWith("result_view", historyRequest);
  expect(run).toHaveBeenCalledWith("result_view", expect.objectContaining({ label_field: "nuclei" }));
});
