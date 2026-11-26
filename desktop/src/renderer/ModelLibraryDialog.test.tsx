// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ModelLibraryDialog from "./ModelLibraryDialog";
import ResearchWorkbench from "./ResearchWorkbench";
import {
  buildModelZooExampleRegistry,
  type ModelZooExampleRegistry,
} from "./model-zoo/examples";
import type {
  ResearchDesktopApi,
  ResearchSnapshot,
  ResearchSource,
} from "../shared/research-contracts";

const hash = "a".repeat(64);
const sourceId = "b".repeat(32);
const pngDataUrl = "data:image/png;base64,AAAA";

// Minimal distinct 1x1 WebP/PNG data URLs used strictly as synthetic UI test doubles.
const syntheticThumbOverlay =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const syntheticOriginal =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const syntheticOverlay =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function makeSyntheticExamples(): ModelZooExampleRegistry {
  return buildModelZooExampleRegistry(
    {
      "./examples/cellpose-sam-v2/credit.json": {
        modelId: "cellpose-sam-v2",
        modelVersion: "cpsam_v2 · rev 7c61431b",
        kind: "prediction",
        subject: "Synthetic UI test double: confluent 2D brightfield cells.",
        attribution: "UI Test Double Attribution",
        imageLicense: "CC0-1.0",
        sourceUrl: "https://example.org/cellpose-test-double-source",
        publicationUrl: "https://doi.org/10.1101/2025.04.28.651001",
        displayTransform: "Linear uint8 display copy.",
        predictionOrigin: "Synthetic UI test double prediction overlay.",
      },
      "./examples/micro-sam-vit-b-lm/credit.json": {
        modelId: "micro-sam-vit-b-lm",
        modelVersion: "micro-sam v2.0.1 · diplomatic-bug 1.2",
        kind: "input-only",
        subject: "Synthetic UI test double: 2D light microscopy input field.",
        attribution: "UI Test Double Attribution",
        imageLicense: "CC-BY-4.0",
        sourceUrl: "https://bioimage.io/#/artifacts/diplomatic-bug/v0",
        publicationUrl: "https://doi.org/10.1038/s41592-024-02580-4",
        displayTransform: "Percentile-stretched scalar input.",
        predictionOrigin: null,
      },
      "./examples/puma-tissue-cpu/credit.json": {
        modelId: "puma-tissue-cpu",
        modelVersion: "0.1.0 · nnU-Net PlainConvUNet, fold 4",
        kind: "prediction",
        subject:
          "H&E-stained primary melanoma, training region 004. The overlay highlights predicted epidermis.",
        attribution:
          "Mark Schuiveling, University Medical Center Utrecht, with Willeke Blokx and Gerben E. Breimer.",
        imageLicense: "CC0-1.0",
        sourceUrl: "https://zenodo.org/records/15050523",
        publicationUrl: "https://doi.org/10.1093/gigascience/giaf011",
        displayTransform:
          "Full native 1024 × 1024 field, series 0. Class 4 has a 22% teal tint and a two-pixel inner contour.",
        predictionOrigin:
          "Loci CPU inference on the published PUMA training image using fold 4 of the nnU-Net tissue baseline.",
      },
    },
    {
      "./examples/cellpose-sam-v2/thumbnail.webp": syntheticThumbOverlay,
      "./examples/cellpose-sam-v2/original.webp": syntheticOriginal,
      "./examples/cellpose-sam-v2/overlay.webp": syntheticOverlay,
      "./examples/micro-sam-vit-b-lm/thumbnail.webp": syntheticOriginal,
      "./examples/micro-sam-vit-b-lm/original.webp": syntheticOriginal,
      "./examples/puma-tissue-cpu/thumbnail.webp": syntheticThumbOverlay,
      "./examples/puma-tissue-cpu/original.webp": syntheticOriginal,
      "./examples/puma-tissue-cpu/overlay.webp": syntheticOverlay,
    },
  );
}

function setNaturalDimensions(
  img: HTMLImageElement,
  width: number,
  height: number,
): void {
  Object.defineProperty(img, "naturalWidth", {
    configurable: true,
    value: width,
  });
  Object.defineProperty(img, "naturalHeight", {
    configurable: true,
    value: height,
  });
}

