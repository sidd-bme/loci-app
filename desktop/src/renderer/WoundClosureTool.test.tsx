// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, webcrypto } from "node:crypto";
import type { ResearchDesktopApi, ResearchSnapshot } from "../shared/research-contracts";
import type { WoundClosurePanelProps } from "./WoundClosurePanel";
import { loadWoundMaskLabels, WoundClosureTool } from "./WoundClosureTool";
import type { WoundBinding, WoundRequest, WoundSummary } from "./wound-closure-types";

const { captured } = vi.hoisted(() => ({ captured: { current: null as unknown } }));
// The standalone panel has its own scientific-form and display regressions.
// This adapter harness captures callback props while exercising the real wrapper.
vi.mock("./WoundClosurePanel", () => ({ WoundClosurePanel: (props: WoundClosurePanelProps) => { captured.current = props; return null; } }));
beforeEach(() => { vi.stubGlobal("crypto", webcrypto); captured.current = null; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const panel = () => captured.current as WoundClosurePanelProps;
const reportHash = "8".repeat(64), reportId = reportHash.slice(0, 32), projectId = "f".repeat(32);
const exact: WoundBinding = { result_id: "a".repeat(32), revision_hash: "a".repeat(64), source_id: "1".repeat(32), source_sha256: "1".repeat(64) };
const other: WoundBinding = { result_id: "b".repeat(32), revision_hash: "b".repeat(64), source_id: "2".repeat(32), source_sha256: "2".repeat(64) };
const token = { preview_id: "6".repeat(32), preview_hash: "9".repeat(64) };
const canonical = (v: unknown): string => Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v);
const hash = (v: unknown) => createHash("sha256").update(canonical(v)).digest("hex");
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
const labels = Array.from({ length: 1001 }, (_, i) => 100001 + i * 2);
function population(request: Record<string, unknown>, values = labels, b = exact) {
  const offset = Number(request.offset), limit = Number(request.limit), query = { x_metric: "measure", y_metric: "voxel_count", filters: [], sort: { metric: "label", direction: "asc" }, offset, limit, plot_limit: 1, bins: 1, selected_label: null };
  const membership = hash({ ...b, filters: [], labels: values });
  return { schema: "loci.population/v1", ...b, query, total_count: values.length, filtered_count: values.length,
    rows: values.slice(offset, offset + limit).map((label, i) => ({ label, values: { measure: 1, voxel_count: 1 }, index_axes: "YX", centroid_index: [Math.floor((offset + i) / 40), (offset + i) % 40], bbox_start: [Math.floor((offset + i) / 40), (offset + i) % 40], bbox_stop_exclusive: [Math.floor((offset + i) / 40) + 1, (offset + i) % 40 + 1] })),
    metrics: [{ id: "measure", label: "Area", kind: "area", unit: "um^2" }, { id: "voxel_count", label: "Pixels", kind: "count", unit: "pixel" }],
    accounting: { filter_excluded_count: 0, filter_missing_count: 0, scatter_missing_count: 0, metric_missing_counts: { measure: 0, voxel_count: 0 } },
    scatter: { points: values.length ? [{ label: values[0], x: 1, y: 1 }] : [], total_count: values.length, displayed_count: values.length ? 1 : 0, sampled: values.length > 1, sampling: values.length > 1 ? "deterministic-evenly-spaced-label-order" : "all" },
    histogram: { metric: "measure", edges: values.length ? [1, 1] : [], counts: values.length ? [values.length] : [], finite_count: values.length, missing_count: 0, endpoints: "left-closed-right-open-last-closed" },
    summaries: { x: { metric: "measure", count: values.length, missing_count: 0, min: values.length ? 1 : null, max: values.length ? 1 : null, mean: values.length ? 1 : null, median: values.length ? 1 : null }, y: { metric: "voxel_count", count: values.length, missing_count: 0, min: values.length ? 1 : null, max: values.length ? 1 : null, mean: values.length ? 1 : null, median: values.length ? 1 : null } }, selected: null,
    membership_sha256: membership, query_sha256: hash({ ...b, query, membership_sha256: membership }) };
}
const request: WoundRequest = { frames: [exact, other].map((b, i) => ({ frame_id: `Frame ${i + 1}`, result_id: b.result_id, revision_hash: b.revision_hash, selected_labels: [1], mask_semantics: "filled-wound-area" })),
  time_s: [0, 15], time_unit: "s", time_declaration: "Recorded seconds", specimen_id: "Specimen", sequence_id: "Sequence", area_declaration: "Explicit filled region union", grid_declaration: "Original unchanged grid", working_bytes: 256 * 1024 ** 2 };
function saved() {
  const frames = [72, 36].map((area, i) => ({ frame_id: `Frame ${i + 1}`, time_s: i * 15, status: "observed" as const, selected_pixel_count: area, excluded_positive_pixel_count: 0, area, area_fraction: area / 72, closure_fraction: 1 - area / 72 }));
  const intervals = [{ from_frame_id: "Frame 1", to_frame_id: "Frame 2", delta_time_s: 15, status: "defined" as const, area_change_rate: -2.4, closure_change_rate: 0.5 / 15 }];
  const inputs = [exact, other].map((b, i) => ({ ...b, frame_id: `Frame ${i + 1}`, time_s: i * 15, specimen_id: request.specimen_id, sequence_id: request.sequence_id,
    result_record_sha256: reportHash, mask_semantics: "filled-wound-area" as const, selected_label_count: 1, selected_labels_sha256: hash([1]),
    selection: { x: 0, y: 0, width: 40, height: 40, t: i, z: 0, c: 0, level: 0 }, geometry: { axes: "YX", unit: "um", frame: "image", affine: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]] }, labels: { sha256: reportHash, bytes: 6400, shape: [40, 40], dtype: "uint32" }, sample: null }));
  const tables = { frames: { total: 2, returned: 2, has_more: false, next_offset: null }, inputs: { total: 2, returned: 2, has_more: false, next_offset: null }, intervals: { total: 1, returned: 1, has_more: false, next_offset: null } };
  const summary: WoundSummary = { schema: "loci.wound-closure-summary/v1", report_schema: "loci.wound-closure-report/v1", report_hash: reportHash, request_sha256: hash(request), created_at: "2026-10-30", software: { engine: "fixture" },
    measurement: { specimen_id: request.specimen_id, sequence_id: request.sequence_id, time_unit: "s", area_unit: "um^2", baseline_frame_id: "Frame 1", baseline_area: 72, calibration_status: "declared-physical-calibration", area_declaration: request.area_declaration, grid_declaration: request.grid_declaration, rules: { intervals: "Adjacent observed slots only" } },
    sample_identity: { study: "Generated study", biological_replicate: "Declared donor", missing_sample_frames: 2, unassigned_biological_replicate_frames: 0, basis: "Captured declarations" }, totals: { scheduled_frames: 2, observed_frames: 2, missing_frames: 0 }, tables, frames, inputs, intervals };
  return { report_id: reportId, report: { schema: "loci.wound-closure-report/v1", report_hash: reportHash, request }, summary, status: { current: true, changes: [] } };
}
const job = { id: "7".repeat(32), operation: "wound_closure_save", request: { source_id: exact.source_id, task_request: token }, report_id: reportId,
  request_key: "native-save-key", request_hash: "5".repeat(64), state: "succeeded" as const, created_at: "2026-10-30", updated_at: "2026-10-30", progress: 1, cancel_requested: false, result_ids: [], error: null };
