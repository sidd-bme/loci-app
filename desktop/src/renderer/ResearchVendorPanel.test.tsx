// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ResearchDesktopApi,
  ResearchSnapshot,
} from "../shared/research-contracts";
import { ResearchVendorPanel } from "./ResearchVendorPanel";

afterEach(cleanup);

const sourceHash = "a".repeat(64);
const jarHash = "b".repeat(64);
const javaHash = "c".repeat(64);
const artifactHash = "d".repeat(64);
const pixelHash = "e".repeat(64);
const snapshot: ResearchSnapshot = {
  project: { title: "Vendor study" },
  sources: [], results: [], samples: [], recipes: [], displays: [],
  selections: [], jobs: [], operations: {},
};
const importedSnapshot: ResearchSnapshot = {
  ...snapshot,
  sources: [{
    id: "f".repeat(32),
    name: "derived.ome.tif",
    sha256: artifactHash,
    metadata: {},
  }],
};
const inspection = {
  grant_id: "grant-1234",
  source_name: "sample.czi",
  source_sha256: sourceHash,
  inspection: {
    schema_version: "loci.vendor-inspection/v1",
    format: "czi",
    source_size_bytes: 123_456,
    source_sha256: sourceHash,
    series: [
      {
        index: 0,
        dimensions: { x: 100, y: 80, z: 3, c: 2, t: 4 },
        dimension_order: "XYZCT",
        dtype: "uint16",
        channel_names: ["DAPI", "RGB preview"],
        samples_per_channel: [1, 3],
        calibration: {
          x: { value: 0.5, unit: "µm" },
          y: { value: 0.75, unit: "µm" },
        },
      },
      {
        index: 1,
        dimensions: { x: 20, y: 10, z: 1, c: 1, t: 1 },
        dimension_order: "XYCZT",
        dtype: "float32",
        channel_names: ["Signal"],
        samples_per_channel: [1],
        calibration: null,
      },
    ],
    runtime: {
      bioformats_version: "8.5.0",
      bioformats_jar_sha256: jarHash,
      bioformats_jar_size_bytes: 53_843_906,
      java_sha256: javaHash,
      java_version: 'openjdk version "21.0.2"',
    },
  },
};
const converted = {
  snapshot: importedSnapshot,
  conversion: {
    schema_version: "loci.vendor-conversion-receipt/v1",
    source_sha256: sourceHash,
    bioformats_jar_sha256: jarHash,
    artifact: {
      filename: "image.ome.tif",
      sha256: artifactHash,
      pixel_sha256: pixelHash,
    },
  },
};

function bridge(inspectVendor: () => Promise<unknown>, convertVendor = vi.fn()) {
  return {
    createStudy: vi.fn(), openStudy: vi.fn(), getSnapshot: vi.fn(),
    addSources: vi.fn(), execute: vi.fn(), reviewResult: vi.fn(),
    exportResult: vi.fn(), cancelJob: vi.fn(), inspectVendor, convertVendor,
  } as unknown as ResearchDesktopApi;
}

type Report = ComponentProps<typeof ResearchVendorPanel>["report"];
const defaultReport: Report = async <T,>(work: () => Promise<T>) => {
  try { return await work(); } catch { return undefined; }
};

function renderPanel(
  api: ResearchDesktopApi,
  report: Report = defaultReport,
) {
  const onSnapshot = vi.fn();
  const onBusyChange = vi.fn();
  render(
    <ResearchVendorPanel
      api={api}
      snapshot={snapshot}
      report={report}
      busy={false}
      onBusyChange={onBusyChange}
      onSnapshot={onSnapshot}
    />,
  );
  return { onSnapshot, onBusyChange, report };
}

