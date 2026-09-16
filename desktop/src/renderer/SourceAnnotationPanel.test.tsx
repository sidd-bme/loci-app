// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ResearchDesktopApi,
  ResearchSelection,
  ResearchSource,
} from "../shared/research-contracts";
import { serializeTransectsCsv, SourceAnnotationPanel } from "./SourceAnnotationPanel";

afterEach(cleanup);

const sources: ResearchSource[] = ["a", "c"].map((value, index) => ({
  id: value.repeat(32),
  name: `Source ${index + 1}`,
  sha256: String(index + 1).repeat(64),
  metadata: {
    dimensions: { t: 1, c: 1, z: 1, y: 48, x: 64 },
  },
}));
const selection: ResearchSelection = {
  x: 2,
  y: 3,
  width: 20,
  height: 16,
  t: 0,
  c: 0,
  z: 0,
  level: 0,
};

function receipt(source: ResearchSource, revision = 4, annotations: unknown[] = []) {
  return {
    source_id: source.id,
    source_sha256: source.sha256,
    revision,
    annotations,
    can_undo: false,
    can_redo: false,
  };
}

function bridge(overrides: Partial<ResearchDesktopApi> = {}): ResearchDesktopApi {
  return {
    createStudy: vi.fn(),
    openStudy: vi.fn(),
    getSnapshot: vi.fn(),
    addSources: vi.fn(),
    execute: vi.fn(async (_operation, request) => {
      const source = sources.find((item) => item.id === request.source_id) ?? sources[0];
      return receipt(source);
    }),
    reviewResult: vi.fn(),
    exportResult: vi.fn(),
    cancelJob: vi.fn(),
    ...overrides,
  };
}

function panel(api: ResearchDesktopApi, source = sources[0], handlers = {
  onPoints: vi.fn(),
  onAnnotations: vi.fn(),
  onError: vi.fn(),
}) {
  return <SourceAnnotationPanel
    api={api}
    source={source}
    selection={selection}
    tool="navigate"
    onTool={vi.fn()}
    points={[]}
    onPoints={handlers.onPoints}
    onAnnotations={handlers.onAnnotations}
    onError={handlers.onError}
  />;
}

