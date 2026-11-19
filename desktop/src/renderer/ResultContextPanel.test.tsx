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
function cliContext(selected = result): ResearchResultContext {
  const selection = { x: 2, y: 2, width: 20, height: 20, t: 0, c: 0, z: 0, level: 0 };
  const recipe = {
    steps: [{ op: "gaussian", sigma: 0.5 }],
    segmentation: { method: "components", threshold: 120, polarity: "bright", min_size: 4, exclude_border: false },
    measurement_channels: [0],
    gates: [],
    working_bytes: 512 * 1024 ** 2,
  };
  return {
    ...context(selected),
    selection,
    replay: {
      status: "available",
      operation: "run_recipe",
      request: { source_id: selected.source_id, selection, recipe },
      reason: null,
    },
    cli_recipe: {
      status: "available",
      route: "native-2d-level0-cpu-components-run-recipe",
      operation: "run_recipe",
      recipe_sha256: "e".repeat(64),
      reason: null,
    },
  };
}
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
  it("copies a verified CLI-ready recipe.json payload after rechecking and documents static CLI commands", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const eligible = cliContext();
    const execute = vi.fn().mockResolvedValue(eligible);
    const desktop = api(execute);
    const { container } = render(<ResultContextPanel api={desktop} result={result} />);
    open(container);

    const requestButton = await screen.findByRole("button", { name: "Copy analysis request" });
    const cliButton = screen.getByRole("button", { name: "Copy CLI recipe JSON" });
    expect(requestButton).toHaveAttribute("type", "button");
    expect(cliButton).toHaveAttribute("type", "button");

    fireEvent.click(requestButton);
    await screen.findByRole("button", { name: "Request copied" });
    expect(execute).toHaveBeenCalledTimes(1);

    fireEvent.click(cliButton);
    await screen.findByRole("button", { name: "CLI recipe copied" });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenNthCalledWith(2, "describe_result", { result_id: result.id, revision_hash: result.revision_hash });
    expect(execute.mock.calls.every(([op]) => op === "describe_result")).toBe(true);
    expect(screen.getByRole("status")).toHaveTextContent("Copied recipe.json request");

    const analysisPayload = JSON.parse(writeText.mock.calls[0][0]);
    const cliPayload = JSON.parse(writeText.mock.calls[1][0]);
    expect(analysisPayload).toEqual({ operation: "run_recipe", request: eligible.replay.request });
    expect(cliPayload).toEqual(analysisPayload.request);
    expect(cliPayload).not.toHaveProperty("operation");
    expect(JSON.stringify(cliPayload)).not.toMatch(/\/Users\/|\/Volumes\/|\\/u);

    const cliDetails = screen.getByText("Run from CLI").closest("details")!;
    expect(cliDetails).not.toHaveAttribute("open");
    cliDetails.open = true;
    fireEvent(cliDetails, new Event("toggle"));
    expect(cliDetails).toHaveTextContent(/unsaved managed session/i);
    expect(cliDetails).toHaveTextContent(/Save study…/);
    expect(cliDetails).toHaveTextContent(/Loci\.app\/Contents\/Resources\/bin/);
    expect(cliDetails).toHaveTextContent(/PATH/);
    const commandBlock = container.querySelector(".result-context-command")!;
    expect(commandBlock).toHaveTextContent('loci execute --project "$LOCI_STUDY" recipe_preflight --request @recipe.json --json');
    expect(commandBlock).toHaveTextContent('loci submit --project "$LOCI_STUDY" --operation run_recipe --request @recipe.json --request-key "$NEW_KEY" --run --json');
    expect(commandBlock.textContent).not.toContain(result.id);

    const techDetails = screen.getByText("Technical record").closest("details")!;
    techDetails.open = true;
    fireEvent(techDetails, new Event("toggle"));
    expect(screen.getByText("e".repeat(64))).toBeVisible();
  });
  it("keeps generic copy when cli_recipe is unsupported and explains why in technical record", async () => {
    const unsupported: ResearchResultContext = {
      ...cliContext(),
      cli_recipe: {
        status: "unsupported",
        route: null,
        operation: null,
        recipe_sha256: null,
        reason: "CLI recipe copy supports only single-plane 2D analyses.",
      },
    };
    const { container } = render(<ResultContextPanel api={api(vi.fn().mockResolvedValue(unsupported))} result={result} />);
    open(container);
    await screen.findByRole("button", { name: "Copy analysis request" });
    expect(screen.queryByRole("button", { name: "Copy CLI recipe JSON" })).not.toBeInTheDocument();
    expect(screen.queryByText("Run from CLI")).not.toBeInTheDocument();
    const techDetails = screen.getByText("Technical record").closest("details")!;
    techDetails.open = true;
    fireEvent(techDetails, new Event("toggle"));
    expect(screen.getByText(/CLI recipe copy unavailable: CLI recipe copy supports only single-plane 2D analyses\./)).toBeVisible();
  });
  it("refuses CLI copy without writing clipboard when recheck fails due to stale revision or missing source", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const execute = vi.fn()
      .mockResolvedValueOnce(cliContext())
      .mockRejectedValueOnce(new Error("Result description source is unavailable or changed"));
    const { container } = render(<ResultContextPanel api={api(execute)} result={result} />);
    open(container);
    fireEvent.click(await screen.findByRole("button", { name: "Copy CLI recipe JSON" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("source is unavailable or changed");
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Copy CLI recipe JSON" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy analysis request" })).not.toBeInTheDocument();
  });
  it("refuses CLI copy when recheck reports ineligible cli_recipe or mismatched context", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const ineligible: ResearchResultContext = {
      ...cliContext(),
      cli_recipe: {
        status: "unsupported",
        route: null,
        operation: null,
        recipe_sha256: null,
        reason: "Marker gate channel labels no longer match.",
      },
    };
    const execute = vi.fn().mockResolvedValueOnce(cliContext()).mockResolvedValueOnce(ineligible);
    const { container } = render(<ResultContextPanel api={api(execute)} result={result} />);
    open(container);
    fireEvent.click(await screen.findByRole("button", { name: "Copy CLI recipe JSON" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Marker gate channel labels no longer match.");
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Copy CLI recipe JSON" })).not.toBeInTheDocument();

    const mismatchedExecute = vi.fn()
      .mockResolvedValueOnce(cliContext())
      .mockResolvedValueOnce({ ...cliContext(), revision_hash: "0".repeat(64) });
    cleanup();
    const rendered = render(<ResultContextPanel api={api(mismatchedExecute)} result={result} />);
    open(rendered.container);
    fireEvent.click(await screen.findByRole("button", { name: "Copy CLI recipe JSON" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("do not match");
    expect(writeText).not.toHaveBeenCalled();
  });
  it("ignores a late copy verification or clipboard write after the selected result changes", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    let finishRecheck!: (value: unknown) => void;
    const next = { ...result, id: "1".repeat(32), revision_hash: "2".repeat(64) };
    const nextContext = { ...cliContext(next), settings: [{ name: "threshold", value: 300, source: "provenance.segmentation.threshold" }] };
    const execute = vi.fn()
      .mockResolvedValueOnce(cliContext())
      .mockImplementationOnce(() => new Promise((resolve) => { finishRecheck = resolve; }))
      .mockResolvedValueOnce(nextContext);
    const { container, rerender } = render(<ResultContextPanel api={api(execute)} result={result} />);
    open(container);
    fireEvent.click(await screen.findByRole("button", { name: "Copy CLI recipe JSON" }));
    rerender(<ResultContextPanel api={api(execute)} result={next} />);
    expect(await screen.findByText("300")).toBeVisible();
    await act(async () => { finishRecheck(cliContext()); });
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Copy CLI recipe JSON" })).toBeEnabled();

    let resolveWrite!: () => void;
    const delayedWrite = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { resolveWrite = resolve; }));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: delayedWrite } });
    const third = { ...result, id: "3".repeat(32), revision_hash: "4".repeat(64) };
    const thirdContext = { ...cliContext(third), settings: [{ name: "threshold", value: 450, source: "provenance.segmentation.threshold" }] };
    execute.mockResolvedValueOnce(nextContext).mockResolvedValueOnce(thirdContext);
    fireEvent.click(screen.getByRole("button", { name: "Copy CLI recipe JSON" }));
    await act(async () => { await Promise.resolve(); });
    rerender(<ResultContextPanel api={api(execute)} result={third} />);
    expect(await screen.findByText("450")).toBeVisible();
    await act(async () => { resolveWrite(); });
    expect(screen.getByRole("button", { name: "Copy CLI recipe JSON" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "CLI recipe copied" })).not.toBeInTheDocument();
  });
  it("reports clipboard denial or unavailability cleanly while retaining verified context", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("Clipboard denied"));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const desktop = api(vi.fn().mockResolvedValue(cliContext()));
    const { container } = render(<ResultContextPanel api={desktop} result={result} />);
    open(container);
    fireEvent.click(await screen.findByRole("button", { name: "Copy CLI recipe JSON" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not copy the CLI recipe JSON.");
    expect(screen.getByRole("button", { name: "Copy CLI recipe JSON" })).toBeEnabled();
    expect(screen.getByText("120")).toBeVisible();

    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    fireEvent.click(screen.getByRole("button", { name: "Copy analysis request" }));
    expect(await screen.findByText("Could not copy the analysis request.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Copy analysis request" })).toBeEnabled();
  });
  it("cancels an in-flight CLI verification when Analysis details closes", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    let finishRecheck!: (value: unknown) => void;
    const execute = vi.fn()
      .mockResolvedValueOnce(cliContext())
      .mockImplementationOnce(() => new Promise((resolve) => { finishRecheck = resolve; }));
    const { container } = render(<ResultContextPanel api={api(execute)} result={result} />);
    open(container);
    fireEvent.click(await screen.findByRole("button", { name: "Copy CLI recipe JSON" }));
    const details = container.querySelector("details.result-context") as HTMLDetailsElement;
    details.open = false;
    fireEvent(details, new Event("toggle"));
    await act(async () => { finishRecheck(cliContext()); });
    expect(writeText).not.toHaveBeenCalled();
  });
});
