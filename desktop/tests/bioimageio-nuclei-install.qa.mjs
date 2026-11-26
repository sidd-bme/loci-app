import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  TWO_GIB,
  close,
  dialogCalls,
  exactNumerics,
  executableFile,
  fileIdentity,
  inside,
  launch,
  noUiError,
  openResearch,
  packageIdentity,
  plainFile,
  previewAndAdopt,
  projectRoot,
  requiredPath,
  run,
  screenshot,
  selectModel,
  visible,
  waitFor,
} from "./research-model-workbench.qa.mjs";
import {
  createEmptyStudy,
  fileMenuAction,
  selectResultSection,
  selectWorkbenchTool,
  setSelectionField,
} from "./workbench-qa-helpers.mjs";

const EXPECTED_ADAPTER = {
  id: "nuclei-segmentation-boundary-model",
  version: "0.1.0-publication-20261015-r2",
  package_sha256:
    "774aa0c53566c9f995af02c905863c0ca86b71460f93c3a11fe101b11c5ba582",
  metadata_sha256:
    "e77c15651c117ded7a9eb73b643c889c4abb41d40024a1294438b767fa6d622d",
  model_sha256:
    "df913b85947f5132bcdaf81d91af0963f60d44f4caf8a4fec672d96a2f327b44",
  reference_input_sha256:
    "c29bd6e16e3f7856217b407ba948222b1c2a0da41922a0f79297e25588614fe2",
  reference_output_sha256:
    "510181f38930e59e4fd8ecc03d6ea7c980eb6609759655f2d4a41fe36108d5f5",
};

const EXPECTED_FIXTURE_SHA256 = {
  source:
    process.env.LOCI_QA_EXPECTED_SOURCE_SHA256 ??
    "502822d7b7f4a7164b6f7e1c2b35807724e1f755efba4678b60b4ea492db3ad9",
  mask:
    process.env.LOCI_QA_EXPECTED_MASK_SHA256 ??
    "e0737550efe11dc9969971947d9095ac0971bf77cfd0f448eeb7592cea7969b3",
};

if (!["darwin", "win32"].includes(process.platform)) {
  throw new Error(
    "Packaged BioImage.IO nuclei install QA supports macOS and Windows only.",
  );
}

const appBundle = requiredPath("LOCI_PACKAGED_APP");
const outputRoot = requiredPath("LOCI_QA_OUTPUT_ROOT");
const sourcePath = requiredPath("LOCI_QA_MODEL_SOURCE");
const maskPath = requiredPath("LOCI_QA_MODEL_MASK");
const referencePackagePath = requiredPath("LOCI_QA_MODEL_PACKAGE");
const offlineExecutablePath = process.env.LOCI_QA_OFFLINE_EXECUTABLE
  ? requiredPath("LOCI_QA_OFFLINE_EXECUTABLE")
  : null;
const sciencePython = process.env.LOCI_QA_PYTHON
  ? requiredPath("LOCI_QA_PYTHON")
  : path.join(projectRoot, "engine", ".venv", "bin", "python");
const scienceScript = path.join(
  projectRoot,
  "scripts",
  "qa",
  "verify_bioimageio_nuclei_science.py",
);

assert.equal(
  !inside(projectRoot, outputRoot) ||
    inside(path.join(projectRoot, ".loci", "evidence"), outputRoot),
  true,
  "LOCI_QA_OUTPUT_ROOT must be outside tracked source or in ignored .loci/evidence.",
);
assert.equal(
  inside(outputRoot, sourcePath) || inside(outputRoot, maskPath),
  false,
  "The source and manual mask fixtures must be independent of QA output.",
);

const executablePath =
  process.platform === "darwin"
    ? path.join(appBundle, "Contents", "MacOS", "Loci")
    : path.join(appBundle, "Loci.exe");
const workerPath =
  process.platform === "darwin"
    ? path.join(appBundle, "Contents", "Resources", "loci-engine", "loci-engine")
    : path.join(appBundle, "resources", "loci-engine", "loci-engine.exe");
