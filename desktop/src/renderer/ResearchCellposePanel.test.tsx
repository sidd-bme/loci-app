// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useLayoutEffect, useState } from "react";
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
import { ResearchCellposePanel, Setting } from "./ResearchCellposePanel";

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

it("keeps an invalid first edit visible when it arrives before passive setting synchronisation", async () => {
  const onChange = vi.fn();
  const onValidity = vi.fn();
  function EarlyEdit() {
    useLayoutEffect(() => { fireEvent.change(screen.getByLabelText("Diameter"), { target: { value: "not-a-number" } }); }, []);
    return <Setting definition={numericSetting("diameter_px", "Diameter", "number", 1, 1000)} value={30}
      disabled={false} onChange={onChange} onValidity={onValidity} />;
  }
  await act(async () => { render(<EarlyEdit />); });
  expect(screen.getByLabelText("Diameter")).toHaveValue("not-a-number");
  expect(screen.getByLabelText("Diameter")).toHaveAttribute("aria-invalid", "true");
  expect(onValidity).toHaveBeenLastCalledWith(false);
  expect(onChange).not.toHaveBeenCalled();
});

it("names the device choice exactly and forwards the explicit CPU selection", () => {
  const onChange = vi.fn();
  render(<Setting definition={{ key: "device", label: "Compute device", section: "Performance",
    valueType: "choice", help: "Select the requested backend", minimum: null, maximum: null, step: null,
    choices: ["auto", "cpu", "mps", "cuda"] }} value="auto" disabled={false}
    onChange={onChange} onValidity={vi.fn()} />);
  const device = screen.getByRole("combobox", { name: "Compute device" });
  expect(device).toHaveAccessibleName("Compute device");
  fireEvent.change(device, { target: { value: "cpu" } });
  expect(onChange).toHaveBeenLastCalledWith("cpu");
});

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
    downloadCellposeModel: vi.fn().mockResolvedValue(status(true)),
    cancelCellposeDownload: vi.fn().mockResolvedValue(true),
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
  it("labels an in-progress remote start as preparation rather than running inference", async () => {
    installNative();
    let finish!: () => void;
    const start = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const onResult = vi.fn();
    const api = researchApi();
    function Harness() {
      const [busy, setBusy] = useState(false);
      return <ResearchCellposePanel api={api} source={source} selection={selection} profileId="cellpose-sam-v2"
        busy={busy} onBusy={value => setBusy(value !== null)} onError={vi.fn()} onResult={onResult}
        remoteTarget={{ alias: "vanda", device: "cuda", start }} />;
    }
    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: "Segment on vanda" }));
    expect(await screen.findByRole("button", { name: "Preparing remote run…" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Running…" })).not.toBeInTheDocument();
    await act(async () => { finish(); });
    expect(screen.getByRole("button", { name: "Segment on vanda" })).toBeEnabled();
    expect(onResult).not.toHaveBeenCalled();
  });

  it("runs the same settings on a remote GPU without requiring a local checkpoint", async () => {
    installNative({ getCellposeStatus: vi.fn().mockResolvedValue(status(false)) });
    const start = vi.fn().mockResolvedValue(undefined), onResult = vi.fn(), onBatchConfiguration = vi.fn();
    const api = researchApi();
    render(<ResearchCellposePanel api={api} source={source} selection={selection} profileId="cellpose-sam-v2"
      busy={false} onBusy={vi.fn()} onError={vi.fn()} onResult={onResult} onBatchConfiguration={onBatchConfiguration}
      remoteTarget={{ alias: "vanda", device: "cuda", start }} />);
    const button = await screen.findByRole("button", { name: "Segment on vanda" });
    await waitFor(() => expect(button).toBeEnabled());
    expect(screen.queryByRole("button", { name: "Import checkpoint…" })).not.toBeInTheDocument();
    fireEvent.click(button);
    await waitFor(() => expect(start).toHaveBeenCalledWith([{ operation: "cellpose_run",
      source: { id: source.id, sha256: source.sha256 }, request: { source_id: source.id, selection,
        profile_id: "cellpose-sam-v2", settings: { ...recommended, device: "cuda" }, measurement_channels: [1], working_bytes: 512 * 1024 ** 2 } }]));
    expect(api.execute).not.toHaveBeenCalledWith("cellpose_run", expect.anything());
    expect(onResult).not.toHaveBeenCalled();
    expect(onBatchConfiguration).toHaveBeenLastCalledWith(expect.objectContaining({ settings: { ...recommended, device: "cuda" } }));
  });

  it("loads the exact profile and readiness without silently importing a model", async () => {
    const native = installNative({ getCellposeStatus: vi.fn().mockResolvedValue(status(false)) });
    renderPanel();

    expect(await screen.findByText("Import the exact local checkpoint.")).toBeVisible();
    expect(native.listProfiles).toHaveBeenCalledOnce();
    expect(native.getCellposeStatus).toHaveBeenCalledWith("cellpose-sam-v2");
    expect(native.importCellposeModel).not.toHaveBeenCalled();
    expect(native.downloadCellposeModel).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Segment image" })).toBeDisabled();
    expect(screen.getByText("Model, licence & validation")).toBeVisible();
    expect(screen.queryByText(/Opening an image never downloads a model/)).not.toBeInTheDocument();
  });

  it("imports only after the explicit readiness action and enables the verified profile", async () => {
    const native = installNative({ getCellposeStatus: vi.fn().mockResolvedValue(status(false)) });
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Import checkpoint…" }));
    await waitFor(() => expect(native.importCellposeModel).toHaveBeenCalledWith("cellpose-sam-v2"));
    expect(await screen.findByText("Ready locally")).toBeVisible();
    expect(screen.getByRole("button", { name: "Segment image" })).toBeEnabled();
  });

  it("downloads only the explicitly selected checkpoint and keeps execution disabled until verified", async () => {
    let finish!: (value: CellposeStatus) => void;
    const downloadCellposeModel = vi.fn(() => new Promise<CellposeStatus>((resolve) => { finish = resolve; }));
    const native = installNative({ getCellposeStatus: vi.fn().mockResolvedValue(status(false)), downloadCellposeModel });
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Download verified checkpoint" }));
    expect(downloadCellposeModel).toHaveBeenCalledWith("cellpose-sam-v2");
    expect(screen.getByRole("button", { name: "Segment image" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Downloading and verifying…" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel download" }));
    await waitFor(() => expect(native.cancelCellposeDownload).toHaveBeenCalledWith("cellpose-sam-v2"));
    await act(async () => { finish(status(true)); });
    expect(screen.getByRole("button", { name: "Segment image" })).toBeEnabled();
    expect(native.importCellposeModel).not.toHaveBeenCalled();
  });

  it("does not treat a downloaded checkpoint as runtime readiness", async () => {
    const missingRuntime = { ...status(false), model: { ...status(false).model, present: true, verified: true } };
    installNative({ getCellposeStatus: vi.fn().mockResolvedValue(status(false)), downloadCellposeModel: vi.fn().mockResolvedValue(missingRuntime) });
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Download verified checkpoint" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Download verified checkpoint" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Segment image" })).toBeDisabled();
  });

  it("ignores a completed download after switching to a different model profile", async () => {
    let finish!: (value: CellposeStatus) => void;
    const originalProfile = { ...profile, id: "cellpose-sam" as const, name: "Cellpose-SAM", model: { ...profile.model, artifactId: "cpsam" } };
    const originalStatus = { ...status(false), profileId: "cellpose-sam" as const, model: { ...status(false).model, artifactId: "cpsam" } };
    const native = installNative({
      listProfiles: vi.fn().mockResolvedValue([originalProfile, profile]),
      getCellposeStatus: vi.fn((id) => Promise.resolve(id === "cellpose-sam" ? originalStatus : status(false))),
      downloadCellposeModel: vi.fn(() => new Promise<CellposeStatus>(resolve => { finish = resolve; })),
    });
    const props = { api: researchApi(), source, selection, busy: false, onBusy: vi.fn(), onError: vi.fn(), onResult: vi.fn() };
    const { rerender } = render(<ResearchCellposePanel {...props} profileId="cellpose-sam-v2" />);
    fireEvent.click(await screen.findByRole("button", { name: "Download verified checkpoint" }));
    rerender(<ResearchCellposePanel {...props} profileId="cellpose-sam" />);
    await waitFor(() => expect(native.getCellposeStatus).toHaveBeenLastCalledWith("cellpose-sam"));
    await act(async () => { finish(status(true)); });
    expect(screen.getByRole("button", { name: "Segment image" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Download verified checkpoint" })).toBeEnabled();
    expect(screen.queryByText("Ready locally")).not.toBeInTheDocument();
    expect(props.onError).not.toHaveBeenCalled();
  });

  it("refuses a completed download for the wrong checkpoint identity", async () => {
    const mismatch = { ...status(true), model: { ...status(true).model, artifactId: "cpsam" } };
    installNative({ getCellposeStatus: vi.fn().mockResolvedValue(status(false)), downloadCellposeModel: vi.fn().mockResolvedValue(mismatch) });
    const { onError } = renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Download verified checkpoint" }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringContaining("does not match the selected model")));
    expect(screen.getByRole("button", { name: "Segment image" })).toBeDisabled();
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

    expect(await screen.findByText(/Choose a single Z plane to run/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Segment image" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Segment image" }));
    expect(execute).not.toHaveBeenCalled();
  });

  it("allows selecting 2 GiB memory allowance and includes it in batch configuration and execution", async () => {
    installNative();
    const execute = vi.fn().mockResolvedValue({ result });
    const onBatchConfiguration = vi.fn();
    renderPanel({ api: researchApi(execute), onBatchConfiguration });

    expect(await screen.findByRole("button", { name: "Segment image" })).toBeEnabled();
    const select = screen.getByLabelText("Cellpose memory allowance");
    expect(select).toHaveValue(String(512 * 1024 ** 2));

    fireEvent.change(select, { target: { value: String(2 * 1024 ** 3) } });
    expect(select).toHaveValue(String(2 * 1024 ** 3));

    await waitFor(() =>
      expect(onBatchConfiguration).toHaveBeenLastCalledWith(
        expect.objectContaining({
          workingBytes: 2 * 1024 ** 3,
        }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Segment image" }));
    await waitFor(() =>
      expect(execute).toHaveBeenCalledWith(
        "cellpose_run",
        expect.objectContaining({
          working_bytes: 2 * 1024 ** 3,
        }),
      ),
    );
  });

  it("supports both cellpose-sam and cellpose-sam-v2 profile IDs", async () => {
    const native = installNative();
    const execute = vi.fn().mockResolvedValue({ result });
    const { rerender } = render(
      <ResearchCellposePanel
        api={researchApi(execute)}
        source={source}
        selection={selection}
        profileId="cellpose-sam"
        busy={false}
        onBusy={vi.fn()}
        onError={vi.fn()}
        onResult={vi.fn()}
      />,
    );

    await waitFor(() => expect(native.getCellposeStatus).toHaveBeenCalledWith("cellpose-sam"));

    rerender(
      <ResearchCellposePanel
        api={researchApi(execute)}
        source={source}
        selection={selection}
        profileId="cellpose-sam-v2"
        busy={false}
        onBusy={vi.fn()}
        onError={vi.fn()}
        onResult={vi.fn()}
      />,
    );

    await waitFor(() => expect(native.getCellposeStatus).toHaveBeenCalledWith("cellpose-sam-v2"));
  });

  it("allows selecting 4 GiB or 8 GiB allowance even when 2 GiB is recommended", async () => {
    installNative();
    const api = researchApi();
    api.recipeResources = vi.fn().mockResolvedValue({
      total_memory_bytes: 16 * 1024 ** 3,
      recommended_working_bytes: 2 * 1024 ** 3,
      limits: { min_bytes: 512 * 1024 ** 2, max_bytes: 8 * 1024 ** 3 },
    });
    const onBatchConfiguration = vi.fn();
    renderPanel({ api, onBatchConfiguration });

    expect(await screen.findByText(/16 GiB installed · 2 GiB recommended/i)).toBeVisible();
    const select = screen.getByLabelText("Cellpose memory allowance");

    // Select 4 GiB
    fireEvent.change(select, { target: { value: String(4 * 1024 ** 3) } });
    expect(select).toHaveValue(String(4 * 1024 ** 3));
    expect(await screen.findByText(/Above the 2 GiB recommendation/i)).toBeVisible();
    expect(onBatchConfiguration).toHaveBeenLastCalledWith(
      expect.objectContaining({
        workingBytes: 4 * 1024 ** 3,
      }),
    );

    // Select 8 GiB
    fireEvent.change(select, { target: { value: String(8 * 1024 ** 3) } });
    expect(select).toHaveValue(String(8 * 1024 ** 3));
    expect(onBatchConfiguration).toHaveBeenLastCalledWith(
      expect.objectContaining({
        workingBytes: 8 * 1024 ** 3,
      }),
    );

    // Click "Use recommended"
    const useRecommendedButton = screen.getByRole("button", { name: "Use recommended" });
    fireEvent.click(useRecommendedButton);
    expect(select).toHaveValue(String(2 * 1024 ** 3));
    expect(onBatchConfiguration).toHaveBeenLastCalledWith(
      expect.objectContaining({
        workingBytes: 2 * 1024 ** 3,
      }),
    );
  });

  it("disables memory allowance selection when busy", async () => {
    installNative();
    render(
      <ResearchCellposePanel
        api={researchApi()}
        source={source}
        selection={selection}
        profileId="cellpose-sam-v2"
        busy={true}
        onBusy={vi.fn()}
        onError={vi.fn()}
        onResult={vi.fn()}
      />,
    );

    const select = await screen.findByLabelText("Cellpose memory allowance");
    expect(select).toBeDisabled();
  });
});
