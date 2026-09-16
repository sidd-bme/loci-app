// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CellposeProfileId,
  CellposeSettings,
  CellposeStatus,
  LociDesktopApi,
  SegmentationProfile,
} from "../shared/contracts";
import type {
  ResearchDesktopApi,
  ResearchResult,
  ResearchSelection,
  ResearchSource,
} from "../shared/research-contracts";
import { ResearchCellposePanel } from "./ResearchCellposePanel";

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "loci");
});

const recommended: CellposeSettings = {
  max_edge_px: 1000,
  diameter_px: 30,
  flow_threshold: 0.4,
  cellprob_threshold: 0,
  min_size_px: 15,
  max_size_fraction: 0.4,
  niter: 250,
  batch_size: 8,
  resample: true,
  augment: false,
  tile_overlap: 0.1,
  normalize: true,
  percentile_low: 1,
  percentile_high: 99,
  tile_norm_blocksize: 0,
  sharpen_radius: 0,
  smooth_radius: 0,
  invert: false,
  device: "auto",
};

const numericSetting = (
  key: keyof CellposeSettings,
  label: string,
  valueType: "integer" | "number" = "number",
  minimum = 0,
  maximum = 10_000,
) => ({ key, label, section: "Input", valueType, help: `${label} help`, minimum, maximum, step: 1, choices: [] });

const profile: SegmentationProfile = {
  schemaVersion: "1",
  id: "cellpose-sam-v2",
  name: "Cellpose-SAM v2",
  version: "4.2.1.1",
  status: "ready",
  availability: { code: "ready", summary: "The exact runtime and checkpoint are ready." },
  backendKind: "cellpose",
  model: { format: "cellpose-native", artifactId: "cpsam_v2", sha256: "2".repeat(64) },
  preprocessing: {
    channelConversion: "rgb-or-replicated-grayscale",
    intensityNormalization: "cellpose-configurable-percentile",
    resizePolicy: "downsample-only",
    maxEdgePx: 1000,
    outputGrid: "source-resolution",
  },
  rights: {
    codeLicense: "BSD-3-Clause",
    modelLicense: "BSD-3-Clause",
    redistribution: "not_permitted",
    commercialUse: "unknown",
    trainingDataLineage: "Upstream-declared training data",
  },
  recommendedSettings: recommended,
  settingsContract: [
    numericSetting("diameter_px", "Diameter", "number", 1, 1000),
    numericSetting("flow_threshold", "Flow threshold", "number", 0, 1),
    numericSetting("cellprob_threshold", "Cell probability", "number", -10, 10),
    numericSetting("min_size_px", "Minimum size", "integer", 1, 1_000_000),
    numericSetting("max_edge_px", "Maximum inference edge", "integer", 64, 10_000),
  ],
  validation: {
    status: "limited",
    summary: "Review every result against the source image.",
    failureModes: [{ code: "domain-shift", summary: "Unvalidated image domains may fail." }],
  },
};

const source: ResearchSource = {
  id: "a".repeat(32),
  name: "Bound source",
  sha256: "b".repeat(64),
  metadata: {
    format: "OME-TIFF",
    dimensions: { t: 1, c: 2, z: 3, y: 32, x: 40 },
    channel_names: ["Nuclei", "Cytoplasm"],
    sample_semantics: "intensity",
  },
};
const selection: ResearchSelection = {
  x: 1, y: 2, width: 20, height: 16, t: 0, c: 1, z: 2, level: 0,
};
const result: ResearchResult = {
  id: "c".repeat(32), source_id: source.id, kind: "segmentation",
  created_at: "2026-09-08T00:00:00Z", revision_hash: "d".repeat(64), object_count: 2,
};

function status(ready: boolean): CellposeStatus {
  return {
    profileId: "cellpose-sam-v2",
    ready,
    code: ready ? "ready" : "package-missing",
    summary: ready ? "Cellpose is ready." : "Import the exact local checkpoint.",
    package: { requiredVersion: "4.2.1.1", installedVersion: ready ? "4.2.1.1" : null, exact: ready },
    model: {
      artifactId: "cpsam_v2", expectedSha256: "2".repeat(64), expectedSizeBytes: 1_233_586_851,
      present: ready, verified: ready,
    },
    devices: { cpu: ready, mps: ready, cuda: false },
  };
}

