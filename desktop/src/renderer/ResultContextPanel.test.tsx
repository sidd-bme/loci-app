// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResearchDesktopApi, ResearchResult, ResearchResultContext } from "../shared/research-contracts";
import { ResultContextPanel } from "./ResultContextPanel";

const result: ResearchResult = { id: "a".repeat(32), revision_hash: "b".repeat(64), source_id: "c".repeat(32), source_sha256: "d".repeat(64),
  kind: "segmentation", object_count: 5, created_at: "2026-10-15T00:00:00Z" };
function context(selected = result): ResearchResultContext { return {
  schema: "loci.result-context/v1", result_id: selected.id, revision_hash: selected.revision_hash,
  source_id: selected.source_id, source_sha256: selected.source_sha256!, kind: selected.kind,
  method_label: "Threshold segmentation", producing_method_label: "Threshold segmentation", engine_version: "0.1",
  settings: [{ name: "threshold", value: 120, source: "provenance.segmentation.threshold" }],
  runtime: [], model: [], importer: [], correction: [], selection: null, calibration: null,
  channels: { segmentation: 0, measurement: [0], names: [{ index: 0, name: "DNA", source: "source.channels[0]" }] },
  measurement_basis: "raw-source-channel-values", parents: [], unavailable: [],
  replay: { status: "available", operation: "run_recipe", request: { source_id: selected.source_id, recipe: { threshold: 120 } }, reason: null },
}; }
function api(execute = vi.fn().mockResolvedValue(context())) { return { execute } as unknown as ResearchDesktopApi; }
function open(container: HTMLElement) { const details = container.querySelector("details")!; details.open = true; fireEvent(details, new Event("toggle")); }
afterEach(cleanup);

describe("recorded analysis details", () => {
  it("loads only on request and keeps identifiers inside the technical record", async () => {
    const desktop = api();
    const { container } = render(<ResultContextPanel api={desktop} result={result} />);
    expect(desktop.execute).not.toHaveBeenCalled();
    open(container);
    expect(await screen.findByText("120")).toBeVisible();
    expect(desktop.execute).toHaveBeenCalledWith("describe_result", { result_id: result.id, revision_hash: result.revision_hash });
    expect(screen.getByText(result.revision_hash)).not.toBeVisible();
    expect(screen.getByText("Threshold segmentation")).toBeVisible();
  });
  it("rejects a context for another result revision", async () => {
    const { container } = render(<ResultContextPanel api={api(vi.fn().mockResolvedValue({ ...context(), revision_hash: "other" }))} result={result} />);
    open(container);
    expect(await screen.findByRole("alert")).toHaveTextContent("do not match");
    expect(screen.queryByText("120")).not.toBeInTheDocument();
  });
  it("ignores a late description after the selected result changes", async () => {
    let finish!: (value: unknown) => void;
    const next = { ...result, id: "e".repeat(32), revision_hash: "f".repeat(64) };
    const latest = { ...context(next), settings: [{ name: "threshold", value: 300, source: "provenance.segmentation.threshold" }] };
    const desktop = api(vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValue(latest));
    const { container, rerender } = render(<ResultContextPanel api={desktop} result={result} />);
    open(container);
    rerender(<ResultContextPanel api={desktop} result={next} />);
    expect(await screen.findByText("300")).toBeVisible();
    await act(async () => { finish(context()); });
    expect(screen.queryByText("120")).not.toBeInTheDocument();
    expect(screen.getByText("300")).toBeVisible();
  });
  it("copies the recorded request without running it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const desktop = api();
    const { container } = render(<ResultContextPanel api={desktop} result={result} />);
    open(container);
    fireEvent.click(await screen.findByRole("button", { name: "Copy analysis request" }));
    await screen.findByRole("button", { name: "Request copied" });
    expect(JSON.parse(writeText.mock.calls[0][0])).toEqual({ operation: "run_recipe", request: context().replay.request });
    expect(desktop.execute).toHaveBeenCalledTimes(1);
  });
  it("does not create a request when persisted settings cannot reconstruct it", async () => {
    const value = { ...context(), replay: { status: "unsupported", operation: null, request: null, reason: "Original request unavailable." } };
    const { container } = render(<ResultContextPanel api={api(vi.fn().mockResolvedValue(value))} result={result} />);
    open(container); await screen.findByText("120");
    expect(screen.queryByRole("button", { name: "Copy analysis request" })).not.toBeInTheDocument();
  });
});
