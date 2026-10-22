// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResearchDesktopApi, ResearchSnapshot } from "../shared/research-contracts";
import type { SampleSheetPreview } from "../shared/intensity-contracts";
import { SampleSheetPanel } from "./SampleSheetPanel";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const source = { id: "a".repeat(32), name: "Image A", sha256: "b".repeat(64), metadata: {} };
const before = { study: "Study", sample: "Field A", condition: "Control", biological_replicate: null, plate: null, well: null };
const after = { ...before, condition: "Treatment", biological_replicate: "R1" };
const snapshot: ResearchSnapshot = { project: { project_id: "c".repeat(32), title: "Study" }, sources: [source], results: [], samples: [{ id: source.id, revision: 1, data: before }], recipes: [], displays: [], selections: [], jobs: [], operations: {} };
const csv = `source_id,study,sample,condition,biological_replicate,plate,well\n${source.id},Study,Field A,Treatment,R1,,\n`;
const sheetPreview = (text = csv): SampleSheetPreview => ({ schema: "loci.sample-sheet-preview/v1", study_id: snapshot.project.project_id!, csv_text: text,
  rows: [{ row_number: 2, source_id: source.id, before, after, match: "matched", issues: [] }], errors: [], bindings: { metadata_revision: 1 }, can_apply: true, preview_sha256: "d".repeat(64) });
function mount(overrides: { execute?: ResearchDesktopApi["execute"]; snapshot?: ResearchSnapshot } = {}) {
  const execute = vi.fn(async (operation: string, request: Record<string, unknown>) => {
    if (overrides.execute) { const result = await overrides.execute(operation, request); if (result !== undefined) return result; }
    if (operation === "sample_sheet_template") return { schema: "loci.sample-sheet-template/v1", study_id: snapshot.project.project_id, csv_text: csv };
    if (operation === "sample_sheet_preview") return sheetPreview(request.csv_text as string);
    if (operation === "sample_sheet_apply") return { schema: "loci.sample-sheet-apply/v1", samples: [] };
    throw new Error(`Unexpected operation ${operation}`);
  });
  const api = { execute, getSnapshot: vi.fn().mockResolvedValue({ ...snapshot, samples: [{ id: source.id, revision: 2, data: after }] }) } as unknown as ResearchDesktopApi;
  const onSnapshot = vi.fn(), props = { api, snapshot: overrides.snapshot ?? snapshot, onSnapshot };
  return { ...render(<SampleSheetPanel {...props} />), api, execute, onSnapshot, props };
}
const setCsv = (value: string) => fireEvent.change(screen.getByRole("textbox", { name: "Sample sheet CSV" }), { target: { value } });
const prepare = async () => {
  fireEvent.click(screen.getByRole("button", { name: "Preview sample sheet" }));
  await screen.findByRole("region", { name: "Sample sheet before and after" });
};

