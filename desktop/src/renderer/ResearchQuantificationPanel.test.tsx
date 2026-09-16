// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    metadata: { dimensions: { t: 1, c: 2, z: 1, y: 8, x: 10 } },
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
  render(<ResearchQuantificationPanel
    api={api(execute)} snapshot={custom} source={custom.sources[0]} selection={selection}
    recipe={recipe} setRecipe={vi.fn()} report={async (work) => work()} busy={false}
    onBusyChange={vi.fn()} onPreview={onPreview} onPublished={onPublished}
  />);
  return { onPublished, onPreview };
}

describe("ResearchQuantificationPanel", () => {
  it("shows immutable originals and saves declarations against the loaded revision", async () => {
    const execute = vi.fn(async (operation: string) => operation === "channel_metadata" ? metadata : { ...metadata, revision: 4 });
    renderPanel(execute);
    expect(await screen.findByText(/original: Original A/)).toBeVisible();
    fireEvent.change(screen.getByLabelText("Channel 1 marker"), { target: { value: "Hoechst" } });
    fireEvent.click(screen.getByText("Save declarations at revision 3"));
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
    fireEvent.click(screen.getByText("puncta"));
    fireEvent.change(screen.getByLabelText("Puncta control and assumptions"), { target: { value: "negative control reviewed" } });
    fireEvent.click(screen.getByText("Preview puncta candidates"));
    fireEvent.change(screen.getByLabelText("Raw intensity threshold"), { target: { value: "7" } });
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
    fireEvent.click(screen.getByText("puncta"));
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
    fireEvent.click(screen.getByText("puncta"));
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
    const associationResult = { ...results[1], id: "7".repeat(32), revision_hash: "7".repeat(64), kind: "nucleus-cell-association" };
    const execute = vi.fn(async (operation: string) => operation === "channel_metadata" ? metadata : {
      adopted: true, result: associationResult,
      associations: [{ nucleus_label: 1, cell_label: 2, overlap_fraction: 0.8, ambiguous: false }], total_associations: 1,
    });
    const { onPublished } = renderPanel(execute, custom);
    await screen.findByText(/original: Original A/);
    fireEvent.click(screen.getByText("association"));
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
    fireEvent.click(screen.getByText("association"));
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
    fireEvent.click(screen.getByText("colocalisation"));
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
    expect(screen.getByText("pearson r")).toBeVisible();
  });

  it("shows identical-channel colocalisation errors without calling the engine", async () => {
    const execute = vi.fn(async (operation: string) =>
      operation === "channel_metadata" ? metadata : {},
    );
    renderPanel(execute);
    await screen.findByText(/original: Original A/);
    fireEvent.click(screen.getByText("colocalisation"));
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