const appArchivePath =
  process.platform === "darwin"
    ? path.join(appBundle, "Contents", "Resources", "app.asar")
    : path.join(appBundle, "resources", "app.asar");

const userData = path.join(outputRoot, "user-data");
const reopenUserData = path.join(outputRoot, "reopen-user-data");
const studyParent = path.join(outputRoot, "study");
const studyPath = path.join(studyParent, "bioimageio-nuclei-install.loci-study");
const exportParent = path.join(outputRoot, "export");
const exportInitialPath = path.join(exportParent, "initial-model-result");
const exportCorrectedPath = path.join(exportParent, "corrected-model-result");
const screenshots = path.join(outputRoot, "screenshots");
const reportPath = path.join(outputRoot, "qa-report.json");
const failurePath = path.join(outputRoot, "qa-failure.json");

function offlineEnv() {
  return {
    ...process.env,
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "",
  };
}

async function installStudyDialogs(app, config) {
  await app.evaluate(({ dialog }, cfg) => {
    globalThis.__lociModelQaDialogCalls = [];
    globalThis.__lociExportDestination = cfg.exportPath ?? null;
    const record = (kind, title) =>
      globalThis.__lociModelQaDialogCalls.push({ kind, title });
    dialog.showOpenDialog = async (...args) => {
      const title = args.at(-1)?.title;
      record("open", title);
      const selected = cfg.openByTitle[title];
      if (selected) return { canceled: false, filePaths: [selected] };
      throw new Error(`Unexpected open dialog: ${String(title)}`);
    };
    dialog.showSaveDialog = async (...args) => {
      const title = args.at(-1)?.title;
      record("save", title);
      if (title === "Export reviewed result bundle" && globalThis.__lociExportDestination) {
        return { canceled: false, filePath: globalThis.__lociExportDestination };
      }
      const selected = cfg.saveByTitle?.[title];
      if (selected) return { canceled: false, filePath: selected };
      throw new Error(`Unexpected save dialog: ${String(title)}`);
    };
    dialog.showMessageBox = async () => ({
      response: 0,
      checkboxChecked: false,
    });
  }, config);
}

async function launchOffline(userDataDir, messages, initialExportDir) {
  const sessionApp = await launch(userDataDir, messages, {
    executablePath: offlineExecutablePath ?? executablePath,
    env: offlineEnv(),
  });
  await sessionApp.app.evaluate(({ session }) => {
    globalThis.__lociOfflineBlockedRequests = [];
    session.defaultSession.enableNetworkEmulation({ offline: true });
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      if (/^https?:/iu.test(details.url)) {
        globalThis.__lociOfflineBlockedRequests.push(details.url);
        callback({ cancel: true });
        return;
      }
      callback({ cancel: false });
    });
  });
  await installStudyDialogs(sessionApp.app, {
    openByTitle: { "Open research study": studyPath },
    exportPath: initialExportDir,
  });
  await openResearch(sessionApp.page);
  await visible(
    sessionApp.page,
    sessionApp.page.getByRole("button", { name: "Open study", exact: true }),
    "offline study reopen trigger",
  );
  await sessionApp.page.getByRole("button", { name: "Open study", exact: true }).click();
  await visible(
    sessionApp.page,
    sessionApp.page.getByRole("main", { name: "Research workspace" }),
    "offline reopened workspace",
  );
  return sessionApp;
}

async function assertNoBlockedRequests(app, label) {
  const blocked = await app.evaluate(() => [...(globalThis.__lociOfflineBlockedRequests ?? [])]);
  assert.deepEqual(
    blocked,
    [],
    `Unexpected network requests attempted during ${label}: ${blocked.join(", ")}`,
  );
}

