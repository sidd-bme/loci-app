// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ResearchDesktopApi,
  ResearchLabelsImportPreview,
  ResearchResult,
  ResearchSelection,
  ResearchSource,
  ResearchUsamHandoffBinding,
  ResearchUsamHandoffReceipt,
  ResearchUsamHandoffRecord,
} from "../shared/research-contracts";
import { ResearchLabelsImportPanel, checkedLabelsPreview, labelsImportUnavailable } from "./ResearchLabelsImportPanel";

afterEach(cleanup);
const source: ResearchSource = { id: "a".repeat(32), name: "Synthetic plane", sha256: "b".repeat(64), source_kind: "native", metadata: { dimensions: { x: 8, y: 4, t: 1, c: 2, z: 2 }, axes: "TCZYX" } };
const selection: ResearchSelection = { x: 0, y: 0, width: 8, height: 4, t: 0, c: 1, z: 1, level: 0 };
const preview: ResearchLabelsImportPreview = { source_id: source.id, source_sha256: source.sha256, selection, working_bytes: 64 * 1024 ** 2, grant_id: "c".repeat(32),
  geometry: null, file_name: "sparse.tif", file_sha256: "d".repeat(64), file_size_bytes: 1000, original_dtype: "uint32", shape: [4, 8], axes: "YX", object_count: 2,
  labels_sha256: "e".repeat(64), format: "TIFF", profile: "scalar-native-yx/v1", estimated_working_bytes: 2048,
  measurement_channel: { index: 1, name: "Raw channel 2", basis: "raw-source-channel-values" }, calibration_handling: {},
  image: "data:image/png;base64,cG5n", preview_width: 8, preview_height: 4 };
const result: ResearchResult = { id: "f".repeat(32), revision_hash: "1".repeat(64), source_id: source.id, source_sha256: source.sha256, kind: "imported-labels", created_at: "now", object_count: 2, selection, review: null };
function setup(overrides: Partial<Parameters<typeof ResearchLabelsImportPanel>[0]> = {}) {
  const execute = vi.fn().mockResolvedValue({ result, measurements: [] });
  const picker = vi.fn().mockResolvedValue(preview);
  const props = { api: { execute, labelsImportPreview: picker } as unknown as ResearchDesktopApi, source, selection, workingBytes: preview.working_bytes, scope: "study-a", busy: false,
    onBusy: vi.fn(), onResult: vi.fn().mockResolvedValue(undefined), ...overrides };
  return { props, execute, picker };
}

