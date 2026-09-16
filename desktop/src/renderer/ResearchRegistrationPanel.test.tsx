// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ResearchDesktopApi,
  ResearchResult,
  ResearchSnapshot,
} from "../shared/research-contracts";
import {
  ResearchRegistrationPanel,
  type RegistrationReceipt,
} from "./ResearchRegistrationPanel";

afterEach(cleanup);

const sourceIds = ["a".repeat(32), "b".repeat(32)];
const results: ResearchResult[] = sourceIds.map((source_id, index) => ({
  id: String(index + 1).repeat(32),
  source_id,
  source_sha256: String(index + 6).repeat(64),
  kind: "segmentation",
  created_at: "now",
  revision_hash: String(index + 3).repeat(64),
  object_count: 1,
  parent_id: null,
  arrays: {
    image: { shape: [8, 10], dtype: "float64" },
    labels: { shape: [8, 10], dtype: "uint32" },
  },
  geometry: {
    axes: "YX",
    affine: [
      [0.5, 0, 0, 0],
      [0, 2, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ],
    unit: "um",
    frame: "image",
  },
}));
const snapshot: ResearchSnapshot = {
  project: { title: "Registration" },
  sources: sourceIds.map((id, index) => ({
    id,
    name: `Source ${index + 1}`,
    sha256: String(index + 6).repeat(64),
    metadata: {},
  })),
  results,
  samples: [],
  recipes: [],
  displays: [],
  selections: [],
  jobs: [],
  operations: {},
};
const receipt: RegistrationReceipt = {
  schema: "loci.registration-preview/v1",
  fixed: {
    result_id: results[0].id,
    revision_hash: results[0].revision_hash,
    array: "image",
  },
  moving: {
    result_id: results[1].id,
    revision_hash: results[1].revision_hash,
    array: "image",
  },
  method: "translation_phase_correlation",
  settings: {
    upsample_factor: 20,
    min_normalized_correlation: 0.25,
    threads: 1,
    seed: 0,
  },
  outputs: [
    {
      array: "image",
      output_name: "image",
      kind: "scalar",
      interpolation: "linear",
      default_value: 0,
    },
  ],
  working_bytes: 512 * 1024 ** 2,
  transform: {
    moving_to_fixed: {
      direction: "moving-world to fixed-world",
      homogeneous_matrix: [
        [1, 0, 0, 2],
        [0, 1, 0, -1],
        [0, 0, 1, 0],
        [0, 0, 0, 1],
      ],
    },
    fixed_to_moving: {
      direction: "fixed-world to moving-world; resampling map",
      homogeneous_matrix: [
        [1, 0, 0, -2],
        [0, 1, 0, 1],
        [0, 0, 1, 0],
        [0, 0, 0, 1],
      ],
    },
  },
  output_grid: {
    shape: [8, 10],
    geometry: {
      axes: "YX",
      affine: results[0].geometry!.affine!,
      unit: "um",
      frame: "image",
    },
  },
  quality: { normalized_correlation: 0.9, overlap_fraction: 0.8, confidence: "accepted" },
  meaning: "technical registration preview; not biological or clinical validation",
};

function bridge(execute: ResearchDesktopApi["execute"]): ResearchDesktopApi {
  return {
    createStudy: vi.fn(),
    openStudy: vi.fn(),
    getSnapshot: vi.fn(),
    addSources: vi.fn(),
    execute,
    reviewResult: vi.fn(),
    exportResult: vi.fn(),
    cancelJob: vi.fn(),
  };
}

function renderPanel(execute: ResearchDesktopApi["execute"]) {
  const onPublished = vi.fn().mockResolvedValue(undefined);
  render(
    <ResearchRegistrationPanel
      api={bridge(execute)}
      snapshot={snapshot}
      report={async (work) => work()}
      busy={false}
      onBusyChange={vi.fn()}
      onOpenResult={vi.fn().mockResolvedValue(undefined)}
      onPublished={onPublished}
    />,
  );
  return onPublished;
}

describe("ResearchRegistrationPanel", () => {
  it("discards a delayed preview after any bound registration setting changes", async () => {
    let resolvePreview!: (value: unknown) => void;
    const execute = vi.fn(
      () =>
        new Promise((resolve) => {
          resolvePreview = resolve;
        }),
    );
    renderPanel(execute);
    fireEvent.click(screen.getByText("Preview exact registration"));
    fireEvent.change(screen.getByLabelText("Registration upsample factor"), {
      target: { value: "40" },
    });
    await act(async () => {
      resolvePreview({ preview: receipt, preview_json: JSON.stringify(receipt), preview_sha256: "f".repeat(64), adopted: false });
      await Promise.resolve();
    });
    expect(screen.getByText("Adopt this exact receipt")).toBeDisabled();
    expect(screen.queryByLabelText("Exact registration preview")).not.toBeInTheDocument();
  });

  it("previews the exact inputs, invalidates a stale receipt, and only adopts the returned receipt", async () => {
    const derived: ResearchResult = {
      ...results[1],
      id: "9".repeat(32),
      revision_hash: "8".repeat(64),
      kind: "registered-derived",
      parent_id: results[1].id,
    };
    const execute = vi.fn((operation: string) =>
      operation === "registration_preview"
        ? Promise.resolve({ preview: receipt, preview_json: JSON.stringify(receipt), preview_sha256: "f".repeat(64), adopted: false })
        : Promise.resolve({ result: derived, adopted: true }),
    );
    const onPublished = renderPanel(execute);
    fireEvent.click(screen.getByText("Preview exact registration"));
    expect(await screen.findByLabelText("Exact registration preview")).toBeVisible();
    expect(execute).toHaveBeenCalledWith("registration_preview", {
      fixed: {
        result_id: results[0].id,
        revision_hash: results[0].revision_hash,
        array: "image",
      },
      moving: {
        result_id: results[1].id,
        revision_hash: results[1].revision_hash,
        array: "image",
      },
      method: "translation_phase_correlation",
      settings: { upsample_factor: 20, min_normalized_correlation: 0.25 },
      outputs: receipt.outputs,
      working_bytes: 512 * 1024 ** 2,
    });
    fireEvent.change(screen.getByLabelText("Registration upsample factor"), {
      target: { value: "40" },
    });
    await waitFor(() => expect(screen.getByText("Adopt this exact receipt")).toBeDisabled());
    expect(screen.queryByLabelText("Exact registration preview")).not.toBeInTheDocument();
    expect(execute).not.toHaveBeenCalledWith("registration_run", expect.anything());

    fireEvent.change(screen.getByLabelText("Registration upsample factor"), {
      target: { value: "20" },
    });
    fireEvent.click(screen.getByText("Preview exact registration"));
    await screen.findByLabelText("Exact registration preview");
    fireEvent.click(screen.getByText("Adopt this exact receipt"));
    await waitFor(() =>
      expect(execute).toHaveBeenCalledWith("registration_run", {
        preview_json: JSON.stringify(receipt),
        preview_sha256: "f".repeat(64),
      }),
    );
    expect(onPublished).toHaveBeenCalledWith(derived);
  });

  it("accepts canonically sorted receipt records without depending on object insertion order", async () => {
    const sortedReceipt: RegistrationReceipt = {
      ...receipt,
      settings: {
        min_normalized_correlation: 0.25,
        seed: 0,
        threads: 1,
        upsample_factor: 20,
      },
      outputs: receipt.outputs.map((item) => ({
        array: item.array,
        default_value: item.default_value,
        interpolation: item.interpolation,
        kind: item.kind,
        output_name: item.output_name,
      })),
    };
    const execute = vi.fn().mockResolvedValue({
      preview: sortedReceipt,
      preview_json: JSON.stringify(sortedReceipt),
      preview_sha256: "e".repeat(64),
      adopted: false,
    });
    renderPanel(execute);
    fireEvent.click(screen.getByText("Preview exact registration"));
    expect(await screen.findByLabelText("Exact registration preview")).toBeVisible();
    expect(screen.getByText("Adopt this exact receipt")).toBeEnabled();
  });

  it("echoes engine receipt bytes without changing integral floating-point spellings", async () => {
    const encoded = JSON.stringify(receipt).replace('"default_value":0', '"default_value":0.0');
    expect(encoded).toContain('"default_value":0.0');
    const derived = {
      ...results[1], id: "9".repeat(32), revision_hash: "8".repeat(64),
      kind: "registered-derived", parent_id: results[1].id,
    };
    const execute = vi.fn((operation: string) => Promise.resolve(operation === "registration_preview"
      ? { preview: JSON.parse(encoded), preview_json: encoded, preview_sha256: "f".repeat(64), adopted: false }
      : { result: derived, adopted: true }));
    renderPanel(execute);
    fireEvent.click(screen.getByText("Preview exact registration"));
    await screen.findByLabelText("Exact registration preview");
    fireEvent.click(screen.getByText("Adopt this exact receipt"));
    await waitFor(() => expect(execute).toHaveBeenCalledWith("registration_run", {
      preview_json: encoded, preview_sha256: "f".repeat(64),
    }));
  });

  it("offers only aligned 2D or 3D scalar arrays and excludes label-like integers", () => {
    const custom = {
      ...snapshot,
      results: snapshot.results.map((item) => ({
        ...item,
        arrays: {
          ...item.arrays,
          score: { shape: [8, 10], dtype: "float32" },
          probabilities: { shape: [2, 8, 10], dtype: "float32" },
          nuclei_labels: { shape: [8, 10], dtype: "uint32" },
        },
      })),
    };
    render(
      <ResearchRegistrationPanel
        api={bridge(vi.fn())}
        snapshot={custom}
        report={async (work) => work()}
        busy={false}
        onBusyChange={vi.fn()}
        onOpenResult={vi.fn().mockResolvedValue(undefined)}
        onPublished={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    const values = Array.from(
      (screen.getByLabelText("Registration fixed array") as HTMLSelectElement).options,
      (option) => option.value,
    );
    expect(values).toEqual(["image", "score"]);
  });

  it("publishes an explicit in-bounds physical resample grid with fixed output names", async () => {
    const derived: ResearchResult = {
      ...results[0],
      id: "7".repeat(32),
      revision_hash: "8".repeat(64),
      kind: "resampled-derived",
      parent_id: results[0].id,
    };
    const execute = vi.fn().mockResolvedValue({ result: derived, adopted: true });
    const onPublished = renderPanel(execute);
    fireEvent.click(screen.getByText("Resample grid"));
    await waitFor(() => expect(screen.getByLabelText("Grid crop start")).toHaveValue("0, 0"));
    expect(screen.getByLabelText("Grid output shape")).toHaveValue("8, 10");
    expect(screen.getByLabelText("Grid physical spacing")).toHaveValue("2, 0.5");
    fireEvent.change(screen.getByLabelText("Grid crop start"), {
      target: { value: "1, 2" },
    });
    fireEvent.change(screen.getByLabelText("Grid output shape"), {
      target: { value: "4, 5" },
    });
    fireEvent.click(screen.getByLabelText("Include parent labels"));
    fireEvent.click(screen.getByText("Publish declared output grid"));
    await waitFor(() =>
      expect(execute).toHaveBeenCalledWith("resample_grid", {
        parent: {
          result_id: results[0].id,
          revision_hash: results[0].revision_hash,
          array: "image",
        },
        grid: { start: [1, 2], shape: [4, 5], spacing: [2, 0.5] },
        outputs: [
          {
            array: "image",
            output_name: "image",
            kind: "scalar",
            interpolation: "linear",
            default_value: 0,
          },
          {
            array: "labels",
            output_name: "labels",
            kind: "labels",
            interpolation: "nearest",
            default_value: 0,
          },
        ],
        working_bytes: 512 * 1024 ** 2,
      }),
    );
    expect(onPublished).toHaveBeenCalledWith(derived);
  });
});
