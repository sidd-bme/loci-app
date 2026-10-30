// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, webcrypto } from "node:crypto";
import { WoundClosurePanel, type WoundClosurePanelProps } from "./WoundClosurePanel";
import { checkedWoundSummary, type WoundInput, type WoundMaskChoice, type WoundQuery, type WoundRequest, type WoundSummary } from "./wound-closure-types";

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const hash = "8".repeat(64), id = hash.slice(0, 32), previewId = "6".repeat(32), previewHash = "9".repeat(64);
const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const masks: WoundMaskChoice[] = ["a", "b", "c", "d"].map((letter, i) => ({ result_id: letter.repeat(32), revision_hash: letter.repeat(64), source_id: String(i + 1).repeat(32),
  source_sha256: String(i + 1).repeat(64), name: `Filled mask ${i + 1}`, label_ids: [1, 2], mask_semantics: "filled-wound-area" }));
const defaultRequest: WoundRequest = { frames: masks.slice(0, 2).map((m, i) => ({ frame_id: `Frame ${i + 1}`, result_id: m.result_id, revision_hash: m.revision_hash, selected_labels: [1], mask_semantics: "filled-wound-area" })),
  time_s: [0, 15], time_unit: "s", specimen_id: "Specimen X", sequence_id: "Sequence Y", time_declaration: "Acquisition log elapsed seconds", area_declaration: "Filled regions inside the wound", grid_declaration: "Same original field and calibration", working_bytes: 256 * 1024 ** 2 };
function reportFor(request: WoundRequest, choices = masks) {
  const frames = request.frames.map((frame, i) => {
    const missing = "missing_reason" in frame;
    const area = missing ? null : !frame.selected_labels.length ? 0 : request.frames.length === 5 ? [72, 0, 36, 108, 0][i] : ([72, 36, 108][i] ?? 36);
    return { frame_id: frame.frame_id, time_s: request.time_s[i], status: missing ? "missing" as const : "observed" as const,
      ...(missing ? { missing_reason: frame.missing_reason } : {}), area, area_fraction: area === null ? null : area / 72,
      closure_fraction: area === null ? null : 1 - area / 72, selected_pixel_count: area, excluded_positive_pixel_count: missing ? null : 0 };
  });
  const intervals = frames.slice(1).map((right, i) => {
    const left = frames[i], defined = left.status === "observed" && right.status === "observed", dt = right.time_s - left.time_s;
    return { from_frame_id: left.frame_id, to_frame_id: right.frame_id, delta_time_s: dt, status: defined ? "defined" as const : "missing_endpoint" as const,
      area_change_rate: defined ? (right.area! - left.area!) / dt : null, closure_change_rate: defined ? (right.closure_fraction! - left.closure_fraction!) / dt : null };
  });
  const inputs: WoundInput[] = request.frames.map((frame, i) => {
    const base = { frame_id: frame.frame_id, time_s: request.time_s[i], specimen_id: request.specimen_id, sequence_id: request.sequence_id };
    if ("missing_reason" in frame) return { ...base, missing_reason: frame.missing_reason };
    const mask = choices.find((m) => m.result_id === frame.result_id)!;
    return { ...base, ...mask, mask_semantics: "filled-wound-area", result_record_sha256: hash, selected_label_count: frame.selected_labels.length, selected_labels_sha256: sha(frame.selected_labels),
      geometry: { axes: "YX", affine: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]], unit: "um", frame: "image" },
      selection: { x: 0, y: 0, width: 20, height: 20, t: i, z: 0, c: 0, level: 0 }, labels: { sha256: hash, bytes: 1600, shape: [20, 20], dtype: "uint32" }, sample: null };
  });
  return { request: structuredClone(request), frames, intervals, inputs };
}
type Report = ReturnType<typeof reportFor>;
function summaryFor(report: Report, shown = 1): WoundSummary {
  const tables = {} as WoundSummary["tables"];
  for (const name of ["frames", "intervals", "inputs"] as const) { const total = report[name].length, returned = Math.min(shown, total); tables[name] = { total, returned, has_more: returned < total, next_offset: returned < total ? returned : null }; }
  return { schema: "loci.wound-closure-summary/v1", report_schema: "loci.wound-closure-report/v1", report_hash: hash, request_sha256: hash, created_at: "2026-10-30T00:00:00Z", software: { engine: "engineering-fixture" },
    measurement: { specimen_id: report.request.specimen_id, sequence_id: report.request.sequence_id, time_unit: "s", area_unit: "um^2", baseline_frame_id: report.frames[0].frame_id, baseline_area: 72,
      area_declaration: report.request.area_declaration, grid_declaration: report.request.grid_declaration, calibration_status: "declared-physical-calibration", rules: { intervals: "Adjacent observed slots only" } },
    sample_identity: { study: "Generated study", biological_replicate: "Declared donor", missing_sample_frames: 0, unassigned_biological_replicate_frames: 0, basis: "Captured declarations" },
    totals: { scheduled_frames: report.frames.length, observed_frames: report.frames.filter((f) => f.status === "observed").length, missing_frames: report.frames.filter((f) => f.status === "missing").length }, tables,
    frames: report.frames.slice(0, shown), intervals: report.intervals.slice(0, shown), inputs: report.inputs.slice(0, shown) };
}
function savedFor(report: Report, current = true) { return { report_id: id, report: { schema: "loci.wound-closure-report/v1", report_hash: hash, request: report.request }, summary: summaryFor(report), status: { current, changes: current ? [] : [{ source_id: masks[0].source_id, reason: "sample_metadata_changed" }] } }; }
function pageFor(report: Report, args: WoundQuery, cap = 100) { const rows = report[args.table].slice(args.offset, args.offset + Math.min(args.limit, cap));
  return { schema: "loci.wound-closure-page/v1", report_hash: hash, table: args.table, offset: args.offset, limit: args.limit, total: report[args.table].length, returned: rows.length, rows,
    next_offset: args.offset + rows.length < report[args.table].length ? args.offset + rows.length : null }; }