describe("checked external-label import", () => {
  it("shows real preview metadata and adopts only the opaque grant with unknown producer", async () => {
    const { props, picker, execute } = setup(); render(<ResearchLabelsImportPanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Import labels" }));
    expect(await screen.findByAltText("Checked label overlay on the selected source plane")).toHaveAttribute("src", preview.image);
    expect(screen.getByText("sparse.tif")).toBeVisible(); expect(screen.getByText(/uint32/)).toBeVisible();
    expect(screen.getByText(/Upstream settings and validation are unknown/)).toBeVisible();
    expect(picker).toHaveBeenCalledWith({ source_id: source.id, source_sha256: source.sha256, selection, working_bytes: preview.working_bytes });
    fireEvent.click(screen.getByRole("button", { name: "Import on this plane" }));
    await waitFor(() => expect(props.onResult).toHaveBeenCalledWith(result, [], expect.any(Function)));
    expect(execute).toHaveBeenCalledWith("labels_import", { source_id: source.id, source_sha256: source.sha256, grant_id: preview.grant_id, alignment: "same-native-yx-grid" });
  });
  it("cancellation and failure preserve the old result", async () => {
    const { props, picker, execute } = setup(); picker.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("Unsupported label dtype"));
    render(<ResearchLabelsImportPanel {...props} />); fireEvent.click(screen.getByText("Import labels"));
    await waitFor(() => expect(props.onBusy).toHaveBeenLastCalledWith(null, expect.any(String)));
    expect(screen.queryByText("Import on this plane")).toBeNull();
    fireEvent.click(screen.getByText("Import labels")); expect(await screen.findByRole("alert")).toHaveTextContent("Unsupported label dtype");
    expect(execute).not.toHaveBeenCalled(); expect(props.onResult).not.toHaveBeenCalled();
  });
  it("discards a late picker preview after changing source plane", async () => {
    let finish!: (value: ResearchLabelsImportPreview) => void;
    const { props, picker } = setup(); picker.mockReturnValue(new Promise<ResearchLabelsImportPreview>((resolve) => { finish = resolve; }));
    const view = render(<ResearchLabelsImportPanel {...props} />); fireEvent.click(screen.getByText("Import labels"));
    view.rerender(<ResearchLabelsImportPanel {...props} selection={{ ...selection, c: 0 }} />); finish(preview);
    await waitFor(() => expect(props.onBusy).toHaveBeenLastCalledWith(null, expect.any(String))); expect(screen.queryByText("Import on this plane")).toBeNull();
  });
  it("does not select a completed import after a document change", async () => {
    let finish!: (value: unknown) => void;
    const { props, execute } = setup(); execute.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const view = render(<ResearchLabelsImportPanel {...props} />); fireEvent.click(screen.getByText("Import labels"));
    fireEvent.click(await screen.findByText("Import on this plane"));
    view.rerender(<ResearchLabelsImportPanel {...props} scope="study-b" />); finish({ result });
    await waitFor(() => expect(props.onBusy).toHaveBeenLastCalledWith(null, expect.any(String))); expect(props.onResult).not.toHaveBeenCalled();
  });
  it("does not select a completed import after another navigation intent even before a render", async () => {
    let finish!: (value: unknown) => void;
    let intent = 1;
    const { props, execute } = setup({ navigationIntent: () => intent });
    execute.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    render(<ResearchLabelsImportPanel {...props} />); fireEvent.click(screen.getByText("Import labels"));
    fireEvent.click(await screen.findByText("Import on this plane")); intent++;
    finish({ result }); await waitFor(() => expect(props.onBusy).toHaveBeenLastCalledWith(null, expect.any(String)));
    expect(props.onResult).not.toHaveBeenCalled();
  });
  it("invalidates a checked preview immediately when plane changes and records declared producer", async () => {
    const { props, execute } = setup(); const view = render(<ResearchLabelsImportPanel {...props} />); fireEvent.click(screen.getByText("Import labels"));
    await screen.findByText("Import on this plane"); fireEvent.change(screen.getByLabelText("Producer version (optional)"), { target: { value: "1.2" } });
    expect(screen.getByText("Import on this plane")).toBeDisabled(); fireEvent.change(screen.getByLabelText("Producer name (optional)"), { target: { value: "External tool" } });
    fireEvent.click(screen.getByText("Import on this plane")); await waitFor(() => expect(execute).toHaveBeenCalledWith("labels_import", expect.objectContaining({ producer: { name: "External tool", version: "1.2" } })));
    view.rerender(<ResearchLabelsImportPanel {...props} selection={{ ...selection, z: 0 }} />); expect(screen.queryByText("Import on this plane")).toBeNull();
  });
  it("shows an empty population without inventing objects", async () => {
    const { props, picker } = setup(); picker.mockResolvedValue({ ...preview, object_count: 0 }); render(<ResearchLabelsImportPanel {...props} />);
    fireEvent.click(screen.getByText("Import labels")); expect(await screen.findByText(/empty population/)).toBeVisible(); expect(screen.getByText("Import on this plane")).toBeEnabled();
  });
  it("rejects a path-like producer before submission and leaves the checked preview intact", async () => {
    const { props, execute } = setup(); render(<ResearchLabelsImportPanel {...props} />);
    fireEvent.click(screen.getByText("Import labels")); await screen.findByText("Import on this plane");
    fireEvent.change(screen.getByLabelText("Producer name (optional)"), { target: { value: "/private/tool" } });
    expect(screen.getByRole("alert")).toHaveTextContent("without file paths"); expect(screen.getByText("Import on this plane")).toBeDisabled();
    expect(execute).not.toHaveBeenCalled(); expect(screen.getByAltText("Checked label overlay on the selected source plane")).toBeVisible();
  });
  it("rejects preview identity mismatches and unsupported grids", () => {
    expect(() => checkedLabelsPreview({ ...preview, source_sha256: "0".repeat(64) }, source, selection, preview.working_bytes)).toThrow(/exact native source plane/);
    expect(() => checkedLabelsPreview({ ...preview, measurement_channel: { ...preview.measurement_channel, index: 0 } }, source, selection, preview.working_bytes)).toThrow();
    expect(labelsImportUnavailable(source, { ...selection, z_stop: 2 })).toMatch(/at least two planes/);
    expect(labelsImportUnavailable({ ...source, metadata: { ...source.metadata, sample_semantics: "rgb" } }, selection)).toMatch(/RGB/);
  });
  it("sends only explicit native-plane keys after leaving a volume", async () => {
    const { props, picker } = setup({ selection: { ...selection, z_stop: undefined } });
    render(<ResearchLabelsImportPanel {...props} />); fireEvent.click(screen.getByText("Import labels"));
    await screen.findByText("Import on this plane");
    expect(Object.keys(picker.mock.calls[0][0].selection).sort()).toEqual(["c", "height", "level", "t", "width", "x", "y", "z"]);
  });
});