describe("ResearchVendorPanel", () => {
  it("binds one explicit crop and bounded runtime to the inspected source grant", async () => {
    const inspectVendor = vi.fn().mockResolvedValue(inspection);
    const convertVendor = vi.fn().mockResolvedValue(converted);
    const { onSnapshot } = renderPanel(bridge(inspectVendor, convertVendor));

    fireEvent.click(screen.getByText("Choose vendor image…"));
    expect(await screen.findByLabelText("Exact vendor inspection")).toHaveTextContent("sample.czi");
    expect(screen.getByLabelText("Exact vendor inspection")).toHaveTextContent("8.5.0");
    expect(screen.getByLabelText("Vendor selection")).toHaveTextContent("100×80");
    expect(document.body).not.toHaveTextContent("/private/");

    fireEvent.change(screen.getByLabelText("Vendor scope"), { target: { value: "plane" } });
    fireEvent.change(screen.getByLabelText("Vendor channel"), { target: { value: "1" } });
    expect(screen.getByText(/multiple RGB samples/)).toBeVisible();
    expect(screen.getByText("Convert and import plane")).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Vendor channel"), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("Vendor Z index"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Vendor T index"), { target: { value: "3" } });
    fireEvent.click(screen.getByLabelText("Crop vendor plane"));
    fireEvent.change(screen.getByLabelText("Vendor crop X"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("Vendor crop Y"), { target: { value: "20" } });
    fireEvent.change(screen.getByLabelText("Vendor crop width"), { target: { value: "30" } });
    fireEvent.change(screen.getByLabelText("Vendor crop height"), { target: { value: "24" } });
    fireEvent.change(screen.getByLabelText("Vendor heap MiB"), { target: { value: "1024" } });
    fireEvent.change(screen.getByLabelText("Vendor timeout seconds"), { target: { value: "600" } });
    fireEvent.change(screen.getByLabelText("Vendor maximum output MiB"), { target: { value: "64" } });
    fireEvent.click(screen.getByText("Convert and import plane"));

    await waitFor(() => expect(convertVendor).toHaveBeenCalledWith({
      grant_id: inspection.grant_id,
      series: 0,
      c: 0,
      z: 2,
      t: 3,
      crop: { x: 10, y: 20, width: 30, height: 24 },
      heap_mib: 1024,
      timeout_seconds: 600,
      max_output_bytes: 64 * 1024 ** 2,
    }));
    expect(onSnapshot).toHaveBeenCalledWith(importedSnapshot);
    const conversionReceipt = await screen.findByLabelText("Vendor conversion receipt");
    expect(conversionReceipt).toHaveTextContent("image.ome.tif added to the study.");
    const fingerprint = within(conversionReceipt).getByText(artifactHash);
    expect(fingerprint).not.toBeVisible();
    fireEvent.click(within(conversionReceipt).getByText("Technical record"));
    expect(fingerprint).toBeVisible();
    expect(within(conversionReceipt).getByText(pixelHash)).toBeVisible();
  });

  it("previews the full series and binds an inclusive range to exclusive worker stops", async () => {
    const grant = structuredClone(inspection);
    grant.inspection.series[0].samples_per_channel = [1, 1];
    const convertVendor = vi.fn().mockResolvedValue(null);
    renderPanel(bridge(vi.fn().mockResolvedValue(grant), convertVendor));
    fireEvent.click(screen.getByText("Choose vendor image…"));
    const preview = await screen.findByLabelText("Vendor output preview");
    expect(preview).toHaveTextContent("TCZYX · 4 × 2 × 3 × 80 × 100 · uint16 · 24 planes · 375.0 KiB");
    expect(screen.getByLabelText("Vendor heap MiB")).not.toBeVisible();
    fireEvent.change(screen.getByLabelText("Vendor scope"), { target: { value: "range" } });
    fireEvent.change(screen.getByLabelText("Vendor T index"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Vendor last T"), { target: { value: "0" } });
    expect(screen.getByText("Convert and import stack")).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Vendor last T"), { target: { value: "2" } });
    expect(preview).toHaveTextContent("2 × 2 × 3 × 80 × 100");
    fireEvent.click(screen.getByText("Convert and import stack"));
    await waitFor(() => expect(convertVendor).toHaveBeenCalledWith(expect.objectContaining({
      series: 0, c: 0, z: 0, t: 1, end_exclusive: { c: 2, z: 3, t: 3 },
    })));
  });

  it("requires matching acquisition evidence and scope before adopting a whole-series receipt", async () => {
    const grant = structuredClone(inspection);
    grant.inspection.series[0].samples_per_channel = [1, 1];
    const receipt = {
      ...converted.conversion, schema_version: "loci.vendor-conversion-receipt/v3",
      runtime: grant.inspection.runtime,
      selection: { series: 0, c: 0, z: 0, t: 0, end_exclusive: { c: 2, z: 3, t: 4 }, crop_xywh: [0, 0, 100, 80] },
      artifact: { ...converted.conversion.artifact, axes: "TCZYX", dtype: "uint16", shape: [4, 2, 3, 80, 100],
        acquisition: { planes_with_delta_t: 0, planes_with_stage_position: 0, stage_position_anchor: "unspecified", native_plane_metadata_sha256: "e".repeat(64) },
      },
    };
    const convertVendor = vi.fn()
      .mockResolvedValueOnce({ ...converted, conversion: { ...receipt, artifact: { ...receipt.artifact, acquisition: null } } })
      .mockResolvedValueOnce({ ...converted, conversion: { ...receipt, selection: { ...receipt.selection, z: 1 } } })
      .mockResolvedValueOnce({ ...converted, conversion: receipt });
    const { onSnapshot, onBusyChange } = renderPanel(bridge(vi.fn().mockResolvedValue(grant), convertVendor));
    fireEvent.click(screen.getByText("Choose vendor image…"));
    const button = await screen.findByText("Convert and import stack");
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeEnabled());
    expect(onSnapshot).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeEnabled());
    expect(onSnapshot).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledWith(importedSnapshot));
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it("discards the previous grant before a cancelled replacement inspection", async () => {
    const inspectVendor = vi.fn()
      .mockResolvedValueOnce(inspection)
      .mockResolvedValueOnce(null);
    renderPanel(bridge(inspectVendor));
    fireEvent.click(screen.getByText("Choose vendor image…"));
    await screen.findByLabelText("Exact vendor inspection");

    fireEvent.click(screen.getByText("Choose vendor image…"));
    await waitFor(() => expect(screen.queryByLabelText("Exact vendor inspection")).not.toBeInTheDocument());
    expect(await screen.findByRole("status")).toHaveTextContent("cancelled");
    expect(screen.queryByText(sourceHash)).not.toBeInTheDocument();
  });

  it("routes inspection and conversion failures through the shared report boundary", async () => {
    const inspectError = new Error("reader failed");
    const inspectVendor = vi.fn().mockRejectedValue(inspectError);
    const reportMock = vi.fn(async (work: () => Promise<unknown>) => {
      try { return await work(); } catch { return undefined; }
    });
    const report = reportMock as unknown as Report;
    renderPanel(bridge(inspectVendor), report);
    fireEvent.click(screen.getByText("Choose vendor image…"));
    await waitFor(() => expect(reportMock).toHaveBeenCalledWith(
      expect.any(Function),
      "Could not inspect the selected vendor source with the approved local reader.",
    ));

    cleanup();
    const convertVendor = vi.fn().mockRejectedValue(new Error("conversion failed"));
    const rendered = renderPanel(bridge(vi.fn().mockResolvedValue(inspection), convertVendor), report);
    fireEvent.click(screen.getByText("Choose vendor image…"));
    await screen.findByLabelText("Exact vendor inspection");
    fireEvent.change(screen.getByLabelText("Vendor scope"), { target: { value: "plane" } });
    fireEvent.click(screen.getByText("Convert and import plane"));
    await waitFor(() => expect(reportMock).toHaveBeenCalledWith(
      expect.any(Function),
      "Could not convert and import the selected vendor data.",
    ));
    expect(rendered.onSnapshot).not.toHaveBeenCalled();
  });

  it("does not adopt a delayed conversion after its exact form fingerprint changes", async () => {
    let resolve!: (value: unknown) => void;
    const convertVendor = vi.fn(() => new Promise((done) => { resolve = done; }));
    const { onSnapshot } = renderPanel(
      bridge(vi.fn().mockResolvedValue(inspection), convertVendor),
    );
    fireEvent.click(screen.getByText("Choose vendor image…"));
    await screen.findByLabelText("Exact vendor inspection");
    fireEvent.change(screen.getByLabelText("Vendor scope"), { target: { value: "plane" } });
    fireEvent.click(screen.getByText("Convert and import plane"));
    expect(screen.getByLabelText("Vendor Z index")).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Vendor Z index"), { target: { value: "1" } });
    await act(async () => {
      resolve(converted);
      await Promise.resolve();
    });
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Vendor conversion receipt")).not.toBeInTheDocument();
  });
});
