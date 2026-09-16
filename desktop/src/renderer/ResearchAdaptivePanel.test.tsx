// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LociDesktopApi, SegmentationProfile, SegmentationSettings } from "../shared/contracts";
import type { ResearchDesktopApi, ResearchResult, ResearchSelection, ResearchSource } from "../shared/research-contracts";
import { ResearchAdaptivePanel } from "./ResearchAdaptivePanel";

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "loci");
});

const recommended: SegmentationSettings = {
  image_mode: "auto",
  polarity: "auto",
  expected_diameter_px: 34,
  min_area_px: 80,
  sensitivity: 0,
  smoothing_px: 1.2,
  split_touching: true,
  exclude_border: false,
};

const profile: SegmentationProfile = {
  schemaVersion: "1.2",
  id: "loci-classical",
  name: "Loci Adaptive Watershed",
  version: "0.1.0",
  status: "ready",
  availability: { code: "ready", summary: "Built in." },
  backendKind: "classical",
  model: { format: "builtin-algorithm", artifactId: null, sha256: null },
  preprocessing: {
    channelConversion: "grayscale-luminance",
    intensityNormalization: "per-image-percentile-1-99",
    resizePolicy: "none",
    maxEdgePx: null,
    outputGrid: "source-resolution",
  },
  rights: {
    codeLicense: "Apache-2.0",
    modelLicense: "not-applicable",
    redistribution: "bundled",
    commercialUse: "permitted",
    trainingDataLineage: "No learned weights or training data; deterministic image processing.",
  },
  recommendedSettings: recommended,
  settingsContract: [
    { key: "image_mode", label: "Imaging preset", section: "Input", valueType: "choice",
      help: "Guides automatic polarity selection.", minimum: null, maximum: null, step: null,
      choices: ["auto", "brightfield", "fluorescence"] },
    { key: "polarity", label: "Cell polarity", section: "Input", valueType: "choice",
      help: "Select foreground polarity.", minimum: null, maximum: null, step: null,
      choices: ["auto", "dark", "bright"] },
    { key: "expected_diameter_px", label: "Expected diameter", section: "Instances", valueType: "number",
      help: "Approximate diameter.", minimum: 4, maximum: 1000, step: 1, choices: [] },
    { key: "min_area_px", label: "Minimum cell area", section: "Instances", valueType: "integer",
      help: "Minimum area.", minimum: 1, maximum: 10_000_000, step: 1, choices: [] },
    { key: "sensitivity", label: "Sensitivity", section: "Detection", valueType: "number",
      help: "Detection sensitivity.", minimum: -1, maximum: 1, step: 0.05, choices: [] },
    { key: "smoothing_px", label: "Edge smoothing", section: "Detection", valueType: "number",
      help: "Gaussian smoothing.", minimum: 0, maximum: 20, step: 0.1, choices: [] },
    { key: "split_touching", label: "Split touching cells", section: "Instances", valueType: "boolean",
      help: "Separate touching regions.", minimum: null, maximum: null, step: null, choices: [] },
    { key: "exclude_border", label: "Exclude border cells", section: "Instances", valueType: "boolean",
      help: "Remove border regions.", minimum: null, maximum: null, step: null, choices: [] },
  ],
  validation: {
    status: "baseline",
    summary: "Deterministic baseline with structural sanity checks; not an accuracy-validated cell model.",
    failureModes: [],
  },
};

const source: ResearchSource = {
  id: "a".repeat(32),
  name: "Scalar source",
  sha256: "b".repeat(64),
  source_kind: "native",
  metadata: {
    format: "OME-TIFF",
    dimensions: { t: 2, c: 3, z: 4, y: 32, x: 40 },
    channel_names: ["Nuclei", "Signal", "Reference"],
    sample_semantics: "intensity",
  },
};
const selection: ResearchSelection = {
  x: 3, y: 5, width: 20, height: 16, z: 2, t: 1, c: 1, level: 0,
};
const result: ResearchResult = {
  id: "c".repeat(32), source_id: source.id, source_sha256: source.sha256,
  kind: "adaptive-segmentation", created_at: "2026-09-08T00:00:00Z",
  revision_hash: "d".repeat(64), object_count: 2,
};

function installNative() {
  const native = { listProfiles: vi.fn().mockResolvedValue([profile]) } as unknown as LociDesktopApi;
  Object.defineProperty(window, "loci", { configurable: true, value: native });
  return native;
}

function researchApi(execute = vi.fn().mockResolvedValue({ result })): ResearchDesktopApi {
  return {
    createStudy: vi.fn(), openStudy: vi.fn(), getSnapshot: vi.fn(), addSources: vi.fn(),
    execute, reviewResult: vi.fn(), exportResult: vi.fn(), cancelJob: vi.fn(),
  };
}

function renderPanel({
  api = researchApi(), activeSource = source, activeSelection = selection,
  onBusy = vi.fn(), onError = vi.fn(), onResult = vi.fn().mockResolvedValue(undefined),
  onBatchConfiguration = vi.fn(),
}: {
  api?: ResearchDesktopApi; activeSource?: ResearchSource; activeSelection?: ResearchSelection;
  onBusy?: (value: string | null) => void; onError?: (value: string) => void;
  onResult?: (value: ResearchResult) => Promise<void>;
  onBatchConfiguration?: Parameters<typeof ResearchAdaptivePanel>[0]["onBatchConfiguration"];
} = {}) {
  render(<ResearchAdaptivePanel api={api} source={activeSource} selection={activeSelection}
    busy={false} onBusy={onBusy} onError={onError} onResult={onResult}
    onBatchConfiguration={onBatchConfiguration} />);
  return { api, onBusy, onError, onResult, onBatchConfiguration };
}