describe("exact native volume label import", () => {
  const volumeSource: ResearchSource = { ...source, metadata: { ...source.metadata, dimensions: { ...source.metadata.dimensions!, z: 9 } } };
  const volumeSelection: ResearchSelection = { ...selection, z: 2, z_stop: 7 };
  const volumePreview: ResearchLabelsImportPreview = { ...preview, selection: volumeSelection, axes: "ZYX", shape: [5, 4, 8], profile: "scalar-native-zyx/v1",
    preview: { plane: "XY", index: 2, source_z: 4, selection: { ...selection, z: 4 }, basis: "single-native-plane-overlay" } };
  const volumeResult: ResearchResult = { ...result, selection: volumeSelection };

  it("keeps the explicit Z range, identifies the middle plane and adopts the captured ZYX alignment", async () => {
    const { props, picker, execute } = setup({ source: volumeSource, selection: volumeSelection });
    picker.mockResolvedValue(volumePreview); execute.mockResolvedValue({ result: volumeResult, measurements: [] });
    render(<ResearchLabelsImportPanel {...props} />);
    fireEvent.click(screen.getByText("Import labels"));
    expect(await screen.findByAltText(/middle XY plane, source Z 4/)).toBeVisible();
    expect(screen.getByText("Preview: middle XY plane only · source Z 4 · plane 3 of 5.")).toBeVisible();
    expect(screen.getByText("uint32 · 5 × 4 × 8 ZYX")).toBeVisible();
    expect(picker).toHaveBeenCalledWith(expect.objectContaining({ selection: volumeSelection }));
    fireEvent.click(screen.getByRole("button", { name: "Import on this volume" }));
    await waitFor(() => expect(props.onResult).toHaveBeenCalledWith(volumeResult, [], expect.any(Function)));
    expect(execute).toHaveBeenCalledWith("labels_import", expect.objectContaining({ grant_id: volumePreview.grant_id, alignment: "same-native-zyx-grid" }));
  });
  it.each([
    { axes: "YX" }, { profile: "scalar-native-yx/v1" }, { shape: [4, 8] }, { shape: [4, 5, 8] },
    { preview: undefined },
    { preview: { ...volumePreview.preview!, index: 1 } },
    { preview: { ...volumePreview.preview!, source_z: 2 } },
    { preview: { ...volumePreview.preview!, selection: { ...selection, z: 4, z_stop: 7 } } },
    { preview: { ...volumePreview.preview!, selection: { ...selection, z: 3 } } },
    { preview: { ...volumePreview.preview!, basis: "maximum-projection" } },
  ])("rejects inconsistent volume preview metadata %#", (patch) => {
    expect(() => checkedLabelsPreview({ ...volumePreview, ...patch } as ResearchLabelsImportPreview,
      volumeSource, volumeSelection, preview.working_bytes)).toThrow(/exact native source volume/);
  });
  it("does not accept a volume descriptor for a plane profile", () => {
    expect(() => checkedLabelsPreview({ ...preview, preview: volumePreview.preview }, source, selection, preview.working_bytes)).toThrow(/exact native source plane/);
  });
  it.each([
    { z: 2, z_stop: 3 }, { z: 2, z_stop: 10 }, { z: -1, z_stop: 4 },
    { z: 2, z_stop: 6.5 }, { z: 2, z_stop: Number.NaN },
  ])("rejects invalid volume bounds %# before opening the picker", (range) => {
    const { props, picker } = setup({ source: volumeSource, selection: { ...selection, ...range } });
    render(<ResearchLabelsImportPanel {...props} />);
    expect(screen.getByRole("button", { name: "Import labels" })).toBeDisabled();
    expect(picker).not.toHaveBeenCalled();
  });
  it("discards a late volume preview if the Z extent changes", async () => {
    let finish!: (value: ResearchLabelsImportPreview) => void;
    const { props, picker } = setup({ source: volumeSource, selection: volumeSelection });
    picker.mockReturnValue(new Promise<ResearchLabelsImportPreview>((resolve) => { finish = resolve; }));
    const view = render(<ResearchLabelsImportPanel {...props} />);
    fireEvent.click(screen.getByText("Import labels"));
    view.rerender(<ResearchLabelsImportPanel {...props} selection={{ ...volumeSelection, z_stop: 6 }} />);
    finish(volumePreview);
    await waitFor(() => expect(props.onBusy).toHaveBeenLastCalledWith(null, expect.any(String)));
    expect(screen.queryByRole("button", { name: "Import on this volume" })).toBeNull();
  });
});

