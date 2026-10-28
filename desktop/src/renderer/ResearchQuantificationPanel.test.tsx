// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import type {
  ResearchDesktopApi,
  ResearchRecipe,
  ResearchResult,
  ResearchSnapshot,
} from "../shared/research-contracts";
import { ResearchQuantificationPanel } from "./ResearchQuantificationPanel";

afterEach(cleanup);

const sourceId = "a".repeat(32);
const sourceSha = "b".repeat(64);
const selection = { x: 0, y: 0, width: 10, height: 8, t: 0, c: 0, z: 0, level: 0 };
const geometry = {
  axes: "YX",
  affine: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]],
  unit: "um",
  frame: "image",
};
const result = (id: string, labelSha: string, kind = "segmentation"): ResearchResult => ({
  id,
  source_id: sourceId,
  source_sha256: sourceSha,
  kind,
  created_at: "now",
  revision_hash: `${id[0]}`.repeat(64),
  object_count: 2,
  arrays: {
    image: { shape: [8, 10], dtype: "float64", sha256: "9".repeat(64) },
    labels: { shape: [8, 10], dtype: "uint32", sha256: labelSha },
  },
  geometry,
  selection,
  parent_id: null,
});
const results = [result("1".repeat(32), "4".repeat(64), "puncta-quantification"), result("2".repeat(32), "5".repeat(64))];
const snapshot: ResearchSnapshot = {
  project: { title: "Quantification" },
  sources: [{
    id: sourceId,
    name: "OME source",
    sha256: sourceSha,
    source_kind: "native",
    metadata: {
      dimensions: { t: 1, c: 2, z: 1, y: 8, x: 10 },
      levels: [{ index: 0, dimensions: { t: 1, c: 2, z: 1, y: 8, x: 10 },
        calibration: { axes: "YX", spacing: [0.5, 0.25], unit: "um" } }],
    },
  }],
  results,
  samples: [],
  recipes: [],
  displays: [],
  channels: [],
  selections: [],
  jobs: [],
  operations: {},
};
const metadata = {
  source_id: sourceId,
  source_sha256: sourceSha,
  original_names: ["Original A", "Original B"],
  revision: 3,
  channels: [
    { index: 0, name: "DNA", marker: "", fluorophore: "DAPI", declaration: "metadata" },
    { index: 1, name: "RNA", marker: "", fluorophore: "Cy3", declaration: "metadata" },
  ],
  basis: "explicit declarations",
};
const recipe: ResearchRecipe = {
  steps: [],
  segmentation: { method: "components", threshold: 0, polarity: "bright", min_size: 1, exclude_border: false },
  measurement_channels: [0],
  gates: [],
  working_bytes: 512 * 1024 ** 2,
};

function api(execute: ResearchDesktopApi["execute"]): ResearchDesktopApi {
  return {
    createStudy: vi.fn(), openStudy: vi.fn(), getSnapshot: vi.fn(), addSources: vi.fn(),
    execute, reviewResult: vi.fn(), exportResult: vi.fn(), cancelJob: vi.fn(),
  };
}

function renderPanel(execute: ResearchDesktopApi["execute"], custom = snapshot) {
  const onPublished = vi.fn().mockResolvedValue(undefined);
  const onPreview = vi.fn();
  const panelApi = api(execute);
  const setRecipe = vi.fn();
  const onBusyChange = vi.fn();
  let active = true;
  let current = custom;
  const element = (next: ResearchSnapshot) => <ResearchQuantificationPanel
    active={active} api={panelApi} snapshot={next} source={next.sources[0]} selection={selection}
    recipe={recipe} setRecipe={setRecipe} report={async (work) => work()} busy={false}
    onBusyChange={onBusyChange} onPreview={onPreview} onPublished={onPublished}
  />;
  const view = render(element(custom));
  return { onPublished, onPreview, setRecipe, onBusyChange,
    setActive: (next: boolean) => { active = next; view.rerender(element(current)); },
    updateSnapshot: (next: ResearchSnapshot) => { current = next; view.rerender(element(next)); },
  };
}

function renderGateEditor() {
  const changed = vi.fn();
  const validity = vi.fn();
  const panelApi = api(vi.fn(async (operation: string) => operation === "channel_metadata" ? metadata : {}));
  function Editor({ active }: { active: boolean }) {
    const [current, setCurrent] = useState<ResearchRecipe>({ ...recipe, gates: [
      { name: "first", channel: "1: DNA", statistic: "mean", threshold: 7.25, control: "control" },
      { name: "second", channel: "1: DNA", statistic: "mean", threshold: -3, control: "control" },
    ] });
    return <ResearchQuantificationPanel active={active} api={panelApi} snapshot={snapshot} source={snapshot.sources[0]} selection={selection}
      recipe={current} setRecipe={(update) => setCurrent((old) => {
        const next = typeof update === "function" ? update(old) : update;
        changed(next); return next;
      })} report={async (work) => work()} busy={false} onBusyChange={vi.fn()} onPreview={vi.fn()}
      onPublished={vi.fn()} onNumberValidity={validity} />;
  }
  const view = render(<Editor active />);
  return { changed, validity, setActive: (active: boolean) => view.rerender(<Editor active={active} />) };
}

