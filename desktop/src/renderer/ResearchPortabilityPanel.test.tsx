// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResearchDesktopApi, ResearchSnapshot } from "../shared/research-contracts";
import { ResearchPortabilityPanel } from "./ResearchPortabilityPanel";

afterEach(cleanup);

const primary = {
  id: "a".repeat(32),
  name: "Primary image",
  sha256: "b".repeat(64),
  source_kind: "native" as const,
  metadata: { dimensions: { t: 1, c: 1, z: 1, y: 8, x: 8 } },
};
const reference = {
  ...primary,
  id: "c".repeat(32),
  name: "Flat field",
  sha256: "d".repeat(64),
};
const missing = {
  ...primary,
  id: "e".repeat(32),
  name: "Imported DICOM",
  sha256: "f".repeat(64),
  source_kind: "medical" as const,
  locator_state: "relink-required" as const,
  relink_hint: { selection_kind: "series" as const, file_count: 4 },
};
const snapshot: ResearchSnapshot = {
  project: { title: "Portable" },
  sources: [primary, reference, missing],
  results: [],
  samples: [],
  recipes: [
    {
      id: "1".repeat(32),
      revision: 1,
      data: { name: "Cell count" },
    },
  ],
  displays: [],
  selections: [],
  jobs: [],
  operations: {},
};

function api(overrides: Partial<ResearchDesktopApi> = {}): ResearchDesktopApi {
  return {
    createStudy: vi.fn(),
    openStudy: vi.fn(),
    getSnapshot: vi.fn().mockResolvedValue(snapshot),
    addSources: vi.fn(),
    execute: vi.fn(),
    reviewResult: vi.fn(),
    exportResult: vi.fn(),
    cancelJob: vi.fn(),
    ...overrides,
  };
}

const report = async <T,>(work: () => Promise<T>) => work();

function panel(bridge: ResearchDesktopApi, onSnapshot = vi.fn()) {
  return render(
    <ResearchPortabilityPanel
      api={bridge}
      snapshot={snapshot}
      selectedSourceId={primary.id}
      selectedResult={null}
      report={report}
      busy={false}
      onBusyChange={vi.fn()}
      onSnapshot={onSnapshot}
      onResult={vi.fn()}
    />,
  );
}

describe("ResearchPortabilityPanel", () => {
  it("switches to a natively imported study and keeps the current study on picker cancellation", async () => {
    const imported = { ...snapshot, sources: [missing] };
    const importStudy = vi.fn().mockResolvedValue(imported);
    const openStudy = vi.fn().mockResolvedValue(null);
    const onSnapshot = vi.fn();
    panel(api({ importStudy, openStudy }), onSnapshot);
    fireEvent.click(screen.getByRole("button", { name: "Import portable study" }));
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledWith(imported));
    onSnapshot.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Open study" }));
    await waitFor(() => expect(openStudy).toHaveBeenCalledOnce());
    expect(onSnapshot).not.toHaveBeenCalled();
  });

  it("exports renderer-safe study and recipe receipts", async () => {
    const exportStudy = vi.fn().mockResolvedValue({
      export_name: "Study.loci-study.zip",
      archive_sha256: "1".repeat(64),
      member_count: 9,
    });
    const exportRecipe = vi.fn().mockResolvedValue({
      export_name: "Recipe.loci-recipe.json",
      roles: ["primary", "flatfield"],
    });
    panel(api({ exportStudy, exportRecipe }));

    fireEvent.click(screen.getByText("Export portable study"));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Study.loci-study.zip · SHA-256 111111111111… · 9 members",
    );
    fireEvent.click(screen.getByText("Export template"));
    await waitFor(() => expect(exportRecipe).toHaveBeenCalledWith("1".repeat(32), primary.id));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "roles primary, flatfield",
    );
  });

  it("uses the archived medical series hint for exact relinking", async () => {
    const relinkSource = vi.fn().mockResolvedValue({
      ...snapshot,
      sources: [primary, reference, { ...missing, locator_state: undefined }],
    });
    const onSnapshot = vi.fn();
    panel(api({ relinkSource }), onSnapshot);
    fireEvent.click(screen.getByText("Relink exact series"));
    await waitFor(() =>
      expect(relinkSource).toHaveBeenCalledWith(missing.id, "dicom"),
    );
    expect(onSnapshot).toHaveBeenCalled();
  });

  it("imports a template with explicit non-empty source roles and refreshes", async () => {
    const importRecipe = vi.fn().mockResolvedValue({
      recipe: { data: { name: "Mapped recipe" } },
    });
    const getSnapshot = vi.fn().mockResolvedValue(snapshot);
    const onSnapshot = vi.fn();
    panel(api({ importRecipe, getSnapshot }), onSnapshot);
    fireEvent.change(screen.getByLabelText("Flatfield source role"), {
      target: { value: reference.id },
    });
    fireEvent.click(screen.getByText("Choose template and import"));
    await waitFor(() =>
      expect(importRecipe).toHaveBeenCalledWith({
        primary: primary.id,
        flatfield: reference.id,
      }),
    );
    expect(onSnapshot).toHaveBeenCalledWith(snapshot);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Imported and revalidated Mapped recipe",
    );
  });
});