function assertModelIdentity(model) {
  assert.equal(model.package.id, EXPECTED_ADAPTER.id);
  assert.equal(model.package.version, EXPECTED_ADAPTER.version);
  assert.equal(model.package.package_sha256, EXPECTED_ADAPTER.package_sha256);
  assert.equal(model.package.metadata_sha256, EXPECTED_ADAPTER.metadata_sha256);
  assert.equal(model.package.model.sha256, EXPECTED_ADAPTER.model_sha256);
  assert.equal(
    model.package.reference.input.sha256,
    EXPECTED_ADAPTER.reference_input_sha256,
  );
  assert.equal(
    model.package.reference.output.sha256,
    EXPECTED_ADAPTER.reference_output_sha256,
  );
  assert.equal(model.reference_qualification.compatible, true);
  assert.equal(model.reference_qualification.comparison.mismatched_elements, 0);
  assert.equal(model.import_working_bytes, TWO_GIB);
}

async function reviewAndExport(page, resultId, label) {
  await selectWorkbenchTool(page, "Info");
  await selectResultSection(page, "Review");
  await page.getByRole("button", { name: "Mark reviewed", exact: true }).click();
  await waitFor(
    page,
    () => page.evaluate(() => window.lociResearch.getSnapshot()),
    (snap) =>
      snap.results.some(
        (item) => item.id === resultId && item.review?.disposition === "reviewed",
      ),
    `${label} reviewed`,
  );
  await selectResultSection(page, "Export");
  await page.getByRole("button", { name: "Export result", exact: true }).click();
  await waitFor(
    page,
    () => fs.stat(path.join(label, "manifest.json")).catch(() => null),
    (stat) => stat?.isFile() === true && stat.size > 0,
    `${label} manifest`,
  );
}

