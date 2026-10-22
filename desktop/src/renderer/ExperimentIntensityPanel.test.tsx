// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResearchDesktopApi, ResearchResult, ResearchSnapshot } from "../shared/research-contracts";
import type { IntensityCatalog, IntensityDescriptor, IntensityReport, IntensityRequest, IntensityStatus } from "../shared/intensity-contracts";
import { ExperimentIntensityPanel } from "./ExperimentIntensityPanel";

afterEach(cleanup);
const source = { id: "a".repeat(32), name: "Image A", sha256: "b".repeat(64), metadata: {} };
const result: ResearchResult = { id: "c".repeat(32), revision_hash: "d".repeat(64), source_id: source.id, source_sha256: source.sha256,
  kind: "segmentation", object_count: 1, created_at: "2026-10-21T00:00:00Z", review: { disposition: "reviewed" } };
const sample = { study: "Study", sample: "A", condition: "Control", biological_replicate: "R1", plate: null, well: null };
const snapshot: ResearchSnapshot = { project: { title: "Study", project_id: "1".repeat(32) }, sources: [source], results: [result],
  samples: [{ id: source.id, revision: 1, data: sample }], recipes: [], displays: [], selections: [], jobs: [], operations: {} };
const descriptor: IntensityDescriptor = { id: "literal-channel/α . raw.mean", label: "Raw α mean", kind: "intensity", statistic: "mean", unit: "source-intensity", channel: "α . raw" };
const declaration = { channel: "Recorded raw channel α", acquisition_context: "Same acquisition settings and exposure", rationale: "These fields share the recorded acquisition context" };
const request: IntensityRequest = { result_ids: [result.id], endpoint: { schema: "loci.intensity-endpoint/v1", kind: "raw-channel-intensity", statistic: "mean", unit: "source-intensity", compartment: "object" },
  metric_ids: { [result.id]: descriptor.id }, declaration };
