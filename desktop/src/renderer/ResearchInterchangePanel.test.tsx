// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ResearchDesktopApi,
  ResearchResult,
} from "../shared/research-contracts";
import { ResearchInterchangePanel } from "./ResearchInterchangePanel";

afterEach(cleanup);

const parent: ResearchResult = {
  id: "a".repeat(32),
  source_id: "b".repeat(32),
  source_sha256: "c".repeat(64),
  kind: "processed",
  created_at: "now",
  revision_hash: "d".repeat(64),
  object_count: 0,
  parent_id: null,
  review: { disposition: "reviewed" },
};
const child: ResearchResult = {
  ...parent,
  id: "e".repeat(32),
  kind: "annotated-result",
  parent_id: parent.id,
  revision_hash: "f".repeat(64),
  review: null,
};
const info = {
  result_id: parent.id,
  revision_hash: parent.revision_hash,
  measurement_channels: [
    { index: 0, name: "DAPI", basis: "raw-source-channel-values" },
    { index: 1, name: "Marker", basis: "raw-source-channel-values" },
  ],
};

function api(execute: ResearchDesktopApi["execute"]): ResearchDesktopApi {
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

const report = async <T,>(work: () => Promise<T>) => work();

function file(
  name: string,
  contents: string | Uint8Array,
): File & {
  text: () => Promise<string>;
  arrayBuffer: () => Promise<ArrayBuffer>;
} {
  const bytes =
    typeof contents === "string"
      ? new TextEncoder().encode(contents)
      : contents;
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const value = new File([copy.buffer], name);
  Object.defineProperties(value, {
    text: { value: () => Promise.resolve(new TextDecoder().decode(bytes)) },
    arrayBuffer: {
      value: () => Promise.resolve(bytes.buffer.slice(0) as ArrayBuffer),
    },
  });
  return value as File & {
    text: () => Promise<string>;
    arrayBuffer: () => Promise<ArrayBuffer>;
  };
}

describe("ResearchInterchangePanel", () => {
  it("keeps method and review visible with the full exact target in a selectable disclosure", async () => {
    const target = { ...parent, method_label: "Classical segmentation" };
    render(<ResearchInterchangePanel api={api(vi.fn(async () => info))} result={target}
      report={report} busy={false} onBusyChange={vi.fn()} onResult={vi.fn()} />);
    await screen.findByText("DAPI");
    expect(screen.getByText("Classical segmentation · reviewed")).toBeVisible();
    const summary = screen.getByText("Technical identity", { selector: "summary" });
    expect(screen.getByText(parent.revision_hash)).not.toBeVisible();
    expect(screen.getByText(parent.source_id)).not.toBeVisible();
    summary.focus();
    expect(summary).toHaveFocus();
    fireEvent.click(summary);
    for (const value of [parent.id, parent.revision_hash, parent.source_id, parent.source_sha256!]) {
      const code = screen.getByText(value, { selector: "code" });
      expect(code).toBeVisible();
      expect(code.textContent).toBe(value);
    }
    expect(screen.getByText(/must match this source, result revision/)).toBeVisible();
    expect(screen.getByText(/Review the new revision before/)).toBeVisible();
  });

  it.each([
    { ...info, result_id: "0".repeat(32) },
    { ...info, revision_hash: "0".repeat(64) },
  ])("rejects channels whose exact target binding is stale: %j", async (staleInfo) => {
    const execute = vi.fn(async () => staleInfo);
    render(<ResearchInterchangePanel api={api(execute)} result={parent}
      report={report} busy={false} onBusyChange={vi.fn()} onResult={vi.fn()} />);
    expect(await screen.findByRole("status")).toHaveTextContent("Could not bind annotation import to this exact revision.");
    fireEvent.change(screen.getByLabelText("Annotation file"), { target: { files: [file("region.geojson", "{}")] } });
    expect(screen.queryByLabelText("Measure DAPI")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import into new revision" })).toBeDisabled();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("clears the previous target's file and ignores its late channels before importing into the new exact target", async () => {
    let resolvePrevious!: (value: typeof info) => void;
    const previousInfo = new Promise<typeof info>((resolve) => { resolvePrevious = resolve; });
    const next = { ...parent, id: "1".repeat(32), source_id: "2".repeat(32), source_sha256: "3".repeat(64), revision_hash: "4".repeat(64), review: null };
    const nextChild = { ...next, id: "5".repeat(32), parent_id: next.id, revision_hash: "6".repeat(64) };
    const execute = vi.fn((operation: string, request: Record<string, unknown>) => {
      if (operation === "correction_info") return request.result_id === parent.id ? previousInfo : Promise.resolve({
        result_id: next.id, revision_hash: next.revision_hash,
        measurement_channels: [{ index: 2, name: "New source channel", basis: "raw-source-channel-values" }],
      });
      return Promise.resolve({ result: nextChild });
    });
    const bridge = api(execute);
    const onResult = vi.fn();
    const properties = { api: bridge, report, busy: false, onBusyChange: vi.fn(), onResult };
    const { rerender } = render(<ResearchInterchangePanel {...properties} result={parent} />);
    fireEvent.change(screen.getByLabelText("Annotation file"), { target: { files: [file("old.geojson", "old payload")] } });
    rerender(<ResearchInterchangePanel {...properties} result={next} />);
    await screen.findByText("New source channel");
    await act(async () => { resolvePrevious(info); await previousInfo; });
    expect(screen.queryByLabelText("Measure DAPI")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import into new revision" })).toBeDisabled();
    expect(screen.getByText(next.revision_hash, { selector: "code" }).textContent).toBe(next.revision_hash);
    expect(screen.queryByText(parent.revision_hash, { selector: "code" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Annotation file"), { target: { files: [file("new.geojson", "new payload")] } });
    fireEvent.click(screen.getByRole("button", { name: "Import into new revision" }));
    await waitFor(() => expect(execute).toHaveBeenCalledWith("roi_import", {
      result_id: next.id, revision_hash: next.revision_hash, format: "geojson", payload: "new payload", measurement_channels: [2],
    }));
    expect(onResult).toHaveBeenCalledWith(nextChild);
  });

  it("imports exact GeoJSON text with explicit measurement channels", async () => {
    const execute = vi.fn((operation: string) =>
      Promise.resolve(
        operation === "correction_info" ? info : { result: child },
      ),
    );
    const onResult = vi.fn();
    render(
      <ResearchInterchangePanel
        api={api(execute)}
        result={parent}
        report={report}
        busy={false}
        onBusyChange={vi.fn()}
        onResult={onResult}
      />,
    );
    await screen.findByText("DAPI");
    fireEvent.click(screen.getByLabelText("Measure Marker"));
    const payload = '{"type":"Feature","properties":{},"geometry":{}}';
    fireEvent.change(screen.getByLabelText("Annotation file"), {
      target: { files: [file("polygon.geojson", payload)] },
    });
    fireEvent.click(screen.getByText("Import into new revision"));
    await waitFor(() =>
      expect(execute).toHaveBeenCalledWith("roi_import", {
        result_id: parent.id,
        revision_hash: parent.revision_hash,
        format: "geojson",
        payload,
        measurement_channels: [0, 1],
      }),
    );
    expect(onResult).toHaveBeenCalledWith(child);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "new unreviewed revision",
    );
  });

  it("auto-selects ImageJ ROI and sends canonical base64", async () => {
    const execute = vi.fn((operation: string) =>
      Promise.resolve(
        operation === "correction_info" ? info : { result: child },
      ),
    );
    render(
      <ResearchInterchangePanel
        api={api(execute)}
        result={parent}
        report={report}
        busy={false}
        onBusyChange={vi.fn()}
        onResult={vi.fn()}
      />,
    );
    await screen.findByText("DAPI");
    fireEvent.change(screen.getByLabelText("Annotation file"), {
      target: { files: [file("region.roi", new Uint8Array([1, 2, 3, 254]))] },
    });
    expect(screen.getByLabelText("Annotation format")).toHaveValue("imagej");
    fireEvent.click(screen.getByText("Import into new revision"));
    await waitFor(() =>
      expect(execute).toHaveBeenCalledWith(
        "roi_import",
        expect.objectContaining({ format: "imagej", payload: "AQID/g==" }),
      ),
    );
  });

  it("requires an exact result and at least one channel", async () => {
    const execute = vi.fn(() => Promise.resolve(info));
    const { rerender } = render(
      <ResearchInterchangePanel
        api={api(execute)}
        result={null}
        report={report}
        busy={false}
        onBusyChange={vi.fn()}
        onResult={vi.fn()}
      />,
    );
    expect(screen.getByText(/Select an exact result/)).toBeVisible();
    rerender(
      <ResearchInterchangePanel
        api={api(execute)}
        result={parent}
        report={report}
        busy={false}
        onBusyChange={vi.fn()}
        onResult={vi.fn()}
      />,
    );
    await screen.findByText("DAPI");
    fireEvent.click(screen.getByLabelText("Measure DAPI"));
    fireEvent.change(screen.getByLabelText("Annotation file"), {
      target: { files: [file("polygon.geojson", "{}")] },
    });
    expect(screen.getByText("Import into new revision")).toBeDisabled();
  });
});
