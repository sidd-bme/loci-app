// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResearchChannelDeclaration, ResearchDesktopApi, ResearchResult, ResearchSnapshot, ResearchSource } from "../shared/research-contracts";
import { PERINUCLEAR_RULES, PERINUCLEAR_VIEWS, type ResearchPerinuclearRecord, type ResearchPerinuclearResponse, type ResearchPerinuclearRow } from "../shared/perinuclear-contracts";
import { PerinuclearResultSummary, ResearchPerinuclearPanel } from "./ResearchPerinuclearPanel";
import { perinuclearRevisionKey } from "./perinuclear-validation";

afterEach(cleanup);
const source: ResearchSource = { id: "a".repeat(32), sha256: "b".repeat(64), name: "Declared fluorescence image", source_kind: "native",
  metadata: { sample_semantics: "scalar", channel_names: ["GFP", "DNA"], dimensions: { x: 10, y: 8, c: 2, z: 1, t: 1 } } };
const selection = { x: 0, y: 0, width: 10, height: 8, c: 1, z: 0, t: 0, level: 0 };
const geometry = { axes: "YX", unit: "pixel", frame: "image", affine: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]] };
const parent: ResearchResult = { schema: "loci.research-result/v1", perinuclear_nuclei_eligible: true, id: "c".repeat(32), revision_hash: "d".repeat(64), source_id: source.id, source_sha256: source.sha256,
  kind: "segmentation", created_at: "2026-10-23", object_count: 3, geometry, selection,
  arrays: { image: { shape: [8, 10], dtype: "float64", sha256: "3".repeat(64) }, labels: { shape: [8, 10], dtype: "uint32", sha256: "4".repeat(64) } } };
const channels: ResearchChannelDeclaration[] = ["GFP", "DNA"].map((name, index) => ({ index, name, marker: "", fluorophore: "", declaration: "Source declaration" }));
const rows: ResearchPerinuclearRow[] = [
  { label: 1, voxel_count: 4, touches_crop_border: false, intensity: { source_channel_0: { sum: 16, mean: 4, min: 4, max: 4, std_population: 0 } }, perinuclear_ring: { count: 8, sum: 16, mean: 2, nuclear_to_ring_mean_ratio: 2, exclusions: [] } },
  { label: 2, voxel_count: 4, touches_crop_border: true, intensity: { source_channel_0: { sum: 12, mean: 3, min: 3, max: 3, std_population: 0 } }, perinuclear_ring: { count: 6, sum: 6, mean: 1, nuclear_to_ring_mean_ratio: null, exclusions: ["boundary-touching-nucleus"] } },
  { label: 3, voxel_count: 4, touches_crop_border: false, intensity: { source_channel_0: { sum: 8, mean: 2, min: 2, max: 2, std_population: 0 } }, perinuclear_ring: { count: 0, sum: 0, mean: null, nuclear_to_ring_mean_ratio: null, exclusions: ["empty-ring"] } },
];
const record: ResearchPerinuclearRecord = { ...PERINUCLEAR_RULES, schema: "loci.perinuclear-enrichment/v1", signal_channel: 0, radius_px: 5, control: "Recorded acquisition and controls",
  nucleus_result: { result_id: parent.id, revision_hash: parent.revision_hash },
  summary: { object_count: 3, eligible_count: 1, excluded_count: 2, excluded_by_reason: { "boundary-touching-nucleus": 1, "empty-ring": 1, "zero-mean-ring": 0 }, endpoint_defined: true, median_ratio: 2, mean_ratio: 2 } };
const adopted: ResearchResult = { ...parent, id: "e".repeat(32), revision_hash: "f".repeat(64), kind: "perinuclear-enrichment", perinuclear_nuclei_eligible: false, parent_id: parent.id,
  selection: { ...selection, c: 0 }, perinuclear: record, arrays: { ...parent.arrays,
    image: { shape: [8, 10], dtype: "float64", sha256: "5".repeat(64) }, ring_labels: { shape: [8, 10], dtype: "uint32", sha256: "6".repeat(64) }, ring_ambiguous: { shape: [8, 10], dtype: "uint8", sha256: "7".repeat(64) } } };
const response: ResearchPerinuclearResponse = { adopted: true, result: adopted, perinuclear: record, summary: record.summary, measurements: rows, total_measurements: 3 };
const snapshot: ResearchSnapshot = { project: { title: "Declared study" }, sources: [source], results: [parent], samples: [], recipes: [], displays: [], selections: [], jobs: [],
  operations: { perinuclear_run: { mutates: true, summary: "Measure perinuclear enrichment" } } };