function installNative(overrides: Partial<LociDesktopApi> = {}) {
  const native = {
    listProfiles: vi.fn().mockResolvedValue([profile]),
    getCellposeStatus: vi.fn().mockResolvedValue(status(true)),
    importCellposeModel: vi.fn().mockResolvedValue(status(true)),
    ...overrides,
  } as unknown as LociDesktopApi;
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
  api = researchApi(),
  activeSource = source,
  activeSelection = selection,
  onBusy = vi.fn(),
  onError = vi.fn(),
  onResult = vi.fn().mockResolvedValue(undefined),
  onBatchConfiguration = vi.fn(),
}: {
  api?: ResearchDesktopApi;
  activeSource?: ResearchSource;
  activeSelection?: ResearchSelection;
  onBusy?: (value: string | null) => void;
  onError?: (value: string) => void;
  onResult?: (value: ResearchResult) => Promise<void>;
  onBatchConfiguration?: Parameters<typeof ResearchCellposePanel>[0]["onBatchConfiguration"];
} = {}) {
  render(<ResearchCellposePanel api={api} source={activeSource} selection={activeSelection}
    profileId="cellpose-sam-v2" busy={false} onBusy={onBusy} onError={onError} onResult={onResult}
    onBatchConfiguration={onBatchConfiguration} />);
  return { api, onBusy, onError, onResult, onBatchConfiguration };
}

describe("ResearchCellposePanel", () => {
  it("loads the exact profile and readiness without silently importing a model", async () => {
    const native = installNative({ getCellposeStatus: vi.fn().mockResolvedValue(status(false)) });
    renderPanel();

    expect(await screen.findByText("Import the exact local checkpoint.")).toBeVisible();
    expect(native.listProfiles).toHaveBeenCalledOnce();
    expect(native.getCellposeStatus).toHaveBeenCalledWith("cellpose-sam-v2");
    expect(native.importCellposeModel).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Segment image" })).toBeDisabled();
    expect(screen.getByText(/Opening an image never downloads a model/)).toBeVisible();
  });

  it("imports only after the explicit readiness action and enables the verified profile", async () => {
    const native = installNative({ getCellposeStatus: vi.fn().mockResolvedValue(status(false)) });
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Import checkpoint…" }));
    await waitFor(() => expect(native.importCellposeModel).toHaveBeenCalledWith("cellpose-sam-v2"));
    expect(await screen.findByText("Ready locally")).toBeVisible();
    expect(screen.getByRole("button", { name: "Segment image" })).toBeEnabled();
  });

  it("blocks invalid numeric drafts, then executes corrected settings bound to the source", async () => {
    installNative();
    const execute = vi.fn().mockResolvedValue({ result });
    const onResult = vi.fn().mockResolvedValue(undefined);
    renderPanel({ api: researchApi(execute), onResult });

    const diameter = await screen.findByLabelText("Diameter");
    fireEvent.change(diameter, { target: { value: "not-a-number" } });
    fireEvent.blur(diameter);
    expect(diameter).toHaveAttribute("aria-invalid", "true");
    fireEvent.click(screen.getByRole("button", { name: "Segment image" }));

    expect(execute).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Segment image" })).toBeDisabled();
    fireEvent.change(diameter, { target: { value: "42" } });
    expect(screen.getByRole("button", { name: "Segment image" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Segment image" }));
    await waitFor(() => expect(execute).toHaveBeenCalledWith("cellpose_run", {
      source_id: source.id,
      selection,
      profile_id: "cellpose-sam-v2",
      settings: expect.objectContaining({ diameter_px: 42 }),
      measurement_channels: [selection.c],
      working_bytes: 512 * 1024 ** 2,
    }));
    expect(onResult).toHaveBeenCalledWith(result);
  });

  it("lifts the exact profile, requested device, settings, channels, and budget for batching", async () => {
    installNative();
    const onBatchConfiguration = vi.fn();
    renderPanel({ onBatchConfiguration });

    await waitFor(() => expect(onBatchConfiguration).toHaveBeenLastCalledWith({
      configuredSourceId: source.id,
      profileId: "cellpose-sam-v2",
      settings: recommended,
      measurementChannels: [selection.c],
      workingBytes: 512 * 1024 ** 2,
    }));
    fireEvent.change(screen.getByLabelText("Diameter"), { target: { value: "invalid" } });
    expect(onBatchConfiguration).toHaveBeenLastCalledWith(null);
  });

  it("rejects a result whose source binding differs from the requested source", async () => {
    installNative();
    const onError = vi.fn();
    const onResult = vi.fn().mockResolvedValue(undefined);
    const execute = vi.fn().mockResolvedValue({
      result: { ...result, source_id: "e".repeat(32) },
    });
    renderPanel({ api: researchApi(execute), onError, onResult });

    fireEvent.click(await screen.findByRole("button", { name: "Segment image" }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("The Cellpose result does not match its source."));
    expect(onResult).not.toHaveBeenCalled();
  });

  it("blocks volumetric selections until a single plane is chosen", async () => {
    installNative();
    const execute = vi.fn();
    renderPanel({
      api: researchApi(execute),
      activeSelection: { ...selection, z_stop: 3 },
    });

    expect(await screen.findByText(/Choose a single plane to run/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Segment image" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Segment image" }));
    expect(execute).not.toHaveBeenCalled();
  });
});