const scalarSource: ResearchSource = {
  id: sourceId,
  sha256: hash,
  name: "Fluorescence Nuclei.tif",
  source_kind: "native",
  metadata: {
    selected_series: 0,
    dimensions: { x: 256, y: 256, c: 2, s: 1, z: 1, t: 1 },
    levels: [{ index: 0, dimensions: { x: 256, y: 256, c: 2, s: 1, z: 1, t: 1 } }],
    sample_semantics: "scalar",
    channel_dtypes: ["uint16", "uint16"],
    channel_names: ["DAPI", "GFP"],
  },
};

function makeLoadedSnapshot(): ResearchSnapshot {
  return {
    project: {
      project_id: "study-model-zoo",
      title: "Microscopy Study",
      first_study: { example_id: "", source_id: "", source_sha256: "" },
    },
    sources: [scalarSource],
    results: [],
    jobs: [],
    samples: [],
    recipes: [],
    displays: [],
    selections: [],
    operations: {
      view: { mutates: false, summary: "view" },
      volume_view: { mutates: false, summary: "volume" },
      preview_recipe: { mutates: false, summary: "preview" },
      run_recipe: { mutates: true, summary: "run" },
      result: { mutates: false, summary: "result" },
      sample: { mutates: true, summary: "sample" },
    },
    workspace: { revision: 1, closed_sources: [], hidden_results: [] },
  };
}

function makeWorkbenchApi(
  openModelLibraryLink = vi.fn(async () => undefined),
): ResearchDesktopApi {
  const snapshot = makeLoadedSnapshot();
  return {
    createStudy: vi.fn(async () => snapshot),
    openStudy: vi.fn(async () => snapshot),
    getSnapshot: vi.fn(async () => snapshot),
    addSources: vi.fn(async () => snapshot),
    sessionState: vi.fn(async () => ({
      sessionId: "session-1",
      title: "Microscopy Study",
      storage: "managed" as const,
      saved: false,
      status: "ready" as const,
      reason: null,
      canKeep: true,
      canDiscard: true,
    })),
    openModelLibraryLink,
    execute: vi.fn(async (op: string, req: Record<string, unknown> = {}) => {
      if (op === "viewer_defaults") {
        return {
          source_id: sourceId,
          source_sha256: hash,
          basis: "Source acquisition range",
          channels: [
            { channel: 0, low: 0, high: 4095, gamma: 1, color: "#4da3ff", opacity: 1, visible: true },
            { channel: 1, low: 0, high: 4095, gamma: 1, color: "#52d17c", opacity: 1, visible: true },
          ],
        };
      }
      if (op === "source_annotations") {
        return { source_id: sourceId, source_sha256: hash, annotations: [] };
      }
      if (op === "source_view") {
        return { source_id: sourceId, source_sha256: hash, revision: 0, state: null };
      }
      if (op === "save_source_view") {
        return {
          source_id: sourceId,
          source_sha256: hash,
          revision: Number(req.expected_revision ?? 0) + 1,
          state: req.state ?? null,
        };
      }
      if (op === "view") {
        return { image: pngDataUrl };
      }
      if (op === "model_list") {
        return { models: [] };
      }
      return {};
    }),
    reviewResult: vi.fn(async () => ({})),
    exportResult: vi.fn(async () => ({})),
    cancelJob: vi.fn(async () => ({})),
  };
}