const annotationReceipt = (revision: number, suffix: string) => ({
  source_id: sourceId, source_sha256: sourceSha, revision,
  annotations: suffix ? [
    { id: `focus-${suffix}`, label: "focus", kind: "polygon", z: 0, t: 0 },
    { id: `background-${suffix}`, label: "background", kind: "polygon", z: 0, t: 0 },
  ] : [],
});

describe("ResearchQuantificationPanel", () => {
  it("refreshes added/deleted ROIs and channel metadata on reentry and discards the old field preview", async () => {
    let annotations = annotationReceipt(1, "old");
    let channels = metadata;
    let deferChannels = false;
    let finishChannels!: (value: unknown) => void;
    const execute = vi.fn(async (operation: string) => {
      if (operation === "channel_metadata") return deferChannels ? new Promise((resolve) => { finishChannels = resolve; }) : channels;
      if (operation === "source_annotations") return annotations;
      return { preview: true, qc_overlay: "old-qc", overlay: "old-overlay", measurements: [] };
    });
    const { setActive } = renderPanel(execute);
    await screen.findByText(/original: Original A/);
    fireEvent.click(screen.getByRole("button", { name: "Field assay" }));
    expect(screen.getByLabelText("Focus region selection")).toHaveValue("focus-old");
    expect(screen.getByLabelText("Background annotation selection")).toHaveValue("background-old");
    fireEvent.click(screen.getByRole("button", { name: "Preview field assay" }));
    await screen.findByRole("img", { name: /Field assay QC overlay/ });
    setActive(false);
    annotations = annotationReceipt(2, "added");
    channels = { ...metadata, revision: 4, channels: metadata.channels.map((channel) => ({ ...channel, name: `Fresh ${channel.name}` })) };
    deferChannels = true;
    setActive(true);
    await waitFor(() => expect(screen.getByLabelText("Focus region selection")).toHaveValue("focus-added"));
    expect(screen.getByRole("button", { name: "Preview field assay" })).toBeDisabled();
    await act(async () => finishChannels(channels));
    deferChannels = false;
    expect(screen.getByLabelText("Background annotation selection")).toHaveValue("background-added");
    expect(screen.getByLabelText("Focus region selection").querySelector('[value="focus-old"]')).toBeNull();
    expect(screen.getByLabelText("Background annotation selection").querySelector('[value="background-old"]')).toBeNull();
    expect(screen.queryByRole("img", { name: /Field assay QC overlay/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save exploratory" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Nuclear channel")).toHaveTextContent("Fresh DNA");
    setActive(false);
    annotations = annotationReceipt(3, "");
    setActive(true);
    await waitFor(() => expect(screen.getByRole("button", { name: "Preview field assay" })).toBeDisabled());
    expect(screen.getByLabelText("Focus region selection")).toHaveValue("");
    expect(screen.getByLabelText("Background annotation selection")).toHaveValue("");
    expect(screen.getByLabelText("Focus region selection").querySelector('[value="focus-added"]')).toBeNull();
    expect(execute.mock.calls.filter(([operation]) => operation === "source_annotations")).toHaveLength(3);
    expect(execute.mock.calls.filter(([operation]) => operation === "channel_metadata")).toHaveLength(3);
    expect(execute).not.toHaveBeenCalledWith("field_assay_run", expect.anything());
  });

  it.each([
    { kind: "Puncta", leave: "tool" }, { kind: "Field assay", leave: "tool" },
    { kind: "Puncta", leave: "mode" }, { kind: "Field assay", leave: "mode" },
  ])("discards a late $kind display preview after leaving its $leave", async ({ kind, leave }) => {
    let finish!: (value: unknown) => void;
    const execute = vi.fn((operation: string) => {
      if (operation === "channel_metadata") return Promise.resolve(metadata);
      if (operation === "source_annotations") return Promise.resolve(annotationReceipt(1, "current"));
      return new Promise((resolve) => { finish = resolve; });
    });
    const { setActive, onPreview } = renderPanel(execute);
    await screen.findByText(/original: Original A/);
    fireEvent.click(screen.getByRole("button", { name: kind }));
    if (kind === "Puncta") fireEvent.change(screen.getByLabelText("Puncta control and assumptions"), { target: { value: "declared control" } });
    fireEvent.click(screen.getByRole("button", { name: kind === "Puncta" ? "Preview puncta candidates" : "Preview field assay" }));
    expect(finish).toBeDefined();
    if (leave === "tool") setActive(false);
    else fireEvent.click(screen.getByRole("button", { name: "Channels" }));
    await act(async () => finish({ preview: true, adopted: false, qc_overlay: "late-qc", overlay: "late-overlay", measurements: [], total_peaks: 2, peaks: [] }));
    expect(onPreview).not.toHaveBeenCalled();
    if (leave === "tool") setActive(true);
    else fireEvent.click(screen.getByRole("button", { name: kind }));
    if (kind === "Puncta") expect(screen.getByRole("button", { name: "Adopt unchanged puncta request" })).toBeDisabled();
    else {
      expect(screen.queryByRole("img", { name: /Field assay QC overlay/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Save exploratory" })).not.toBeInTheDocument();
    }
  });

  it.each(["puncta", "compartments"])("keeps an already-started %s publication and busy state across reactivation", async (kind) => {
    let finish!: (value: unknown) => void;
    const execute = vi.fn((operation: string) => {
      if (operation === "channel_metadata") return Promise.resolve(metadata);
      if (operation === "source_annotations") return Promise.resolve(annotationReceipt(1, "current"));
      if (operation === "puncta_preview") return Promise.resolve({ preview: true, adopted: false, overlay: "preview", total_peaks: 0, peaks: [] });
      return new Promise((resolve) => { finish = resolve; });
    });
    const { setActive, onPublished, onBusyChange } = renderPanel(execute);
    if (kind === "compartments") {
      await selectCompartments();
      fireEvent.click(screen.getByRole("button", { name: "Measure compartments" }));
    } else {
      await screen.findByText(/original: Original A/);
      fireEvent.click(screen.getByRole("button", { name: "Puncta" }));
      fireEvent.change(screen.getByLabelText("Puncta control and assumptions"), { target: { value: "declared control" } });
      fireEvent.click(screen.getByRole("button", { name: "Preview puncta candidates" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Adopt unchanged puncta request" })).toBeEnabled());
      fireEvent.click(screen.getByRole("button", { name: "Adopt unchanged puncta request" }));
    }
    setActive(false);
    expect(onBusyChange).toHaveBeenLastCalledWith(true);
    setActive(true);
    await waitFor(() => expect(execute.mock.calls.filter(([operation]) => operation === "channel_metadata")).toHaveLength(2));
    expect(onBusyChange).toHaveBeenLastCalledWith(true);
    const output = kind === "compartments" ? compartmentResponse() : { adopted: true, result: results[0] };
    await act(async () => finish(output));
    expect(onPublished).toHaveBeenCalledExactlyOnceWith(output.result);
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it("preserves unfinished gate drafts, restores with Escape, and applies exact finite thresholds", async () => {
    const { changed, validity, setActive } = renderGateEditor();
    await screen.findByText(/original: Original A/);
    fireEvent.click(screen.getByRole("button", { name: "Recipe" }));
    const input = screen.getByLabelText("Gate 1 threshold");
    for (const draft of ["", ".", "-", "-1.2e", "1e-", "NaN", "Infinity", "1e309"]) {
      fireEvent.change(input, { target: { value: draft } });
      fireEvent.blur(input);
      expect(input).toHaveValue(draft);
      expect(input).toHaveAttribute("aria-invalid", "true");
      expect(changed).not.toHaveBeenCalled();
      expect(validity).toHaveBeenLastCalledWith(false);
    }
    setActive(false);
    expect(validity).toHaveBeenLastCalledWith(false);
    setActive(true);
    expect(screen.getByLabelText("Gate 1 threshold")).toBe(input);
    expect(input).toHaveValue("1e309");
    fireEvent.click(screen.getByRole("button", { name: "Channels" }));
    expect(input).not.toBeVisible();
    expect(validity).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByRole("button", { name: "Recipe" }));
    expect(screen.getByLabelText("Gate 1 threshold")).toBe(input);
    expect(input).toHaveValue("1e309");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).toHaveValue("7.25");
    expect(validity).toHaveBeenLastCalledWith(true);
    expect(changed).not.toHaveBeenCalled();
    for (const [draft, threshold] of [["0", 0], ["-0.12345678912345", -0.12345678912345], ["1.", 1], ["1.25e-3", 0.00125]] as const) {
      fireEvent.change(input, { target: { value: draft } });
      expect(input).toHaveValue(draft);
      expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ gates: [
        expect.objectContaining({ name: "first", threshold }), expect.objectContaining({ name: "second", threshold: -3 }),
      ] }));
      expect(validity).toHaveBeenLastCalledWith(true);
    }
  });

  it("keeps a gate draft bound to its row when gates are edited, added, or removed", async () => {
    const { changed, validity } = renderGateEditor();
    await screen.findByText(/original: Original A/);
    fireEvent.click(screen.getByRole("button", { name: "Recipe" }));
    const second = screen.getByLabelText("Gate 2 threshold");
    fireEvent.change(second, { target: { value: "-3e" } });
    fireEvent.change(screen.getByLabelText("Gate 2 name"), { target: { value: "renamed" } });
    expect(screen.getByLabelText("Gate 2 threshold")).toBe(second);
    expect(second).toHaveValue("-3e");
    fireEvent.click(screen.getByRole("button", { name: "Add explicit gate" }));
    expect(screen.getByLabelText("Gate 3 threshold")).toHaveValue("0");
    expect(validity).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getAllByRole("button", { name: "Remove gate" })[0]);
    expect(screen.getByLabelText("Gate 1 threshold")).toBe(second);
    expect(second).toHaveValue("-3e");
    expect(screen.getByLabelText("Gate 2 threshold")).toHaveValue("0");
    expect(validity).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getAllByRole("button", { name: "Remove gate" })[0]);
    expect(screen.getByLabelText("Gate 1 threshold")).toHaveValue("0");
    expect(validity).toHaveBeenLastCalledWith(true);
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ gates: [expect.objectContaining({ threshold: 0 })] }));
  });

  it("exposes perinuclear enrichment through the ordinary fluorescence tool with declared raw channels", async () => {
    const execute = vi.fn(async (operation: string) => operation === "channel_metadata" ? metadata : {});
    renderPanel(execute, { ...snapshot, operations: { perinuclear_run: { mutates: true, summary: "Measure perinuclear enrichment" } } });
    await screen.findByText(/original: Original A/);
    fireEvent.click(screen.getByRole("button", { name: "Perinuclear" }));
    expect(screen.getByRole("heading", { name: "Perinuclear enrichment" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Perinuclear nucleus result" })).toBeVisible();
    expect(within(screen.getByRole("combobox", { name: "Perinuclear raw signal channel" })).getByRole("option", { name: "1: DNA" })).toHaveValue("0");
    expect(screen.getByRole("button", { name: "Measure perinuclear enrichment" })).toBeDisabled();
    expect(execute).not.toHaveBeenCalledWith("perinuclear_run", expect.anything());
  });

  it("labels puncta lengths from source calibration and preserves exact preview/run values", async () => {
    const adopted = { ...results[0], id: "3".repeat(32), revision_hash: "8".repeat(64) };
    const execute = vi.fn(async (operation: string) => operation === "channel_metadata" ? metadata :
      operation === "puncta_preview" ? { preview: true, adopted: false, overlay: "data:image/png;base64,AA==", total_peaks: 0, peaks: [] } :
      { adopted: true, result: adopted, measurements: [] });
    renderPanel(execute);
    await screen.findByText(/original: Original A/);
    fireEvent.click(screen.getByText("Puncta", { exact: true }));
    fireEvent.change(screen.getByLabelText("LoG sigma (µm)"), { target: { value: "1.25" } });
    fireEvent.change(screen.getByLabelText("Minimum peak separation (µm)"), { target: { value: "2.5" } });
    fireEvent.change(screen.getByLabelText("Aperture radius (µm)"), { target: { value: "3.75" } });
    fireEvent.change(screen.getByLabelText("LoG response threshold"), { target: { value: "0.125" } });
    fireEvent.change(screen.getByLabelText("Raw intensity threshold (source values)"), { target: { value: "-4.5" } });
    fireEvent.change(screen.getByLabelText("Puncta control and assumptions"), { target: { value: "recorded control" } });
    const expectedRequest = { source_id: sourceId, selection, sigma: 1.25,
      minimum_distance: 2.5, aperture_radius: 3.75, response_threshold: 0.125,
      raw_threshold: -4.5, exclude_border: true, control: "recorded control", working_bytes: 512 * 1024 ** 2 };
    fireEvent.click(screen.getByRole("button", { name: "Preview puncta candidates" }));
    await screen.findByText("0 initial peaks before correction.");
    expect(execute).toHaveBeenCalledWith("puncta_preview", expectedRequest);
    fireEvent.click(screen.getByRole("button", { name: "Adopt unchanged puncta request" }));
    await waitFor(() => expect(execute).toHaveBeenCalledWith("puncta_run", expectedRequest));
  });

  it("does not borrow physical units from a result when source level calibration is missing", async () => {
    const custom = { ...snapshot, sources: [{ ...snapshot.sources[0], metadata: {
      dimensions: snapshot.sources[0].metadata.dimensions,
    } }] };
    renderPanel(vi.fn(async (operation: string) => operation === "channel_metadata" ? metadata : {}), custom);
    await screen.findByText(/original: Original A/);
    fireEvent.click(screen.getByText("Puncta", { exact: true }));
    expect(results[0].geometry?.unit).toBe("um");
    expect(screen.getByLabelText("LoG sigma (unit unverified)")).toHaveValue(1);
    expect(screen.getByLabelText("Minimum peak separation (unit unverified)")).toHaveValue(1);
    expect(screen.getByLabelText("Aperture radius (unit unverified)")).toHaveValue(2);
    expect(screen.queryByLabelText("LoG sigma (µm)")).not.toBeInTheDocument();
  });

  it("disambiguates reference filenames without routine fingerprints and binds exact source IDs", async () => {
    const filename = "A long acquisition reference filename.ome.tif";
    const second = { ...snapshot.sources[0], id: "6".repeat(32), sha256: "7".repeat(64), name: filename };
    const custom = { ...snapshot, sources: [{ ...snapshot.sources[0], name: filename }, second] };
    const execute = vi.fn(async (operation: string) => operation === "channel_metadata" ? metadata : {});
    const { setRecipe } = renderPanel(execute, custom);
    await screen.findByText(/original: Original A/);
    fireEvent.click(screen.getByText("Recipe", { exact: true }));
    const flat = screen.getByLabelText("Flat-field source");
    expect(within(flat).getByRole("option", { name: `${filename} · Image 1` })).toHaveValue(sourceId);
    expect(within(flat).getByRole("option", { name: `${filename} · Image 2` })).toHaveValue(second.id);
    expect(flat).not.toHaveTextContent(sourceId.slice(0, 8));
    expect(flat).not.toHaveTextContent(second.id.slice(0, 8));
    fireEvent.change(flat, { target: { value: sourceId } });
    fireEvent.change(screen.getByLabelText("Dark-field source"), { target: { value: second.id } });
    expect(screen.getByText(sourceSha)).not.toBeVisible();
    expect(screen.getByText(second.sha256)).not.toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Bind flat-field step" }));
    const update = setRecipe.mock.calls.at(-1)![0] as (previous: ResearchRecipe) => ResearchRecipe;
    expect(update(recipe).references).toEqual({
      flatfield: { source_id: sourceId, selection }, darkfield: { source_id: second.id, selection },
    });
  });

  it("shows readable puncta columns with exact coordinate and response records in closed details", async () => {
    const peak = { label: 7, index: [3, 4], index_axes: "YX", flat_index_c_order: 34,
      world_xyz: [20.23456789, 5.123456789, 0], world_frame: "image", distance_unit: "um",
      response: 0.123456789123, raw: 1234.56789123 };
    const frozen = JSON.stringify(peak);
    const execute = vi.fn(async (operation: string) => operation === "channel_metadata" ? metadata :
      operation === "puncta_preview" ? { preview: true, adopted: false, overlay: "data:image/png;base64,AA==",
        overlay_basis: "selected-raw-plane", total_peaks: 1, peaks: [peak], measurements: [] } : {});
    renderPanel(execute);
    await screen.findByText(/original: Original A/);
    fireEvent.click(screen.getByText("Puncta", { exact: true }));
    fireEvent.change(screen.getByLabelText("Puncta control and assumptions"), { target: { value: "Recorded control" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview puncta candidates" }));
    const preview = await screen.findByRole("region", { name: "Puncta preview" });
    expect(within(preview).getByRole("columnheader", { name: "Position XYZ" })).toBeVisible();
    expect(within(preview).getByRole("columnheader", { name: "LoG response" })).toBeVisible();
    expect(within(preview).getByText("0.123457")).toHaveAttribute("data-exact-value", String(peak.response));
    expect(within(preview).getByText("20.2346, 5.12346, 0 um")).toBeVisible();
    expect(within(preview).getByText("flat index c order")).not.toBeVisible();
    expect(within(preview).getByText(String(peak.response))).not.toBeVisible();
    preview.querySelector("details")!.open = true;
    expect(within(preview).getByText(String(peak.response))).toBeVisible();
    expect(JSON.stringify(peak)).toBe(frozen);
  });

  it("keeps colocalisation precision, undefined metrics and method text in their proper disclosure", async () => {
    const metrics = { pearson_r: 0.123456789123, manders_first: null, manders_second: -0,
      voxel_pairs: 80, formula: "Exact recorded Pearson and thresholded Manders formula", basis: "raw selected channels" };
    const adopted = { ...results[0], id: "8".repeat(32), kind: "colocalisation" };
    const execute = vi.fn(async (operation: string) => operation === "channel_metadata" ? metadata :
      operation === "colocalisation_run" ? { adopted: true, result: adopted, metrics } : {});
    renderPanel(execute);
    await screen.findByText(/original: Original A/);
    fireEvent.click(screen.getByText("Colocalisation", { exact: true }));
    fireEvent.change(screen.getByLabelText("Colocalisation controls and assumptions"), { target: { value: "Recorded control" } });
    fireEvent.click(screen.getByRole("button", { name: "Run and adopt colocalisation" }));
    const measurements = await screen.findByLabelText("Colocalisation measurements");
    expect(within(measurements).getByText("0.123457")).toHaveAttribute("title", String(metrics.pearson_r));
    expect(within(measurements).getByText("not defined")).toBeVisible();
    expect(within(measurements).getByText("-0")).toBeVisible();
    expect(screen.getByText(metrics.formula)).not.toBeVisible();
    expect(screen.getByText(String(metrics.pearson_r))).not.toBeVisible();
    screen.getByText(metrics.formula).closest("details")!.open = true;
    expect(screen.getByText(String(metrics.pearson_r))).toBeVisible();
    expect(Object.is(metrics.manders_second, -0)).toBe(true);
  });

  it("shows immutable originals and saves declarations against the loaded revision", async () => {
    const execute = vi.fn(async (operation: string) => operation === "channel_metadata" ? metadata : { ...metadata, revision: 4 });
    renderPanel(execute);
    expect(await screen.findByText(/original: Original A/)).toBeVisible();
    fireEvent.change(screen.getByLabelText("Channel 1 marker"), { target: { value: "Hoechst" } });
    fireEvent.click(screen.getByText("Save channel identities"));
    await waitFor(() => expect(execute).toHaveBeenCalledWith("channels", expect.objectContaining({
      source_id: sourceId,
      expected_revision: 3,
      channels: expect.arrayContaining([expect.objectContaining({ index: 0, marker: "Hoechst" })]),
    })));
  });

  it("discards a delayed puncta preview after an explicit threshold changes", async () => {
    let resolvePreview!: (value: unknown) => void;
    const execute = vi.fn((operation: string) => {
      if (operation === "channel_metadata") return Promise.resolve(metadata);
      return new Promise((resolve) => { resolvePreview = resolve; });
    });
    const { onPreview } = renderPanel(execute);
    await screen.findByText(/original: Original A/);
    fireEvent.click(screen.getByText("Puncta"));
    fireEvent.change(screen.getByLabelText("Puncta control and assumptions"), { target: { value: "negative control reviewed" } });
    fireEvent.click(screen.getByText("Preview puncta candidates"));
    fireEvent.change(screen.getByLabelText("Raw intensity threshold (source values)"), { target: { value: "7" } });
    resolvePreview({ preview: true, adopted: false, overlay: "data:image/png;base64,AA==", total_peaks: 2, peaks: [] });
    await waitFor(() => expect(onPreview).not.toHaveBeenCalled());
    expect(screen.getByText("Adopt unchanged puncta request")).toBeDisabled();
  });

  it("shows puncta preflight errors without an unhandled rejection", async () => {
    const execute = vi.fn(async (operation: string) =>
      operation === "channel_metadata" ? metadata : {},
    );
    renderPanel(execute);
    await screen.findByText(/original: Original A/);
    fireEvent.click(screen.getByText("Puncta"));
    fireEvent.click(screen.getByText("Preview puncta candidates"));
    expect(
      await screen.findByText("Declare the puncta control and assumptions."),
    ).toHaveAttribute("role", "alert");
    expect(execute).not.toHaveBeenCalledWith("puncta_preview", expect.anything());
  });

  it("adopts only the exact previewed puncta request and preserves initial-peak wording", async () => {
    const adopted = { ...results[0], id: "3".repeat(32), revision_hash: "8".repeat(64) };
    const execute = vi.fn(async (operation: string) => {
      if (operation === "channel_metadata") return metadata;
      if (operation === "puncta_preview") return { preview: true, adopted: false, overlay: "data:image/png;base64,AA==", overlay_basis: "selected-raw-plane", total_peaks: 2, peaks: [{ label: 1 }] };
      return { adopted: true, result: adopted, measurements: [] };
    });
    const { onPublished } = renderPanel(execute);
    await screen.findByText(/original: Original A/);
    fireEvent.click(screen.getByText("Puncta"));
    fireEvent.change(screen.getByLabelText("Puncta control and assumptions"), { target: { value: "bead negative control" } });
    fireEvent.click(screen.getByText("Preview puncta candidates"));
    expect(await screen.findByText(/2 initial peaks before correction/)).toBeVisible();
    fireEvent.click(screen.getByText("Adopt unchanged puncta request"));
    await waitFor(() => expect(onPublished).toHaveBeenCalledWith(adopted));
    const previewRequest = (execute.mock.calls as unknown as Array<[string, unknown]>).find(
      ([operation]) => operation === "puncta_preview",
    )?.[1];
    expect(execute).toHaveBeenCalledWith("puncta_run", previewRequest);
  });

  it("filters exact compatible association bindings and sends declared roles", async () => {
    const incompatible = { ...result("6".repeat(32), "7".repeat(64)), geometry: { ...geometry, unit: "px" } };
    const custom = { ...snapshot, results: [...results, incompatible] };
    const associationResult = { ...results[1], id: "7".repeat(32), revision_hash: "7".repeat(64), kind: "nucleus-cell-association", object_count: 1, parent_id: results[1].id, arrays: { ...results[1].arrays, nuclei_labels: results[0].arrays!.labels } };
    const execute = vi.fn(async (operation: string) => operation === "channel_metadata" ? metadata : {
      adopted: true, result: associationResult,
      association_inputs: { nuclei: { result_id: results[0].id, revision_hash: results[0].revision_hash }, cells: { result_id: results[1].id, revision_hash: results[1].revision_hash } },
      association_summary: { nucleus_count: 1, ambiguous_count: 0, unassigned_count: 0 },
      associations: [{ nucleus_label: 1, cell_label: 2, overlap_fraction: 0.8, ambiguous: false }], total_associations: 1,
    });
    const { onPublished } = renderPanel(execute, custom);
    await screen.findByText(/original: Original A/);
    fireEvent.click(screen.getByText("Compartments"));
    fireEvent.change(screen.getByLabelText("Nuclei result"), { target: { value: results[0].id } });
    await waitFor(() => expect(screen.getByLabelText("Cells result")).toHaveValue(results[1].id));
    expect(screen.getByLabelText("Cells result")).not.toContainHTML(incompatible.id);
    fireEvent.change(screen.getByLabelText("Association controls and assumptions"), { target: { value: "segmentation controls reviewed" } });
    fireEvent.click(screen.getByText("Associate exact revisions"));
    await waitFor(() => expect(onPublished).toHaveBeenCalledWith(associationResult));
    expect(execute).toHaveBeenCalledWith("associate_results", expect.objectContaining({
      nuclei: { result_id: results[0].id, revision_hash: results[0].revision_hash },
      cells: { result_id: results[1].id, revision_hash: results[1].revision_hash },
      roles: { nuclei: "nucleus label field", cells: "cell boundary label field" },
    }));
    fireEvent.click(screen.getByText(/1 nucleus assignments/));
    expect(screen.getByText(/cannot be edited directly/)).toBeVisible();
  });

  it("compares association geometry and selections independent of object key order", async () => {
    const reordered = {
      ...result("6".repeat(32), "7".repeat(64)),
      geometry: {
        frame: geometry.frame,
        unit: geometry.unit,
        affine: geometry.affine,
        axes: geometry.axes,
      },
      selection: {
        level: 0,
        z: 0,
        c: 1,
        t: 0,
        height: 8,
        width: 10,
        y: 0,
        x: 0,
      },
    };
    const custom = { ...snapshot, results: [results[0], reordered] };
    const execute = vi.fn(async (operation: string) =>
      operation === "channel_metadata" ? metadata : {},
    );
    renderPanel(execute, custom);
    await screen.findByText(/original: Original A/);
    fireEvent.click(screen.getByText("Compartments"));
    fireEvent.change(screen.getByLabelText("Nuclei result"), {
      target: { value: results[0].id },
    });
    await waitFor(() =>
      expect(screen.getByLabelText("Cells result")).toHaveValue(reordered.id),
    );
  });

  it("sends two exact channels with both visible thresholds and declared controls", async () => {
    const colocalisation = {
      ...results[0],
      id: "8".repeat(32),
      revision_hash: "8".repeat(64),
      kind: "colocalisation",
    };
    const execute = vi.fn(async (operation: string) => operation === "channel_metadata" ? metadata : {
      adopted: true,
      result: colocalisation,
      metrics: { pearson_r: 0.4, manders_first: 0.6, manders_second: 0.5, voxel_pairs: 80 },
    });
    const { onPublished } = renderPanel(execute);
    await screen.findByText(/original: Original A/);
    fireEvent.click(screen.getByText("Colocalisation"));
    fireEvent.change(screen.getByLabelText("First colocalisation threshold"), { target: { value: "12" } });
    fireEvent.change(screen.getByLabelText("Second colocalisation threshold"), { target: { value: "34" } });
    fireEvent.change(screen.getByLabelText("Colocalisation controls and assumptions"), { target: { value: "single-stain and bleed-through controls reviewed" } });
    fireEvent.click(screen.getByText("Run and adopt colocalisation"));
    await waitFor(() => expect(onPublished).toHaveBeenCalledWith(colocalisation));
    expect(execute).toHaveBeenCalledWith("colocalisation_run", {
      source_id: sourceId,
      selection,
      first_channel: 0,
      second_channel: 1,
      threshold_first: 12,
      threshold_second: 34,
      control: "single-stain and bleed-through controls reviewed",
      working_bytes: 512 * 1024 ** 2,
    });
    expect(within(screen.getByLabelText("Colocalisation measurements")).getByText("Pearson r")).toBeVisible();
  });

  it("shows identical-channel colocalisation errors without calling the engine", async () => {
    const execute = vi.fn(async (operation: string) =>
      operation === "channel_metadata" ? metadata : {},
    );
    renderPanel(execute);
    await screen.findByText(/original: Original A/);
    fireEvent.click(screen.getByText("Colocalisation"));
    fireEvent.change(screen.getByLabelText("Second colocalisation channel"), {
      target: { value: "0" },
    });
    fireEvent.click(screen.getByText("Run and adopt colocalisation"));
    expect(
      await screen.findByText("Choose two distinct acquisition channels."),
    ).toHaveAttribute("role", "alert");
    expect(execute).not.toHaveBeenCalledWith("colocalisation_run", expect.anything());
  });
});

function compartmentResponse() {
  const stats = (count: number, sum: number) => ({ count, sum, mean: count ? sum / count : null, min: count ? sum / count - 1 : null, max: count ? sum / count + 1 : null, std_population: count ? 1 : null });
  const record = (count: number, sum: number) => ({ voxel_count: count, measure: count, measure_kind: "area", measure_unit: "um^2", intensity: { "1: DNA": stats(count, sum), "2: RNA": stats(count, sum * 2) } });
  return {
    adopted: true,
    result: { ...results[1], id: "7".repeat(32), revision_hash: "7".repeat(64), kind: "nucleus-cell-association", object_count: 1, parent_id: results[1].id, arrays: { ...results[1].arrays, nuclei_labels: results[0].arrays!.labels } },
    association_inputs: { nuclei: { result_id: results[0].id, revision_hash: results[0].revision_hash }, cells: { result_id: results[1].id, revision_hash: results[1].revision_hash } },
    association_summary: { nucleus_count: 1, ambiguous_count: 1, unassigned_count: 0 },
    associations: [{ nucleus_label: 1, cell_label: 70000, ambiguous: true, overlap_fraction: 0.5 }], total_associations: 1,
    measurements: [{ label: 70000, compartments: { cell: record(2, 6), nuclear: record(0, 0), cytoplasm: record(2, 6) } }], total_measurements: 1,
    compartment_measurement: { channel_metadata: metadata, channels: [0, 1].map((index) => ({ index, name: `${index + 1}: ${metadata.channels[index].name}`, source_id: sourceId, source_sha256: sourceSha, geometry, selection: { ...selection, c: index } })) },
  };
}
async function selectCompartments() {
  await screen.findByText(/original: Original A/);
  fireEvent.click(screen.getByText("Compartments"));
  fireEvent.change(screen.getByLabelText("Nuclei result"), { target: { value: results[0].id } });
  await waitFor(() => expect(screen.getByLabelText("Cells result")).toHaveValue(results[1].id));
  fireEvent.change(screen.getByLabelText("Association controls and assumptions"), { target: { value: "Declared control" } });
  fireEvent.click(screen.getByLabelText("Measure compartment channel 1: DNA"));
  fireEvent.click(screen.getByLabelText("Measure compartment channel 2: RNA"));
}
describe("explicit compartment measurement", () => {
  it("sends raw channels and displays every statistic with undefined empty means", async () => {
    const response = compartmentResponse();
    const execute = vi.fn(async (operation: string) => operation === "channel_metadata" ? metadata : response);
    const { onPublished } = renderPanel(execute);
    await selectCompartments();
    fireEvent.click(screen.getByText("Measure compartments"));
    await waitFor(() => expect(onPublished).toHaveBeenCalledWith(response.result));
    expect(execute).toHaveBeenCalledWith("associate_results", expect.objectContaining({ measurement_channels: [0, 1] }));
    expect(screen.getByText("Nuclear intersection")).toBeVisible();
    for (const heading of ["Sum", "Mean", "Min", "Max", "Population SD"]) expect(screen.getByRole("columnheader", { name: heading })).toBeVisible();
    expect(screen.getAllByText("—")).toHaveLength(4);
    fireEvent.change(screen.getByLabelText("Compartment table channel"), { target: { value: "2: RNA" } });
    expect(screen.getAllByText("12")).toHaveLength(2);
  });
  it.each(["parent", "nuclear revision", "channels", "NaN", "empty mean", "partition"])("rejects malformed response: %s", async (change) => {
    const response = compartmentResponse();
    if (change === "parent") response.result.parent_id = results[0].id;
    if (change === "nuclear revision") response.association_inputs.nuclei.revision_hash = "a".repeat(64);
    if (change === "channels") response.compartment_measurement.channels.reverse();
    if (change === "NaN") response.measurements[0].compartments.cell.intensity["1: DNA"].sum = NaN;
    if (change === "empty mean") response.measurements[0].compartments.nuclear.intensity["1: DNA"].mean = 0;
    if (change === "partition") response.measurements[0].compartments.cell.voxel_count = 7;
    const execute = vi.fn(async (operation: string) => operation === "channel_metadata" ? metadata : response);
    const { onPublished } = renderPanel(execute);
    await selectCompartments();
    fireEvent.click(screen.getByText("Measure compartments"));
    expect(await screen.findByRole("alert")).toBeVisible();
    expect(onPublished).not.toHaveBeenCalled();
    expect(screen.queryByText("Nuclear intersection")).not.toBeInTheDocument();
  });
  it("rejects delayed measurement when the selected inputs change", async () => {
    let resolve!: (value: unknown) => void;
    const execute = vi.fn((operation: string) => operation === "channel_metadata" ? Promise.resolve(metadata) : new Promise((done) => { resolve = done; }));
    const { onPublished } = renderPanel(execute);
    await selectCompartments();
    fireEvent.click(screen.getByText("Measure compartments"));
    fireEvent.change(screen.getByLabelText("Nuclei role declaration"), { target: { value: "Revised role" } });
    resolve(compartmentResponse());
    expect(await screen.findByText("The selected compartment inputs changed during measurement.")).toHaveAttribute("role", "alert");
    expect(onPublished).not.toHaveBeenCalled();
  });
});


describe("compartment table and drafts", () => {
  it("preserves declared roles, controls and raw channels during unrelated snapshot updates", async () => {
    const execute = vi.fn(async (operation: string) => operation === "channel_metadata" ? metadata : {});
    const { updateSnapshot } = renderPanel(execute);
    await selectCompartments();
    fireEvent.change(screen.getByLabelText("Nuclei role declaration"), { target: { value: "Reviewed nuclei" } });
    updateSnapshot({ ...snapshot, results: [...results, result("8".repeat(32), "6".repeat(64))] });
    expect(screen.getByLabelText("Nuclei role declaration")).toHaveValue("Reviewed nuclei");
    expect(screen.getByLabelText("Association controls and assumptions")).toHaveValue("Declared control");
    expect(screen.getByLabelText("Measure compartment channel 1: DNA")).toBeChecked();
    expect(screen.getByLabelText("Cells result")).toHaveValue(results[1].id);
    expect(execute.mock.calls.filter(([operation]) => operation === "channel_metadata")).toHaveLength(1);
  });

  it("paginates cells without truncating their compartment statistics", async () => {
    const response = compartmentResponse();
    const first = response.measurements[0];
    response.measurements = Array.from({ length: 26 }, (_, index) => ({ ...first, label: 70000 + index }));
    response.total_measurements = 26;
    response.result.object_count = 26;
    const execute = vi.fn(async (operation: string) => operation === "channel_metadata" ? metadata : response);
    renderPanel(execute);
    await selectCompartments();
    fireEvent.click(screen.getByText("Measure compartments"));
    await screen.findByText("26 measured cells.");
    expect(screen.queryByText("70025")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Next cells"));
    expect(screen.getAllByText("70025")).toHaveLength(3);
    expect(within(screen.getByRole("region", { name: "Compartment measurements" })).queryByText("70000")).not.toBeInTheDocument();
  });
});