const snapshot = { project: { project_id: projectId, title: "Generated study" }, sources: [exact, other].map((b, i) => ({ id: b.source_id, sha256: b.source_sha256, name: `Source ${i + 1}`, metadata: {} })),
  results: [exact, other].map((b) => ({ id: b.result_id, revision_hash: b.revision_hash, source_id: b.source_id, source_sha256: b.source_sha256, kind: "segmentation", schema: "loci.research-result/v1", created_at: "2026-10-30", object_count: 1001, arrays: { labels: { shape: [40, 40], dtype: "uint32", sha256: reportHash } } })), samples: [], recipes: [], displays: [], selections: [], jobs: [job], operations: {} } as ResearchSnapshot;
const plan = { schema: "loci.wound-closure-export-plan/v1" as const, report_id: reportId, report_hash: reportHash, plan_hash: "4".repeat(64), status: { current: true, changes: [] } };
function apiFor(overrides: Partial<ResearchDesktopApi> = {}) {
  return { getSnapshot: vi.fn(async () => snapshot), execute: vi.fn(async (operation: string, args: Record<string, unknown>) => {
    if (operation === "wound_closure_list") return { reports: [{ id: reportId, created_at: "2026-10-30", specimen_id: "Specimen", sequence_id: "Sequence", status: { current: true, changes: [] } }] };
    if (operation === "population_query") return population(args);
    if (operation === "wound_closure_save") return { ...saved(), job };
    if (operation === "wound_closure_get") return saved();
    if (operation === "wound_closure_preview") return { preview_id: token.preview_id, preview_hash: token.preview_hash, summary: saved().summary };
    if (operation === "review_history") return { result_id: args.result_id, revision_hash: exact.revision_hash, total_events: 0, next_offset: null, events: [], current_review_sha256: null };
    throw new Error(`Unexpected native operation ${operation}`);
  }), reviewResult: vi.fn(), planWoundClosureExport: vi.fn(async () => plan), exportWoundClosureReport: vi.fn(async () => ({ schema: "loci.wound-closure-export-receipt/v1" as const, basename: "wound-export", report_hash: reportHash, manifest_sha256: "3".repeat(64) })), cancelDataExport: vi.fn(async () => ({ cancelled: true })), ...overrides } as unknown as ResearchDesktopApi;
}
function mount(api = apiFor(), next = snapshot) { const onInspect = vi.fn(), onRefresh = vi.fn(); const rendered = render(<WoundClosureTool api={api} snapshot={next} onInspect={onInspect} onRefresh={onRefresh} />); return { api, onInspect, onRefresh, ...rendered }; }

