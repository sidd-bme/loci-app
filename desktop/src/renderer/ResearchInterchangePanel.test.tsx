// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
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