async function verifyExportBundle(exportDir, extraArgs = []) {
  const args = [
    scienceScript,
    "--export-dir",
    exportDir,
    "--image",
    sourcePath,
    "--mask",
    maskPath,
    "--package",
    referencePackagePath,
    "--expected-image-sha256",
    EXPECTED_FIXTURE_SHA256.source,
    "--expected-mask-sha256",
    EXPECTED_FIXTURE_SHA256.mask,
    ...extraArgs,
  ];
  const out = await run(sciencePython, args, {
    cwd: projectRoot,
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const parsed = JSON.parse(out.stdout);
  assert.equal(parsed.status, "passed");
  return parsed;
}

await Promise.all([
  plainFile(sourcePath, "Public scalar fluorescence source"),
  plainFile(maskPath, "Public BBBC039 manual instance labels"),
  plainFile(executablePath, "Packaged application executable", true),
  plainFile(workerPath, "Packaged engine executable", true),
  plainFile(appArchivePath, "Packaged app archive"),
  executableFile(sciencePython, "Science verification Python"),
  plainFile(scienceScript, "Independent export verification script"),
  ...(offlineExecutablePath
    ? [executableFile(offlineExecutablePath, "Strict offline application wrapper")]
    : []),
]);

const [
  sourceBefore,
  maskBefore,
  refPkgIdentity,
  executableIdentity,
  workerIdentity,
  archiveIdentity,
  offlineExecutableIdentity,
] = await Promise.all([
  fileIdentity(sourcePath),
  fileIdentity(maskPath),
  packageIdentity(referencePackagePath),
  fileIdentity(executablePath),
  fileIdentity(workerPath),
  fileIdentity(appArchivePath),
  offlineExecutablePath ? fileIdentity(offlineExecutablePath) : null,
]);

assert.equal(
  sourceBefore.sha256,
  EXPECTED_FIXTURE_SHA256.source,
  `Source image SHA-256 mismatch: expected ${EXPECTED_FIXTURE_SHA256.source}, got ${sourceBefore.sha256}`,
);
assert.equal(
  maskBefore.sha256,
  EXPECTED_FIXTURE_SHA256.mask,
  `Manual mask SHA-256 mismatch: expected ${EXPECTED_FIXTURE_SHA256.mask}, got ${maskBefore.sha256}`,
);
assert.equal(refPkgIdentity.package_sha256, EXPECTED_ADAPTER.package_sha256);

await fs.mkdir(outputRoot, { recursive: false });
await Promise.all([
  fs.mkdir(userData),
  fs.mkdir(reopenUserData),
  fs.mkdir(studyParent),
  fs.mkdir(exportParent),
  fs.mkdir(screenshots),
]);

let app;
let page;
const installMessages = [];
const offlineMessages = [];
const reopenMessages = [];

try {
  // Phase 1: Clean study + clean userData + explicit Model Zoo install (real network)
  ({ app, page } = await launch(userData, installMessages, { executablePath }));
  await installStudyDialogs(app, {
    openByTitle: { "Add microscopy or medical images": sourcePath },
    saveByTitle: { "Create research study": studyPath },
  });
  await openResearch(page);

  await createEmptyStudy(page);
  await visible(
    page,
    page.getByRole("main", { name: "Research workspace" }),
    "new research workspace",
  );
  await page.getByRole("button", { name: "Add images…", exact: true }).click();
  const importedSnapshot = await waitFor(
    page,
    () => page.evaluate(() => window.lociResearch.getSnapshot()),
    (value) => value?.sources.length === 1,
    "public fluorescence source import snapshot",
    120_000,
  );
  const source = importedSnapshot.sources[0];
  assert.equal(source.name, path.basename(sourcePath));
  assert.equal(source.sha256, sourceBefore.sha256);
  const { c, s, t, x, y, z } = source.metadata.dimensions;
  assert.deepEqual({ c, s, t, z }, { c: 1, s: 1, t: 1, z: 1 });
  assert.ok(x > 0 && y > 0, "Source plane must have positive dimensions");

  await selectWorkbenchTool(page, "Display");
  for (const [label, value] of [
    ["C", "0"],
    ["Z", "0"],
    ["T", "0"],
    ["X", "0"],
    ["Y", "0"],
    ["Width", String(x)],
    ["Height", String(y)],
  ]) {
    await setSelectionField(page, label, value);
  }

  await fileMenuAction(page, "Model Zoo…");
  const zoo = await visible(
    page,
    page.getByRole("dialog", { name: "Model Zoo", exact: true }),
    "Model Zoo dialog",
  );
  await zoo
    .locator(
      'article[data-model-id="bioimageio-nuclei-boundary-onnx"] .model-zoo-card__select',
    )
    .click();

  const zooInstallSection = await visible(
    page,
    zoo.locator('section[data-nuclei-install-surface="model-zoo"]'),
    "BioImage.IO nuclei install section",
  );
  assert.equal(
    await zooInstallSection.getAttribute("data-nuclei-install-state"),
    "not-installed",
  );
  await screenshot(page, "01-before-install", screenshots);

  await zooInstallSection
    .getByRole("button", { name: "Install for this study", exact: true })
    .click();

  const installDeadline = Date.now() + 600_000;
  let installState = null;
  while (Date.now() < installDeadline) {
    await noUiError(page, "installing BioImage.IO nuclei model");
    const inlineAlert = zooInstallSection.locator(
      '[data-nuclei-install-error][role="alert"]',
    );
    if (await inlineAlert.isVisible().catch(() => false)) {
      throw new Error(
        `Model Zoo install failed: ${(await inlineAlert.textContent()) ?? "unknown error"}`,
      );
    }
    installState = await zooInstallSection.getAttribute("data-nuclei-install-state");
    if (installState === "ready") break;
    if (
      installState === "failed" ||
      installState === "cancelled" ||
      installState === "unavailable"
    ) {
      throw new Error(`Model Zoo install entered terminal state: ${installState}`);
    }
    await page.waitForTimeout(250);
  }
  assert.equal(
    installState,
    "ready",
    `Timed out waiting for BioImage.IO nuclei install; last state: ${String(installState)}`,
  );
  assert.match(
    (await zooInstallSection
      .locator('[data-nuclei-install-status][role="status"]')
      .textContent()) ?? "",
    /Installed and ready in this study \(works offline\)/u,
  );
  await screenshot(page, "02-installed-ready", screenshots);

  const afterInstallModels = await page.evaluate(() =>
    window.lociResearch.execute("model_list", {}),
  );
  assert.equal(afterInstallModels.models.length, 1);
  const installedModel = afterInstallModels.models[0];
  assertModelIdentity(installedModel);

  const postInstallSnapshot = await page.evaluate(() =>
    window.lociResearch.getSnapshot(),
  );
  assert.equal(
    postInstallSnapshot.results.length,
    0,
    "Explicit install must remain separate from inference/preview execution",
  );

  await zoo
    .getByRole("button", { name: "Open Use a model in Analyze", exact: true })
    .click();
  await zoo.waitFor({ state: "hidden", timeout: 30_000 });
  await visible(
    page,
    page
      .locator(".research-model-records")
      .filter({ hasText: "Reference check passed." }),
    "selected model after Model Zoo handoff",
  );
  assert.equal(
    await page.getByLabel("Model package").inputValue(),
    installedModel.model_id,
  );
  const installCalls = await dialogCalls(app);
  assert.deepEqual(installCalls, [
    { kind: "save", title: "Create research study" },
    { kind: "open", title: "Add microscopy or medical images" },
  ]);
  await close(app);
  app = undefined;
  page = undefined;

  // Phase 2: Offline preview, initial export, independent verification, false-positive edit, export
  ({ app, page } = await launchOffline(
    userData,
    offlineMessages,
    exportInitialPath,
  ));
  await selectWorkbenchTool(page, "Model");
  const modelPanelInstall = await visible(
    page,
    page.locator('section[data-nuclei-install-surface="model-panel"][data-nuclei-install-state="ready"]'),
    "Use a model install status",
  );
  assert.equal(
    await modelPanelInstall.getAttribute("data-nuclei-install-state"),
    "ready",
  );
  assert.match(
    (await modelPanelInstall
      .locator('[data-nuclei-install-status][role="status"]')
      .textContent()) ?? "",
    /Installed and ready in this study \(works offline\)/u,
  );
  await selectModel(page, installedModel.model_id);
  await page.getByLabel("Model segmentation method").selectOption("components");
  await page.getByLabel("Model threshold", { exact: true }).fill("0.5");
  await page.getByLabel("Model threshold", { exact: true }).press("Enter");

  const initialRun = await previewAndAdopt(
    page,
    new Set(),
    "03-offline-initial",
    screenshots,
  );
  const initialRecord = initialRun.record;
  assert.equal(initialRecord.result.kind, "model-segmentation");
  assert.equal(
    initialRecord.provenance.model.package_sha256,
    EXPECTED_ADAPTER.package_sha256,
  );
  assert.equal(initialRecord.provenance.source_scale.resampled, false);
  assert.deepEqual(initialRecord.provenance.measurement_channels, [0]);
  assert.equal(initialRecord.provenance.geometry.unit, "pixel");
  assert.ok(initialRecord.measurements.length > 0);

  await reviewAndExport(page, initialRecord.result.id, exportInitialPath);
  const initialScience = await verifyExportBundle(exportInitialPath);
  assert.equal(
    initialScience.measurement_parity.row_count,
    initialRecord.measurements.length,
  );
  assert.equal(
    initialScience.independent_ort.components_label_parity_with_initial,
    true,
  );
  const deletedLabel = initialScience.recommended_false_positive.label;
  assert.ok(Number.isInteger(deletedLabel) && deletedLabel > 0);

  await selectWorkbenchTool(page, "Correction");
  const correctionLabel = page.getByLabel("Correction label", { exact: true });
  await visible(page, correctionLabel, "Correction label selector");
  await waitFor(
    page,
    () => correctionLabel.isDisabled(),
    (disabled) => disabled === false,
    "enabled Correction label selector",
  );
  const availableLabels = await correctionLabel
    .locator("option")
    .evaluateAll((opts) =>
      opts.map((opt) => Number(opt.value)).filter((n) => Number.isInteger(n) && n > 0),
    );
  assert.ok(
    availableLabels.includes(deletedLabel),
    `Recommended false-positive label ${deletedLabel} missing from Correction selector`,
  );
  await correctionLabel.selectOption(String(deletedLabel));

  const beforeCorrectionIds = new Set(
    (await page.evaluate(() => window.lociResearch.getSnapshot())).results.map(
      (item) => item.id,
    ),
  );
  await page
    .getByRole("button", { name: "Delete selected label", exact: true })
    .click();
  const correctedSnapshot = await waitFor(
    page,
    () => page.evaluate(() => window.lociResearch.getSnapshot()),
    (value) => value.results.some((item) => !beforeCorrectionIds.has(item.id)),
    "corrected label child result",
    120_000,
  );
  const correctedSummary = correctedSnapshot.results.find(
    (item) => !beforeCorrectionIds.has(item.id),
  );
  assert.ok(correctedSummary, "Correction did not publish a child result");
  const correctedRecord = await page.evaluate(
    (result_id) => window.lociResearch.execute("result", { result_id }),
    correctedSummary.id,
  );
  assert.equal(correctedRecord.result.kind, "corrected-labels");
  assert.equal(correctedRecord.result.parent_id, initialRecord.result.id);
  assert.equal(correctedSummary.object_count, initialRun.summary.object_count - 1);
  assert.equal(correctedRecord.provenance.correction.operations.length, 1);
  assert.equal(correctedRecord.provenance.correction.operations[0].op, "delete");
  assert.equal(correctedRecord.provenance.correction.operations[0].label, deletedLabel);

  const parentAfterCorrection = await page.evaluate(
    (result_id) => window.lociResearch.execute("result", { result_id }),
    initialRecord.result.id,
  );
  assert.deepEqual(
    exactNumerics(parentAfterCorrection),
    exactNumerics(initialRecord),
    "Correction mutated the parent result",
  );
  await screenshot(page, "04-offline-corrected", screenshots);

  await app.evaluate((_, dest) => {
    globalThis.__lociExportDestination = dest;
  }, exportCorrectedPath);
  await reviewAndExport(page, correctedRecord.result.id, exportCorrectedPath);
  await assertNoBlockedRequests(app, "offline phase 2");
  const offlineCalls = await dialogCalls(app);
  const runtime = await app.evaluate(({ app: electronApp }) => ({
    application_version: electronApp.getVersion(),
    electron: process.versions.electron,
    platform: process.platform,
    arch: process.arch,
  }));
  await close(app);
  app = undefined;
  page = undefined;

  // Phase 3: Fresh userData cold reopen offline
  ({ app, page } = await launchOffline(
    reopenUserData,
    reopenMessages,
    exportCorrectedPath,
  ));
  const reopenedSnapshot = await page.evaluate(() =>
    window.lociResearch.getSnapshot(),
  );
  assert.equal(reopenedSnapshot.sources.length, 1);
  assert.equal(reopenedSnapshot.sources[0].sha256, sourceBefore.sha256);
  assert.equal(reopenedSnapshot.results.length, 2);

  const reopenedModels = await page.evaluate(() =>
    window.lociResearch.execute("model_list", {}),
  );
  assert.equal(reopenedModels.models.length, 1);
  assertModelIdentity(reopenedModels.models[0]);

  const [reopenedInitial, reopenedCorrected] = await Promise.all([
    page.evaluate(
      (result_id) => window.lociResearch.execute("result", { result_id }),
      initialRecord.result.id,
    ),
    page.evaluate(
      (result_id) => window.lociResearch.execute("result", { result_id }),
      correctedRecord.result.id,
    ),
  ]);
  assert.deepEqual(exactNumerics(reopenedInitial), exactNumerics(initialRecord));
  assert.deepEqual(exactNumerics(reopenedCorrected), exactNumerics(correctedRecord));
  assert.equal(reopenedInitial.result.review.disposition, "reviewed");
  assert.equal(reopenedCorrected.result.review.disposition, "reviewed");

  await page
    .locator(`.research-sources [data-result-id="${correctedRecord.result.id}"]`)
    .click();
  const overlayKey = `${correctedRecord.result.id}:${correctedRecord.result.revision_hash}`;
  await visible(
    page,
    page.locator(
      `.image-viewport[data-viewer-source="${correctedRecord.result.source_id}"][data-result-overlay="${overlayKey}"][data-prepared="true"]`,
    ),
    "reopened corrected overlay",
  );
  await screenshot(page, "05-reopened-offline", screenshots);
  await assertNoBlockedRequests(app, "offline phase 3 reopen");
  const reopenCalls = await dialogCalls(app);
  await close(app);
  app = undefined;
  page = undefined;

  // Phase 4: Verify corrected export against parent export & check source/mask immutability
  const correctedScience = await verifyExportBundle(exportCorrectedPath, [
    "--parent-export-dir",
    exportInitialPath,
    "--deleted-label",
    String(deletedLabel),
  ]);
  assert.ok(correctedScience.correction_verification.changed_voxel_count > 0);

  const [sourceAfter, maskAfter] = await Promise.all([
    fileIdentity(sourcePath),
    fileIdentity(maskPath),
  ]);
  assert.deepEqual(sourceAfter, sourceBefore, "Source image mutated during QA");
  assert.deepEqual(maskAfter, maskBefore, "Manual mask mutated during QA");

  const publicPayload = JSON.stringify({
    importedSnapshot,
    afterInstallModels,
    reopenedModels,
    initialRecord,
    correctedRecord,
    reopenedSnapshot,
  });
  for (const privatePath of [
    sourcePath,
    maskPath,
    referencePackagePath,
    outputRoot,
    studyPath,
    exportInitialPath,
    exportCorrectedPath,
  ]) {
    assert.equal(
      publicPayload.includes(privatePath),
      false,
      `Renderer-safe payload disclosed a private path: ${privatePath}`,
    );
  }

  const report = {
    schema: "loci.bioimageio-nuclei-install-packaged-qa/v2",
    status: "passed",
    offline_coverage: {
      mode: offlineExecutablePath
        ? "native-network-denied-wrapper"
        : "electron-session-and-proxy-guard-only",
      phase2_offline_executable: offlineExecutableIdentity ?? executableIdentity,
      phase3_reopen_executable: offlineExecutableIdentity ?? executableIdentity,
    },
    paths: {
      app_bundle: appBundle,
      source: sourcePath,
      mask: maskPath,
      package: referencePackagePath,
      output_root: outputRoot,
      study: studyPath,
      export_initial: exportInitialPath,
      export_corrected: exportCorrectedPath,
    },
    package_identity: {
      executable: executableIdentity,
      worker: workerIdentity,
      app_archive: archiveIdentity,
    },
    runtime,
    dialog_calls: {
      install: installCalls,
      offline: offlineCalls,
      reopen: reopenCalls,
    },
    original_source: { before: sourceBefore, after: sourceAfter },
    manual_mask: { before: maskBefore, after: maskAfter },
    installed_model: installedModel,
    initial_result: exactNumerics(initialRecord),
    corrected_result: {
      deleted_label: deletedLabel,
      deleted_label_max_iou_with_manual:
        initialScience.recommended_false_positive.max_iou_with_manual,
      ...exactNumerics(correctedRecord),
    },
    independent_science_verification: {
      initial: initialScience,
      corrected: correctedScience,
    },
    renderer_messages: {
      install: installMessages,
      offline: offlineMessages,
      reopen: reopenMessages,
    },
    screenshots: (await fs.readdir(screenshots)).sort(),
  };
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  const failure = {
    schema: "loci.bioimageio-nuclei-install-packaged-qa-failure/v1",
    status: "failed",
    error:
      error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : { name: "Unknown", message: String(error) },
    dialog_calls: app ? await dialogCalls(app).catch(() => []) : [],
    renderer_messages: {
      install: installMessages,
      offline: offlineMessages,
      reopen: reopenMessages,
    },
  };
  if (page) {
    failure.screenshot = await screenshot(page, "failure", screenshots).catch(
      () => null,
    );
    failure.ui_text = await page
      .locator("body")
      .innerText()
      .catch(() => "UI unavailable");
  }
  await fs.writeFile(failurePath, `${JSON.stringify(failure, null, 2)}\n`);
  process.stderr.write(`${JSON.stringify(failure, null, 2)}\n`);
  throw error;
} finally {
  if (app) await app.close().catch(() => undefined);
}