describe("complete exact wound mask membership", () => {
  it("loads all noncontiguous labels beyond 1000 through real population offsets", async () => {
    const api = apiFor(); const actual = await loadWoundMaskLabels(api, exact, () => true);
    expect(actual).toEqual(labels); expect(actual).toHaveLength(1001);
    const calls = vi.mocked(api.execute).mock.calls; expect(calls).toHaveLength(6);
    expect(calls.at(-1)).toEqual(["population_query", { result_id: exact.result_id, revision_hash: exact.revision_hash, filters: [], sort: { metric: "label", direction: "asc" }, offset: 1000, limit: 200, plot_limit: 1, bins: 1 }]);
  });
  it.each(["wrong revision", "changed membership", "duplicate label", "empty page"])("refuses %s without returning partial membership", async (kind) => {
    const api = apiFor({ execute: vi.fn(async (_op: string, args: Record<string, unknown>) => {
      const value = population(args);
      if (Number(args.offset) > 0) {
        if (kind === "wrong revision") value.revision_hash = "f".repeat(64);
        if (kind === "changed membership") value.membership_sha256 = "f".repeat(64);
        if (kind === "duplicate label") value.rows[0].label = labels[0];
        if (kind === "empty page") value.rows = [];
      }
      return value;
    }) });
    await expect(loadWoundMaskLabels(api, exact, () => true)).rejects.toThrow();
  });
  it("drops a cancelled read before requesting another page", async () => {
    let live = true; const api = apiFor({ execute: vi.fn(async (_op: string, args: Record<string, unknown>) => { live = false; return population(args); }) });
    expect(await loadWoundMaskLabels(api, exact, () => live)).toBeNull(); expect(api.execute).toHaveBeenCalledTimes(1);
  });
  it("adds only a fully resolved mask choice to the authoring panel", async () => {
    const { api } = mount();
    fireEvent.change(screen.getByLabelText("Saved label mask"), { target: { value: `${exact.result_id}:${exact.revision_hash}` } });
    fireEvent.click(screen.getByRole("button", { name: "Load complete mask labels" }));
    await waitFor(() => expect(panel().masks[0]?.label_ids).toEqual(labels));
    expect(panel().inspectionBindings).toHaveLength(2);
    expect(api.execute).not.toHaveBeenCalledWith("result", expect.anything());
  });
});