describe("SampleSheetPanel", () => {
  it("places read-only source navigation above the CSV editor without changing its preview contract", async () => {
    const onInspectResult = vi.fn(), onEditMetadata = vi.fn();
    const view = mount();
    view.rerender(<SampleSheetPanel {...view.props} onInspectResult={onInspectResult} onEditMetadata={onEditMetadata} />);
    const navigator = screen.getByRole("region", { name: "Sources & samples" });
    const editor = screen.getByRole("textbox", { name: "Sample sheet CSV" });
    expect(navigator.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    setCsv(csv); await prepare();
    const prepared = screen.getByRole("region", { name: "Sample sheet before and after" });
    fireEvent.change(within(navigator).getByRole("searchbox"), { target: { value: "Field A" } });
    fireEvent.click(within(navigator).getByRole("button", { name: "Edit metadata" }));
    expect(onEditMetadata).toHaveBeenCalledWith(source);
    expect(onInspectResult).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Sample sheet CSV" })).toBe(editor);
    expect(editor).toHaveValue(csv); expect(prepared).toBeVisible();
    expect(view.execute.mock.calls.map(([operation]) => operation)).toEqual(["sample_sheet_preview"]);
    expect(screen.getByRole("button", { name: "Apply sample sheet" })).toBeEnabled();
    view.rerender(<SampleSheetPanel {...view.props} onEditMetadata={onEditMetadata}
      snapshot={{ ...snapshot, samples: [{ ...snapshot.samples[0], revision: 2 }] }} />);
    expect(editor).toHaveValue(csv);
    expect(screen.getByRole("button", { name: "Apply sample sheet" })).toBeDisabled();
  });
  it("keeps format limits and validation visible while disclosing the full CSV column reference", () => {
    mount();
    expect(screen.getByText("UTF-8 CSV · up to 1,000 rows and 1 MiB. Preview validates every row before applying.")).toBeVisible();
    const columns = screen.getByText(/Columns: source_id, study, sample/);
    expect(columns).not.toBeVisible();
    const summary = screen.getByText("CSV columns & source matching");
    summary.focus(); expect(summary).toHaveFocus(); fireEvent.click(summary);
    expect(columns).toBeVisible();
    expect(columns).toHaveTextContent("exact source_id from the template");
    expect(screen.getByRole("button", { name: "Apply sample sheet" })).toBeDisabled();
  });
  it("loads an inspectable template, downloads literal CSV and applies only the exact preview", async () => {
    const createObjectURL = vi.fn().mockReturnValue("blob:sample-template"), revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const view = mount();
    fireEvent.click(screen.getByRole("button", { name: "Load sample sheet template" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Sample sheet CSV" })).toHaveValue(csv));
    fireEvent.click(screen.getByRole("button", { name: "Download sample sheet template" }));
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob)); expect(click).toHaveBeenCalledOnce(); click.mockRestore();
    await prepare();
    expect(screen.getByRole("table", { name: /Every CSV row/ })).toHaveTextContent("Control");
    expect(screen.getByRole("table", { name: /Every CSV row/ })).toHaveTextContent("Treatment");
    fireEvent.click(screen.getByRole("button", { name: "Apply sample sheet" }));
    await waitFor(() => expect(view.execute).toHaveBeenCalledWith("sample_sheet_apply", { preview: sheetPreview() }));
    await screen.findByText("Applied sample metadata for 1 images.");
    expect(view.onSnapshot).toHaveBeenCalledWith(expect.objectContaining({ samples: [{ id: source.id, revision: 2, data: after }] }));
    expect(screen.getByRole("button", { name: "Apply sample sheet" })).toBeDisabled();
  });
  it("invalidates preview after CSV edits or sample/source revision changes and rejects a stale apply", async () => {
    const view = mount({ execute: async (operation) => { if (operation === "sample_sheet_apply") throw new Error("Preview is stale; no metadata changed"); return undefined; } });
    setCsv(csv); await prepare();
    setCsv(csv.replace("R1", "R2"));
    expect(screen.getByRole("button", { name: "Apply sample sheet" })).toBeDisabled();
    expect(screen.getByText(/CSV or study metadata changed/)).toBeVisible();
    await prepare();
    view.rerender(<SampleSheetPanel {...view.props} snapshot={{ ...snapshot, samples: [{ ...snapshot.samples[0], revision: 2 }] }} />);
    expect(screen.getByRole("button", { name: "Apply sample sheet" })).toBeDisabled();
    await prepare();
    fireEvent.click(screen.getByRole("button", { name: "Apply sample sheet" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Preview is stale");
    expect(screen.getByRole("button", { name: "Apply sample sheet" })).toBeDisabled();
    expect(view.onSnapshot).not.toHaveBeenCalled();
  });
  it("shows every unknown, duplicate and missing-field issue and blocks atomic apply", async () => {
    const invalid = sheetPreview(); invalid.can_apply = false;
    invalid.rows = [
      { ...invalid.rows[0], issues: ["Conflicting duplicate source_id"] },
      { ...invalid.rows[0], row_number: 3, issues: ["Conflicting duplicate source_id"] },
      { row_number: 4, source_id: "unknown", before: null, after: null, match: "unmatched", issues: ["Unknown source_id", "Sample is required"] },
    ];
    const view = mount({ execute: async (operation) => operation === "sample_sheet_preview" ? invalid : undefined });
    setCsv(csv); await prepare();
    expect(screen.getByText("2 matched rows · 1 unmatched rows")).toBeVisible();
    expect(screen.getAllByText("Conflicting duplicate source_id")).toHaveLength(2);
    expect(screen.getByText("Unknown source_id")).toBeVisible(); expect(screen.getByText("Sample is required")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Apply sample sheet" }));
    expect(view.execute.mock.calls.some(([operation]) => operation === "sample_sheet_apply")).toBe(false);
  });
  it("checks the 1 MiB bound before file/text preview and reports malformed CSV errors", async () => {
    const view = mount({ execute: async (operation) => { if (operation === "sample_sheet_preview") throw new Error("Malformed CSV quoting"); return undefined; } });
    const file = new File(["x".repeat(1024 * 1024 + 1)], "oversize.csv", { type: "text/csv" });
    fireEvent.change(screen.getByLabelText("Sample sheet file"), { target: { files: [file] } });
    expect(await screen.findByRole("alert")).toHaveTextContent("at most 1 MiB");
    expect(view.execute).not.toHaveBeenCalled();
    setCsv("x".repeat(1024 * 1024 + 1)); expect(screen.getByRole("button", { name: "Preview sample sheet" })).toBeDisabled();
    setCsv('source_id,"unterminated'); fireEvent.click(screen.getByRole("button", { name: "Preview sample sheet" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Malformed CSV quoting");
    expect(screen.getByRole("button", { name: "Apply sample sheet" })).toBeDisabled();
  });
});
