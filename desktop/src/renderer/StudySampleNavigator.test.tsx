// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResearchResult, ResearchSnapshot, ResearchSource } from "../shared/research-contracts";
import { StudySampleNavigator, studyResultReviewState } from "./StudySampleNavigator";
import { resolveStudyResult, resolveStudySource } from "./study-sample-navigation";

afterEach(cleanup);
const source = (id: number, name = `Image ${id}`): ResearchSource => ({ id: String(id).padStart(32, "0"),
  sha256: String(id).padStart(64, "0"), name, metadata: {} });
const result = (id: number, owner: ResearchSource, review?: ResearchResult["review"]): ResearchResult => ({
  id: String(id + 100).padStart(32, "0"), revision_hash: String(id + 200).padStart(64, "0"), source_id: owner.id,
  source_sha256: owner.sha256, kind: "segmentation", created_at: `2026-10-22T00:${String(id % 60).padStart(2, "0")}:00Z`, object_count: 3, review,
});
function fixture(): ResearchSnapshot {
  const sources = Array.from({ length: 8 }, (_, index) => source(index + 1, index < 2 ? "Duplicate.ome.tif" : `Image ${index + 1}`));
  sources[7].locator_state = "relink-required";
  const parent = result(1, sources[0], { disposition: "reviewed", schema: "loci.result-review/v2", actor: "human" });
  return { project: { project_id: "study-a", title: "Study" }, sources, results: [parent,
    { ...result(2, sources[0]), kind: "corrected-labels", parent_id: parent.id },
    result(3, sources[0], { disposition: "excluded" }),
    result(4, sources[0], { disposition: "reviewed", actor: "agent", schema: "loci.result-review/v2" }),
    result(5, sources[1], { disposition: "reviewed", result_id: parent.id }),
    result(6, sources[2], { disposition: "unknown" })],
    samples: [
      { id: sources[0].id, revision: 1, data: { study: "Study", sample: "Field A", condition: "A", biological_replicate: "R1" } },
      { id: sources[1].id, revision: 1, data: { study: "Study", sample: "Field B", condition: "B", biological_replicate: "R1" } },
      { id: sources[2].id, revision: 1, data: { study: "Study", sample: "Field C", condition: "A", biological_replicate: null } },
      { id: sources[4].id, revision: 1, data: { study: "  ", sample: "Field E", condition: "B", biological_replicate: "R2" } },
      { id: sources[5].id, revision: 1, data: { study: "Study", sample: "Literal sentinel", condition: "Unassigned", biological_replicate: "Unassigned" } },
      { id: sources[6].id, revision: 1, data: { study: "Study", sample: "Unicode 核", condition: " α ", biological_replicate: " R1 " } },
      { id: "Image 4", revision: 1, data: { study: "Wrong filename join", sample: "Must not match", condition: "Wrong" } },
    ], recipes: [], displays: [], selections: [], jobs: [], operations: {} };
}
function mount(snapshot = fixture()) {
  const onInspectResult = vi.fn(), onEditMetadata = vi.fn();
  const props = { snapshot, onInspectResult, onEditMetadata };
  return { ...render(<StudySampleNavigator {...props} />), props, onInspectResult, onEditMetadata };
}
const rowFor = (source: ResearchSource) => document.querySelector<HTMLTableRowElement>(`tr[data-source-id="${source.id}"]`)!;
const sourceRows = () => [...screen.getByRole("table").querySelectorAll<HTMLTableRowElement>("tbody > tr")];
const ids = () => sourceRows().map((row) => row.dataset.sourceId);
const choose = (name: string, value: string) => fireEvent.change(screen.getByRole("combobox", { name }), { target: { value } });
const declared = (value: string) => JSON.stringify(["declared", value]);
const openResults = (source: ResearchSource) => {
  const details = within(rowFor(source)).getByText(/^Results \(/).closest("details")!;
  details.open = true; fireEvent(details, new Event("toggle"));
  return within(rowFor(source));
};

describe("StudySampleNavigator", () => {
  it("joins samples only by exact source ID and separates missing metadata, optional replicate and source availability", () => {
    const study = fixture(); mount(study);
    expect(ids()).toEqual(study.sources.map((row) => row.id));
    expect(within(rowFor(study.sources[0])).getByText("Field A")).toBeVisible();
    expect(within(rowFor(study.sources[1])).getByText("Field B")).toBeVisible();
    expect(rowFor(study.sources[3])).not.toHaveTextContent("Must not match");
    choose("Sample status", "missing");
    expect(ids()).toEqual([3, 4, 7].map((index) => study.sources[index].id));
    choose("Sample status", "unassigned");
    expect(ids()).toEqual([2, 3, 7].map((index) => study.sources[index].id));
    choose("Sample status", "none");
    expect(ids()).toEqual(study.sources.slice(3).map((row) => row.id));
    choose("Sample status", "all");
    expect(within(rowFor(study.sources[7])).getByText("Relink required")).toBeVisible();
    expect(screen.queryByText(/analysis ready/i)).not.toBeInTheDocument();
  });
  it("filters exact condition/replicate pairs without merging literal Unassigned, whitespace, case or Unicode declarations", () => {
    const study = fixture(); const view = mount(study);
    choose("Biological replicate filter", declared("R1"));
    expect(ids()).toEqual(study.sources.slice(0, 2).map((row) => row.id));
    choose("Condition filter", declared("B")); expect(ids()).toEqual([study.sources[1].id]);
    choose("Condition filter", "all");
    choose("Biological replicate filter", declared("Unassigned")); expect(ids()).toEqual([study.sources[5].id]);
    choose("Biological replicate filter", "unassigned"); expect(ids()).toEqual([2, 3, 7].map((index) => study.sources[index].id));
    choose("Biological replicate filter", declared(" R1 ")); choose("Condition filter", declared(" α "));
    expect(ids()).toEqual([study.sources[6].id]);
    expect(within(rowFor(study.sources[6])).getByText("α")).toHaveTextContent("α");
    expect(view.onInspectResult).not.toHaveBeenCalled(); expect(view.onEditMetadata).not.toHaveBeenCalled();
  });
  it("searches image and sample names while preserving duplicate filenames and source order", () => {
    const study = fixture(); mount(study);
    const search = screen.getByRole("searchbox", { name: "Find images or samples" });
    fireEvent.change(search, { target: { value: "Duplicate" } }); expect(ids()).toEqual(study.sources.slice(0, 2).map((row) => row.id));
    fireEvent.change(search, { target: { value: "field b" } }); expect(ids()).toEqual([study.sources[1].id]);
    fireEvent.change(search, { target: { value: "核" } }); expect(ids()).toEqual([study.sources[6].id]);
  });
  it("counts every exact revision, keeps reviewed parents and pending children, and preserves agent review attribution", () => {
    const study = fixture(); const view = mount(study);
    expect(rowFor(study.sources[0])).toHaveTextContent("1 to review · 2 reviewed · 1 excluded");
    choose("Sample status", "pending"); expect(ids()).toEqual(study.sources.slice(0, 3).map((row) => row.id));
    const row = openResults(study.sources[0]);
    expect(row.getAllByRole("button", { name: "Inspect result" })).toHaveLength(4);
    expect(row.getByText("Reviewed by researcher")).toBeVisible(); expect(row.getByText("Reviewed by agent")).toBeVisible();
    expect(row.getByText("Corrected segmentation")).toBeVisible();
    expect(row.getByText("To review")).toBeVisible();
    fireEvent.click(row.getAllByRole("button", { name: "Inspect result" })[1]);
    expect(view.onInspectResult).toHaveBeenCalledWith(study.results[1]);
    const next = { ...study, results: study.results.map((result, index) => index === 1 ? { ...result, review: { disposition: "excluded" } } : result) };
    view.rerender(<StudySampleNavigator {...view.props} snapshot={next} />);
    expect(rowFor(study.sources[0])).toBeNull();
    choose("Sample status", "all");
    expect(rowFor(study.sources[0])).toHaveTextContent("0 to review · 2 reviewed · 2 excluded");
  });
  it.each([
    undefined, { disposition: "unknown" }, { disposition: "reviewed", result_id: "wrong" },
    { disposition: "excluded", revision_hash: "wrong" },
    { disposition: "reviewed", actor: "agent" as const, result_id: "wrong" },
    { disposition: "reviewed", actor: "agent" as const, revision_hash: "wrong" },
  ])("treats missing, unknown and contradictory review records conservatively: %j", (review) => {
    const study = fixture(); expect(studyResultReviewState({ ...study.results[0], review })).toBe("pending");
  });
  it("discloses full result identities locally and disables an unverifiable result binding", () => {
    const study = fixture(); study.results[1].source_sha256 = "f".repeat(64);
    mount(study); const row = openResults(study.sources[0]);
    const item = row.getAllByRole("listitem")[1];
    expect(within(item).getByRole("button", { name: "Inspect result" })).toBeDisabled();
    const revision = within(item).getByText(study.results[1].revision_hash); expect(revision).not.toBeVisible();
    const details = within(item).getByText("Technical result identity").closest("details")!; details.open = true;
    expect(revision).toBeVisible(); expect(item).toHaveTextContent(study.results[1].id);
  });
  it("bounds source/result rendering with pages while retaining access to every revision", () => {
    const study = fixture(); study.sources = Array.from({ length: 61 }, (_, index) => source(index + 1));
    study.results = Array.from({ length: 23 }, (_, index) => result(index + 1, study.sources[0]));
    mount(study); expect(sourceRows()).toHaveLength(25);
    fireEvent.click(screen.getByRole("button", { name: "Next images" })); expect(ids()[0]).toBe(study.sources[25].id);
    fireEvent.click(screen.getByRole("button", { name: "Next images" })); expect(sourceRows()).toHaveLength(11);
    fireEvent.change(screen.getByRole("searchbox", { name: "Find images or samples" }), { target: { value: "Image 1" } });
    const row = openResults(study.sources[0]); expect(row.getAllByRole("listitem")).toHaveLength(10);
    fireEvent.click(row.getByRole("button", { name: "Next results" }));
    expect(row.getAllByRole("listitem")).toHaveLength(10);
    expect(row.getAllByRole("listitem")[0]).toHaveAttribute("data-result-id", study.results[10].id);
    fireEvent.click(row.getByRole("button", { name: "Next results" })); expect(row.getAllByRole("listitem")).toHaveLength(3);
    expect(row.getAllByRole("listitem")[2]).toHaveAttribute("data-result-id", study.results[22].id);
  });
  it("prunes vanished declarations and resets filters for another study", () => {
    const study = fixture(); const view = mount(study);
    choose("Condition filter", declared("A")); choose("Biological replicate filter", declared("R1"));
    const next = { ...study, samples: study.samples.map((sample) => ({ ...sample, data: { ...sample.data, condition: "Changed", biological_replicate: "R2" } })) };
    view.rerender(<StudySampleNavigator {...view.props} snapshot={next} />);
    expect(screen.getByRole("combobox", { name: "Condition filter" })).toHaveValue("all");
    expect(screen.getByRole("combobox", { name: "Biological replicate filter" })).toHaveValue("all");
    fireEvent.change(screen.getByRole("searchbox", { name: "Find images or samples" }), { target: { value: "No match" } });
    choose("Sample status", "pending");
    view.rerender(<StudySampleNavigator {...view.props} snapshot={{ ...next, project: { project_id: "another-study", title: "Another" } }} />);
    expect(screen.getByRole("searchbox", { name: "Find images or samples" })).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "Sample status" })).toHaveValue("all");
  });
  it("gates navigation when busy and reports rejected navigation without any mutation capability", async () => {
    const study = fixture(); const onInspectResult = vi.fn().mockRejectedValue(new Error("Exact result changed"));
    const onEditMetadata = vi.fn();
    const view = render(<StudySampleNavigator snapshot={study} onInspectResult={onInspectResult} onEditMetadata={onEditMetadata} busy />);
    const row = openResults(study.sources[0]);
    for (const button of row.getAllByRole("button")) expect(button).toBeDisabled();
    view.rerender(<StudySampleNavigator snapshot={study} onInspectResult={onInspectResult} onEditMetadata={onEditMetadata} />);
    fireEvent.click(row.getAllByRole("button", { name: "Inspect result" })[0]);
    expect(await screen.findByRole("alert")).toHaveTextContent("Exact result changed");
    expect(onEditMetadata).not.toHaveBeenCalled();
  });
});

