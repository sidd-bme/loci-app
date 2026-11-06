// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControlledMethodBinding, ControlledMethodInfo } from "../shared/controlled-method-contracts";
import type { ResearchDesktopApi, ResearchResult, ResearchSnapshot, ResearchSource } from "../shared/research-contracts";
import { ControlledMethodSummary, ResearchControlledMethodsPanel } from "./ResearchControlledMethodsPanel";
afterEach(cleanup);
const hash = (v: string) => v.repeat(64), identity = (v: string) => v.repeat(32);
const source: ResearchSource = { id: identity("a"), sha256: hash("b"), name: "Generated controlled-method fixture", metadata: { dimensions: { c: 2, z: 1, t: 1, y: 8, x: 10 } } };
const parent: ResearchResult = { id: identity("c"), revision_hash: hash("d"), source_id: source.id, source_sha256: source.sha256, kind: "segmentation", created_at: "2026-11-06", object_count: 2,
  selection: { x: 0, y: 0, width: 10, height: 8, c: 1, z: 0, t: 0, level: 0 }, geometry: { axes: "YX", unit: "pixel" }, arrays: { image: { sha256: hash("e") }, labels: { sha256: hash("f") } } };
const method: ControlledMethodInfo = { method_id: identity("1"), manifest_sha256: hash("2"), module_sha256: hash("3"), rights_status: "approved",
  manifest: { schema: "loci.controlled-method/v1", id: "fixture-intensity", version: "1.0.0", abi: "loci-buffer-v1", module: { sha256: hash("3"), bytes: 20 }, rights: { license: "Apache-2.0", source: "Generated regression fixture", use_basis: "Fixture-only method" },
    metrics: [{ id: "intensity", kind: "measurement", unit: "raw-count", description: "Mean raw intensity" }, { id: "score", kind: "prediction", unit: "dimensionless", description: "Declared model score" }] },
  runtime: { available: true, execution_available: false, qualification: "not-established", execution_reason: "No current accepted native runtime qualification is installed" } };
function binding(channels = [1]): ControlledMethodBinding { return { method_id: method.method_id, manifest_sha256: method.manifest_sha256, module_sha256: method.module_sha256, result_id: parent.id, revision_hash: parent.revision_hash, raw_channels: channels, working_bytes: 16 * 1024 ** 2 }; }
function flight(channels = [1]) { return { preflight_hash: hash("4"), preflight: { request: binding(channels), input_sha256: hash("5"), label_ids: [7, 42], estimated_working_bytes: 1024 ** 2 }, runtime: method.runtime }; }
const grant = { output_grant_id: identity("6"), output_sha256: hash("7"), preflight_hash: hash("4") };
function saved(): ResearchResult { return { ...parent, id: identity("8"), revision_hash: hash("9"), parent_id: parent.id, kind: "controlled-method", controlled_method: { schema: "loci.controlled-method-derivative/v1", method_id: method.method_id, manifest_sha256: method.manifest_sha256, module_sha256: method.module_sha256,
  input_sha256: hash("5"), output_sha256: grant.output_sha256, preflight_hash: grant.preflight_hash, origin: "adopted-external", total_rows: 2, raw_channels: [1], metrics: method.manifest.metrics } }; }