describe("Model Zoo dialog", () => {
  afterEach(() => {
    cleanup();
    delete document.documentElement.dataset.motion;
  });

  it("renders the minimal scientific atlas with zero schematic SVGs, equal-structure cards, and quiet native baselines", () => {
    const onOpenLink = vi.fn();
    render(
      <div className="research-workbench">
        <ModelLibraryDialog
          onClose={vi.fn()}
          onOpenLink={onOpenLink}
          examples={makeSyntheticExamples()}
        />
      </div>,
    );

    const dialog = screen.getByRole("dialog", { name: /^Model Zoo$/i });
    expect(dialog).toBeInTheDocument();
    expect(onOpenLink).not.toHaveBeenCalled();

    // No schematic SVG or demo states exist anywhere in the DOM
    expect(document.querySelectorAll(".model-library-stage__svg")).toHaveLength(0);
    expect(document.querySelectorAll(".model-schematic__task-layer")).toHaveLength(0);
    // No nested buttons anywhere
    expect(dialog.querySelectorAll("button button")).toHaveLength(0);

    // Existing gallery models keep their titles
    expect(screen.getByRole("heading", { name: "Cellpose-SAM v2" })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "μSAM Light Microscopy Generalist" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "StarDist Versatile Fluorescence Nuclei" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "BioImage.IO 2D Nuclei Boundary ONNX" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "PUMA tissue nnU-Net · fold 4" }),
    ).toBeInTheDocument();

    // Quiet native baselines live in a collapsed bottom <details> disclosure
    const baselinesDetails = document.querySelector<HTMLDetailsElement>(
      "details.model-library-baselines",
    )!;
    expect(baselinesDetails).not.toHaveAttribute("open");
    expect(
      within(baselinesDetails).getByText("Classical threshold & watershed"),
    ).toBeInTheDocument();
    expect(
      within(baselinesDetails).getByText("Loci Adaptive Watershed"),
    ).toBeInTheDocument();
  });

  it("shows overlay initially on paired cards with accessible Original/Overlay toggle, and omits prediction controls on input-only or unbundled cards", () => {
    render(
      <ModelLibraryDialog
        onClose={vi.fn()}
        examples={makeSyntheticExamples()}
      />,
    );

    // Paired prediction card starts on overlay thumbnail and toggles to original
    const cellposeCard = document.querySelector<HTMLElement>(
      '[data-model-id="cellpose-sam-v2"]',
    )!;
    expect(cellposeCard).toHaveAttribute("data-example-kind", "prediction");
    expect(cellposeCard).toHaveAttribute("data-preview-layer", "overlay");
    const cellposeImg = within(cellposeCard).getByRole("img");
    expect(cellposeImg).toHaveAttribute("src", syntheticThumbOverlay);
    expect(cellposeImg.getAttribute("alt")).toMatch(/prediction overlay/i);

    const toggleBtn = within(cellposeCard).getByRole("button", {
      name: /switch to original input/i,
    });
    expect(toggleBtn).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(toggleBtn);
    expect(cellposeCard).toHaveAttribute("data-preview-layer", "original");
    expect(toggleBtn).toHaveAttribute("aria-pressed", "true");
    expect(within(cellposeCard).getByRole("img")).toHaveAttribute(
      "src",
      syntheticOriginal,
    );

    // Toggling back returns to overlay
    fireEvent.click(toggleBtn);
    expect(cellposeCard).toHaveAttribute("data-preview-layer", "overlay");
    expect(within(cellposeCard).getByRole("img")).toHaveAttribute(
      "src",
      syntheticThumbOverlay,
    );

    // Input-only card displays genuine input with zero Original/Overlay toggle
    const usamCard = document.querySelector<HTMLElement>(
      '[data-model-id="micro-sam-vit-b-lm"]',
    )!;
    expect(usamCard).toHaveAttribute("data-example-kind", "input-only");
    expect(usamCard).toHaveAttribute("data-preview-layer", "original");
    expect(within(usamCard).getByRole("img")).toHaveAttribute(
      "src",
      syntheticOriginal,
    );
    expect(
      usamCard.querySelector(".model-zoo-card__layer-toggle"),
    ).toBeNull();

    // Unbundled card renders honest placeholder text with zero broken <img> or toggle
    const stardistCard = document.querySelector<HTMLElement>(
      '[data-model-id="stardist-2d-versatile-fluo"]',
    )!;
    expect(stardistCard).toHaveAttribute("data-example-kind", "unavailable");
    expect(within(stardistCard).queryByRole("img")).toBeNull();
    expect(
      within(stardistCard).getByText(/no bundled example/i),
    ).toBeInTheDocument();
    expect(
      stardistCard.querySelector(".model-zoo-card__layer-toggle"),
    ).toBeNull();

    // Decode error on card image falls back honestly without broken icon
    fireEvent.error(within(usamCard).getByRole("img"));
    fireEvent.error(within(usamCard).getByRole("img"));
    expect(
      within(usamCard).getByText(/example image failed to decode/i),
    ).toBeInTheDocument();
  });

  it.each([
    ["ovule confocal", "PlantSeg · Arabidopsis ovules", "Open volume label importer", "labels-import", "plantseg-ovules-ds1x"],
    ["multiplex tissue", "Mesmer · multiplex tissue", "Open plane label importer", "labels-import", "mesmer-multiplex-tissue"],
    ["Phase3D", "DynaCell · iPSC nuclear virtual stain", "Open virtual stain control", "virtual-stain", "dynacell-ipsc-nucleus"],
  ])("opens the published workflow for %s from a text-only card", (query, title, action, route, modelId) => {
    const selectRoute = vi.fn();
    const openLink = vi.fn();
    render(<ModelLibraryDialog onClose={vi.fn()} onOpenLink={openLink} onSelectWorkbenchRoute={selectRoute} />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: query } });
    fireEvent.click(screen.getByRole("button", { name: title }));
    expect(screen.queryByRole("slider")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: action }));
    expect(selectRoute).toHaveBeenCalledExactlyOnceWith(route, modelId);
    expect(openLink).not.toHaveBeenCalled();
  });

  it("supports search, empty-state feedback, Escape-to-clear search, and All/Local/External keyboard filtering", () => {
    render(
      <ModelLibraryDialog
        onClose={vi.fn()}
        examples={makeSyntheticExamples()}
      />,
    );

    const search = screen.getByRole("searchbox", { name: /search model zoo/i });
    const filterGroup = screen.getByRole("radiogroup", {
      name: /filter models by execution route/i,
    });

    // Search for PUMA by architecture token
    fireEvent.change(search, { target: { value: "PlainConvUNet" } });
    expect(
      screen.getByRole("heading", { name: "PUMA tissue nnU-Net · fold 4" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Cellpose-SAM v2" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/showing 1 of 8/i);

    // Non-matching search shows explicit empty state with reset action
    fireEvent.change(search, { target: { value: "unmatched-modality-777" } });
    expect(
      screen.getAllByText(/no models match “unmatched-modality-777”/i).length,
    ).toBeGreaterThanOrEqual(1);

    // Escape while search has focus & text clears search without closing dialog
    search.focus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(search).toHaveValue("");
    expect(screen.getByRole("dialog", { name: /^Model Zoo$/i })).toBeInTheDocument();

    // Filter radiogroup switches via keyboard ArrowRight
    const allRadio = within(filterGroup).getByRole("radio", { name: /^All/i });
    const localRadio = within(filterGroup).getByRole("radio", { name: /^Local/i });
    const externalRadio = within(filterGroup).getByRole("radio", { name: /^External/i });

    allRadio.focus();
    fireEvent.keyDown(filterGroup, { key: "ArrowRight" });
    expect(localRadio).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("heading", { name: "Cellpose-SAM v2" })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "BioImage.IO 2D Nuclei Boundary ONNX" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "PUMA tissue nnU-Net · fold 4" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "μSAM Light Microscopy Generalist" }),
    ).not.toBeInTheDocument();

    fireEvent.keyDown(filterGroup, { key: "ArrowRight" });
    expect(externalRadio).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByRole("heading", { name: "μSAM Light Microscopy Generalist" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "StarDist Versatile Fluorescence Nuclei" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Cellpose-SAM v2" }),
    ).not.toBeInTheDocument();
  });

  it("opens contextual detail without nested dialogs, provides aligned keyboard-accessible comparison for pairs, and enforces fixed-ID links & plain credit addresses", () => {
    const onClose = vi.fn();
    const onOpenLink = vi.fn();
    const onSelectWorkbenchRoute = vi.fn();

    render(
      <ModelLibraryDialog
        onClose={onClose}
        onOpenLink={onOpenLink}
        onSelectWorkbenchRoute={onSelectWorkbenchRoute}
        examples={makeSyntheticExamples()}
      />,
    );

    // Select PUMA from the gallery
    const pumaSelectBtn = screen.getByRole("button", {
      name: "PUMA tissue nnU-Net · fold 4",
    });
    fireEvent.click(pumaSelectBtn);

    // Still a single modal dialog (no nested dialogs)
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(
      screen.getByRole("heading", { name: "PUMA tissue nnU-Net · fold 4" }),
    ).toBeInTheDocument();

    // Verify PUMA architecture & ensemble distinction visibly on the detail face
    const detailSummary = document.querySelector<HTMLElement>(
      ".model-zoo-detail__summary",
    )!;
    expect(detailSummary).toHaveTextContent(/Six-class PlainConvUNet/i);
    expect(detailSummary).toHaveTextContent(/paper's ensemble differs/i);

    // Aligned pixel-space comparison: original & overlay decode to identical 1024x1024 geometry
    const originalImg = document.querySelector<HTMLImageElement>(
      'img[data-layer="original"]',
    )!;
    const overlayImg = document.querySelector<HTMLImageElement>(
      'img[data-layer="overlay"]',
    )!;
    setNaturalDimensions(originalImg, 1024, 1024);
    setNaturalDimensions(overlayImg, 1024, 1024);
    fireEvent.load(originalImg);
    fireEvent.load(overlayImg);

    const stage = document.querySelector<HTMLElement>(".model-zoo-detail-stage")!;
    expect(stage).toHaveAttribute("data-aligned-geometry", "1024x1024");
    expect(screen.getByText("1024 × 1024 px")).toBeInTheDocument();

    // Native range slider adjusts overlay clip-path cleanly
    const slider = screen.getByRole("slider", {
      name: /original and overlay comparison split/i,
    });
    expect(slider).toHaveValue("50");
    fireEvent.change(slider, { target: { value: "72" } });
    expect(slider).toHaveValue("72");
    expect(overlayImg.style.clipPath).toBe("inset(0 0 0 72%)");

    // Mode radiogroup switches to Original and back to Overlay
    const modeGroup = screen.getByRole("radiogroup", {
      name: /example view mode/i,
    });
    fireEvent.click(within(modeGroup).getByRole("radio", { name: "Original" }));
    expect(stage).toHaveAttribute("data-view-mode", "original");
    expect(overlayImg.style.opacity).toBe("0");

    fireEvent.click(within(modeGroup).getByRole("radio", { name: "Overlay" }));
    expect(stage).toHaveAttribute("data-view-mode", "overlay");
    expect(overlayImg.style.clipPath).toBe("inset(0 0 0 0)");

    // Precise destination-specific source links include pinned PUMA baseline repo
    fireEvent.click(
      screen.getByRole("button", { name: /PUMA baseline code \(21178205\)/i }),
    );
    expect(onOpenLink).toHaveBeenCalledExactlyOnceWith("puma-baseline-repo");

    // Rights & provenance disclosure starts collapsed
    const provenance = document.querySelector<HTMLDetailsElement>(
      "details.model-zoo-provenance",
    )!;
    expect(provenance).not.toHaveAttribute("open");
    fireEvent.click(within(provenance).getByText("Rights, reference & provenance"));

    // Registered publicationUrl in credit.json opens via fixed link ID "puma-paper"
    fireEvent.click(
      within(provenance).getByRole("button", {
        name: "https://doi.org/10.1093/gigascience/giaf011",
      }),
    );
    expect(onOpenLink).toHaveBeenLastCalledWith("puma-paper");

    // Unregistered sourceUrl in credit.json renders as plain non-clickable address text
    const plainAddress = within(provenance).getByText(
      "https://zenodo.org/records/15050523",
    );
    expect(plainAddress.tagName).toBe("CODE");
    expect(plainAddress.closest("button, a")).toBeNull();

    // Launch action routes cleanly
    fireEvent.click(
      screen.getByRole("button", {
        name: /open epidermis model \(needs converted pair\)/i,
      }),
    );
    expect(onSelectWorkbenchRoute).toHaveBeenCalledExactlyOnceWith(
      "tissue-epidermis",
      "puma-tissue-cpu",
    );

    // Escape closes detail view (NOT the whole dialog) and returns focus to PUMA card button
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(
      screen.getByRole("dialog", { name: /^Model Zoo$/i }),
    ).toHaveAttribute("data-view", "grid");
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "PUMA tissue nnU-Net · fold 4" }),
    );

    // Input-only model detail shows genuine input with ZERO comparison controls
    fireEvent.click(
      screen.getByRole("button", { name: "μSAM Light Microscopy Generalist" }),
    );
    expect(screen.queryByRole("slider")).toBeNull();
    expect(
      screen.queryByRole("radiogroup", { name: /example view mode/i }),
    ).toBeNull();
    expect(screen.getByText("Reference input only")).toBeInTheDocument();
  });

  it("fails closed when a prediction pair reports mismatched natural dimensions and respects reduced motion", () => {
    document.documentElement.dataset.motion = "reduced";
    render(
      <ModelLibraryDialog
        onClose={vi.fn()}
        examples={makeSyntheticExamples()}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: /^Model Zoo$/i });
    expect(dialog).toHaveAttribute("data-reduced-motion", "true");

    fireEvent.click(screen.getByRole("button", { name: "Cellpose-SAM v2" }));
    const originalImg = document.querySelector<HTMLImageElement>(
      'img[data-layer="original"]',
    )!;
    const overlayImg = document.querySelector<HTMLImageElement>(
      'img[data-layer="overlay"]',
    )!;
    setNaturalDimensions(originalImg, 512, 512);
    setNaturalDimensions(overlayImg, 640, 480);
    fireEvent.load(originalImg);
    fireEvent.load(overlayImg);

    expect(
      screen.getByText(/dimensions do not match/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole("slider")).toBeNull();
    expect(document.querySelector('img[data-layer="overlay"]')).toBeNull();
  });

  it("exposes destination-specific repository links for Cellpose and StarDist and disabled route reason when no image is open", () => {
    const onOpenLink = vi.fn();
    render(
      <ModelLibraryDialog
        onClose={vi.fn()}
        onOpenLink={onOpenLink}
        onSelectWorkbenchRoute={vi.fn()}
        workbenchRouteUnavailableReason="Open an image first to configure this tool in the inspector."
        examples={makeSyntheticExamples()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cellpose-SAM v2" }));
    fireEvent.click(
      screen.getByRole("button", { name: /MouseLand\/cellpose repository/i }),
    );
    expect(onOpenLink).toHaveBeenCalledWith("cellpose-github-repo");

    const disabledLaunch = screen.getByRole("button", {
      name: /open cellpose-sam v2 in analyze/i,
    });
    expect(disabledLaunch).toBeDisabled();
    expect(
      screen.getByText(
        "Open an image first to configure this tool in the inspector.",
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Model Zoo" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "StarDist Versatile Fluorescence Nuclei",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /stardist\/stardist repository/i }),
    );
    expect(onOpenLink).toHaveBeenLastCalledWith("stardist-github-repo");
    fireEvent.click(
      screen.getByRole("button", { name: /stardist-models v0\.1 release notes/i }),
    );
    expect(onOpenLink).toHaveBeenLastCalledWith("stardist-v01-release");
  });

  it("closes on Escape from the grid and restores focus to the launching control", () => {
    const launcher = document.createElement("button");
    launcher.textContent = "Launch Model Zoo";
    document.body.appendChild(launcher);
    launcher.focus();
    expect(document.activeElement).toBe(launcher);

    const onClose = vi.fn();
    const { unmount } = render(
      <ModelLibraryDialog onClose={onClose} examples={makeSyntheticExamples()} />,
    );
    expect(document.activeElement).not.toBe(launcher);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    unmount();
    expect(document.activeElement).toBe(launcher);
    launcher.remove();
  });
});

describe("ResearchWorkbench Model Zoo integration on a loaded study", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      setTransform: vi.fn(),
      fillRect: vi.fn(),
      clearRect: vi.fn(),
      scale: vi.fn(),
      drawImage: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      closePath: vi.fn(),
      arc: vi.fn(),
      stroke: vi.fn(),
      fillText: vi.fn(),
      setLineDash: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      ellipse: vi.fn(),
      fill: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("opens Model Zoo from Analyze and File menu in a loaded study, restores focus on Escape, and routes into workbench tools", async () => {
    const openModelLibraryLink = vi.fn(async () => undefined);
    const api = makeWorkbenchApi(openModelLibraryLink);
    render(<ResearchWorkbench api={api} onBack={vi.fn()} />);

    await screen.findByRole("button", { name: /Fluorescence Nuclei\.tif/i });

    // Switch to Analyze group (Segment & measure)
    fireEvent.click(screen.getByRole("button", { name: "Analyze" }));
    const analyzeLauncher = await screen.findByRole("button", {
      name: "Browse Model Zoo…",
    });
    analyzeLauncher.focus();
    expect(document.activeElement).toBe(analyzeLauncher);

    // Click Browse Model Zoo… in Analyze -> Segment & measure
    fireEvent.click(analyzeLauncher);
    const dialog = await screen.findByRole("dialog", { name: /^Model Zoo$/i });
    expect(dialog).toBeInTheDocument();
    expect(openModelLibraryLink).not.toHaveBeenCalled();

    // Deliberate click on StarDist card publisher badge dispatches fixed-ID link
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: /open official stardist versatile fluorescence nuclei source/i,
      }),
    );
    expect(openModelLibraryLink).toHaveBeenCalledExactlyOnceWith(
      "stardist-2d-versatile-fluo-zip",
    );

    // Escape closes the dialog and returns focus to the Analyze launcher button
    fireEvent.keyDown(window, { key: "Escape" });
    expect(
      screen.queryByRole("dialog", { name: /^Model Zoo$/i }),
    ).not.toBeInTheDocument();
    expect(document.activeElement).toBe(analyzeLauncher);

    // Reopen from Analyze, select μSAM detail, and launch μSAM handoff route
    fireEvent.click(analyzeLauncher);
    const reopenedDialog = await screen.findByRole("dialog", {
      name: /^Model Zoo$/i,
    });
    fireEvent.click(
      within(reopenedDialog).getByRole("button", {
        name: "μSAM Light Microscopy Generalist",
      }),
    );
    fireEvent.click(
      within(reopenedDialog).getByRole("button", {
        name: /open μsam handoff in analyze/i,
      }),
    );
    expect(
      screen.queryByRole("dialog", { name: /^Model Zoo$/i }),
    ).not.toBeInTheDocument();
    const importLabelsDetails = screen
      .getByText("Import existing labels", { selector: "summary" })
      .closest("details");
    expect(importLabelsDetails).toHaveAttribute("open");
    expect(screen.getByText("μSAM (standalone)", { selector: "summary" }).closest("details")).toHaveAttribute("open");
    expect(screen.getByRole("button", { name: "Export native TIFF for μSAM" })).toBeVisible();

    // Also open from the header File menu and route to Use a model
    const fileMenuSummary = document.querySelector<HTMLElement>(
      "details.workbench-file-menu > summary",
    )!;
    fireEvent.click(fileMenuSummary);
    const fileMenuButton = within(
      document.querySelector<HTMLElement>("details.workbench-file-menu")!,
    ).getByRole("button", { name: "Model Zoo…" });
    fireEvent.click(fileMenuButton);

    const fileDialog = await screen.findByRole("dialog", {
      name: /^Model Zoo$/i,
    });
    fireEvent.click(
      within(fileDialog).getByRole("button", {
        name: "BioImage.IO 2D Nuclei Boundary ONNX",
      }),
    );
    fireEvent.click(
      within(fileDialog).getByRole("button", {
        name: /open use a model in analyze/i,
      }),
    );
    expect(
      screen.queryByRole("dialog", { name: /^Model Zoo$/i }),
    ).not.toBeInTheDocument();
    expect(
      await screen.findByRole("heading", {
        name: /no model packages in this study|use a model/i,
      }),
    ).toBeInTheDocument();
  });
});