describe("exact study navigation resolution", () => {
  it("requires the complete current result/source binding and rejects removed or replaced records", () => {
    const study = fixture(), target = study.results[0];
    expect(resolveStudyResult(study, target)).toBe(target);
    expect(resolveStudySource(study, study.sources[0])).toBe(study.sources[0]);
    expect(() => resolveStudyResult({ ...study, results: [] }, target)).toThrow(/exact result revision/);
    for (const changes of [{ revision_hash: "f".repeat(64) }, { source_id: study.sources[1].id }, { source_sha256: study.sources[1].sha256 }])
      expect(() => resolveStudyResult({ ...study, results: [{ ...target, ...changes }] }, target)).toThrow(/exact result revision/);
    expect(() => resolveStudyResult({ ...study, sources: study.sources.slice(1) }, target)).toThrow(/source fingerprint/);
    const replacement = { ...study.sources[0], sha256: "f".repeat(64) };
    expect(() => resolveStudyResult({ ...study, sources: [replacement] }, target)).toThrow(/source fingerprint/);
    expect(() => resolveStudySource({ ...study, sources: [replacement] }, study.sources[0])).toThrow(/source fingerprint/);
    expect(() => resolveStudyResult(study, { ...target, source_sha256: undefined })).toThrow(/exact result revision/);
  });
});