describe("ResearchAdaptivePanel", () => {
  it("loads every setting from the established eight-setting profile contract", async () => {
    const native = installNative();
    renderPanel();

    expect(await screen.findByLabelText("Imaging preset")).toHaveValue("auto");
    expect(screen.getByLabelText("Cell polarity")).toHaveValue("auto");
    expect(screen.getByLabelText("Expected diameter")).toHaveValue("34");
    expect(screen.getByLabelText("Minimum cell area")).toHaveValue("80");
    expect(screen.getByLabelText("Sensitivity")).toHaveValue("0");
    expect(screen.getByLabelText("Edge smoothing")).toHaveValue("1.2");
    expect(screen.getByLabelText("Split touching cells")).toBeChecked();
    expect(screen.getByLabelText("Exclude border cells")).not.toBeChecked();
    expect(native.listProfiles).toHaveBeenCalledOnce();
  });

  it("blocks invalid typed settings from both execution and batch configuration", async () => {
    installNative();
    const execute = vi.fn();
    const onBatchConfiguration = vi.fn();
    renderPanel({ api: researchApi(execute), onBatchConfiguration });

    const diameter = await screen.findByLabelText("Expected diameter");
    await waitFor(() => expect(onBatchConfiguration).toHaveBeenLastCalledWith(expect.objectContaining({
      configuredSourceId: source.id,
    })));
    fireEvent.change(diameter, { target: { value: "34.5.6" } });

    expect(diameter).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Correct the highlighted settings before running.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Segment image" })).toBeDisabled();
    expect(onBatchConfiguration).toHaveBeenLastCalledWith(null);
    fireEvent.click(screen.getByRole("button", { name: "Segment image" }));
    expect(execute).not.toHaveBeenCalled();
  });

  it("submits the exact native plane, profile, settings, channel, and memory budget", async () => {
    installNative();
    const execute = vi.fn().mockResolvedValue({ result });
    const onResult = vi.fn().mockResolvedValue(undefined);
    const onBatchConfiguration = vi.fn();
    const { onBusy } = renderPanel({ api: researchApi(execute), onResult, onBatchConfiguration });

    const button = await screen.findByRole("button", { name: "Segment image" });
    await waitFor(() => expect(onBatchConfiguration).toHaveBeenLastCalledWith({
      configuredSourceId: source.id,
      profileId: "loci-classical",
      settings: recommended,
      measurementChannels: [selection.c],
      workingBytes: 512 * 1024 ** 2,
    }));
    fireEvent.click(button);

    await waitFor(() => expect(execute).toHaveBeenCalledWith("classical_run", {
      source_id: source.id,
      selection,
      profile_id: "loci-classical",
      settings: recommended,
      measurement_channels: [selection.c],
      working_bytes: 512 * 1024 ** 2,
    }));
    expect(onResult).toHaveBeenCalledWith(result);
    expect(onBusy).toHaveBeenNthCalledWith(1, "Adaptive segmentation");
    expect(onBusy).toHaveBeenLastCalledWith(null);
  });

  it("does not treat interleaved RGB components as biological measurement channels", async () => {
    installNative();
    const rgbSource: ResearchSource = {
      ...source, id: "e".repeat(32), name: "RGB source",
      metadata: { ...source.metadata, sample_semantics: "RGB" },
    };
    const rgbResult = { ...result, source_id: rgbSource.id };
    const execute = vi.fn().mockResolvedValue({ result: rgbResult });
    const onBatchConfiguration = vi.fn();
    renderPanel({ api: researchApi(execute), activeSource: rgbSource, onBatchConfiguration });

    expect(await screen.findByText(/Input: RGB-derived grayscale/)).toBeVisible();
    await waitFor(() => expect(onBatchConfiguration).toHaveBeenLastCalledWith(expect.objectContaining({
      measurementChannels: [],
    })));
    fireEvent.click(screen.getByRole("button", { name: "Segment image" }));
    await waitFor(() => expect(execute).toHaveBeenCalledWith("classical_run",
      expect.objectContaining({ measurement_channels: [] })));
  });

  it("blocks a depth selection until the user chooses one two-dimensional plane", async () => {
    installNative();
    const execute = vi.fn();
    const onBatchConfiguration = vi.fn();
    renderPanel({ api: researchApi(execute),
      activeSelection: { ...selection, z_stop: 4 }, onBatchConfiguration });

    expect(await screen.findByText(/works on one 2D plane/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Segment image" })).toBeDisabled();
    expect(onBatchConfiguration).toHaveBeenLastCalledWith(null);
    fireEvent.click(screen.getByRole("button", { name: "Segment image" }));
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails closed when the returned result belongs to another source", async () => {
    installNative();
    const onError = vi.fn();
    const onResult = vi.fn().mockResolvedValue(undefined);
    const execute = vi.fn().mockResolvedValue({
      result: { ...result, source_id: "f".repeat(32) },
    });
    const { onBusy } = renderPanel({ api: researchApi(execute), onError, onResult });

    fireEvent.click(await screen.findByRole("button", { name: "Segment image" }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("The adaptive result does not match its source."));
    expect(onResult).not.toHaveBeenCalled();
    expect(onBusy).toHaveBeenLastCalledWith(null);
  });
});