function mount(options: { saved?: boolean; current?: boolean; cap?: number; overrides?: Partial<WoundClosurePanelProps> } = {}) {
  let retained = reportFor(defaultRequest);
  const props: WoundClosurePanelProps = { studyKey: "study", inputVersion: "1", masks, reports: options.saved ? [{ id, created_at: "2026-10-30", specimen_id: "Specimen X", sequence_id: "Sequence Y", status: { current: true, changes: [] } }] : [],
    onPreview: vi.fn(async (request: WoundRequest) => { retained = reportFor(request); return { preview_id: previewId, preview_hash: previewHash, summary: summaryFor(retained) }; }),
    onSave: vi.fn(async () => savedFor(retained, options.current)), onGet: vi.fn(async () => savedFor(retained, options.current)),
    onQuery: vi.fn(async (args: WoundQuery) => pageFor(retained, args, options.cap)), onInspect: vi.fn(), onInspectReviews: vi.fn(async () => {}), onExport: vi.fn(async () => {}), onSaved: vi.fn(), ...options.overrides };
  const rendered = render(<WoundClosurePanel {...props} />);
  return { props, ...rendered };
}
function fillFrame(index: number, maskIndex: number, time: string) {
  const frame = within(screen.getByRole("group", { name: `Frame slot ${index + 1}${index === 0 ? " · baseline" : ""}` }));
  fireEvent.change(frame.getByLabelText("Actual time (s)"), { target: { value: time } });
  fireEvent.change(frame.getByLabelText("Exact filled-area mask"), { target: { value: `${masks[maskIndex].result_id}:${masks[maskIndex].revision_hash}` } });
  fireEvent.change(frame.getByLabelText("Filled-region label IDs"), { target: { value: "1" } });
}
function setup() {
  for (const [label, value] of [["Specimen identity", defaultRequest.specimen_id], ["Sequence identity", defaultRequest.sequence_id], ["Acquisition time basis", defaultRequest.time_declaration],
    ["Filled-area definition", defaultRequest.area_declaration], ["Shared field of view and calibration", defaultRequest.grid_declaration]]) fireEvent.change(screen.getByLabelText(label), { target: { value } });
  fireEvent.click(screen.getByLabelText("Selected labels represent filled wound area"));
  fillFrame(0, 0, "0"); fillFrame(1, 1, "15");
}
async function preview() { fireEvent.click(screen.getByRole("button", { name: "Preview wound closure" })); await screen.findByText("Verified preview"); }
async function openSaved() { fireEvent.click(screen.getByText(/Saved wound reports \(/u)); fireEvent.click(screen.getByRole("button", { name: "Open saved report" })); await screen.findByText("Saved wound report"); }

describe("native wound closure authoring", () => {
  it("requires real acquisition times and explicit filled-area/grid declarations", () => {
    const { props } = mount();
    expect(screen.getByRole("button", { name: "Preview wound closure" })).toBeDisabled();
    expect(screen.getAllByLabelText("Actual time (s)").every((e) => (e as HTMLInputElement).value === "")).toBe(true);
    setup(); expect(screen.getByRole("button", { name: "Preview wound closure" })).toBeEnabled();
    fireEvent.change(screen.getAllByLabelText("Actual time (s)")[1], { target: { value: "0" } });
    expect(screen.getByText(/strictly increasing/u)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview wound closure" })).toBeDisabled(); expect(props.onPreview).not.toHaveBeenCalled();
  });
  it("binds all exact inputs before token-only save and exposes exact review/export callbacks", async () => {
    const { props } = mount({ cap: 1 }); setup(); await preview();
    expect(props.onPreview).toHaveBeenCalledWith(defaultRequest);
    expect(props.onQuery).toHaveBeenCalledWith({ preview_id: previewId, preview_hash: previewHash, table: "inputs", offset: 1, limit: 100 });
    fireEvent.click(screen.getByRole("button", { name: "Save immutable report" })); await screen.findByText("Saved wound report");
    expect(props.onSave).toHaveBeenCalledWith({ preview_id: previewId, preview_hash: previewHash });
    expect(props.onSaved).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Inspect input reviews" })); await waitFor(() => expect(props.onInspectReviews).toHaveBeenCalledWith({ report_id: id, report_hash: hash }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Export wound report…" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Export wound report…" })); await waitFor(() => expect(props.onExport).toHaveBeenCalledWith({ report_id: id, report_hash: hash }));
  });
  it("preserves missing slots, negative closure and observed zero area without gap interpolation", async () => {
    const { container, props } = mount(); setup();
    const second = within(screen.getByRole("group", { name: "Frame slot 2" }));
    fireEvent.click(second.getByLabelText("Missing acquisition")); fireEvent.change(second.getByLabelText("Missing frame reason"), { target: { value: "Acquisition unavailable" } });
    for (let i = 2; i < 5; i++) { fireEvent.click(screen.getByRole("button", { name: "Add frame slot" })); fillFrame(i, i - 1, String(i * 15)); }
    const last = within(screen.getByRole("group", { name: "Frame slot 5" })); fireEvent.click(last.getByLabelText("Observed zero area (no selected labels)"));
    await preview();
    const endpoints = within(screen.getByRole("region", { name: "Wound frame endpoints" }));
    expect(endpoints.getByText("Missing — Acquisition unavailable")).toBeInTheDocument();
    expect(endpoints.getByText("-0.5")).toBeInTheDocument(); expect(endpoints.getByText("Observed zero area")).toBeInTheDocument();
    expect(container.querySelectorAll("[data-wound-interval]")).toHaveLength(2);
    const intervals = within(screen.getByRole("region", { name: "Adjacent wound intervals" }));
    expect(intervals.getAllByText("Undefined: missing endpoint")).toHaveLength(4);
    expect(intervals.getByText("4.8")).toBeInTheDocument(); expect(intervals.getByText("-7.2")).toBeInTheDocument();
    const submitted = vi.mocked(props.onPreview).mock.calls[0][0];
    expect(submitted.frames[1]).toEqual({ frame_id: "Frame 2", missing_reason: "Acquisition unavailable" });
    expect(submitted.frames[4]).toMatchObject({ selected_labels: [], mask_semantics: "filled-wound-area" });
  });
  it("rejects duplicate masks, repeated labels and unavailable label IDs", () => {
    mount(); setup();
    fillFrame(1, 0, "15"); expect(screen.getByText(/cannot represent two observations/u)).toBeInTheDocument();
    fillFrame(1, 1, "15"); const labels = screen.getAllByLabelText("Filled-region label IDs")[1];
    fireEvent.change(labels, { target: { value: "1,1" } }); expect(screen.getByText(/unique positive integers/u)).toBeInTheDocument();
    fireEvent.change(labels, { target: { value: "99" } }); expect(screen.getByText(/label is unavailable/u)).toBeInTheDocument();
  });
  it("does not offer boundary or skeleton masks as filled-area inputs", () => {
    mount({ overrides: { masks: [...masks, { ...masks[0], result_id: "e".repeat(32), name: "Boundary", mask_semantics: "boundary-only" }] } });
    expect(screen.getAllByRole("option", { name: /Boundary ·/u }).every((e) => (e as HTMLOptionElement).disabled)).toBe(true);
  });
  it.each(["wrong hash", "empty page", "wrong source", "wrong labels", "wrong times"])("refuses a %s response", async (kind) => {
    const original = reportFor(defaultRequest);
    const onQuery = vi.fn(async (args: WoundQuery) => {
      const response = pageFor(original, args);
      if (kind === "wrong hash") response.report_hash = "f".repeat(64);
      if (kind === "empty page") { response.rows = []; response.returned = 0; }
      if (kind === "wrong source" && args.table === "inputs") (response.rows[0] as WoundInput).source_sha256 = "f".repeat(64);
      if (kind === "wrong labels" && args.table === "inputs") (response.rows[0] as WoundInput).selected_labels_sha256 = "f".repeat(64);
      if (kind === "wrong times" && args.table === "inputs") (response.rows[0] as WoundInput).time_s = 999;
      return response;
    });
    mount({ overrides: { onQuery } }); setup(); fireEvent.click(screen.getByRole("button", { name: "Preview wound closure" }));
    await screen.findByRole("alert"); expect(screen.queryByRole("button", { name: "Save immutable report" })).not.toBeInTheDocument();
  });
  it("invalidates an unsaved preview when authoritative input metadata changes", async () => {
    const { props, rerender } = mount(); setup(); await preview();
    rerender(<WoundClosurePanel {...props} inputVersion="2" />);
    expect(screen.queryByText("Verified preview")).not.toBeInTheDocument(); expect(props.onSave).not.toHaveBeenCalled();
  });
  it("ignores a preview that resolves after the user stops loading", async () => {
    let resolve!: (value: unknown) => void;
    const { props } = mount({ overrides: { onPreview: vi.fn(() => new Promise((done) => { resolve = done; })) } }); setup();
    fireEvent.click(screen.getByRole("button", { name: "Preview wound closure" })); fireEvent.click(screen.getByRole("button", { name: "Stop loading" }));
    await act(async () => resolve({ preview_id: previewId, preview_hash: previewHash, summary: summaryFor(reportFor(defaultRequest)) }));
    expect(props.onQuery).not.toHaveBeenCalled(); expect(screen.queryByText("Verified preview")).not.toBeInTheDocument();
  });
  it("keeps the verified preview available after a failed save and redacts local paths", async () => {
    const { props } = mount({ overrides: { onSave: vi.fn(async () => { throw new Error("Cannot read /Volumes/private/sensitive.dat"); }) } }); setup(); await preview();
    fireEvent.click(screen.getByRole("button", { name: "Save immutable report" })); await screen.findByRole("alert");
    expect(screen.getByRole("alert")).not.toHaveTextContent("/Volumes/private");
    expect(screen.getByText("Verified preview")).toBeInTheDocument(); expect(props.onSaved).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save immutable report" })).toBeEnabled();
  });
});

describe("immutable saved wound inspection", () => {
  it("shows metadata changes separately and inspects only an exact current mask binding", async () => {
    const { props, rerender } = mount({ saved: true, current: false }); await openSaved();
    expect(screen.getByText(/saved values and captured samples remain unchanged/u)).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("region", { name: "Wound frame endpoints" })).getAllByRole("button", { name: "Inspect exact mask" })[0]);
    expect(props.onInspect).toHaveBeenCalledWith({ result_id: masks[0].result_id, revision_hash: masks[0].revision_hash, source_id: masks[0].source_id, source_sha256: masks[0].source_sha256 });
    rerender(<WoundClosurePanel {...props} masks={masks.map((m) => ({ ...m, revision_hash: "f".repeat(64) }))} inputVersion="2" />);
    expect(screen.getByText("Saved wound report")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Wound frame endpoints" })).getAllByText("Exact mask revision unavailable")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Refresh saved report" })).toBeInTheDocument();
  });
  it("drops report data when the study identity changes", async () => {
    const { props, rerender } = mount({ saved: true }); await openSaved();
    rerender(<WoundClosurePanel {...props} studyKey="other-study" reports={[]} />);
    expect(screen.queryByText("Saved wound report")).not.toBeInTheDocument(); expect(screen.getByLabelText("Specimen identity")).toHaveValue("");
  });
  it("disables native publication actions while the containing workbench is busy", async () => {
    const { props, rerender } = mount({ saved: true }); await openSaved();
    rerender(<WoundClosurePanel {...props} busy />);
    expect(screen.getByRole("button", { name: "Export wound report…" })).toBeDisabled(); expect(screen.getByRole("button", { name: "Inspect input reviews" })).toBeDisabled();
    expect(props.onExport).not.toHaveBeenCalled();
  });
  it("loads byte-capped cursors completely and pages long saved frame tables", async () => {
    const longMasks = Array.from({ length: 32 }, (_, i) => ({ ...masks[0], result_id: (i + 100).toString(16).padStart(32, "0"), revision_hash: (i + 100).toString(16).padStart(64, "0"), name: `Mask ${i + 1}` }));
    const request = { ...defaultRequest, frames: longMasks.map((mask, i) => ({ frame_id: `Frame ${i + 1}`, result_id: mask.result_id, revision_hash: mask.revision_hash, selected_labels: [1], mask_semantics: "filled-wound-area" as const })), time_s: longMasks.map((_, i) => i * 15) };
    const report = reportFor(request, longMasks), onQuery = vi.fn(async (args: WoundQuery) => pageFor(report, args, 7));
    mount({ saved: true, overrides: { masks: longMasks, onGet: vi.fn(async () => savedFor(report)), onQuery } });
    await openSaved();
    const endpoints = within(screen.getByRole("region", { name: "Wound frame endpoints" }));
    expect(endpoints.queryByRole("rowheader", { name: /^Frame 26\s/u })).not.toBeInTheDocument();
    expect(onQuery).toHaveBeenCalledWith({ report_id: id, table: "frames", offset: 8, limit: 100 });
    fireEvent.click(within(screen.getByRole("group", { name: "Frame pages" })).getByRole("button", { name: "Next" }));
    expect(endpoints.getByRole("rowheader", { name: /^Frame 26\s/u })).toHaveTextContent("375 s"); expect(endpoints.getAllByRole("row")).toHaveLength(8);
  });
  it("rejects nonfinite and missing-as-zero payloads without scientific disclosure", () => {
    const report = reportFor(defaultRequest), summary = summaryFor(report);
    expect(() => checkedWoundSummary({ ...summary, frames: [{ ...summary.frames[0], area: Infinity }] })).toThrow();
    expect(() => checkedWoundSummary({ ...summary, frames: [{ ...summary.frames[0], status: "missing", missing_reason: "lost", area: 0 }] })).toThrow();
  });
});
