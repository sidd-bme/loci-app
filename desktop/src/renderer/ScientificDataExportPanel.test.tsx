// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResearchDesktopApi, ResearchJob, ResearchResult, ResearchSnapshot } from "../shared/research-contracts";
import type { ScientificExportPreview, ScientificExportRequest, ScientificExportReceipt } from "../shared/scientific-export-contracts";
import { ScientificDataExportPanel } from "./ScientificDataExportPanel";

afterEach(cleanup);
const source = { id: "a".repeat(32), sha256: "b".repeat(64), name: "Sample image", metadata: {} };
const result: ResearchResult = {
  id: "c".repeat(32), revision_hash: "d".repeat(64), source_id: source.id, source_sha256: source.sha256,
  kind: "classical", method_label: "Threshold", object_count: 2, created_at: "2026-10-19T00:00:00Z", review: { disposition: "reviewed" },
};
const other: ResearchResult = { ...result, id: "e".repeat(32), revision_hash: "f".repeat(64), method_label: "Watershed" };
const snapshot: ResearchSnapshot = {
  project: { title: "Synthetic test" }, sources: [source], results: [result, other], samples: [], recipes: [], displays: [], selections: [], jobs: [], operations: {},
};
const opaque = '  {"opaque_server_plan":true,"precision":"0.123456789012345678901"}\n';
const receipt: ScientificExportReceipt = {
  schema: "loci.scientific-data-package/v1", basename: "Synthetic.data", purpose: "reviewed", manifest_sha256: "1".repeat(64),
  result_count: 1, source_count: 1, selected_count: 2,
};
function preview(request: ScientificExportRequest, overrides: Partial<ScientificExportPreview["plan"]> = {}): ScientificExportPreview {
  return { plan_json: opaque, plan: {
    schema: "loci.data-export-plan/v1", plan_sha256: "2".repeat(64), request, purpose: request.purpose,
    source_count: new Set(request.bindings.map((binding) => binding.source_id)).size,
    result_count: request.bindings.length, total_count: request.bindings.length * 2, selected_count: request.bindings.length * 2,
    measurement_count: request.bindings.length * 4, group_count: 0, membership_count: 0,
    declared_replicate_count: 0, unassigned_source_count: 1, mixed_units: false, units: [],
    results: request.bindings.map((binding) => ({ result_id: binding.result_id, revision_hash: binding.revision_hash, source_id: binding.source_id,
      name: source.name, review_status: request.purpose === "provisional" ? "pending" : "reviewed", total_count: 2, selected_count: 2,
      measurement_count: 4, group_count: 0, preview: [{ label: "9007199254740993", measure: "0.1234567890123456789012345", measure_unit: "µm²" }],
    })), ...overrides,
  } };
}
function api(overrides: Partial<ResearchDesktopApi> = {}): ResearchDesktopApi {
  return {
    createStudy: vi.fn(), openStudy: vi.fn(), getSnapshot: vi.fn().mockResolvedValue(snapshot), addSources: vi.fn(),
    execute: vi.fn().mockResolvedValue({ groups: [] }), reviewResult: vi.fn(), exportResult: vi.fn(), cancelJob: vi.fn(),
    planDataExport: vi.fn().mockImplementation(async (request) => preview(request)),
    exportDataPackage: vi.fn().mockResolvedValue(receipt), cancelDataExport: vi.fn().mockResolvedValue({ cancelled: true }), ...overrides,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const choose = (label: string, value: string) => fireEvent.change(screen.getByRole("combobox", { name: label }), { target: { value } });
const prepare = async () => {
  fireEvent.click(screen.getByRole("button", { name: "Preview data" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Export data package…" })).toBeEnabled());
};

describe("ScientificDataExportPanel", () => {
  it("binds the current revision and source exactly and exports only its opaque prepared plan", async () => {
    const bridge = api(), onSnapshot = vi.fn();
    render(<ScientificDataExportPanel api={bridge} snapshot={snapshot} result={result} onSnapshot={onSnapshot} />);
    expect(screen.getByRole("combobox", { name: "Data export purpose" })).toHaveValue("reviewed");
    expect(screen.getByRole("combobox", { name: "Data export result scope" })).toHaveValue("current");
    const exportButton = screen.getByRole("button", { name: "Export data package…" });
    expect(exportButton).toBeDisabled(); fireEvent.click(exportButton); expect(bridge.exportDataPackage).not.toHaveBeenCalled();
    await prepare();
    const request: ScientificExportRequest = { purpose: "reviewed", bindings: [{ result_id: result.id, revision_hash: result.revision_hash,
      source_id: source.id, source_sha256: source.sha256, subset: "all", group_ids: [] }] };
    expect(bridge.planDataExport).toHaveBeenCalledWith(request, expect.stringMatching(/^scientific-export:[0-9a-f-]{36}$/));
    expect(bridge.execute).not.toHaveBeenCalled();
    expect(screen.getByRole("cell", { name: "9007199254740993" })).toBeVisible();
    expect(screen.getByRole("cell", { name: "0.1234567890123456789012345" })).toBeVisible();
    expect(screen.getByRole("cell", { name: "µm²" })).toBeVisible();
    for (const label of ["Results", "Sources", "Objects in revisions", "Objects to export", "Metric values", "Groups", "Group memberships", "Declared condition/replicate groups", "Sources without a declared replicate"]) {
      expect(screen.getByText(label, { selector: "dt" })).toBeVisible();
    }
    fireEvent.click(exportButton);
    await screen.findByText("Saved Synthetic.data · 1 results · 1 sources · 2 objects.");
    expect(bridge.exportDataPackage).toHaveBeenCalledWith(opaque, expect.stringMatching(/^scientific-export:/));
    expect(vi.mocked(bridge.exportDataPackage!).mock.calls[0][1]).not.toBe(vi.mocked(bridge.planDataExport!).mock.calls[0][1]);
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledWith(snapshot));
  });

  it("uses explicit study revision checkboxes and never substitutes a newer revision", async () => {
    const bridge = api();
    const view = render(<ScientificDataExportPanel api={bridge} snapshot={snapshot} result={result} />);
    choose("Data export result scope", "study");
    const choices = screen.getByRole("group", { name: "Exact result revisions" });
    const checkboxes = within(choices).getAllByRole("checkbox");
    expect(checkboxes[0]).toBeChecked(); expect(checkboxes[1]).not.toBeChecked();
    fireEvent.click(checkboxes[1]); await prepare();
    expect(vi.mocked(bridge.planDataExport!).mock.calls[0][0].bindings.map((binding) => [binding.result_id, binding.revision_hash])).toEqual([
      [result.id, result.revision_hash], [other.id, other.revision_hash],
    ]);
    fireEvent.click(checkboxes[1]); expect(screen.getByRole("button", { name: "Export data package…" })).toBeDisabled();
    await prepare();
    const updated = { ...result, revision_hash: "3".repeat(64) };
    view.rerender(<ScientificDataExportPanel api={bridge} snapshot={{ ...snapshot, results: [updated, other] }} result={updated} />);
    expect(screen.getByRole("button", { name: "Export data package…" })).toBeDisabled();
    expect(screen.getByText(/A selected revision or its matching source is unavailable/)).toBeVisible();
    expect(within(choices).getAllByRole("checkbox")[0]).not.toBeChecked();
  });

  it("loads only exact revision groups and requires one group per result before forming each union", async () => {
    const groupFor = (entry: ResearchResult, id: string) => ({ id, name: `Group ${entry.method_label}`, result_id: entry.id,
      revision_hash: entry.revision_hash, source_id: source.id, source_sha256: source.sha256, included_count: 1 });
    const firstGroup = groupFor(result, "4".repeat(32)), secondGroup = groupFor(other, "5".repeat(32));
    const bridge = api({ execute: vi.fn().mockImplementation(async (_op, request) => ({ groups: request.result_id === result.id ? [firstGroup] : [secondGroup] })) });
    render(<ScientificDataExportPanel api={bridge} snapshot={snapshot} result={result} />);
    choose("Data export result scope", "study");
    fireEvent.click(within(screen.getByRole("group", { name: "Exact result revisions" })).getAllByRole("checkbox")[1]);
    choose("Data export object scope", "groups");
    expect(screen.getByText("Loading named groups…")).toBeVisible();
    const first = await screen.findByRole("checkbox", { name: "Group Threshold · 1 objects" });
    const second = screen.getByRole("checkbox", { name: "Group Watershed · 1 objects" });
    expect(bridge.execute).toHaveBeenCalledWith("population_group_list", { result_id: result.id, revision_hash: result.revision_hash });
    expect(bridge.execute).toHaveBeenCalledWith("population_group_list", { result_id: other.id, revision_hash: other.revision_hash });
    expect(first).not.toBeChecked(); expect(second).not.toBeChecked();
    fireEvent.click(first); expect(screen.getByRole("button", { name: "Preview data" })).toBeDisabled();
    fireEvent.click(second); await prepare();
    expect(vi.mocked(bridge.planDataExport!).mock.calls[0][0].bindings.map((binding) => [binding.subset, binding.group_ids])).toEqual([
      ["groups", [firstGroup.id]], ["groups", [secondGroup.id]],
    ]);
    fireEvent.click(first); expect(screen.getByRole("button", { name: "Export data package…" })).toBeDisabled();
  });

  it.each(["pending", "excluded"])("requires reviewed revisions by default and preserves %s status in provisional exports", async (disposition) => {
    const unreviewed = { ...result, review: { disposition } };
    const bridge = api({ planDataExport: vi.fn().mockImplementation(async (request) => {
      const value = preview(request); value.plan.results[0].review_status = disposition; return value;
    }) });
    render(<ScientificDataExportPanel api={bridge} snapshot={{ ...snapshot, results: [unreviewed] }} result={unreviewed} />);
    fireEvent.click(screen.getByRole("button", { name: "Preview data" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Reviewed data requires every selected revision to be reviewed");
    expect(bridge.planDataExport).not.toHaveBeenCalled();
    choose("Data export purpose", "provisional"); await prepare();
    expect(vi.mocked(bridge.planDataExport!).mock.calls[0][0].purpose).toBe("provisional");
    expect(screen.getByText("Pending and excluded review statuses are preserved. Export does not approve a result.")).toBeVisible();
    expect(screen.getByRole("heading", { name: `Sample image · ${disposition}` })).toBeVisible();
  });

  it.each(["purpose", "scope", "review", "sample", "source", "revision"])("invalidates a prepared plan after %s changes", async (change) => {
    const bridge = api();
    const view = render(<ScientificDataExportPanel api={bridge} snapshot={snapshot} result={result} />);
    await prepare();
    if (change === "purpose") choose("Data export purpose", "provisional");
    if (change === "scope") choose("Data export object scope", "groups");
    if (change === "review") view.rerender(<ScientificDataExportPanel api={bridge} snapshot={{ ...snapshot, results: [{ ...result, review: { disposition: "excluded" } }, other] }} result={result} />);
    if (change === "sample") view.rerender(<ScientificDataExportPanel api={bridge} snapshot={{ ...snapshot, samples: [{ id: source.id, revision: 1, data: { study: "Study", sample: "A", condition: "Control", biological_replicate: "R1" } }] }} result={result} />);
    if (change === "source") view.rerender(<ScientificDataExportPanel api={bridge} snapshot={{ ...snapshot, sources: [{ ...source, sha256: "6".repeat(64) }] }} result={result} />);
    if (change === "revision") view.rerender(<ScientificDataExportPanel api={bridge} snapshot={{ ...snapshot, results: [{ ...result, revision_hash: "6".repeat(64) }] }} result={result} />);
    if (["purpose", "review", "sample"].includes(change)) {
      expect(screen.getByText("Export settings or review state changed since the last preview. Preview data again before exporting.")).toBeVisible();
    }
    expect(screen.getByRole("button", { name: "Export data package…" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Export data package…" })); expect(bridge.exportDataPackage).not.toHaveBeenCalled();
  });

  it("provides direct recovery actions for pending revisions, study revision inspection, and empty named groups", async () => {
    const pendingOther: ResearchResult = { ...other, review: { disposition: "pending" } };
    const onSelectResult = vi.fn();
    const onOpenPopulation = vi.fn();
    const bridge = api({
      execute: vi.fn().mockResolvedValue({ groups: [] }),
      planDataExport: vi.fn().mockImplementation(async (request) => preview(request)),
    });
    render(
      <ScientificDataExportPanel
        api={bridge}
        snapshot={{ ...snapshot, results: [result, pendingOther] }}
        result={result}
        onSelectResult={onSelectResult}
        onOpenPopulation={onOpenPopulation}
      />,
    );
    choose("Data export result scope", "study");
    const choices = screen.getByRole("group", { name: "Exact result revisions" });
    const inspectBtn = within(choices).getByRole("button", { name: `Inspect rev ${pendingOther.revision_hash.slice(0, 8)}` });
    fireEvent.click(inspectBtn);
    expect(onSelectResult).toHaveBeenCalledWith(pendingOther);

    fireEvent.click(within(choices).getAllByRole("checkbox")[1]);
    fireEvent.click(screen.getByRole("button", { name: "Preview data" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Reviewed data requires every selected revision to be reviewed");
    fireEvent.click(screen.getByRole("button", { name: `Inspect unreviewed rev ${pendingOther.revision_hash.slice(0, 8)}` }));
    expect(onSelectResult).toHaveBeenLastCalledWith(pendingOther);

    fireEvent.click(screen.getByRole("button", { name: "Use Provisional data for review" }));
    expect(screen.getByRole("combobox", { name: "Data export purpose" })).toHaveValue("provisional");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    choose("Data export object scope", "groups");
    expect((await screen.findAllByText("No named groups for this revision. Save a group or choose All objects.")).length).toBe(2);
    fireEvent.click(screen.getAllByRole("button", { name: "Create group in Statistics & objects" })[0]);
    expect(onOpenPopulation).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getAllByRole("button", { name: "Use All objects" })[0]);
    expect(screen.getByRole("combobox", { name: "Data export object scope" })).toHaveValue("all");
  });

  it("cancels obsolete planning by exact key and rejects its late response", async () => {
    const old = deferred<ScientificExportPreview>();
    const bridge = api({ planDataExport: vi.fn().mockImplementationOnce(() => old.promise).mockImplementation(async (request) => preview(request)) });
    render(<ScientificDataExportPanel api={bridge} snapshot={snapshot} result={result} />);
    fireEvent.click(screen.getByRole("button", { name: "Preview data" }));
    expect(screen.getByRole("status")).toHaveTextContent("Preparing preview");
    const [oldPayload, oldKey] = vi.mocked(bridge.planDataExport!).mock.calls[0];
    choose("Data export purpose", "provisional");
    await waitFor(() => expect(bridge.cancelDataExport).toHaveBeenCalledWith(oldKey));
    await prepare();
    await act(async () => old.resolve(preview(oldPayload, { selected_count: 0 })));
    expect(screen.getByRole("heading", { name: "Sample image · pending" })).toBeVisible();
    expect(screen.queryByText(/This scope contains zero objects/)).not.toBeInTheDocument();
    expect(bridge.cancelJob).not.toHaveBeenCalled();
  });

  it("keeps cancellation available while busy and ignores late publication responses", async () => {
    const publication = deferred<ScientificExportReceipt | null>();
    const bridge = api({ exportDataPackage: vi.fn().mockReturnValue(publication.promise) });
    const view = render(<ScientificDataExportPanel api={bridge} snapshot={snapshot} result={result} />);
    await prepare(); fireEvent.click(screen.getByRole("button", { name: "Export data package…" }));
    const exportKey = vi.mocked(bridge.exportDataPackage!).mock.calls[0][1];
    view.rerender(<ScientificDataExportPanel api={bridge} snapshot={snapshot} result={result} busy />);
    const cancel = screen.getByRole("button", { name: "Cancel data export" }); expect(cancel).toBeEnabled(); fireEvent.click(cancel);
    await screen.findByText("Cancellation requested. Check Jobs and the destination before retrying.");
    expect(bridge.cancelDataExport).toHaveBeenCalledExactlyOnceWith(exportKey);
    await act(async () => publication.resolve(receipt));
    expect(screen.queryByText(/^Saved Synthetic/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export data package…" })).toBeDisabled();
    expect(bridge.cancelJob).not.toHaveBeenCalled();
  });

  it("discovers an export started from idle before its receipt so Jobs can cancel it", async () => {
    const publication = deferred<ScientificExportReceipt | null>();
    const onSnapshot = vi.fn();
    const bridge = api({ exportDataPackage: vi.fn().mockReturnValue(publication.promise) });
    const current = () => ({ ...snapshot, jobs: [{ id: "job", operation: "scientific_data_export",
      request_key: vi.mocked(bridge.exportDataPackage!).mock.calls[0][1], state: "running", progress: 0.25 } as ResearchJob] });
    vi.mocked(bridge.getSnapshot).mockImplementation(async () => current());
    const view = render(<ScientificDataExportPanel api={bridge} snapshot={snapshot} result={result} onSnapshot={onSnapshot} />);
    await prepare(); fireEvent.click(screen.getByRole("button", { name: "Export data package…" }));
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledWith(current()));
    expect(screen.queryByText(/^Saved Synthetic/)).not.toBeInTheDocument();
    view.rerender(<ScientificDataExportPanel api={bridge} snapshot={current()} result={result} onSnapshot={onSnapshot} />);
    expect(screen.getByRole("progressbar", { name: "Scientific data export progress" })).toHaveAttribute("value", "0.25");
    expect(bridge.cancelDataExport).not.toHaveBeenCalled();
    await act(async () => publication.resolve(receipt));
    await screen.findByText("Saved Synthetic.data · 1 results · 1 sources · 2 objects.");
  });

  it("shows progress only for this exact export job and keeps a preview after picker cancellation", async () => {
    const publication = deferred<ScientificExportReceipt | null>();
    const bridge = api({ exportDataPackage: vi.fn().mockReturnValue(publication.promise) });
    const view = render(<ScientificDataExportPanel api={bridge} snapshot={snapshot} result={result} />);
    await prepare(); fireEvent.click(screen.getByRole("button", { name: "Export data package…" }));
    const key = vi.mocked(bridge.exportDataPackage!).mock.calls[0][1];
    const job = { id: "j", operation: "scientific_data_export", request_key: "unrelated", state: "running", progress: 0.9 } as ResearchJob;
    view.rerender(<ScientificDataExportPanel api={bridge} snapshot={{ ...snapshot, jobs: [job] }} result={result} />);
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    view.rerender(<ScientificDataExportPanel api={bridge} snapshot={{ ...snapshot, project: { ...snapshot.project, counts: { job: 2, document: 1 } }, jobs: [job, { ...job, id: "ours", request_key: key, progress: 0.25 }] }} result={result} />);
    expect(screen.getByRole("progressbar", { name: "Scientific data export progress" })).toHaveAttribute("value", "0.25");
    expect(bridge.cancelDataExport).not.toHaveBeenCalled();
    await act(async () => publication.resolve(null));
    expect(screen.getByText("Destination selection cancelled. The preview is ready to export.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Export data package…" })).toBeEnabled();
  });

  it("explains an existing destination without IPC details and requires a fresh preview", async () => {
    const bridge = api({ exportDataPackage: vi.fn().mockRejectedValue(new Error(
      "Error invoking remote method 'loci-research:data-export-package': Error: ValueError: Data export destination must be absent",
    )) });
    render(<ScientificDataExportPanel api={bridge} snapshot={snapshot} result={result} />);
    await prepare();
    fireEvent.click(screen.getByRole("button", { name: "Export data package…" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("That destination already exists. Choose a new package name or destination. Prepare a new preview before exporting.");
    expect(alert).not.toHaveTextContent(/invoking remote|loci-research|ValueError|Error:/);
    expect(screen.getByRole("button", { name: "Export data package…" })).toBeDisabled();
    await prepare();
    expect(screen.getByRole("button", { name: "Export data package…" })).toBeEnabled();
  });

  it("explains empty studies, unavailable sources, zero objects and mixed units", async () => {
    const bridge = api({ planDataExport: vi.fn().mockImplementation(async (request) => {
      const value = preview(request, { total_count: 0, selected_count: 0, measurement_count: 0, mixed_units: true });
      value.plan.results[0] = { ...value.plan.results[0], total_count: 0, selected_count: 0, measurement_count: 0, preview: [] }; return value;
    }) });
    const view = render(<ScientificDataExportPanel api={bridge} snapshot={{ ...snapshot, results: [] }} result={null} />);
    expect(screen.getByText("Select a result to export its scientific data.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Preview data" })).toBeDisabled();
    choose("Data export result scope", "study"); expect(screen.getByText("This study has no results. Run an analysis first.")).toBeVisible();
    choose("Data export result scope", "current");
    view.rerender(<ScientificDataExportPanel api={bridge} snapshot={{ ...snapshot, sources: [{ ...source, locator_state: "relink-required" }] }} result={result} />);
    expect(screen.getByRole("button", { name: "Preview data" })).toBeDisabled();
    view.rerender(<ScientificDataExportPanel api={bridge} snapshot={snapshot} result={{ ...result, object_count: 0 }} />);
    await prepare();
    expect(screen.getByText(/This scope contains zero objects/)).toBeVisible();
    expect(screen.getByText(/Mixed measurement units are present. Compare rows within the same metric and unit/)).toBeVisible();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("contains long names in semantic controls and gives keyboard access to the preview table", async () => {
    const name = "Long scientific source ".repeat(25);
    const bridge = api({ planDataExport: vi.fn().mockImplementation(async (request) => {
      const value = preview(request); value.plan.results[0].name = name; return value;
    }) });
    render(<ScientificDataExportPanel api={bridge} snapshot={{ ...snapshot, sources: [{ ...source, name }] }} result={result} />);
    const scope = screen.getByRole("combobox", { name: "Data export result scope" }); scope.focus(); expect(scope).toHaveFocus();
    choose("Data export result scope", "study");
    const checkbox = within(screen.getByRole("group", { name: "Exact result revisions" })).getAllByRole("checkbox")[0];
    checkbox.focus(); expect(checkbox).toHaveFocus(); expect(checkbox).toHaveAccessibleName(new RegExp("Long scientific source"));
    await prepare();
    const region = screen.getByRole("region", { name: `Data preview for ${name.trim()}` });
    expect(region).toHaveAttribute("tabindex", "0"); region.focus(); expect(region).toHaveFocus();
    expect(within(region).getByRole("table")).toHaveAccessibleName("First 1 object rows · exact stored values");
  });

  it("rejects mismatched previews and clears a failed publication plan", async () => {
    const bridge = api({ planDataExport: vi.fn().mockImplementationOnce(async (request) => {
      const value = preview(request); value.plan.results[0].revision_hash = "7".repeat(64); return value;
    }).mockImplementation(async (request) => preview(request)), exportDataPackage: vi.fn().mockRejectedValue(new Error("The plan is stale")) });
    render(<ScientificDataExportPanel api={bridge} snapshot={snapshot} result={result} />);
    fireEvent.click(screen.getByRole("button", { name: "Preview data" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Preview does not match the requested exact revisions");
    expect(screen.getByRole("button", { name: "Export data package…" })).toBeDisabled();
    await prepare(); fireEvent.click(screen.getByRole("button", { name: "Export data package…" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("The plan is stale Prepare a new preview before exporting."));
    expect(screen.getByRole("button", { name: "Export data package…" })).toBeDisabled();
  });

  it("reports group loading errors and empty groups without enabling an invalid subset", async () => {
    const bridge = api({ execute: vi.fn().mockRejectedValueOnce(new Error("Group lookup failed")).mockResolvedValue({ groups: [] }) });
    render(<ScientificDataExportPanel api={bridge} snapshot={snapshot} result={result} />);
    choose("Data export object scope", "groups");
    expect(await screen.findByRole("alert")).toHaveTextContent("Group lookup failed");
    fireEvent.click(screen.getByRole("button", { name: "Refresh groups" }));
    expect(await screen.findByText("No named groups for this revision. Save a group or choose All objects.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Preview data" })).toBeDisabled();
    choose("Data export object scope", "all"); await prepare();
  });
});