function panel(output: unknown = response, custom = snapshot) {
  const execute = vi.fn(async (operation: string, request: Record<string, unknown>) => operation === "result_view"
    ? { image: "data:image/png;base64,AA==", label_image: "data:image/png;base64,AA==", result_id: adopted.id,
      revision_hash: adopted.revision_hash, shape: [8, 10], axis: "z", index: 0, geometry,
      label_field: request.label_field, label_field_basis: PERINUCLEAR_VIEWS[request.label_field as keyof typeof PERINUCLEAR_VIEWS].basis }
    : output), onPublished = vi.fn().mockResolvedValue(undefined), onBusyChange = vi.fn();
  const props = { api: { execute } as unknown as ResearchDesktopApi, snapshot: custom, source: custom.sources[0], channels, workingBytes: 512 * 1024 ** 2,
    busy: false, report: async <T,>(work: () => Promise<T>) => work(), onBusyChange, onPublished };
  return { ...render(<ResearchPerinuclearPanel {...props} />), props, execute, onPublished, onBusyChange };
}
function choose(parentResult = parent) {
  fireEvent.change(screen.getByLabelText("Perinuclear nucleus result"), { target: { value: perinuclearRevisionKey(parentResult) } });
  fireEvent.change(screen.getByLabelText("Perinuclear raw signal channel"), { target: { value: "0" } });
  fireEvent.change(screen.getByLabelText("Perinuclear controls and assumptions"), { target: { value: record.control } });
}