function runResponse() { const result = saved(); return { result, job: { id: identity("0"), operation: "method_run", state: "succeeded", request: { ...binding(), preflight_hash: hash("4"), mode: "adopt-external", output_grant_id: grant.output_grant_id }, result_ids: [result.id] } }; }
function setup(initialList?: Promise<unknown>) {
  const execute = vi.fn().mockImplementation(async (operation: string) => operation === "method_list" ? initialList ?? { methods: [method], next_offset: null } : operation === "method_preflight" ? flight() : runResponse());
  const api = { execute, importControlledMethod: vi.fn().mockResolvedValue(null), chooseControlledMethodOutput: vi.fn().mockResolvedValue(grant), exportControlledMethodInput: vi.fn().mockResolvedValue(null) } as unknown as ResearchDesktopApi;
  const props = { api, snapshot: { project: { title: "Fixture study", project_id: identity("a") }, sources: [source], results: [parent] } as ResearchSnapshot,
    source, selectedResult: null as ResearchResult | null, active: true, busy: false, workingBytes: 16 * 1024 ** 2, onBusyChange: vi.fn(), onPublished: vi.fn().mockResolvedValue(undefined) };
  return { ...render(<ResearchControlledMethodsPanel {...props} />), props, api, execute };
}
async function choose() {
  await screen.findByRole("option", { name: "fixture-intensity · 1.0.0" });
  fireEvent.change(screen.getByLabelText("Registered method"), { target: { value: method.method_id } });
  fireEvent.change(screen.getByLabelText("Input label result"), { target: { value: `${parent.id}:${parent.revision_hash}` } });
}
async function checked() { fireEvent.click(screen.getByRole("button", { name: "Check method inputs" })); return screen.findByRole("region", { name: "Exact method input ready" }); }
async function external() { await checked(); fireEvent.click(screen.getByRole("button", { name: "Choose external output" })); return screen.findByRole("button", { name: "Adopt external output" }); }