describe("offline standalone μSAM handoff", () => {
  const handoffId = "1".repeat(32);
  const otherHandoffId = "2".repeat(32);
  const measurementChannel: ResearchUsamHandoffReceipt["measurement_channel"] = {
    index: 1,
    name: "Raw channel 2",
    basis: "raw-source-channel-values",
  };
  const inputMeta: ResearchUsamHandoffReceipt["input"] = {
    file_name: "input.tif",
    file_sha256: "d".repeat(64),
    file_size_bytes: 512,
    array_sha256: "e".repeat(64),
    dtype: "uint16",
    shape: [4, 8],
    axes: "YX",
    compression: "deflate",
    value_preservation: "exact-original-native-scalar-samples",
  };
  const labelProfile: ResearchUsamHandoffRecord["label_profile"] = {
    profile: "scalar-native-yx/v1",
    alignment: "same-native-yx-grid",
    axes: "YX",
    shape: [4, 8],
    allowed_dtypes: ["uint8", "uint16", "uint32"],
    background_value: 0,
    format: "TIFF",
  };
  const receipt: ResearchUsamHandoffReceipt = {
    schema: "loci.usam-handoff-receipt/v1",
    basename: "Loci-uSAM-plane",
    handoff_id: handoffId,
    manifest_sha256: "f".repeat(64),
    export_origin: "verified-loci-native-export",
    source_id: source.id,
    source_sha256: source.sha256,
    selection,
    measurement_channel: measurementChannel,
    geometry: { axes: "YX", unit: "pixel", frame: "image", affine: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]] },
    calibration: { status: "unknown", unit: "pixel", axes: "YX", spacing: null },
    input: inputMeta,
    label_profile: labelProfile,
    validation: "not-established",
    artifacts: {
      "input.tif": { sha256: "d".repeat(64), size_bytes: 512 },
      "manifest.json": { sha256: "f".repeat(64), size_bytes: 600 },
      "README.md": { sha256: "9".repeat(64), size_bytes: 1200 },
    },
  };
  const matchingRecord: ResearchUsamHandoffRecord = {
    schema: "loci.usam-handoff/v1",
    handoff_id: handoffId,
    export_origin: "verified-loci-native-export",
    source_id: source.id,
    source_sha256: source.sha256,
    source_name: source.name,
    selection,
    measurement_channel: measurementChannel,
    geometry: receipt.geometry,
    calibration: receipt.calibration,
    input: inputMeta,
    label_profile: labelProfile,
    upstream_reference: { tool: "micro-sam", version: "2.0.1", commit: "d45ab70ece93a9eb3ca1e237b9067767b0a18263" },
    validation: "not-established",
    manifest_sha256: receipt.manifest_sha256,
  };
  const mismatchedRecord: ResearchUsamHandoffRecord = {
    ...matchingRecord,
    handoff_id: otherHandoffId,
    source_name: "Other plane",
    selection: { ...selection, z: 0 },
  };
  const boundHandoff: ResearchUsamHandoffBinding = {
    schema: "loci.usam-handoff-binding/v1",
    handoff_id: handoffId,
    manifest_sha256: receipt.manifest_sha256,
    export_identity_basis: "verified-loci-study-handoff",
    binding_source: "manifest-and-study-handoff",
    exported_input_file_sha256: inputMeta.file_sha256,
    exported_input_array_sha256: inputMeta.array_sha256,
    exported_input_dtype: "uint16",
    exported_input_shape: [4, 8],
    exported_input_axes: "YX",
    mask_origin_verified_by_loci: false,
    model_validation: "unknown",
  };
  const boundPreview: ResearchLabelsImportPreview = {
    ...preview,
    handoff: boundHandoff,
  };

  function setupUsam(overrides: Partial<Parameters<typeof ResearchLabelsImportPanel>[0]> = {}) {
    const execute = vi.fn().mockResolvedValue({ result, measurements: [] });
    const picker = vi.fn().mockResolvedValue(boundPreview);
    const exportUsamHandoff = vi.fn().mockResolvedValue(receipt);
    const listUsamHandoffs = vi.fn().mockResolvedValue([matchingRecord]);
    const props = {
      api: { execute, labelsImportPreview: picker, exportUsamHandoff, listUsamHandoffs } as unknown as ResearchDesktopApi,
      source,
      selection,
      workingBytes: preview.working_bytes,
      scope: "study-a",
      busy: false,
      onBusy: vi.fn(),
      onResult: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
    return { props, execute, picker, exportUsamHandoff, listUsamHandoffs };
  }

  it("keeps μSAM (standalone) collapsed by default and exports path-free native TIFF without auto-launching", async () => {
    const { props, exportUsamHandoff, listUsamHandoffs } = setupUsam();
    render(<ResearchLabelsImportPanel {...props} />);
    const summary = screen.getByText("μSAM (standalone)");
    const details = summary.closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(screen.getByRole("button", { name: "Import labels" })).toBeVisible();

    fireEvent.click(summary);
    await waitFor(() => expect(listUsamHandoffs).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole("button", { name: "Export native TIFF for μSAM" }));
    expect(await screen.findByText(/Loci-uSAM-plane/)).toBeVisible();
    expect(screen.getByText(/README explains how to save YX labels/)).toBeVisible();
    expect(exportUsamHandoff).toHaveBeenCalledWith({
      source_id: source.id,
      source_sha256: source.sha256,
      selection,
      working_bytes: preview.working_bytes,
    });
  });

  it("disables μSAM export on derived sources while leaving generic Import labels enabled", () => {
    const derivedSource: ResearchSource = { ...source, derivation: { kind: "vendor-derived" } };
    const { props, exportUsamHandoff } = setupUsam({ source: derivedSource });
    render(<ResearchLabelsImportPanel {...props} />);
    fireEvent.click(screen.getByText("μSAM (standalone)"));
    expect(screen.getByRole("button", { name: "Export native TIFF for μSAM" })).toBeDisabled();
    expect(screen.getByText(/derived sources cannot export a μSAM handoff/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Import labels" })).toBeEnabled();
    expect(exportUsamHandoff).not.toHaveBeenCalled();
  });

  it("supports saved cross-session handoff selection, mismatch gating, and manifest return", async () => {
    const { props, picker, listUsamHandoffs } = setupUsam();
    listUsamHandoffs.mockResolvedValue([mismatchedRecord, matchingRecord]);
    render(<ResearchLabelsImportPanel {...props} />);
    fireEvent.click(screen.getByText("μSAM (standalone)"));
    const select = await screen.findByLabelText("Saved μSAM handoff");
    await waitFor(() => expect((select as HTMLSelectElement).value).toBe(handoffId));

    const returnSelected = screen.getByRole("button", { name: "Return labels for selected handoff" });
    expect(returnSelected).toBeEnabled();

    fireEvent.change(select, { target: { value: otherHandoffId } });
    expect(returnSelected).toBeDisabled();
    expect(screen.getByText(/Select the source, time, channel and Z range/)).toBeVisible();

    fireEvent.change(select, { target: { value: handoffId } });
    expect(returnSelected).toBeEnabled();
    fireEvent.click(returnSelected);
    await waitFor(() => expect(picker).toHaveBeenCalledWith({
      source_id: source.id,
      source_sha256: source.sha256,
      selection,
      working_bytes: preview.working_bytes,
      handoff_id: handoffId,
    }));

    fireEvent.click(screen.getByRole("button", { name: "Return labels with manifest…" }));
    await waitFor(() => expect(picker).toHaveBeenCalledWith({
      source_id: source.id,
      source_sha256: source.sha256,
      selection,
      working_bytes: preview.working_bytes,
      use_handoff_manifest: true,
    }));
  });

  it("separates verified Loci export from user-declared mask origin, validates model details, and resets declared fields", async () => {
    const { props, execute, picker } = setupUsam();
    const view = render(<ResearchLabelsImportPanel {...props} />);
    fireEvent.click(screen.getByText("μSAM (standalone)"));
    fireEvent.click(screen.getByRole("button", { name: "Return labels with manifest…" }));

    await screen.findByText("Verified Loci export");
    expect(screen.getByText(/Declared by the researcher. Model validation is unknown/)).toBeVisible();
    expect(screen.getByLabelText("Producer name (optional)")).toHaveValue("");
    expect(screen.getByLabelText("Model (optional)")).not.toBeVisible();
    fireEvent.click(screen.getByText("External model details (optional, user-declared)"));
    fireEvent.change(screen.getByLabelText("Producer name (optional)"), { target: { value: "micro-sam" } });

    fireEvent.change(screen.getByLabelText("Checkpoint digest (optional)"), { target: { value: "not-a-digest" } });
    expect(screen.getByRole("alert")).toHaveTextContent(/sha256:<64 hex>, xxh128:<32 hex>/);
    expect(screen.getByRole("button", { name: "Import on this plane" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Checkpoint (optional)"), { target: { value: "/private/weights.pt" } });
    expect(screen.getByRole("alert")).toHaveTextContent(/without file paths/);

    fireEvent.change(screen.getByLabelText("Producer version (optional)"), { target: { value: "2.0.1" } });
    fireEvent.change(screen.getByLabelText("Model (optional)"), { target: { value: "hvit_t_cells" } });
    fireEvent.change(screen.getByLabelText("Mode (optional)"), { target: { value: "ais-sparse" } });
    fireEvent.change(screen.getByLabelText("Checkpoint (optional)"), { target: { value: "hvit_t_cells_v2" } });
    fireEvent.change(screen.getByLabelText("Checkpoint digest (optional)"), { target: { value: `xxh128:${"ab".repeat(16)}` } });

    const importBtn = screen.getByRole("button", { name: "Import on this plane" });
    expect(importBtn).toBeEnabled();
    fireEvent.click(importBtn);

    await waitFor(() => expect(execute).toHaveBeenCalledWith("labels_import", {
      source_id: source.id,
      source_sha256: source.sha256,
      grant_id: boundPreview.grant_id,
      alignment: "same-native-yx-grid",
      producer: {
        name: "micro-sam",
        version: "2.0.1",
        model: "hvit_t_cells",
        mode: "ais-sparse",
        checkpoint: "hvit_t_cells_v2",
        checkpoint_digest: `xxh128:${"ab".repeat(16)}`,
      },
    }));

    // After adopt, re-opening a preview starts with cleared user-declared fields.
    picker.mockResolvedValueOnce(boundPreview);
    fireEvent.click(screen.getByRole("button", { name: "Return labels with manifest…" }));
    await screen.findByText("Discard preview");
    expect(screen.getByLabelText("Producer version (optional)")).toHaveValue("");
    expect(screen.getByLabelText("Model (optional)")).toHaveValue("");
    expect(screen.getByLabelText("Mode (optional)")).toHaveValue("");
    expect(screen.getByLabelText("Checkpoint (optional)")).toHaveValue("");
    expect(screen.getByLabelText("Checkpoint digest (optional)")).toHaveValue("");

    // Changing declared fields and discarding or changing view resets them too.
    fireEvent.change(screen.getByLabelText("Model (optional)"), { target: { value: "hvit_b_lm" } });
    fireEvent.click(screen.getByText("Discard preview"));
    picker.mockResolvedValueOnce(boundPreview);
    fireEvent.click(screen.getByRole("button", { name: "Return labels with manifest…" }));
    await screen.findByText("Discard preview");
    expect(screen.getByLabelText("Model (optional)")).toHaveValue("");

    view.rerender(<ResearchLabelsImportPanel {...props} selection={{ ...selection, c: 0 }} />);
    expect(screen.queryByText("Verified Loci export")).toBeNull();
  });

  it("discards late export receipts on binding or navigation intent changes and surfaces actionable signed-dtype errors", async () => {
    let resolveExport!: (value: ResearchUsamHandoffReceipt) => void;
    let intent = 1;
    const { props, exportUsamHandoff, picker } = setupUsam({ navigationIntent: () => intent });
    exportUsamHandoff.mockReturnValue(new Promise<ResearchUsamHandoffReceipt>((resolve) => { resolveExport = resolve; }));

    const view = render(<ResearchLabelsImportPanel {...props} />);
    fireEvent.click(screen.getByText("μSAM (standalone)"));
    fireEvent.click(screen.getByRole("button", { name: "Export native TIFF for μSAM" }));
    intent++;
    resolveExport(receipt);
    await waitFor(() => expect(props.onBusy).toHaveBeenLastCalledWith(null, expect.any(String)));
    expect(screen.queryByText(/README explains how to save/)).toBeNull();

    let resolveBindingExport!: (value: ResearchUsamHandoffReceipt) => void;
    exportUsamHandoff.mockReturnValue(new Promise<ResearchUsamHandoffReceipt>((resolve) => { resolveBindingExport = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "Export native TIFF for μSAM" }));
    view.rerender(<ResearchLabelsImportPanel {...props} scope="study-b" navigationIntent={() => intent} />);
    resolveBindingExport(receipt);
    await waitFor(() => expect(props.onBusy).toHaveBeenLastCalledWith(null, expect.any(String)));
    expect(screen.queryByText(/README explains how to save/)).toBeNull();

    picker.mockRejectedValueOnce(new Error("Label TIFF uses signed dtype int16; export uint8, uint16 or uint32 labels without implicit conversion."));
    fireEvent.click(screen.getByRole("button", { name: "Return labels with manifest…" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/uint8, uint16 or uint32.*without implicit conversion/);
  });
});