describe("Perinuclear enrichment workflow", () => {
  it("requires an explicit saved revision and raw channel, then preserves the exact C0 request and exclusion accounting", async () => {
    const view = panel();
    const run = screen.getByRole("button", { name: "Measure perinuclear enrichment" });
    expect(run).toBeDisabled();
    expect(screen.getByLabelText("Perinuclear raw signal channel")).toHaveValue("");
    expect(screen.getByLabelText("Perinuclear ring radius (px)")).toHaveValue("5");
    const channel = screen.getByLabelText("Perinuclear raw signal channel");
    channel.focus(); expect(channel).toHaveFocus();
    expect(within(channel).getByRole("option", { name: "1: GFP" })).toHaveValue("0");
    choose();
    expect(screen.getByText("Full image · T 1 · Z 1 · 3 nuclei")).toBeVisible();
    fireEvent.click(run);
    await waitFor(() => expect(view.onPublished).toHaveBeenCalledWith(adopted));
    expect(view.execute.mock.calls.filter(([operation]) => operation === "perinuclear_run")).toHaveLength(1);
    expect(view.execute).toHaveBeenCalledWith("perinuclear_run", { result_id: parent.id, revision_hash: parent.revision_hash,
      signal_channel: 0, radius_px: 5, working_bytes: 512 * 1024 ** 2, control: record.control });
    const summary = await screen.findByRole("region", { name: "Perinuclear enrichment summary" });
    expect(summary).toHaveTextContent("1 of 3 nuclei");
    expect(summary).toHaveTextContent("Excluded nuclei2");
    fireEvent.click(within(summary).getByText("Exclusion reasons"));
    expect(summary).toHaveTextContent("Nucleus touches the image border1");
    expect(summary).toHaveTextContent("Empty ring1");
    fireEvent.click(screen.getByText("Object measurements (3)"));
    const table = screen.getByRole("table", { name: "Perinuclear object measurements" });
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    expect(within(table).getAllByText("Not defined")).toHaveLength(3);
    expect(await screen.findByRole("img", { name: "Nuclei (all) over the saved raw signal channel" })).toBeVisible();
  });

  it.each(["", "0", "-1", "129", "NaN"])("blocks invalid radius %s without substituting the default", (draft) => {
    const view = panel(); choose();
    fireEvent.change(screen.getByLabelText("Perinuclear ring radius (px)"), { target: { value: draft } });
    expect(screen.getByRole("button", { name: "Measure perinuclear enrichment" })).toBeDisabled();
    expect(screen.getByLabelText("Perinuclear ring radius (px)")).toHaveValue(draft);
    expect(view.execute).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByLabelText("Perinuclear ring radius (px)"), { key: "Escape" });
    expect(screen.getByLabelText("Perinuclear ring radius (px)")).toHaveValue("5");
    expect(screen.getByRole("button", { name: "Measure perinuclear enrichment" })).toBeEnabled();
  });

  it("only offers full native planes with exact source fingerprints and resets a replaced revision", () => {
    const bad = [
      { ...parent, id: "1".repeat(32), source_sha256: "1".repeat(64) },
      { ...parent, id: "2".repeat(32), selection: { ...selection, level: 1 } },
      { ...parent, id: "3".repeat(32), selection: { ...selection, x: 1, width: 9 } },
      { ...parent, id: "4".repeat(32), selection: { ...selection, z_stop: 1 } },
    ];
    const view = panel(response, { ...snapshot, results: [parent, ...bad] }); choose();
    expect(within(screen.getByLabelText("Perinuclear nucleus result")).getAllByRole("option")).toHaveLength(2);
    const replaced = { ...parent, revision_hash: "8".repeat(64) };
    view.rerender(<ResearchPerinuclearPanel {...view.props} snapshot={{ ...snapshot, results: [replaced] }} />);
    expect(screen.getByLabelText("Perinuclear nucleus result")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Measure perinuclear enrichment" })).toBeDisabled();
    expect(view.execute).not.toHaveBeenCalled();
  });

  it("keeps eligible native and corrected label methods while excluding derivative and unverified parents", () => {
    const eligible = ["segmentation", "adaptive-segmentation", "cellpose-segmentation", "corrected-labels", "external-labels"].map((kind, index) => ({ ...parent, kind, id: String(index + 1).repeat(32) }));
    const ineligible = [
      { ...adopted, perinuclear_nuclei_eligible: true },
      ...["nucleus-cell-association", "tracking", "declared-stain-analysis"].map((kind, index) => ({ ...parent, kind, id: String(index + 6).repeat(32) })),
      { ...parent, id: "9".repeat(32), kind: "corrected-labels", perinuclear_nuclei_eligible: false },
      { ...parent, id: "a".repeat(32), perinuclear_nuclei_eligible: undefined },
    ];
    panel(response, { ...snapshot, results: [...eligible, ...ineligible] });
    const choices = within(screen.getByLabelText("Perinuclear nucleus result")).getAllByRole("option");
    expect(choices.map((choice) => (choice as HTMLOptionElement).value)).toEqual(["", ...eligible.map(perinuclearRevisionKey)]);
  });

  it("binds a second selected result revision without borrowing the first labels", async () => {
    const second = { ...parent, id: "1".repeat(32), revision_hash: "2".repeat(64) };
    const nextRecord = { ...record, nucleus_result: { result_id: second.id, revision_hash: second.revision_hash } };
    const nextResult = { ...adopted, parent_id: second.id, perinuclear: nextRecord };
    const view = panel({ ...response, result: nextResult, perinuclear: nextRecord }, { ...snapshot, results: [parent, second] });
    choose(second); fireEvent.click(screen.getByRole("button", { name: "Measure perinuclear enrichment" }));
    await waitFor(() => expect(view.onPublished).toHaveBeenCalledWith(nextResult));
    expect(view.execute).toHaveBeenCalledWith("perinuclear_run", expect.objectContaining({ result_id: second.id, revision_hash: second.revision_hash, signal_channel: 0 }));
  });

  it("rejects a late response after the selected revision changes and prevents duplicate submissions", async () => {
    let finish!: (value: unknown) => void;
    const view = panel(); view.execute.mockImplementation(() => new Promise((resolve) => { finish = resolve; })); choose();
    const run = screen.getByRole("button", { name: "Measure perinuclear enrichment" });
    fireEvent.click(run); fireEvent.click(run);
    expect(view.execute).toHaveBeenCalledTimes(1);
    view.rerender(<ResearchPerinuclearPanel {...view.props} snapshot={{ ...snapshot, results: [{ ...parent, revision_hash: "8".repeat(64) }] }} />);
    await act(async () => { finish(response); });
    expect(await screen.findByRole("alert")).toHaveTextContent("inputs changed during measurement");
    expect(view.onPublished).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Perinuclear enrichment summary" })).not.toBeInTheDocument();
  });

  it.each(["source", "revision", "channel", "non-finite", "missing-row", "false-exclusions", "extra-exclusion", "non-finite-summary", "negative-raw", "negative-ratio"])("rejects mismatched %s response evidence", async (kind) => {
    const bad = structuredClone(response);
    if (kind === "source") bad.result.source_sha256 = "0".repeat(64);
    if (kind === "revision") { bad.perinuclear.nucleus_result.revision_hash = "0".repeat(64); bad.result.perinuclear = bad.perinuclear; }
    if (kind === "channel") bad.result.selection!.c = 1;
    if (kind === "negative-raw") bad.measurements[0].intensity.source_channel_0.min = -1;
    if (kind === "negative-ratio") bad.measurements[0].perinuclear_ring.nuclear_to_ring_mean_ratio = -2;
    if (kind === "non-finite-summary") bad.summary.median_ratio = NaN;
    if (kind === "non-finite") bad.measurements[0].perinuclear_ring.nuclear_to_ring_mean_ratio = Infinity;
    if (kind === "missing-row") bad.measurements.pop();
    if (kind === "extra-exclusion") bad.measurements[1].perinuclear_ring.exclusions.push("empty-ring");
    if (kind === "false-exclusions") { bad.measurements[1].perinuclear_ring.exclusions = []; bad.measurements[1].perinuclear_ring.nuclear_to_ring_mean_ratio = 3; }
    const view = panel(bad); choose(); fireEvent.click(screen.getByRole("button", { name: "Measure perinuclear enrichment" }));
    await screen.findByRole("alert");
    expect(view.onPublished).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Perinuclear enrichment summary" })).not.toBeInTheDocument();
  });

  it("restores a saved undefined endpoint visibly without replacing null by zero", () => {
    const saved = structuredClone(adopted);
    saved.object_count = 0;
    saved.perinuclear!.summary = { ...record.summary, object_count: 0, eligible_count: 0, excluded_count: 0,
      excluded_by_reason: { "boundary-touching-nucleus": 0, "empty-ring": 0, "zero-mean-ring": 0 }, endpoint_defined: false, median_ratio: null, mean_ratio: null };
    render(<PerinuclearResultSummary result={saved} />);
    expect(screen.getAllByText("Not defined")).toHaveLength(2);
    expect(screen.getByRole("status")).toHaveTextContent("No nuclei have a defined ratio");
    expect(screen.getByText("0 of 0 nuclei")).toBeVisible();
  });
});