describe("durable native wound saves", () => {
  it("awaits the final native worker reply and terminal snapshot before loading the report", async () => {
    const completion = deferred<unknown>(), snap = deferred<ResearchSnapshot>(), base = apiFor();
    const api = apiFor({ execute: vi.fn(async (op: string, args: Record<string, unknown>) => op === "wound_closure_save" ? completion.promise : base.execute(op, args)), getSnapshot: vi.fn(() => snap.promise) });
    const { onRefresh } = mount(api); let pending!: Promise<unknown>;
    act(() => { pending = panel().onSave(token); });
    expect(api.getSnapshot).not.toHaveBeenCalled();
    await act(async () => { completion.resolve({ ...saved(), job }); });
    expect(api.getSnapshot).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.execute).mock.calls.filter(([op]) => op === "wound_closure_get")).toHaveLength(0);
    await act(async () => { snap.resolve(snapshot); await pending; });
    expect(api.execute).toHaveBeenCalledWith("wound_closure_get", { report_id: reportId }); expect(onRefresh).toHaveBeenCalledWith(snapshot);
  });
  it.each(["running", "wrong token", "agent owner"])("rejects a %s save job before report disclosure", async (kind) => {
    const invalid = { ...job, ...(kind === "running" ? { state: "running" } : kind === "agent owner" ? { owner: { policy_sha256: reportHash, session_id: "6".repeat(32) } } : { request: { ...job.request, task_request: { ...token, preview_hash: "f".repeat(64) } } }) };
    const base = apiFor(), api = apiFor({ execute: vi.fn(async (op: string, args: Record<string, unknown>) => op === "wound_closure_save" ? { ...saved(), job: invalid } : base.execute(op, args)) });
    mount(api); await act(async () => { await expect(panel().onSave(token)).rejects.toThrow(/terminal job/u); }); expect(api.getSnapshot).not.toHaveBeenCalled();
  });
  it("does not load saved science after the native study snapshot has closed", async () => {
    const api = apiFor({ getSnapshot: vi.fn(async () => null) }); mount(api);
    await act(async () => { await expect(panel().onSave(token)).rejects.toThrow(/different study/u); });
    expect(vi.mocked(api.execute).mock.calls.some(([op]) => op === "wound_closure_get")).toBe(false);
  });
  it("refuses a snapshot that has not retained the succeeded job", async () => {
    const api = apiFor({ getSnapshot: vi.fn(async () => ({ ...snapshot, jobs: [{ ...job, state: "running" as const }] })) });
    mount(api); await act(async () => { await expect(panel().onSave(token)).rejects.toThrow(/terminal state/u); });
    expect(vi.mocked(api.execute).mock.calls.some(([op]) => op === "wound_closure_get")).toBe(false);
  });
});