describe("SourceAnnotationPanel interchange", () => {
  it("binds import and export to the loaded revision and treats dialog cancellation as no change", async () => {
    const exportSourceAnnotations = vi.fn().mockResolvedValue(null);
    const importSourceAnnotations = vi.fn().mockResolvedValue(null);
    const api = bridge({ exportSourceAnnotations, importSourceAnnotations });
    const handlers = { onPoints: vi.fn(), onAnnotations: vi.fn(), onError: vi.fn() };
    render(panel(api, sources[0], handlers));

    expect(await screen.findByText("0 saved")).toBeVisible();
    fireEvent.click(screen.getByText("Import & export annotations"));
    const exportButton = screen.getByRole("button", { name: "Export annotations" });
    fireEvent.click(exportButton);
    await waitFor(() => expect(exportSourceAnnotations).toHaveBeenCalledWith({
      source_id: sources[0].id,
      source_sha256: sources[0].sha256,
      expected_revision: 4,
    }));
    await waitFor(() => expect(exportButton).toBeEnabled());

    const importButton = screen.getByRole("button", { name: "Import annotations" });
    fireEvent.click(importButton);
    await waitFor(() => expect(importSourceAnnotations).toHaveBeenCalledWith({
      source_id: sources[0].id,
      source_sha256: sources[0].sha256,
      expected_revision: 4,
    }));
    await waitFor(() => expect(importButton).toBeEnabled());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(handlers.onError).not.toHaveBeenCalled();
  });

  it("drops an export receipt that resolves after the source changes", async () => {
    type ExportReceipt = { basename: string; sha256: string; annotation_count: number };
    let resolveExport!: (value: ExportReceipt | null) => void;
    const exportSourceAnnotations = vi.fn(
      () => new Promise<ExportReceipt | null>((resolve) => {
        resolveExport = resolve;
      }),
    );
    const api = bridge({ exportSourceAnnotations });
    const handlers = { onPoints: vi.fn(), onAnnotations: vi.fn(), onError: vi.fn() };
    const view = render(panel(api, sources[0], handlers));

    expect(await screen.findByText("0 saved")).toBeVisible();
    fireEvent.click(screen.getByText("Import & export annotations"));
    fireEvent.click(screen.getByRole("button", { name: "Export annotations" }));
    await waitFor(() => expect(exportSourceAnnotations).toHaveBeenCalledOnce());
    view.rerender(panel(api, sources[1], handlers));
    await waitFor(() => expect(api.execute).toHaveBeenCalledWith(
      "source_annotations",
      { source_id: sources[1].id },
    ));
    await act(async () => {
      resolveExport({ basename: "stale-annotations.json", sha256: "f".repeat(64), annotation_count: 9 });
      await Promise.resolve();
    });

    expect(screen.queryByText(/stale-annotations\.json/)).not.toBeInTheDocument();
    expect(handlers.onError).not.toHaveBeenCalled();
  });

  it("drops imported annotations that resolve after the source changes", async () => {
    let resolveImport!: (value: unknown) => void;
    const importSourceAnnotations = vi.fn(() => new Promise((resolve) => {
      resolveImport = resolve;
    }));
    const api = bridge({ importSourceAnnotations });
    const handlers = { onPoints: vi.fn(), onAnnotations: vi.fn(), onError: vi.fn() };
    const view = render(panel(api, sources[0], handlers));

    expect(await screen.findByText("0 saved")).toBeVisible();
    fireEvent.click(screen.getByText("Import & export annotations"));
    fireEvent.click(screen.getByRole("button", { name: "Import annotations" }));
    await waitFor(() => expect(importSourceAnnotations).toHaveBeenCalledOnce());
    view.rerender(panel(api, sources[1], handlers));
    await waitFor(() => expect(api.execute).toHaveBeenCalledWith(
      "source_annotations",
      { source_id: sources[1].id },
    ));
    handlers.onAnnotations.mockClear();
    await act(async () => {
      resolveImport(receipt(sources[0], 5, [{
        id: "old",
        kind: "point",
        points: [{ x: 1, y: 1 }],
        label: "stale",
        color: "#ffd36a",
        z: 0,
        t: 0,
        length: null,
        area: null,
        unit: "px",
      }]));
      await Promise.resolve();
    });

    expect(handlers.onAnnotations).not.toHaveBeenCalled();
    expect(screen.queryByText("Annotations imported. Undo is available.")).not.toBeInTheDocument();
    expect(handlers.onError).not.toHaveBeenCalled();
  });

  it("clears a draft when its exact source identity changes", async () => {
    const api = bridge();
    const handlers = { onPoints: vi.fn(), onAnnotations: vi.fn(), onError: vi.fn() };
    const view = render(<SourceAnnotationPanel api={api} source={sources[0]} selection={selection}
      tool="polygon" onTool={vi.fn()} points={[{ x: 1, y: 1 }, { x: 5, y: 1 }, { x: 5, y: 5 }]}
      onPoints={handlers.onPoints} onAnnotations={handlers.onAnnotations} onError={handlers.onError} />);
    expect(await screen.findByText("0 saved")).toBeVisible();
    handlers.onPoints.mockClear();

    view.rerender(<SourceAnnotationPanel api={api} source={sources[1]} selection={selection}
      tool="polygon" onTool={vi.fn()} points={[{ x: 1, y: 1 }, { x: 5, y: 1 }, { x: 5, y: 5 }]}
      onPoints={handlers.onPoints} onAnnotations={handlers.onAnnotations} onError={handlers.onError} />);

    await waitFor(() => expect(handlers.onPoints).toHaveBeenCalledWith([]));
    expect(api.execute).toHaveBeenCalledWith("source_annotations", { source_id: sources[1].id });
  });

  it("clears a draft when the active T/Z plane changes", async () => {
    const handlers = { onPoints: vi.fn(), onAnnotations: vi.fn(), onError: vi.fn() };
    const api = bridge();
    const props = { api, source: sources[0], tool: "line" as const, onTool: vi.fn(),
      points: [{ x: 1, y: 1 }], onPoints: handlers.onPoints,
      onAnnotations: handlers.onAnnotations, onError: handlers.onError };
    const view = render(<SourceAnnotationPanel {...props} selection={selection} />);
    expect(await screen.findByText("0 saved")).toBeVisible();
    handlers.onPoints.mockClear();

    view.rerender(<SourceAnnotationPanel {...props} selection={{ ...selection, z: 1 }} />);

    await waitFor(() => expect(handlers.onPoints).toHaveBeenCalledWith([]));
  });

  it.each([
    ["rectangle", [{ x: 4, y: 6 }, { x: 18, y: 20 }], "rectangle",
      [{ x: 4, y: 6 }, { x: 18, y: 6 }, { x: 18, y: 20 }, { x: 4, y: 20 }]],
    ["freehand", [{ x: 4, y: 6 }, { x: 18, y: 7 }, { x: 12, y: 20 }], "polygon",
      [{ x: 4, y: 6 }, { x: 18, y: 7 }, { x: 12, y: 20 }]],
  ] as const)("saves a %s draft with canonical engine geometry", async (tool, points, kind, savedPoints) => {
    const execute = vi.fn(async (operation: string) =>
      operation === "source_annotations" ? receipt(sources[0]) : receipt(sources[0], 5));
    render(<SourceAnnotationPanel api={bridge({ execute })} source={sources[0]} selection={selection}
      tool={tool} onTool={vi.fn()} points={[...points]}
      onPoints={vi.fn()} onAnnotations={vi.fn()} onError={vi.fn()} />);
    const save = await screen.findByRole("button", { name: "Save annotation" });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() => expect(execute).toHaveBeenCalledWith("annotate_source", expect.objectContaining({
      source_id: sources[0].id,
      source_sha256: sources[0].sha256,
      expected_revision: 4,
      action: "add",
      annotation: expect.objectContaining({ kind, points: savedPoints, z: 0, t: 0 }),
    })));
  });

  it("supports calibrated epidermal transects with explicit boundary definitions and review state", async () => {
    const initialAnnotations = [
      {
        id: "t1",
        kind: "line",
        points: [{ x: 10, y: 10 }, { x: 10, y: 25 }],
        label: "[transect:suprapapillary] Supra 1 · rev: Dr Alice [reviewed]",
        color: "#84cf91",
        z: 0,
        t: 0,
        length: 15.0,
        area: null,
        unit: "um",
        transect: {
          schema: "loci.epidermal-transect/v1",
          class: "suprapapillary",
          upper_boundary: "Granular layer",
          lower_boundary: "DEJ",
          orientation_rule: "Normal to local DEJ",
          exclusions: "Exclude folds",
          review: { status: "approved", reviewer: "Dr Alice" },
        },
      },
      {
        id: "t2",
        kind: "line",
        points: [{ x: 30, y: 10 }, { x: 30, y: 50 }],
        label: "[transect:ridge-base] Ridge 1 · rev: Dr Alice [reviewed]",
        color: "#86b9ec",
        z: 0,
        t: 0,
        length: 40.0,
        area: null,
        unit: "um",
        transect: {
          schema: "loci.epidermal-transect/v1",
          class: "ridge-base",
          upper_boundary: "Viable upper boundary",
          lower_boundary: "Ridge base",
          orientation_rule: "Normal to local DEJ",
          exclusions: "Exclude appendages",
          review: { status: "approved", reviewer: "Dr Alice" },
        },
      },
    ];

    const execute = vi.fn(async (op: string, req: Record<string, unknown>) => {
      if (op === "source_annotations") {
        return receipt(sources[0], 1, initialAnnotations);
      }
      if (op === "annotate_source") {
        return receipt(sources[0], 2, [
          ...initialAnnotations,
          ...(req.action === "add"
            ? [
                {
                  id: "t3",
                  ...(req.annotation as Record<string, unknown>),
                  length: 15.0,
                  area: null,
                  unit: "um",
                },
              ]
            : []),
        ]);
      }
      return receipt(sources[0]);
    });

    const api = bridge({ execute });
    const handlers = { onPoints: vi.fn(), onAnnotations: vi.fn(), onError: vi.fn() };
    render(
      <SourceAnnotationPanel
        api={api}
        source={{
          ...sources[0],
          metadata: {
            ...sources[0].metadata,
            physical_calibration: { spacing: [1, 0.5, 0.5], unit: "um" },
          },
        }}
        selection={selection}
        tool="transect"
        onTool={vi.fn()}
        points={[{ x: 5, y: 5 }, { x: 5, y: 20 }]}
        onPoints={handlers.onPoints}
        onAnnotations={handlers.onAnnotations}
        onError={handlers.onError}
      />
    );

    // Displays transect form
    expect(await screen.findByText(/Click one boundary, then the opposite boundary/)).toBeVisible();
    expect(screen.getByLabelText("Transect class")).toBeVisible();
    expect(screen.getByLabelText("Upper boundary")).toHaveValue("Stratum granulosum (viable epidermis)");
    expect(screen.getByLabelText("Lower boundary")).toHaveValue("Dermal-epidermal junction");

    // Approval remains fail-closed until a reviewer identity is present.
    fireEvent.click(screen.getByLabelText("Confirm transect review"));
    expect(screen.getByRole("button", { name: "Save annotation" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Enter the reviewer name");
    fireEvent.change(screen.getByLabelText("Transect reviewer"), { target: { value: "Dr Bob" } });

    // Save transect
    fireEvent.click(screen.getByRole("button", { name: "Save annotation" }));

    await waitFor(() => expect(execute).toHaveBeenCalledWith("annotate_source", expect.objectContaining({
      action: "add",
      annotation: expect.objectContaining({
        kind: "line",
        color: "#84cf91",
        label: expect.stringContaining("[transect:suprapapillary]"),
        transect: {
          schema: "loci.epidermal-transect/v1",
          class: "suprapapillary",
          upper_boundary: "Stratum granulosum (viable epidermis)",
          lower_boundary: "Dermal-epidermal junction",
          orientation_rule: "Perpendicular to local basement membrane",
          exclusions: "Tears, folds, appendages excluded",
          review: { status: "approved", reviewer: "Dr Bob" },
        },
      }),
    })));

    // Verify summary renders separate suprapapillary and ridge-base statistics
    expect(await screen.findByText("Epidermal transects (3)")).toBeVisible();
    expect(screen.getByText(/Suprapapillary \(2\)/)).toBeVisible();
    expect(screen.getByText(/Ridge-base \(1\)/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Export transects CSV" })).toBeVisible();
    expect(screen.getByText(/Different or missing protocols/)).toBeVisible();
    expect(screen.getByLabelText("Confirm transect review")).not.toBeChecked();
  });

  it("serializes each transect's saved protocol and neutralizes every text field", () => {
    const csv = serializeTransectsCsv(
      { id: sources[0].id, name: '=SUM(1,2) "source"', sha256: sources[0].sha256 },
      [
        {
          id: "t1", kind: "line", points: [{ x: 1, y: 2 }, { x: 3, y: 4 }],
          label: "First", color: "#84cf91", z: 2, t: 3, length: 5, area: null, unit: "um",
          transect: {
            schema: "loci.epidermal-transect/v1", class: "suprapapillary",
            upper_boundary: "+first boundary", lower_boundary: "first lower",
            orientation_rule: "first orientation", exclusions: "first exclusions",
            review: { status: "approved", reviewer: "Dr First" },
          },
        },
        {
          id: "t2", kind: "line", points: [{ x: 5, y: 6 }, { x: 7, y: 8 }],
          label: "Second", color: "#86b9ec", z: 0, t: 0, length: 9, area: null, unit: "um",
          transect: {
            schema: "loci.epidermal-transect/v1", class: "ridge-base",
            upper_boundary: "second upper", lower_boundary: "second lower",
            orientation_rule: "second orientation", exclusions: "@second exclusions",
            review: { status: "unverified", reviewer: null },
          },
        },
        {
          id: "legacy", kind: "line", points: [{ x: 9, y: 10 }, { x: 11, y: 12 }],
          label: "[transect:custom] old · rev: [reviewed]", color: "#ffd36a",
          z: 0, t: 0, length: 3, area: null, unit: "um",
        },
      ],
    );

    expect(csv).toContain('"\'=SUM(1,2) ""source"""');
    expect(csv).toContain('"\'+first boundary"');
    expect(csv).toContain('"\'@second exclusions"');
    expect(csv).toContain('"Dr First","structured","First"');
    expect(csv).toContain('"1","2","3","4","2","3","level0-pixel-edges","5","um"');
    expect(csv).toContain('"unverified","","structured","Second"');
    expect(csv).toContain('"unverified","","legacy-unverified"');
    expect(csv.split("\n")).toHaveLength(5);
  });

  it("does not promote legacy label-only review text to structured approval", async () => {
    const legacy = {
      id: "legacy", kind: "line", points: [{ x: 1, y: 1 }, { x: 2, y: 3 }],
      label: "[transect:suprapapillary] old · rev: [reviewed]", color: "#84cf91",
      z: 0, t: 0, length: 2.5, area: null, unit: "um",
    };
    const api = bridge({
      execute: vi.fn(async () => receipt(sources[0], 1, [legacy])),
    });

    render(panel(api));

    expect(await screen.findByText(/Legacy protocol metadata unavailable; unverified/)).toBeVisible();
    expect(screen.getByText(/0 approved; 1 unverified/)).toBeVisible();
  });
  it("summarizes only the active T/Z plane and labels other time points", async () => {
    const annotations = [0, 1].map((t) => ({
      id: `plane-${t}`, kind: "line", points: [{ x: 1, y: 1 }, { x: 2, y: 3 }],
      label: `Transect ${t}`, color: "#84cf91", z: 0, t, length: t ? 100 : 2,
      area: null, unit: "um",
      transect: { schema: "loci.epidermal-transect/v1", class: "suprapapillary",
        upper_boundary: "Upper", lower_boundary: "Lower", orientation_rule: "Normal",
        exclusions: "None", review: { status: "unverified", reviewer: null } },
    }));
    const source = { ...sources[0], metadata: { dimensions: { t: 2, c: 1, z: 1, y: 48, x: 64 } } };
    render(panel(bridge({ execute: vi.fn(async () => receipt(source, 1, annotations)) }), source));
    expect(await screen.findByText("Suprapapillary (1)")).toBeVisible();
    expect(screen.getByText("Mean: 2.00 um")).toBeVisible();
    expect(screen.queryByText("Mean: 51.00 um")).not.toBeInTheDocument();
    expect(screen.getByText(/100 um · T 2/)).toBeVisible();
  });

  it.each(["px", "pixel"])("does not describe %s lengths as calibrated", async (unit) => {
    const annotation = { id: "uncalibrated", kind: "line", label: "[transect:custom] sampled",
      color: "#ffd36a", z: 0, t: 0, points: [{ x: 1, y: 1 }, { x: 2, y: 3 }],
      length: 2, area: null, unit };
    render(panel(bridge({ execute: vi.fn(async () => receipt(sources[0], 1, [annotation])) })));
    expect(await screen.findByText(/Uncalibrated pixel lengths/)).toBeVisible();
    expect(screen.queryByText(/Calibrated lengths/)).not.toBeInTheDocument();
  });

});
