// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ResearchWorkbench from "./ResearchWorkbench";
import type {
  ResearchDesktopApi,
  ResearchSnapshot,
} from "../shared/research-contracts";

let canvasContext: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  canvasContext = Object.fromEntries(
    [
      "setTransform",
      "fillRect",
      "clearRect",
      "scale",
      "drawImage",
      "beginPath",
      "moveTo",
      "lineTo",
      "closePath",
      "arc",
      "stroke",
      "fillText",
      "setLineDash",
      "save",
      "restore",
      "ellipse",
      "fill",
    ].map((name) => [name, vi.fn()]),
  );
  canvasContext.createRadialGradient = vi.fn(() => ({
    addColorStop: vi.fn(),
  }));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    canvasContext as unknown as CanvasRenderingContext2D,
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function createSnapshot(sourceNames = ["Specimen_A.tif", "Specimen_B.tif", "Specimen_C.tif"]): ResearchSnapshot {
  const sources = sourceNames.map((name, i) => ({
    id: `src-${i + 1}`,
    sha256: `sha-${i + 1}`.repeat(8),
    name,
    source_kind: "native" as const,
    metadata: {
      axes: "CZYX",
      dimensions: { t: 1, c: 2, z: 1, y: 100, x: 100, s: 1 },
      channel_dtypes: ["uint8", "uint8"],
      sample_semantics: "none",
    },
  }));

  return {
    project: {
      title: "Source Lookup Test Project",
    },
    sources,
    results: [],
    jobs: [],
    samples: [],
    recipes: [],
    displays: [],
    selections: [],
    workspace: { revision: 0, closed_sources: [], hidden_results: [] },
    operations: {
      view: { mutates: false, summary: "view" },
    },
  };
}

function mockApi(snapshotToUse: ResearchSnapshot): ResearchDesktopApi {
  return {
    getSnapshot: vi.fn(async () => snapshotToUse),
    execute: vi.fn(async (op: string) => {
      if (op === "viewer_defaults") {
        return {
          source_id: snapshotToUse.sources[0]?.id,
          source_sha256: snapshotToUse.sources[0]?.sha256,
          basis: "Source acquisition range",
          channels: [
            { channel: 0, low: 0, high: 255, gamma: 1, color: "#0000ff", opacity: 1, visible: true },
          ],
        };
      }
      if (op === "source_view") {
        return { source_id: snapshotToUse.sources[0]?.id, revision: 0, state: null };
      }
      if (op === "source_annotations") {
        return { source_id: snapshotToUse.sources[0]?.id, revision: 0, annotations: [], can_undo: false, can_redo: false };
      }
      return {};
    }),
    reorderSources: vi.fn(async () => {}),
  } as unknown as ResearchDesktopApi;
}

describe("ResearchWorkbench source DOM lookup and wrapper tolerance", () => {
  it("locates source items regardless of intermediate DOM wrappers", async () => {
    const names = ["Alpha.tif", "Beta.tif", "Gamma.tif"];
    const snapshot = createSnapshot(names);
    const api = mockApi(snapshot);

    const { container } = render(<ResearchWorkbench api={api} onBack={() => {}} />);

    await waitFor(() => {
      expect(
        container.querySelectorAll(".research-sources .research-source-name").length,
      ).toBe(names.length);
    });

    // The legacy brittle direct-child selector fails because of .research-sources-list and .research-source-name-row
    const legacyDirectChildElements = container.querySelectorAll(
      ".research-sources > button > .research-source-name",
    );
    expect(legacyDirectChildElements.length).toBe(0);

    // The hardened resilient selector correctly matches all source names
    const resilientNameElements = container.querySelectorAll(
      ".research-sources button[data-source-id] .research-source-name",
    );
    expect(resilientNameElements.length).toBe(names.length);

    // Verify each button has the data-source-id attribute and correct text
    const buttons = container.querySelectorAll<HTMLButtonElement>(
      ".research-sources button[data-source-id]",
    );
    expect(buttons.length).toBe(names.length);
    buttons.forEach((button, idx) => {
      expect(button.getAttribute("data-source-id")).toBe(`src-${idx + 1}`);
      expect(button.querySelector(".research-source-name")?.textContent).toBe(names[idx]);
    });
  });

  it("fails lookup predictably when a source is missing or not rendered", async () => {
    const snapshot = createSnapshot(["Present.tif"]);
    const api = mockApi(snapshot);

    const { container } = render(<ResearchWorkbench api={api} onBack={() => {}} />);

    await waitFor(() => {
      expect(
        container.querySelectorAll(".research-sources .research-source-name").length,
      ).toBe(1);
    });

    const missingButton = container.querySelector(
      '.research-sources button[data-source-id="src-nonexistent"]',
    );
    expect(missingButton).toBeNull();

    const missingName = Array.from(
      container.querySelectorAll(".research-sources .research-source-name"),
    ).find((el) => el.textContent === "Absent.tif");
    expect(missingName).toBeUndefined();
  });

  it("distinguishes individual buttons even when sources have duplicate names", async () => {
    const names = ["Duplicate.tif", "Duplicate.tif"];
    const snapshot = createSnapshot(names);
    const api = mockApi(snapshot);

    const { container } = render(<ResearchWorkbench api={api} onBack={() => {}} />);

    await waitFor(() => {
      expect(container.querySelectorAll(".research-sources .research-source-name").length).toBe(2);
    });

    const buttons = container.querySelectorAll<HTMLButtonElement>(
      ".research-sources button[data-source-id]",
    );
    expect(buttons.length).toBe(2);
    // Distinct IDs must be preserved
    expect(buttons[0].getAttribute("data-source-id")).toBe("src-1");
    expect(buttons[1].getAttribute("data-source-id")).toBe("src-2");
  });
});