describe("native export and existing review histories", () => {
  it("uses exact native plan/receipt methods without any renderer destination path", async () => {
    const { api, onRefresh } = mount();
    await act(async () => { await panel().onExport({ report_id: reportId, report_hash: reportHash }); });
    const call = vi.mocked(api.planWoundClosureExport!).mock.calls[0]; expect(call[0]).toBe(reportId); expect(call[1]).toMatch(/^scientific-export:/u);
    expect(api.exportWoundClosureReport).toHaveBeenCalledWith(reportId, plan.plan_hash, call[1]); expect(onRefresh).toHaveBeenCalledWith(snapshot);
    expect(screen.getByText(/Exported wound-export/u)).toBeInTheDocument();
    expect(vi.mocked(api.execute).mock.calls.some(([op]) => op === "wound_closure_export")).toBe(false);
  });
  it("reports native picker cancellation without claiming export", async () => {
    mount(apiFor({ exportWoundClosureReport: vi.fn(async () => null) }));
    await act(async () => { await panel().onExport({ report_id: reportId, report_hash: reportHash }); });
    expect(screen.getByText(/Destination selection cancelled/u)).toBeInTheDocument(); expect(screen.queryByText(/^Exported/u)).not.toBeInTheDocument();
  });
  it("preserves a successful publication receipt when the later study refresh fails", async () => {
    mount(apiFor({ getSnapshot: vi.fn(async () => { throw new Error("Snapshot refresh unavailable"); }) }));
    await act(async () => { await panel().onExport({ report_id: reportId, report_hash: reportHash }); });
    expect(screen.getByText(/Exported wound-export. Study refresh failed/u)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel wound export" })).not.toBeInTheDocument();
  });
  it("removes cancellation after the publication receipt while refresh is still pending", async () => {
    const snapshotReply = deferred<ResearchSnapshot>(), api = apiFor({ getSnapshot: vi.fn(() => snapshotReply.promise) }); mount(api);
    let pending!: Promise<void>; act(() => { pending = panel().onExport({ report_id: reportId, report_hash: reportHash }); });
    await screen.findByText(/Exported wound-export/u);
    expect(screen.queryByRole("button", { name: "Cancel wound export" })).not.toBeInTheDocument();
    await act(async () => { snapshotReply.resolve(snapshot); await pending; }); expect(api.cancelDataExport).not.toHaveBeenCalled();
  });
  it("rejects an export plan for a different saved report", async () => {
    const api = apiFor({ planWoundClosureExport: vi.fn(async () => ({ ...plan, report_hash: "f".repeat(64) })) }); mount(api);
    await act(async () => { await expect(panel().onExport({ report_id: reportId, report_hash: reportHash })).rejects.toThrow(/does not match/u); });
    expect(api.exportWoundClosureReport).not.toHaveBeenCalled();
  });
  it("waits for a native export to settle after requesting cancellation", async () => {
    const receipt = deferred<null>(), api = apiFor({ exportWoundClosureReport: vi.fn(() => receipt.promise) }); mount(api);
    let pending!: Promise<void>; act(() => { pending = panel().onExport({ report_id: reportId, report_hash: reportHash }); });
    await waitFor(() => expect(api.exportWoundClosureReport).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel wound export" })); await waitFor(() => expect(api.cancelDataExport).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Cancel wound export" })).toBeDisabled();
    await act(async () => { receipt.resolve(null); await pending; }); expect(screen.queryByRole("button", { name: "Cancel wound export" })).not.toBeInTheDocument();
    expect(screen.getByText(/Destination selection cancelled/u)).toBeInTheDocument();
  });
  it("reads actual input review history without creating a report approval", async () => {
    const { api, onInspect } = mount();
    await act(async () => { await panel().onInspectReviews({ report_id: reportId, report_hash: reportHash }); });
    expect(screen.getByText(/do not approve this wound report/u)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Read input review history" })[0]);
    await screen.findByText("0 recorded review decisions for this input.");
    expect(api.execute).toHaveBeenCalledWith("review_history", { result_id: exact.result_id, offset: 0, limit: 100 }); expect(api.reviewResult).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: "Inspect input mask" })[0]); expect(onInspect).toHaveBeenCalledWith(exact);
  });
  it("drops a late mask read when the active study changes", async () => {
    const response = deferred<unknown>(), base = apiFor(), api = apiFor({ execute: vi.fn(async (op: string, args: Record<string, unknown>) => op === "population_query" ? response.promise : base.execute(op, args)) });
    const { rerender, onInspect } = mount(api);
    fireEvent.change(screen.getByLabelText("Saved label mask"), { target: { value: `${exact.result_id}:${exact.revision_hash}` } }); fireEvent.click(screen.getByRole("button", { name: "Load complete mask labels" }));
    rerender(<WoundClosureTool api={api} snapshot={{ ...snapshot, project: { ...snapshot.project, project_id: "e".repeat(32) } }} onInspect={onInspect} />);
    await act(async () => { response.resolve(population({ offset: 0, limit: 200 })); }); expect(panel().masks).toEqual([]);
  });
});