describe("Controlled method researcher workflow", () => {
  it("lists existing methods and imports data through the native picker without executing", async () => {
    const v = setup(); await screen.findByRole("option", { name: "fixture-intensity · 1.0.0" });
    let finish!: (m: ControlledMethodInfo) => void;
    vi.mocked(v.api.importControlledMethod!).mockImplementationOnce(() => new Promise(resolve => { finish = resolve as typeof finish; }));
    fireEvent.click(screen.getByRole("button", { name: "Import method package" })); v.rerender(<ResearchControlledMethodsPanel {...v.props} busy />);
    await act(async () => { finish({ ...method, manifest: { ...method.manifest, version: "1.1.0" } }); });
    expect(screen.getByLabelText("Registered method")).toHaveValue(method.method_id); expect(screen.getByRole("option", { name: "fixture-intensity · 1.1.0" })).toBeInTheDocument();
    expect(v.execute.mock.calls.map(call => call[0])).toEqual(["method_list"]); expect(v.props.onBusyChange.mock.calls).toEqual([[true], [false]]);
  });
  it("preserves a just-imported method when an older listing completes late", async () => {
    let finish!: (value: unknown) => void;
    const v = setup(new Promise(resolve => { finish = resolve; }));
    vi.mocked(v.api.importControlledMethod!).mockResolvedValueOnce(method);
    fireEvent.click(screen.getByRole("button", { name: "Import method package" })); await screen.findByRole("option", { name: "fixture-intensity · 1.0.0" });
    await act(async () => { finish({ methods: [], next_offset: null }); });
    expect(screen.getByLabelText("Registered method")).toHaveValue(method.method_id); expect(screen.getByRole("option", { name: "fixture-intensity · 1.0.0" })).toBeInTheDocument();
  });
  it("loads the next bounded method page without changing the selected method and refuses a skipping cursor", async () => {
    const make = (n: number): ControlledMethodInfo => ({ ...method, method_id: n.toString(16).padStart(32, "0"), manifest_sha256: n.toString(16).padStart(64, "0"), manifest: { ...method.manifest, id: `fixture-${n}` } });
    const first = Array.from({ length: 50 }, (_, index) => make(index + 100));
    const v = setup(Promise.resolve({ methods: first, next_offset: 50 }));
    await screen.findByRole("option", { name: "fixture-100 · 1.0.0" }); fireEvent.change(screen.getByLabelText("Registered method"), { target: { value: first[0].method_id } });
    v.execute.mockResolvedValueOnce({ methods: Array.from({ length: 50 }, (_, index) => make(index + 150)), next_offset: 100 });
    fireEvent.click(screen.getByRole("button", { name: "Load more methods" })); await screen.findByRole("option", { name: "fixture-199 · 1.0.0" });
    expect(v.execute).toHaveBeenLastCalledWith("method_list", { offset: 50, limit: 50 }); expect(screen.getByLabelText("Registered method")).toHaveValue(first[0].method_id);
    expect(screen.getAllByRole("option").filter(option => option.parentElement === screen.getByLabelText("Registered method"))).toHaveLength(101);
    v.execute.mockResolvedValueOnce({ methods: [make(200)], next_offset: 200 }); fireEvent.click(screen.getByRole("button", { name: "Load more methods" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("registered method page is inconsistent"); expect(screen.queryByRole("option", { name: "fixture-200 · 1.0.0" })).not.toBeInTheDocument(); expect(screen.getByLabelText("Registered method")).toHaveValue(first[0].method_id);
    v.execute.mockResolvedValueOnce({ methods: [make(200)], next_offset: null }); fireEvent.click(screen.getByRole("button", { name: "Load more methods" })); await screen.findByRole("option", { name: "fixture-200 · 1.0.0" });
    expect(v.execute).toHaveBeenLastCalledWith("method_list", { offset: 100, limit: 50 }); expect(screen.queryByRole("button", { name: "Load more methods" })).not.toBeInTheDocument();
  });
  it("preflights exact parent revision and selected raw-channel order, then invalidates on channel changes", async () => {
    const v = setup(); await choose(); fireEvent.click(screen.getByLabelText("Channel 1")); v.execute.mockResolvedValueOnce(flight([1, 0])); await checked();
    expect(v.execute).toHaveBeenLastCalledWith("method_preflight", binding([1, 0])); expect(screen.getByText("Channel 2 → Channel 1")).toBeVisible();
    fireEvent.click(screen.getByLabelText("Channel 2")); expect(screen.queryByRole("region", { name: "Exact method input ready" })).not.toBeInTheDocument();
  });
  it("adopts only a completed exact external job with retained input and output identity", async () => {
    const v = setup(); await choose(); fireEvent.click(await external());
    await waitFor(() => expect(v.props.onPublished).toHaveBeenCalledExactlyOnceWith(saved()));
    expect(v.api.chooseControlledMethodOutput).toHaveBeenCalledExactlyOnceWith({ ...binding(), preflight_hash: hash("4") }); expect(v.execute).toHaveBeenLastCalledWith("method_run", runResponse().job.request);
    expect(screen.getByText(/their production remains unverified/)).toBeVisible();
  });
  it("rejects a completed result whose durable job records a different request", async () => {
    const v = setup(); await choose(); const adopt = await external(); const response = runResponse(); response.job.request.raw_channels = [0]; v.execute.mockResolvedValueOnce(response); fireEvent.click(adopt);
    expect(await screen.findByRole("alert")).toHaveTextContent("completed job and exact input"); expect(v.props.onPublished).not.toHaveBeenCalled();
  });
  it("rejects method output bound to a different preflight input buffer", async () => {
    const v = setup(); await choose(); const adopt = await external(); const response = runResponse(); response.result.controlled_method = { ...response.result.controlled_method as object, input_sha256: hash("a") }; v.execute.mockResolvedValueOnce(response); fireEvent.click(adopt);
    expect(await screen.findByRole("alert")).toHaveTextContent("provenance differs"); expect(v.props.onPublished).not.toHaveBeenCalled();
  });
  it("requires explicit accepted native qualification before any local execution", async () => {
    const v = setup(); await choose(); v.execute.mockResolvedValueOnce({ ...flight(), runtime: { ...method.runtime, execution_available: true } }); await checked();
    const run = screen.getByRole("button", { name: "Run locally" }); expect(run).toBeDisabled(); fireEvent.click(run); expect(v.execute.mock.calls.some(call => call[0] === "method_run")).toBe(false);
  });
  it("treats native cancel as no change and ignores a delayed output picker after a study switch", async () => {
    const v = setup(); await choose(); await checked(); vi.mocked(v.api.chooseControlledMethodOutput!).mockResolvedValueOnce(null);
    fireEvent.click(screen.getByRole("button", { name: "Choose external output" })); await waitFor(() => expect(v.props.onBusyChange).toHaveBeenLastCalledWith(false)); expect(screen.queryByRole("button", { name: "Adopt external output" })).not.toBeInTheDocument(); expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    let finish!: (value: typeof grant) => void; vi.mocked(v.api.chooseControlledMethodOutput!).mockImplementationOnce(() => new Promise(resolve => { finish = resolve as typeof finish; }));
    fireEvent.click(screen.getByRole("button", { name: "Choose external output" })); v.rerender(<ResearchControlledMethodsPanel {...v.props} snapshot={{ ...v.props.snapshot, project: { title: "Other study", project_id: identity("b") } }} />);
    await act(async () => { finish(grant); }); expect(screen.queryByRole("button", { name: "Adopt external output" })).not.toBeInTheDocument(); expect(v.props.onPublished).not.toHaveBeenCalled();
  });
});

describe("Retained controlled-method values", () => {
  it("preserves precise values and explicit measurement/prediction units", async () => {
    const result = saved(), execute = vi.fn().mockResolvedValue({ result_id: result.id, revision_hash: result.revision_hash, total_rows: 2, next_offset: null, rows: [{ label_id: 7, values: [0.1234567890123456, -2] }, { label_id: 42, values: [1, 0.25] }] });
    render(<ControlledMethodSummary api={{ execute } as unknown as ResearchDesktopApi} result={result} />); fireEvent.click(screen.getByText("Inspect method values"));
    expect(await screen.findByText("0.1234567890123456")).toBeVisible(); expect(screen.getByText("measurement · raw-count")).toBeVisible(); expect(screen.getByText("prediction · dimensionless")).toBeVisible();
    expect(execute).toHaveBeenCalledExactlyOnceWith("method_query", { result_id: result.id, revision_hash: result.revision_hash, offset: 0, limit: 25 }); expect(screen.getByRole("button", { name: "Next values" })).toBeDisabled();
  });
  it("rejects a page cursor that would skip retained values", async () => {
    const result = saved(), execute = vi.fn().mockResolvedValue({ result_id: result.id, revision_hash: result.revision_hash, total_rows: 2, next_offset: 99, rows: [{ label_id: 7, values: [1, 2] }, { label_id: 42, values: [3, 4] }] });
    render(<ControlledMethodSummary api={{ execute } as unknown as ResearchDesktopApi} result={result} />); fireEvent.click(screen.getByText("Inspect method values")); expect(await screen.findByRole("alert")).toHaveTextContent("do not match this exact result"); expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
  it("ignores delayed query rows after the saved revision changes", async () => {
    const result = saved(); let finish!: (value: unknown) => void; const execute = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue({ result_id: result.id, revision_hash: hash("a"), total_rows: 2, next_offset: null, rows: [{ label_id: 7, values: [8, 9] }, { label_id: 42, values: [10, 11] }] });
    const api = { execute } as unknown as ResearchDesktopApi, v = render(<ControlledMethodSummary api={api} result={result} />); fireEvent.click(screen.getByText("Inspect method values")); await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    v.rerender(<ControlledMethodSummary api={api} result={{ ...result, revision_hash: hash("a") }} />); await screen.findByText("11");
    await act(async () => { finish({ result_id: result.id, revision_hash: result.revision_hash, total_rows: 2, next_offset: null, rows: [{ label_id: 7, values: [999, 999] }, { label_id: 42, values: [999, 999] }] }); }); expect(screen.queryByText("999")).not.toBeInTheDocument(); expect(within(screen.getByRole("table")).getByText("11")).toBeVisible();
  });
});
