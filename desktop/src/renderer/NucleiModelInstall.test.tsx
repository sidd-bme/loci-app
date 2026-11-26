// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ResearchWorkbench from "./ResearchWorkbench";
import {
  findInstalledNucleiModel,
  formatByteCount,
} from "./NucleiModelInstallControl";
import { NUCLEI_MODEL_INSTALL } from "../shared/nuclei-model-install";
import type {
  ResearchDesktopApi,
  ResearchSnapshot,
  ResearchSource,
} from "../shared/research-contracts";

const pngDataUrl = "data:image/png;base64,AAAA";
const catalogModelId = "c".repeat(32);
const otherModelId = "e".repeat(32);

function makeSource(id: string, name: string, sha256: string): ResearchSource {
  return {
    id,
    sha256,
    name,
    source_kind: "native",
    metadata: {
      selected_series: 0,
      dimensions: { x: 256, y: 256, c: 2, s: 1, z: 1, t: 1 },
      levels: [
        { index: 0, dimensions: { x: 256, y: 256, c: 2, s: 1, z: 1, t: 1 } },
      ],
      sample_semantics: "scalar",
      channel_dtypes: ["uint16", "uint16"],
      channel_names: ["DAPI", "GFP"],
    },
  };
}

const sourceOne = makeSource("a".repeat(32), "Nuclei Field A.tif", "1".repeat(64));
const sourceTwo = makeSource("b".repeat(32), "Nuclei Field B.tif", "2".repeat(64));