function report(payload = request, hash = "e", mean = -0.12345678901234568): IntensityReport {
  return { schema: "loci.experiment-intensity-report/v1", created_at: "2026-10-21T00:01:00Z", software: { engine: "0.2.0", implementation: { kind: "source", sha256: "7".repeat(64) } },
    result_ids: payload.result_ids, endpoint: payload.endpoint, declaration: payload.declaration,
    bindings: [{ result_id: result.id, source_id: source.id, revision_hash: result.revision_hash, source_sha256: source.sha256,
      descriptor: { ...descriptor, id: payload.metric_ids[result.id], ...(payload.endpoint.compartment !== "object" ? { compartment: payload.endpoint.compartment } : {}) }, source: { name: source.name } }],
    observations: [{ result_id: result.id, label: 1, value: mean, status: "value" }],
    images: [{ ...sample, result_id: result.id, source_id: source.id, revision_hash: result.revision_hash,
      object_count: 1, valid_object_count: 1, null_object_count: 0, missing_object_count: 0, mean, included: true, reason: "included" }],
    replicates: [{ condition: sample.condition, biological_replicate: "R1", mean, image_count: 1, valid_image_count: 1, object_count: 1, valid_object_count: 1 }],
    conditions: [{ condition: sample.condition, mean, sd: null, object_count: 1, valid_object_count: 1, image_count: 1, valid_image_count: 1,
      declared_replicate_count: 1, valid_replicate_count: 1, unassigned_image_count: 0 }],
    audit: [{ result_id: result.id, source_id: source.id, review_disposition: "reviewed", reason: "included" }], aggregation: {}, report_hash: hash.repeat(64) };
}
const currentStatus: IntensityStatus = { current: true, changes: [] };
const wire = (value: IntensityReport) => ({ report_json: JSON.stringify(value).replace(/[^\x00-\x7f]/g,
  character => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0")) });
function fixture(options: { execute?: ResearchDesktopApi["execute"]; status?: () => IntensityStatus; saved?: IntensityReport } = {}) {
  const stored = options.saved ?? report();
  const savedReports = new Map([[stored.report_hash.slice(0, 32), stored]]);
  const get = (id: string) => {
    const value = savedReports.get(id)!;
    return { report: value, report_id: value.report_hash.slice(0, 32), status: options.status?.() ?? currentStatus };
  };
  const execute = vi.fn(async (operation: string, payload: Record<string, unknown>) => {
    if (options.execute) { const response = await options.execute(operation, payload); if (response !== undefined) return operation === "intensity_preview" && !(response && typeof response === "object" && "report_json" in response) ? wire(response as IntensityReport) : response; }
    if (operation === "intensity_list") return { reports: [{ id: stored.report_hash.slice(0, 32), created_at: stored.created_at, endpoint: stored.endpoint, declaration: stored.declaration }] };
    if (operation === "intensity_get") return get(payload.report_id as string);
    if (operation === "intensity_catalog") return { schema: "loci.experiment-intensity-catalog/v1", results: [{ result_id: result.id,
      revision_hash: result.revision_hash, source_id: source.id, name: source.name, review_status: "reviewed", descriptors: [descriptor,
        { ...descriptor, id: "literal-cell.mean", compartment: "cell" }], binding: {} }] } satisfies IntensityCatalog;
    if (operation === "intensity_preview") return wire(report(payload as unknown as IntensityRequest));
    if (operation === "intensity_save") { const value = JSON.parse(payload.report_json as string) as IntensityReport; savedReports.set(value.report_hash.slice(0, 32), value); return { report: value, report_id: value.report_hash.slice(0, 32), status: currentStatus }; }
    throw new Error(`Unexpected operation ${operation}`);
  });
  const api = { execute, getSnapshot: vi.fn().mockResolvedValue(snapshot), reviewResult: vi.fn(),
    planIntensityExport: vi.fn().mockResolvedValue({ schema: "loci.intensity-export-plan/v1", report_id: stored.report_hash.slice(0, 32), report_hash: stored.report_hash, plan_hash: "f".repeat(64), status: currentStatus }),
    exportIntensityReport: vi.fn().mockResolvedValue({ schema: "loci.intensity-export-receipt/v1", report_hash: stored.report_hash, basename: "Intensity.data", manifest_sha256: "9".repeat(64) }),
    cancelDataExport: vi.fn().mockResolvedValue({ cancelled: true }),
  } as unknown as ResearchDesktopApi;
  const onInspect = vi.fn(), onSnapshot = vi.fn();
  return { api, execute, stored, onInspect, onSnapshot };
}
function mount(setup = fixture(), activeSnapshot = snapshot) {
  const props = { api: setup.api, snapshot: activeSnapshot, onInspect: setup.onInspect, onSnapshot: setup.onSnapshot };
  return { ...render(<ExperimentIntensityPanel {...props} />), ...setup, props };
}
const resultCheckbox = (id: string) => within(screen.getByText(id, { selector: ".intensity-identity dd" }).closest<HTMLElement>(".intensity-result-row")!).getByRole("checkbox");
const channelName = /^Intensity channel for Image A · segmentation(?: · result \d+)?$/;
const choose = (name: string | RegExp, value: string) => fireEvent.change(screen.getByRole("combobox", { name }), { target: { value } });
async function configure() {
  fireEvent.click(resultCheckbox(result.id));
  await screen.findByRole("option", { name: "Object mean" });
  choose("Intensity compartment", "object");
  choose(channelName, descriptor.id);
  for (const [label, value] of [["Shared channel declaration", declaration.channel], ["Acquisition context", declaration.acquisition_context], ["Comparability rationale", declaration.rationale]])
    fireEvent.change(screen.getByRole("textbox", { name: label }), { target: { value } });
}
async function prepare() {
  fireEvent.click(screen.getByRole("button", { name: "Preview intensity comparison" }));
  await screen.findByRole("region", { name: "Intensity comparison preview" });
}
async function openSaved(stored = report()) {
  const details = screen.getByText(/Saved intensity reports \(/).closest<HTMLDetailsElement>("details")!;
  details.open = true;
  const identity = await screen.findByText(stored.report_hash.slice(0, 32), { selector: "code" });
  const open = within(identity.closest<HTMLElement>("li")!).getByRole("button", { name: /^Open saved intensity report 1:/ });
  expect(open.getAttribute("aria-label")).not.toContain(stored.created_at);
  fireEvent.click(open);
  await screen.findByRole("region", { name: "Saved intensity report" });
  await waitFor(() => expect(screen.getByRole("button", { name: "Recompute as new preview" })).toBeEnabled());
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; }

describe("ExperimentIntensityPanel", () => {
  it("uses concise human method labels and retains unique exact identities when names and methods repeat", () => {
    const duplicate = { ...result, id: "2".repeat(32), revision_hash: "3".repeat(64), created_at: "2026-10-22T01:02:03Z" };
    mount(fixture(), { ...snapshot, results: [result, duplicate] });
    const first = resultCheckbox(result.id), second = resultCheckbox(duplicate.id);
    expect(first).toHaveAccessibleName("Intensity result: Image A · segmentation · result 1 · Reviewed");
    expect(second).toHaveAccessibleName("Intensity result: Image A · segmentation · result 2 · Reviewed");
    expect(second.closest<HTMLElement>(".intensity-result-row")).toHaveAttribute("data-intensity-result-id", duplicate.id);
    expect(second.closest<HTMLElement>(".intensity-result-row")).toHaveAttribute("data-revision-hash", duplicate.revision_hash);
    const disclosure = second.closest<HTMLElement>(".intensity-result-row")!.querySelector("summary")!;
    disclosure.focus(); expect(disclosure).toHaveFocus(); fireEvent.click(disclosure);
    expect(screen.getByText(duplicate.id, { selector: "dd" })).toBeVisible();
    expect(screen.getByText(duplicate.revision_hash, { selector: "dd" })).toBeVisible();
    expect(within(second.closest<HTMLElement>(".intensity-result-row")!).getByText(duplicate.created_at, { selector: "dd" })).toBeVisible();
    expect(second.closest("label")).not.toHaveTextContent(duplicate.created_at);
    expect(second.closest("label")).not.toHaveTextContent("Eligible reviewed revision");
  });
  it("describes stale saved evidence from its binding rather than relabeling a result ID as a revision or reading live labels", async () => {
    const status = { current: false, changes: [{ result_id: result.id, reason: "changed: sample_document" }] };
    mount(fixture({ status: () => status }), { ...snapshot, sources: [{ ...source, name: "Later source label" }],
      results: [{ ...result, method_label: "Later method label" }] });
    await openSaved();
    const current = screen.getByText("Current inputs differ. Saved values remain unchanged.").closest('[role="status"]')!;
    expect(current).toHaveTextContent("Image A · Raw α mean · Changed: sample metadata");
    expect(current).not.toHaveTextContent("Later source label");
    expect(current).not.toHaveTextContent("Later method label");
    expect(current).not.toHaveTextContent(`Revision ${result.id.slice(0, 8)}`);
    const statusDetails = screen.getByText("Current input status details");
    statusDetails.focus(); expect(statusDetails).toHaveFocus(); fireEvent.click(statusDetails);
    expect(within(statusDetails.closest<HTMLDetailsElement>("details")!).getByText(result.id, { selector: "dd" })).toBeVisible();
    expect(within(statusDetails.closest<HTMLDetailsElement>("details")!).getByText(result.revision_hash, { selector: "dd" })).toBeVisible();
    expect(screen.getByText(declaration.rationale, { selector: "dd" })).not.toBeVisible();
    expect(screen.getByText("Object raw-channel mean")).toBeVisible();
    expect(screen.getByText("Equal weight at each step: objects → images → declared replicates → conditions.")).toBeVisible();
    fireEvent.click(screen.getByText("Channel declaration & method"));
    expect(screen.getByText(declaration.rationale, { selector: "dd" })).toBeVisible();
  });
  it("clears an obsolete catalog load when selection returns to cached exact evidence", async () => {
    const pending = deferred<unknown>();
    const other = { ...result, id: "2".repeat(32), source_id: "3".repeat(32) };
    const setup = fixture({ execute: async (operation, payload) => operation === "intensity_catalog" &&
      (payload.result_ids as string[]).length === 2 ? pending.promise : undefined });
    mount(setup, { ...snapshot, sources: [...snapshot.sources, { ...source, id: other.source_id }], results: [result, other] });
    await configure();
    expect(screen.getByRole("button", { name: "Preview intensity comparison" })).toBeEnabled();
    const box = resultCheckbox(other.id);
    fireEvent.click(box);
    await screen.findByText("Reading the actual stored intensity measurements…");
    fireEvent.click(box);
    await waitFor(() => expect(screen.getByRole("button", { name: "Preview intensity comparison" })).toBeEnabled());
    await act(async () => pending.resolve({ results: [] }));
    expect(screen.getByRole("button", { name: "Preview intensity comparison" })).toBeEnabled();
  });
  it("saves the authoritative numeric spelling verbatim rather than serializing display numbers", async () => {
    const original = wire(report(request, "e", -0)).report_json.replaceAll('"mean":0', '"mean":-0.0').replace('"value":0', '"value":-0.0');
    const view = mount(fixture({ execute: async operation => operation === "intensity_preview" ? { report_json: original } : undefined }));
    await configure(); await prepare();
    expect(screen.getByRole("table", { name: "Condition means · source-intensity units" })).toHaveTextContent("-0");
    fireEvent.click(screen.getByRole("button", { name: "Save intensity report" }));
    await waitFor(() => expect(view.execute).toHaveBeenCalledWith("intensity_save", { report_json: original }));
  });
  it("uses actual literal mean descriptors and exact evidence, retains the preview across Inspect, and blocks stale save", async () => {
    const view = mount();
    await configure();
    expect(screen.getByRole("option", { name: "Whole cell mean" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Nuclear intersection mean" })).not.toBeInTheDocument();
    await prepare();
    expect(view.execute).toHaveBeenCalledWith("intensity_preview", request);
    const conditions = screen.getByRole("table", { name: "Condition means · source-intensity units" });
    const approximate = within(conditions).getByText("≈ -0.123457", { selector: "summary" });
    approximate.focus(); expect(approximate).toHaveFocus();
    fireEvent.click(approximate);
    expect(within(conditions).getByText("-0.12345678901234568", { selector: "code" })).toBeVisible();
    expect(screen.getByRole("img", { name: "Declared replicate means by condition" })).toBeVisible();
    screen.getByText(/Image means & inclusion reasons/).closest<HTMLDetailsElement>("details")!.open = true;
    fireEvent.click(screen.getByRole("button", { name: "Inspect result: Image A · Raw α mean" }));
    expect(view.onInspect).toHaveBeenCalledWith(result);
    view.rerender(<ExperimentIntensityPanel {...view.props} active={false} />);
    view.rerender(<ExperimentIntensityPanel {...view.props} active />);
    expect(screen.getByRole("button", { name: "Save intensity report" })).toBeEnabled();
    view.rerender(<ExperimentIntensityPanel {...view.props} snapshot={{ ...snapshot, samples: [{ ...snapshot.samples[0], revision: 2 }] }} />);
    expect(screen.getByRole("button", { name: "Save intensity report" })).toBeDisabled();
    expect(screen.getByText(/Settings or bound evidence changed/)).toBeVisible();
    expect(view.api.reviewResult).not.toHaveBeenCalled();
  });
  it.each(["cell", "nuclear", "cytoplasm"] as const)("selects actual typed %s means without inferring channel identity", async (part) => {
    const literalId = `measured/${part}/α . mean`;
    const setup = fixture({ execute: async (operation) => operation === "intensity_catalog" ? {
      schema: "loci.experiment-intensity-catalog/v1", results: [{ result_id: result.id, revision_hash: result.revision_hash,
        source_id: source.id, name: source.name, review_status: "reviewed", binding: {},
        descriptors: [descriptor, { ...descriptor, id: literalId, compartment: part }] }],
    } : undefined });
    const view = mount(setup); await configure();
    choose("Intensity compartment", part);
    expect(screen.getByRole("combobox", { name: channelName })).toHaveValue("");
    choose(channelName, literalId); await prepare();
    expect(view.execute).toHaveBeenCalledWith("intensity_preview", { ...request,
      endpoint: { ...request.endpoint, compartment: part }, metric_ids: { [result.id]: literalId } });
    expect(view.api.reviewResult).not.toHaveBeenCalled();
  });
  it("blocks pending, duplicate-source and indexed evidence with actionable reasons", async () => {
    const pending = { ...result, id: "2".repeat(32), revision_hash: "3".repeat(64), review: { disposition: "pending" as const } };
    const indexed = { ...result, id: "4".repeat(32), schema: "loci.research-result/v2" as const };
    const duplicate = { ...result, id: "5".repeat(32), revision_hash: "6".repeat(64) };
    mount(fixture(), { ...snapshot, results: [result, pending, indexed, duplicate] });
    expect(resultCheckbox(pending.id)).toBeDisabled();
    expect(resultCheckbox(indexed.id)).toBeDisabled();
    fireEvent.click(resultCheckbox(result.id));
    expect(resultCheckbox(duplicate.id)).toBeDisabled();
    expect(resultCheckbox(duplicate.id).closest("label")).toHaveTextContent("Clear the other selected revision on this source first");
    expect(screen.getByRole("button", { name: "Preview intensity comparison" })).toBeDisabled();
  });
  it("reopens saved values unchanged, distinguishes current status, and explicitly recomputes a new save", async () => {
    let status = currentStatus;
    const old = report(), unchanged = JSON.stringify(old), fresh = report(request, "f", 42);
    const setup = fixture({ saved: old, status: () => status, execute: async (operation) => operation === "intensity_preview" ? fresh : undefined });
    const view = mount(setup);
    await openSaved(old);
    expect(screen.getByLabelText("Shared channel declaration")).toBeDisabled();
    expect(screen.getByText("Current inputs match this saved report.")).toBeVisible();
    status = { current: false, changes: [{ result_id: result.id, reason: "changed: sample_document, review_sha256, row_sha256" }] };
    view.rerender(<ExperimentIntensityPanel {...view.props} snapshot={{ ...snapshot, samples: [{ ...snapshot.samples[0], revision: 2 }] }} />);
    await screen.findByText("Current inputs differ. Saved values remain unchanged.");
    expect(screen.getByText(/Changed: sample metadata, review decision, stored measurements/)).toBeVisible();
    expect(screen.getByRole("table", { name: "Condition means · source-intensity units" })).toHaveTextContent("-0.12345678901234568");
    expect(JSON.stringify(old)).toBe(unchanged);
    fireEvent.click(screen.getByRole("button", { name: "Recompute as new preview" }));
    await screen.findByRole("region", { name: "Intensity comparison preview" });
    expect(screen.getByRole("table", { name: "Condition means · source-intensity units" })).toHaveTextContent("42");
    fireEvent.click(screen.getByRole("button", { name: "Save intensity report" }));
    await waitFor(() => expect(view.execute).toHaveBeenCalledWith("intensity_save", wire(fresh)));
    expect(JSON.stringify(old)).toBe(unchanged);
  });
  it("cancels export preparation, ignores its late plan, and obtains fresh plans after cancel and conflict", async () => {
    const setup = fixture(), first = deferred<Awaited<ReturnType<NonNullable<ResearchDesktopApi["planIntensityExport"]>>>>();
    const plan = await setup.api.planIntensityExport!(setup.stored.report_hash.slice(0, 32), "fixture");
    vi.mocked(setup.api.planIntensityExport!).mockClear().mockImplementationOnce(() => first.promise).mockResolvedValue(plan);
    vi.mocked(setup.api.exportIntensityReport!).mockRejectedValueOnce(new Error("Destination already exists"));
    mount(setup); await openSaved();
    fireEvent.click(screen.getByRole("button", { name: "Export intensity report…" }));
    await screen.findByRole("button", { name: "Cancel intensity export" });
    const firstKey = vi.mocked(setup.api.planIntensityExport!).mock.calls[0][1];
    fireEvent.click(screen.getByRole("button", { name: "Cancel intensity export" }));
    await waitFor(() => expect(setup.api.cancelDataExport).toHaveBeenCalledWith(firstKey));
    await act(async () => first.resolve(plan));
    expect(setup.api.exportIntensityReport).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Export intensity report…" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent("Destination already exists");
    fireEvent.click(screen.getByRole("button", { name: "Export intensity report…" }));
    await screen.findByText(/Saved Intensity.data/);
    const keys = vi.mocked(setup.api.planIntensityExport!).mock.calls.map((call) => call[1]);
    expect(keys).toHaveLength(3); expect(new Set(keys).size).toBe(3);
    expect(keys.every((key) => /^scientific-export:[0-9a-f-]{36}$/u.test(key))).toBe(true);
  });
  it("rejects stale late previews and permits retrying a failed catalog read", async () => {
    const late = deferred<IntensityReport>(); let catalogReads = 0;
    const view = mount(fixture({ execute: async (operation) => {
      if (operation === "intensity_catalog" && catalogReads++ === 0) throw new Error("Source could not be verified");
      if (operation === "intensity_preview") return late.promise;
      return undefined;
    } }));
    fireEvent.click(resultCheckbox(result.id));
    fireEvent.click(await screen.findByRole("button", { name: "Retry stored measurements" }));
    await screen.findByRole("option", { name: "Object mean" });
    choose("Intensity compartment", "object"); choose(channelName, descriptor.id);
    for (const [label, value] of [["Shared channel declaration", declaration.channel], ["Acquisition context", declaration.acquisition_context], ["Comparability rationale", declaration.rationale]])
      fireEvent.change(screen.getByRole("textbox", { name: label }), { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "Preview intensity comparison" }));
    view.rerender(<ExperimentIntensityPanel {...view.props} snapshot={{ ...snapshot, samples: [{ ...snapshot.samples[0], revision: 3 }] }} />);
    await act(async () => late.resolve(report()));
    expect(screen.queryByRole("region", { name: "Intensity comparison preview" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save intensity report" })).toBeDisabled();
  });
});