function makeSnapshot(
  projectId: string,
  title: string,
  sources: ResearchSource[] = [sourceOne],
): ResearchSnapshot {
  return {
    project: {
      project_id: projectId,
      title,
      first_study: { example_id: "", source_id: "", source_sha256: "" },
    },
    sources,
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

function makeNucleiModelRecord(
  availabilityState: "ready" | "reimport-required" = "ready",
  packageSha256: string = NUCLEI_MODEL_INSTALL.packageSha256,
  modelId: string = catalogModelId,
): Record<string, unknown> {
  return {
    model_id: modelId,
    package: {
      id: "nuclei-segmentation-boundary-model",
      version: "0.1.0-publication-20261015-r2",
      package_sha256: packageSha256,
      input: {
        channels: [
          { name: "declared-fluorescence-intensity", source_index: 0 },
        ],
      },
    },
    availability: { state: availabilityState },
    technical_compatibility:
      availabilityState === "ready"
        ? "reference-qualified on the recorded CPU runtime"
        : "historical qualification only; exact package re-import and rerun required",
    reference_qualification: {
      compatible: true,
      package_sha256: packageSha256,
    },
    scientific_validation: { status: "unvalidated" },
    usage_rights: { review_state: "independent-rights-review-required" },
  };
}

function makeOtherModelRecord(): Record<string, unknown> {
  return {
    model_id: otherModelId,
    package: {
      id: "custom-local-model",
      version: "1.0.0",
      package_sha256: "9".repeat(64),
      input: {
        channels: [{ name: "custom-channel", source_index: 0 }],
      },
    },
    availability: { state: "ready" },
    technical_compatibility: "reference-qualified on the recorded CPU runtime",
    reference_qualification: { compatible: true, package_sha256: "9".repeat(64) },
    scientific_validation: { status: "unvalidated" },
    usage_rights: {},
  };
}

function makeDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function openUseAModelTool() {
  const navigation = await screen.findByRole("navigation", {
    name: "Task groups",
  });
  const tools = within(navigation.parentElement!);
  fireEvent.click(within(navigation).getByRole("button", { name: "Analyze" }));
  fireEvent.click(await tools.findByRole("combobox", { name: "Analyze tool" }));
  const options = within(
    await tools.findByRole("listbox", { name: "Analyze tool" }),
  );
  fireEvent.click(options.getByRole("option", { name: "Use a model" }));
}

function makeWorkbenchApi({
  snapshot = makeSnapshot("study-1", "Nuclei Study 1", [sourceOne, sourceTwo]),
  modelsByStudy,
  installNucleiModel,
  cancelNucleiModelInstall,
  importModel,
  openStudy,
}: {
  snapshot?: ResearchSnapshot | null;
  modelsByStudy?: () => Record<string, unknown>[];
  installNucleiModel?: ResearchDesktopApi["installNucleiModel"];
  cancelNucleiModelInstall?: ResearchDesktopApi["cancelNucleiModelInstall"];
  importModel?: ResearchDesktopApi["importModel"];
  openStudy?: ResearchDesktopApi["openStudy"];
} = {}): {
  api: ResearchDesktopApi;
  execute: ReturnType<typeof vi.fn>;
} {
  const execute = vi.fn(
    async (op: string, req: Record<string, unknown> = {}) => {
      if (op === "viewer_defaults") {
        const sid = String(req.source_id ?? sourceOne.id);
        const matched = snapshot?.sources.find((s) => s.id === sid) ?? sourceOne;
        return {
          source_id: matched.id,
          source_sha256: matched.sha256,
          basis: "Source acquisition range",
          channels: [
            { channel: 0, low: 0, high: 4095, gamma: 1, color: "#4da3ff", opacity: 1, visible: true },
            { channel: 1, low: 0, high: 4095, gamma: 1, color: "#52d17c", opacity: 1, visible: true },
          ],
        };
      }
      if (op === "source_annotations") {
        const sid = String(req.source_id ?? sourceOne.id);
        const matched = snapshot?.sources.find((s) => s.id === sid) ?? sourceOne;
        return { source_id: matched.id, source_sha256: matched.sha256, annotations: [] };
      }
      if (op === "source_view") {
        const sid = String(req.source_id ?? sourceOne.id);
        const matched = snapshot?.sources.find((s) => s.id === sid) ?? sourceOne;
        return { source_id: matched.id, source_sha256: matched.sha256, revision: 0, state: null };
      }
      if (op === "save_source_view") {
        const sid = String(req.source_id ?? sourceOne.id);
        const matched = snapshot?.sources.find((s) => s.id === sid) ?? sourceOne;
        return {
          source_id: matched.id,
          source_sha256: matched.sha256,
          revision: Number(req.expected_revision ?? 0) + 1,
          state: req.state ?? null,
        };
      }
      if (op === "view") return { image: pngDataUrl };
      if (op === "model_list") {
        return { models: modelsByStudy ? modelsByStudy() : [] };
      }
      if (op === "model_preview") {
        return {
          preview: { id: "f".repeat(32), preview_sha256: "8".repeat(64) },
          overlay_png: pngDataUrl,
        };
      }
      return {};
    },
  );

  const api: ResearchDesktopApi = {
    createStudy: vi.fn(async () => snapshot),
    openStudy: openStudy ?? vi.fn(async () => snapshot),
    getSnapshot: vi.fn(async () => snapshot),
    addSources: vi.fn(async () => snapshot!),
    sessionState: vi.fn(async () =>
      snapshot
        ? {
            sessionId: "session-1",
            title: snapshot.project.title,
            storage: "managed" as const,
            saved: false,
            status: "ready" as const,
            reason: null,
            canKeep: true,
            canDiscard: true,
          }
        : { status: "empty" as const },
    ),
    openModelLibraryLink: vi.fn(async () => undefined),
    ...(importModel ? { importModel } : {}),
    ...(installNucleiModel ? { installNucleiModel } : {}),
    ...(cancelNucleiModelInstall ? { cancelNucleiModelInstall } : {}),
    execute,
    reviewResult: vi.fn(async () => ({})),
    exportResult: vi.fn(async () => ({})),
    cancelJob: vi.fn(async () => ({})),
  };

  return { api, execute };
}

describe("findInstalledNucleiModel strict engine DTO matching", () => {
  it("matches only exact package.package_sha256 with explicit ready+compatible or reimport-required state", () => {
    const sha = NUCLEI_MODEL_INSTALL.packageSha256;
    expect(formatByteCount(NUCLEI_MODEL_INSTALL.downloadBytes)).toMatch(/MiB|KiB|GiB|B/);
    expect(formatByteCount(NUCLEI_MODEL_INSTALL.workingBytes)).toMatch(/MiB|GiB/);

    // Legacy v7 digest is ignored
    expect(
      findInstalledNucleiModel([
        makeNucleiModelRecord(
          "ready",
          "94259d554d02f43c4d5fa116f0e9e647be4be5c7ed00fb7555b141a9e9f2937b",
        ),
      ]),
    ).toBeNull();

    // Unknown or missing availability.state is NEVER ready
    expect(
      findInstalledNucleiModel([
        {
          model_id: catalogModelId,
          package: { package_sha256: sha },
          reference_qualification: { compatible: true },
        },
        {
          model_id: catalogModelId,
          package: { package_sha256: sha },
          availability: { state: "unknown" },
          reference_qualification: { compatible: true },
        },
      ]),
    ).toBeNull();

    // Ready without reference_qualification.compatible === true is NEVER ready
    expect(
      findInstalledNucleiModel([
        {
          model_id: catalogModelId,
          package: { package_sha256: sha },
          availability: { state: "ready" },
          reference_qualification: { compatible: false },
        },
        {
          model_id: catalogModelId,
          package: { package_sha256: sha },
          availability: { state: "ready" },
        },
      ]),
    ).toBeNull();

    // Alternate digest path without package.package_sha256 is NOT accepted
    expect(
      findInstalledNucleiModel([
        {
          model_id: catalogModelId,
          package: {},
          availability: { state: "ready" },
          reference_qualification: { compatible: true, package_sha256: sha },
        },
      ]),
    ).toBeNull();

    // Explicit reimport-required matches recovery only
    const recovery = makeNucleiModelRecord("reimport-required");
    expect(findInstalledNucleiModel([recovery])).toEqual({
      modelId: catalogModelId,
      state: "reimport-required",
    });

    // Exact ready + compatible matches ready (preferred over recovery)
    const ready = makeNucleiModelRecord("ready", sha, "f".repeat(32));
    expect(findInstalledNucleiModel([recovery, ready])).toEqual({
      modelId: "f".repeat(32),
      state: "ready",
    });
  });
});

describe("Nuclei boundary ONNX explicit study installation", () => {
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

  it("installs explicitly from Model Zoo, prevents duplicate clicks, keeps inference separate, preserves other cards, and transitions cleanly to Use a model", async () => {
    let studyModels: Record<string, unknown>[] = [];
    const pendingInstall = makeDeferred<unknown>();
    const installNucleiModel = vi.fn(() => pendingInstall.promise);
    const cancelNucleiModelInstall = vi.fn(async () => true);

    const { api, execute } = makeWorkbenchApi({
      modelsByStudy: () => studyModels,
      installNucleiModel,
      cancelNucleiModelInstall,
      importModel: vi.fn(async () => ({})),
    });

    render(<ResearchWorkbench api={api} onBack={vi.fn()} />);
    await screen.findByRole("button", { name: /Nuclei Field A\.tif/i });

    fireEvent.click(screen.getByRole("button", { name: "Analyze" }));
    fireEvent.click(await screen.findByRole("button", { name: "Browse Model Zoo…" }));
    const dialog = await screen.findByRole("dialog", { name: /^Model Zoo$/i });
    expect(installNucleiModel).not.toHaveBeenCalled();

    // Other model cards stay untouched
    fireEvent.click(within(dialog).getByRole("button", { name: "Cellpose-SAM v2" }));
    expect(dialog.querySelector('[data-nuclei-install-surface="model-zoo"]')).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Model Zoo" }));

    const nucleiCardBtn = dialog.querySelector<HTMLButtonElement>(
      'article[data-model-id="bioimageio-nuclei-boundary-onnx"] .model-zoo-card__select',
    )!;
    expect(nucleiCardBtn).toHaveAccessibleName("BioImage.IO 2D Nuclei Boundary ONNX");
    fireEvent.click(nucleiCardBtn);

    const installSection = dialog.querySelector<HTMLElement>(
      'section[data-nuclei-install-surface="model-zoo"]',
    )!;
    expect(installSection).toHaveAttribute("data-nuclei-install-state", "not-installed");
    expect(installSection).toHaveTextContent(formatByteCount(NUCLEI_MODEL_INSTALL.downloadBytes));
    expect(installSection).toHaveTextContent(formatByteCount(NUCLEI_MODEL_INSTALL.workingBytes));
    expect(installSection).toHaveTextContent(/BioImage\.IO affable-shark v0/);
    expect(installSection).toHaveTextContent(/Zenodo 6647674/);
    expect(installSection).toHaveTextContent(NUCLEI_MODEL_INSTALL.packageSha256.slice(0, 12));
    expect(installSection).toHaveTextContent(/Does not run inference/i);

    fireEvent.click(
      within(installSection).getByRole("button", { name: "Install for this study" }),
    );
    expect(installNucleiModel).toHaveBeenCalledTimes(1);
    expect(installNucleiModel).toHaveBeenCalledWith(NUCLEI_MODEL_INSTALL.workingBytes);
    expect(installSection).toHaveAttribute("data-nuclei-install-state", "installing");
    const busyBtn = within(installSection).getByRole("button", {
      name: "Installing & verifying…",
    });
    expect(busyBtn).toBeDisabled();
    fireEvent.click(busyBtn);
    expect(installNucleiModel).toHaveBeenCalledTimes(1);
    expect(
      within(installSection).getByRole("button", { name: "Cancel download" }),
    ).toBeEnabled();

    studyModels = [makeNucleiModelRecord("ready")];
    pendingInstall.resolve({ model_id: catalogModelId });

    await waitFor(() =>
      expect(installSection).toHaveAttribute("data-nuclei-install-state", "ready"),
    );
    expect(
      installSection.querySelector('[data-nuclei-install-status][role="status"]'),
    ).toHaveTextContent("Installed and ready in this study (works offline)");
    expect(
      within(installSection).queryByRole("button", { name: "Install for this study" }),
    ).toBeNull();
    expect(execute).not.toHaveBeenCalledWith("model_preview", expect.anything());
    expect(execute).not.toHaveBeenCalledWith("model_run", expect.anything());

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Open Use a model in Analyze" }),
    );
    expect(screen.queryByRole("dialog", { name: /^Model Zoo$/i })).toBeNull();
    expect(await screen.findByLabelText("Model package")).toHaveValue(catalogModelId);
    expect(screen.getByText("Reference check passed.")).toBeVisible();
    expect(execute).not.toHaveBeenCalledWith("model_preview", expect.anything());
    expect(execute).not.toHaveBeenCalledWith("model_run", expect.anything());
  });

  it("selects the catalog memory allowance after reopening a study", async () => {
    const { api } = makeWorkbenchApi({ modelsByStudy: () => [makeNucleiModelRecord()] });
    render(<ResearchWorkbench api={api} onBack={vi.fn()} />);
    await screen.findByRole("button", { name: /Nuclei Field A\.tif/i });
    await openUseAModelTool();
    const selector = await screen.findByLabelText("Model package");
    fireEvent.change(selector, { target: { value: catalogModelId } });
    expect(screen.getByLabelText("Model working memory")).toHaveValue(String(NUCLEI_MODEL_INSTALL.workingBytes));
  });

  it("supports cancellation, actionable failure retry, and preserves offline local import and recovery", async () => {
    let studyModels: Record<string, unknown>[] = [];
    const firstAttempt = makeDeferred<unknown>();
    const cancelDeferred = makeDeferred<boolean>();
    const installNucleiModel = vi
      .fn()
      .mockImplementationOnce(() => firstAttempt.promise)
      .mockRejectedValueOnce(new Error("BioImage.IO returned HTTP 503"));
    const cancelNucleiModelInstall = vi.fn(() => cancelDeferred.promise);
    const importModel = vi.fn(async () => ({}));

    const { api } = makeWorkbenchApi({
      modelsByStudy: () => studyModels,
      installNucleiModel,
      cancelNucleiModelInstall,
      importModel,
    });

    render(<ResearchWorkbench api={api} onBack={vi.fn()} />);
    await screen.findByRole("button", { name: /Nuclei Field A\.tif/i });
    await openUseAModelTool();

    const installSection = await waitFor(() => {
      const node = document.querySelector<HTMLElement>(
        'section[data-nuclei-install-surface="model-panel"]',
      );
      expect(node).not.toBeNull();
      return node!;
    });

    const localImportBtn = screen.getByRole("button", { name: "Import model package…" });
    expect(localImportBtn).toBeEnabled();

    fireEvent.click(
      within(installSection).getByRole("button", { name: "Install for this study" }),
    );
    expect(localImportBtn).toBeDisabled();

    const cancelBtn = within(installSection).getByRole("button", { name: "Cancel download" });
    fireEvent.click(cancelBtn);
    expect(cancelNucleiModelInstall).toHaveBeenCalledTimes(1);
    expect(cancelBtn).toBeDisabled();
    cancelDeferred.resolve(true);
    await waitFor(() =>
      expect(
        installSection.querySelector('[data-nuclei-install-status][role="status"]'),
      ).toHaveTextContent("Cancelling download…"),
    );

    firstAttempt.reject(new Error("Download cancelled"));
    await waitFor(() =>
      expect(installSection).toHaveAttribute("data-nuclei-install-state", "cancelled"),
    );
    expect(localImportBtn).toBeEnabled();

    fireEvent.click(
      within(installSection).getByRole("button", { name: "Install for this study" }),
    );
    const alert = await waitFor(() => {
      const node = installSection.querySelector<HTMLElement>(
        '[data-nuclei-install-error][role="alert"]',
      );
      expect(node).not.toBeNull();
      return node!;
    });
    expect(alert).toHaveTextContent(/HTTP 503/i);
    expect(installSection).toHaveAttribute("data-nuclei-install-state", "failed");

    // Recovery record stays honest and keeps local Re-import model package…
    studyModels = [makeNucleiModelRecord("reimport-required")];
    fireEvent.click(localImportBtn);
    const populatedInstallSection = await waitFor(() => {
      const node = document.querySelector<HTMLElement>(
        'section[data-nuclei-install-surface="model-panel"]',
      );
      expect(node).toHaveAttribute("data-nuclei-install-state", "reimport-required");
      return node!;
    });
    expect(
      within(populatedInstallSection).getByRole("button", { name: "Reinstall for this study" }),
    ).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Model package"), {
      target: { value: catalogModelId },
    });
    expect(screen.getByRole("button", { name: "Re-import model package…" })).toBeEnabled();
  });

  it("preserves study-wide install progress on same-study source switches without overwriting the newer source's mapping/preview, and retires on actual study swap", async () => {
    let activeStudyModels: Record<string, unknown>[] = [makeOtherModelRecord()];
    const sameStudyInstall = makeDeferred<unknown>();
    const studySwapInstall = makeDeferred<unknown>();
    const installNucleiModel = vi
      .fn()
      .mockImplementationOnce(() => sameStudyInstall.promise)
      .mockImplementationOnce(() => studySwapInstall.promise);
    const studyTwoSnapshot = makeSnapshot("study-2", "Second Study", [
      makeSource("9".repeat(32), "Other Study Image.tif", "9".repeat(64)),
    ]);
    const openStudy = vi.fn(async () => {
      activeStudyModels = [];
      return studyTwoSnapshot;
    });

    const { api } = makeWorkbenchApi({
      modelsByStudy: () => activeStudyModels,
      installNucleiModel,
      cancelNucleiModelInstall: vi.fn(async () => true),
      openStudy,
    });

    render(<ResearchWorkbench api={api} onBack={vi.fn()} />);
    await screen.findByRole("button", { name: /Nuclei Field A\.tif/i });
    await openUseAModelTool();

    const installSection = () =>
      document.querySelector<HTMLElement>(
        'section[data-nuclei-install-surface="model-panel"]',
      )!;

    // 1. Start install on Source A, then switch to Source B in the SAME study
    fireEvent.click(
      within(installSection()).getByRole("button", { name: "Install for this study" }),
    );
    expect(installSection()).toHaveAttribute("data-nuclei-install-state", "installing");

    fireEvent.click(screen.getByRole("button", { name: /Nuclei Field B\.tif/i }));
    await waitFor(() =>
      expect(screen.getByLabelText("Active image")).toHaveTextContent("Nuclei Field B.tif"),
    );
    // Progress and Cancel stay live across same-study source switch (no duplicate Install!)
    expect(installSection()).toHaveAttribute("data-nuclei-install-state", "installing");
    expect(
      within(installSection()).getByRole("button", { name: "Installing & verifying…" }),
    ).toBeDisabled();
    expect(
      within(installSection()).getByRole("button", { name: "Cancel download" }),
    ).toBeEnabled();

    // Configure another model + channel mapping + pending preview on Source B
    fireEvent.change(screen.getByLabelText("Model package"), {
      target: { value: otherModelId },
    });
    fireEvent.change(screen.getByLabelText("Model input 1 source channel"), {
      target: { value: "1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview model overlay" }));
    await screen.findByText("Preview ready to save as a result.");

    // Install completes for the study -> status updates to ready, Source B's mapping & preview stay intact!
    activeStudyModels = [makeOtherModelRecord(), makeNucleiModelRecord("ready")];
    sameStudyInstall.resolve({ model_id: catalogModelId });

    await waitFor(() =>
      expect(installSection()).toHaveAttribute("data-nuclei-install-state", "ready"),
    );
    expect(screen.getByLabelText("Model package")).toHaveValue(otherModelId);
    expect(screen.getByLabelText("Model input 1 source channel")).toHaveValue("1");
    expect(screen.getByText("Preview ready to save as a result.")).toBeVisible();
    expect(
      within(installSection()).getByRole("button", { name: "Select installed nuclei model" }),
    ).toBeEnabled();

    // 2. Actual study swap mid-install: start install in Study 2 (after switching), then swap studies
    const fileMenuSummary = document.querySelector<HTMLElement>(
      "details.workbench-file-menu > summary",
    )!;
    fireEvent.click(fileMenuSummary);
    fireEvent.click(
      within(document.querySelector<HTMLElement>("details.workbench-file-menu")!).getByRole(
        "button",
        { name: /Open study/i },
      ),
    );
    await screen.findByRole("button", { name: /Other Study Image\.tif/i });
    await waitFor(() =>
      expect(installSection()).toHaveAttribute("data-nuclei-install-state", "not-installed"),
    );

    // Start install in Study 2, then open Study 3 while pending -> late reply from Study 2 is dropped
    const studyThreeSnapshot = makeSnapshot("study-3", "Third Study", [
      makeSource("8".repeat(32), "Third Study Image.tif", "8".repeat(64)),
    ]);
    openStudy.mockResolvedValueOnce(studyThreeSnapshot);

    fireEvent.click(
      within(installSection()).getByRole("button", { name: "Install for this study" }),
    );
    expect(installSection()).toHaveAttribute("data-nuclei-install-state", "installing");

    fireEvent.click(fileMenuSummary);
    fireEvent.click(
      within(document.querySelector<HTMLElement>("details.workbench-file-menu")!).getByRole(
        "button",
        { name: /Open study/i },
      ),
    );
    await screen.findByRole("button", { name: /Third Study Image\.tif/i });
    await waitFor(() =>
      expect(installSection()).toHaveAttribute("data-nuclei-install-state", "not-installed"),
    );

    studySwapInstall.reject(new Error("Stale Study 2 network error"));
    await Promise.resolve();
    await Promise.resolve();
    expect(installSection()).toHaveAttribute("data-nuclei-install-state", "not-installed");
    expect(
      installSection().querySelector('[data-nuclei-install-error][role="alert"]'),
    ).toBeNull();
  });

  it("disables install when no study is open, fails closed on missing verified record, and omits controls when optional API is absent", async () => {
    // Welcome screen (no open study)
    const welcomeInstall = vi.fn(async () => ({}));
    const welcome = render(
      <ResearchWorkbench
        api={makeWorkbenchApi({ snapshot: null, installNucleiModel: welcomeInstall }).api}
        onBack={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Model Zoo" }));
    const dialog = await screen.findByRole("dialog", { name: /^Model Zoo$/i });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "BioImage.IO 2D Nuclei Boundary ONNX" }),
    );
    const welcomeSection = dialog.querySelector<HTMLElement>(
      'section[data-nuclei-install-surface="model-zoo"]',
    )!;
    expect(welcomeSection).toHaveAttribute("data-nuclei-install-state", "unavailable");
    expect(
      within(welcomeSection).getByRole("button", { name: "Install for this study" }),
    ).toBeDisabled();
    expect(welcomeInstall).not.toHaveBeenCalled();
    welcome.unmount();

    // Fail-closed when install resolves without a verified record in model_list
    const failClosed = render(
      <ResearchWorkbench
        api={makeWorkbenchApi({
          modelsByStudy: () => [],
          installNucleiModel: vi.fn(async () => ({ ok: true })),
        }).api}
        onBack={vi.fn()}
      />,
    );
    await screen.findByRole("button", { name: /Nuclei Field A\.tif/i });
    await openUseAModelTool();
    const panelSection = await waitFor(() => {
      const node = document.querySelector<HTMLElement>(
        'section[data-nuclei-install-surface="model-panel"]',
      );
      expect(node).not.toBeNull();
      return node!;
    });
    fireEvent.click(
      within(panelSection).getByRole("button", { name: "Install for this study" }),
    );
    await waitFor(() =>
      expect(
        panelSection.querySelector('[data-nuclei-install-error][role="alert"]'),
      ).toHaveTextContent(/not found in this study/i),
    );
    failClosed.unmount();

    // Optional API absent -> local offline import stays clean
    render(
      <ResearchWorkbench
        api={makeWorkbenchApi({
          modelsByStudy: () => [],
          importModel: vi.fn(async () => ({})),
        }).api}
        onBack={vi.fn()}
      />,
    );
    await screen.findByRole("button", { name: /Nuclei Field A\.tif/i });
    await openUseAModelTool();
    expect(document.querySelector('[data-nuclei-install-surface="model-panel"]')).toBeNull();
    expect(screen.getByRole("button", { name: "Import model package…" })).toBeEnabled();
  });
});
