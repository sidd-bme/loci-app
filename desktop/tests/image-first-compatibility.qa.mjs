import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";

import { _electron as electron } from "playwright";
import { selectWorkbenchTool } from "./workbench-qa-helpers.mjs";

const run = promisify(execFile);
const desktopRoot = path.resolve(import.meta.dirname, "..");
const projectRoot = path.resolve(desktopRoot, "..");
const engineRoot = path.join(projectRoot, "engine");
const development = process.env.LOCI_QA_DEV === "1";
const defaultBundle = path.join(
  desktopRoot, "..", ".loci", "builds", "current", "Loci.app",
);
const appBundle = path.resolve(process.env.LOCI_PACKAGED_APP ?? defaultBundle);
const qualificationRoot = path.resolve(
  process.env.LOCI_QA_OUTPUT_ROOT ??
    path.resolve(import.meta.dirname, `../../.loci/evidence/qa/image-first/compatibility-${development ? "development" : "packaged"}`),
);
const runName = new Date().toISOString().replaceAll(/[:.]/g, "-");
const runRoot = path.join(qualificationRoot, runName);
const userData = path.join(runRoot, "user-data");
const screenshots = path.join(runRoot, "screenshots");
const workingRoot = path.join(userData, "working-results");
const jobId = "legacy_job_1";
const jobRoot = path.join(workingRoot, jobId);
const sourcePath = path.join(runRoot, "legacy-cells.png");
const legacyProjectPath = path.join(runRoot, "reviewed-corrected.loci-project");
const savedStudyPath = path.join(runRoot, "reviewed-corrected.loci-study");
const temporarilyMovedStudyPath = path.join(runRoot, "temporarily-moved.loci-study");
const executablePath = development
  ? path.join(desktopRoot, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron")
  : path.join(appBundle, "Contents", "MacOS", "Loci");
const workerExecutable = development
  ? path.join(engineRoot, ".venv", "bin", "python")
  : path.join(appBundle, "Contents", "Resources", "loci-engine", "loci-engine");
const workerArguments = development ? ["-m", "loci_engine.worker"] : [];
const workerCwd = development ? engineRoot : runRoot;
const archiveArtifact = path.join(appBundle, "Contents", "Resources", "app.asar");
const mainArtifact = path.join(desktopRoot, ".vite", "build", "main.js");
const preloadArtifact = path.join(desktopRoot, ".vite", "build", "preload.js");
const rendererSource = path.join(
  desktopRoot,
  "src",
  "renderer",
  "main.tsx",
);
const sourcePngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAGAAAABQCAAAAADDiS9JAAAA3UlEQVR4nO2XQQ6DMBADYdUTT/D/3+Z3cOqprbyJN4CqnRNKiAccJJT92NYSi/O3Fki6IklXJOmKJF3R/RW9sjfyfYExwX4MpY87MgJ+DqFQwO/DqNpkDo6PCjgxMyLg5FxWQGM2I1AJNAV6PT1BCeEVQEdQQ5hfIecFRcRtAiYDOCuoIlqg6IoeXBGSAZgVVBH3CZBaj3lBEbFZrwBHUENYjwdPINdD54uKYOerPYCbLzcZZr7+iuDlP+GMdsEp84JzssE//w+KiKqgX7RA0hVJuiJJVyTpiiTLKzoBBEEZ6xC4gDUAAAAASUVORK5CYII=";

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("The compatibility journey currently qualifies Apple-silicon macOS.");
}
await Promise.all([
  fs.mkdir(jobRoot, { recursive: true, mode: 0o700 }),
  fs.mkdir(screenshots, { recursive: true, mode: 0o700 }),
  fs.access(executablePath),
  fs.access(workerExecutable),
  ...(development
    ? [fs.access(mainArtifact), fs.access(preloadArtifact), fs.access(rendererSource)]
    : [fs.access(archiveArtifact)]),
]);

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function workingSourceSha256() {
  const { stdout } = await run(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: projectRoot, maxBuffer: 16 * 1024 * 1024 },
  );
  const digest = createHash("sha256");
  for (const relative of stdout.split("\0").filter(Boolean).sort()) {
    const file = path.join(projectRoot, relative);
    const status = await fs.lstat(file).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    digest.update(relative).update("\0");
    if (!status) digest.update("deleted\0");
    else if (status.isSymbolicLink()) {
      digest.update("symlink\0").update(await fs.readlink(file)).update("\0");
    } else if (status.isFile()) {
      digest.update("file\0").update(await sha256(file)).update("\0");
    } else {
      digest.update(`unsupported-${status.mode}\0`);
    }
  }
  return digest.digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function preservedDocumentIdentity(snapshot) {
  return {
    project: snapshot.project,
    sources: snapshot.sources,
    results: snapshot.results,
    samples: snapshot.samples,
    recipes: snapshot.recipes,
    displays: snapshot.displays.map(({ revision: _revision, updated_at: _updatedAt, ...display }) => display),
    channels: snapshot.channels,
    selections: snapshot.selections,
    comparisons: snapshot.comparisons,
    jobs: snapshot.jobs,
  };
}

async function frozenWorkerFixture() {
  await fs.writeFile(sourcePath, Buffer.from(sourcePngBase64, "base64"), { mode: 0o600 });
  const child = spawn(workerExecutable, workerArguments, {
    cwd: workerCwd,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: "1",
      LOCI_MODEL_HOME: path.join(userData, "models"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  lines.on("line", (line) => {
    let response;
    try { response = JSON.parse(line); }
    catch (error) {
      for (const request of pending.values()) request.reject(error);
      pending.clear();
      return;
    }
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    if (response.error) request.reject(new Error(response.error.message));
    else request.resolve(response.result);
  });
  child.once("exit", (code) => {
    if (code && pending.size) {
      const error = new Error(`Frozen fixture worker exited ${code}: ${stderr.join("")}`);
      for (const request of pending.values()) request.reject(error);
      pending.clear();
    }
  });
  let sequence = 0;
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = `fixture-${++sequence}`;
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  const segmented = await request("segment", {
    path: sourcePath,
    settings: {
      image_mode: "fluorescence",
      expected_diameter_px: 35,
      min_area_px: 50,
    },
  });
  const original = await request("publish_working_result", {
    result_id: segmented.result_id,
    directory: jobRoot,
  });
  await request("delete_instance", {
    result_id: segmented.result_id,
    x: 44,
    y: 38,
  });
  const corrected = await request("add_polygon", {
    result_id: segmented.result_id,
    points: [
      { x: 12, y: 12 },
      { x: 28, y: 12 },
      { x: 28, y: 28 },
      { x: 12, y: 28 },
    ],
  });
  const active = await request("publish_working_result", {
    result_id: segmented.result_id,
    directory: jobRoot,
  });
  child.stdin.end();
  await new Promise((resolve) => child.once("close", resolve));
  await fs.writeFile(path.join(runRoot, "fixture-worker-stderr.log"), stderr.join(""));
  assert.equal(corrected.corrections.revision, 2);
  assert.equal(active.pack.sha256, await sha256(path.join(jobRoot, active.pack.basename)));
  return { segmented, corrected, original: original.pack, active: active.pack };
}

function artifact(pack) {
  return {
    artifactId: "working-result",
    filename: pack.basename,
    mediaType: "application/vnd.loci.working-result+zip",
    byteLength: pack.size_bytes,
    sha256: pack.sha256,
  };
}

async function writeLegacyProject(fixture) {
  const sourceSha256 = fixture.segmented.source.sha256;
  const fingerprint = {
    status: "verified",
    algorithm: "sha256",
    sha256: sourceSha256,
    verifiedAt: "2026-09-08T00:00:00.000Z",
  };
  const settings = fixture.segmented.settings;
  const settingsSha256 = createHash("sha256").update(stableJson(settings)).digest("hex");
  const originalArtifact = artifact(fixture.original);
  const activeArtifact = artifact(fixture.active);
  const resultId = fixture.segmented.result_id;
  const operationIds = fixture.corrected.corrections.applied_operations.map(
    (operation) => operation.operation_id,
  );
  const descriptor = {
    schemaVersion: "loci.source-descriptor/v1",
    displayName: "Legacy cells corrected",
    relativeLabel: "legacy-cells.png",
    format: "PNG",
    formatAdapter: "raster",
    dimensions: { width: 96, height: 80 },
    axes: [
      { name: "X", length: 96, unit: null, spacing: null },
      { name: "Y", length: 80, unit: null, spacing: null },
    ],
    channels: [{
      index: 0,
      name: "intensity",
      dtype: "uint8",
      colorSource: "not-applicable",
      rangeSource: "dtype",
    }],
    colorModel: "intensity",
    calibration: null,
    pyramid: null,
    chunks: { storage: "striped", shape: null },
    access: {
      mode: "full",
      canRender: true,
      canAnalyze: true,
      canExportRenderedView: true,
      canExportNativeData: false,
      provisionalUntilFingerprintVerified: false,
      reason: null,
    },
    fingerprint,
    ambiguity: [{
      code: "biological-purpose-unknown",
      summary: "The biological purpose is not inferred from pixels.",
    }],
  };
  const createdAt = "2026-09-08T00:00:01.000Z";
  const completedAt = "2026-09-08T00:00:03.000Z";
  const resultManifestId = "legacy_manifest_1";
  const manifest = {
    schemaVersion: "loci.project/v1",
    projectId: "legacy_project_1",
    title: "Reviewed corrected legacy study",
    createdAt: "2026-09-08T00:00:00.000Z",
    updatedAt: "2026-09-08T00:00:04.000Z",
    appVersion: "0.1.0",
    sources: [{
      sourceId: "legacy_source_1",
      displayName: "Legacy cells corrected",
      relativeLabel: "legacy-cells.png",
      fingerprint,
      inspectionStatus: "ready",
      inspectionFailure: null,
      descriptor,
      workspace: {
        schemaVersion: "loci.workspace-recommendation/v1",
        inferredWorkspace: "generic-2d",
        workspace: "generic-2d",
        decision: "safe-default",
        evidence: [{
          code: "ambiguous-single-plane",
          summary: "The source has no unambiguous structural marker for a specialist workspace.",
        }],
        applicablePresets: [
          "generic-display",
          "brightfield-cell",
          "fluorescence",
          "h-and-e-display",
        ],
        requiredCapabilities: [],
        userOverride: null,
        analysis: {
          autoRun: false,
          recommendedModelId: null,
          reason: "Loci does not infer a biological analysis task or start analysis from image structure alone.",
        },
      },
    }],
    displayRecipes: [],
    annotations: [],
    corrections: [{
      correctionId: "legacy_correction_1",
      sourceId: "legacy_source_1",
      resultId,
      revision: 2,
      operationIds,
      workingResultArtifact: activeArtifact,
    }],
    modelResults: [{
      resultId,
      sourceId: "legacy_source_1",
      modelId: fixture.segmented.profile.id,
      modelSha256: fixture.segmented.profile.model.sha256,
      evidenceStatus: "experimental",
      createdAt,
      resultManifestId,
    }],
    reviews: [{
      reviewId: "legacy_review_1",
      sourceId: "legacy_source_1",
      resultId,
      correctionRevision: 2,
      disposition: "reviewed",
      decidedAt: "2026-09-08T00:00:04.000Z",
      note: "Synthetic QA fixture reviewed at corrected revision 2.",
    }],
    jobs: [{
      spec: {
        schemaVersion: "loci.job-spec/v1",
        jobId,
        kind: "segment",
        createdAt,
        executionTarget: { kind: "local" },
        inputs: [{
          sourceId: "legacy_source_1",
          fingerprintSha256: sourceSha256,
          byteLength: (await fs.stat(sourcePath)).size,
        }],
        operation: {
          profileId: fixture.segmented.profile.id,
          modelId: fixture.segmented.profile.id,
          modelSha256: fixture.segmented.profile.model.sha256,
          settings,
        },
        resources: {
          cpuCores: 1,
          memoryMiB: 512,
          gpuCount: 0,
          walltimeMinutes: 5,
        },
        expectedOutputs: [{
          artifactId: "working-result",
          mediaType: "application/vnd.loci.working-result+zip",
        }],
      },
      events: [
        {
          schemaVersion: "loci.job-event/v1",
          jobId,
          sequence: 0,
          occurredAt: createdAt,
          state: "staging",
          progress: 0,
          message: "Preparing verified synthetic source.",
          reasonCode: null,
          schedulerState: null,
        },
        {
          schemaVersion: "loci.job-event/v1",
          jobId,
          sequence: 1,
          occurredAt: "2026-09-08T00:00:02.000Z",
          state: "running",
          progress: 0.5,
          message: "Segmenting synthetic source.",
          reasonCode: null,
          schedulerState: null,
        },
        {
          schemaVersion: "loci.job-event/v1",
          jobId,
          sequence: 2,
          occurredAt: completedAt,
          state: "completed",
          progress: 1,
          message: "Verified working result published.",
          reasonCode: null,
          schedulerState: null,
        },
      ],
      result: {
        schemaVersion: "loci.result/v1",
        resultManifestId,
        resultId,
        jobId,
        createdAt,
        sourceFingerprints: [{ sourceId: "legacy_source_1", sha256: sourceSha256 }],
        producer: {
          appVersion: "0.1.0",
          engineVersion: fixture.segmented.engine.version,
          modelId: fixture.segmented.profile.id,
          modelSha256: fixture.segmented.profile.model.sha256,
          settingsSha256,
        },
        artifacts: [originalArtifact],
        publication: { state: "verified", atomic: true, reason: null },
      },
    }],
    migrations: [],
  };
  const document = {
    schemaVersion: "loci.project-file/v1",
    revision: 7,
    manifest,
    sourceLocators: [{
      sourceId: "legacy_source_1",
      kind: "local-file",
      platform: "posix",
      canonicalPath: await fs.realpath(sourcePath),
    }],
  };
  await fs.writeFile(legacyProjectPath, `${JSON.stringify(document)}\n`, { mode: 0o600 });
  return { document, sourceSha256, resultId, operationIds, originalArtifact, activeArtifact };
}

const fixture = await frozenWorkerFixture();
const legacy = await writeLegacyProject(fixture);
const git = async (...args) => (await run("git", args, { cwd: projectRoot })).stdout.trim();
const runtimeFiles = [
  "desktop/src/main/job-store.ts",
  "desktop/src/main/legacy-project-adapter.ts",
  "desktop/src/main/managed-research-session.ts",
  "desktop/src/main/research-bridge.ts",
  "desktop/src/main/worker-client.ts",
  "desktop/src/preload.ts",
  "desktop/src/renderer/ContextHelp.tsx",
  "desktop/src/renderer/ImageViewport.tsx",
  "desktop/src/renderer/ResearchWorkbench.tsx",
  "desktop/src/renderer/WorkbenchChrome.tsx",
  "desktop/src/shared/research-contracts.ts",
  "engine/src/loci_engine/research_legacy_import.py",
  "engine/src/loci_engine/research_project.py",
  "engine/src/loci_engine/research_session.py",
  "engine/src/loci_engine/workbench.py",
  "engine/src/loci_engine/worker.py",
  "engine/src/loci_engine/working_result.py",
];
const sourceIdentity = {
  head: await git("rev-parse", "HEAD"),
  head_tree: await git("rev-parse", "HEAD^{tree}"),
  working_source_sha256: await workingSourceSha256(),
  status: await git("status", "--porcelain"),
  status_sha256: createHash("sha256").update(await git("status", "--porcelain")).digest("hex"),
  harness_sha256: await sha256(import.meta.filename),
  runtime_file_sha256: Object.fromEntries(await Promise.all(runtimeFiles.map(async (relative) => [
    relative,
    await sha256(path.join(projectRoot, relative)),
  ]))),
};
let buildIdentity;
if (development) {
  const mainJavascript = await fs.readFile(mainArtifact, "utf8");
  const rendererUrl = mainJavascript.match(/window\.loadURL\("(https?:\/\/[^"?]+)"\)/u)?.[1];
  assert.ok(rendererUrl, "Expected the frozen Forge main artifact to declare its renderer URL.");
  const rendererResponse = await fetch(rendererUrl);
  assert.ok(rendererResponse.ok, `Renderer entry returned HTTP ${rendererResponse.status}.`);
  const rendererEntry = Buffer.from(await rendererResponse.arrayBuffer());
  buildIdentity = {
    mode: "forge-development",
    executable_sha256: await sha256(executablePath),
    worker: {
      kind: "python-module",
      executable_sha256: await sha256(workerExecutable),
      module: "loci_engine.worker",
      module_entry_sha256: await sha256(path.join(engineRoot, "src", "loci_engine", "worker.py")),
    },
    main_artifact_sha256: await sha256(mainArtifact),
    preload_artifact_sha256: await sha256(preloadArtifact),
    renderer_url: rendererUrl,
    renderer_entry_sha256: createHash("sha256").update(rendererEntry).digest("hex"),
    renderer_source_sha256: await sha256(rendererSource),
  };
} else {
  buildIdentity = {
    mode: "packaged-adhoc",
    executable_sha256: await sha256(executablePath),
    worker: {
      kind: "packaged-binary",
      executable_sha256: await sha256(workerExecutable),
    },
    app_bundle: appBundle,
    asar_sha256: await sha256(archiveArtifact),
  };
}
const fixtureIdentity = {
  source_sha256: legacy.sourceSha256,
  legacy_project_sha256: await sha256(legacyProjectPath),
  original_pack_sha256: legacy.originalArtifact.sha256,
  corrected_pack_sha256: legacy.activeArtifact.sha256,
  correction_revision: fixture.corrected.corrections.revision,
  correction_operation_ids: legacy.operationIds,
};

let app;
let page;
const pageErrors = [];
const consoleErrors = [];
const captures = {};
const startedAt = new Date().toISOString();

async function capture(name, locator = page) {
  const destination = path.join(screenshots, `${name}.png`);
  const bytes = await locator.screenshot({ path: destination });
  assert.ok(bytes.length > 2_000, `${name} did not capture substantive UI.`);
  captures[name] = {
    file: path.basename(destination),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  };
}

async function launch() {
  const instance = await electron.launch({
    executablePath,
    args: [...(development ? [desktopRoot] : []), `--user-data-dir=${userData}`],
    cwd: desktopRoot,
    timeout: 120_000,
  });
  const window = await instance.firstWindow();
  await instance.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setBounds({ width: 1280, height: 840 });
  });
  await window.getByRole("main", { name: "Loci workspace" }).waitFor({
    state: "visible",
    timeout: 30_000,
  });
  window.on("pageerror", (error) => pageErrors.push(error.message));
  window.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  return { instance, window };
}

async function installDialogs(openImagesMode) {
  await app.evaluate(({ dialog }, values) => {
    dialog.showOpenDialog = async (...args) => {
      const options = args.at(-1);
      if (options?.title === "Import a legacy Loci project") {
        return { canceled: false, filePaths: [values.legacyProject] };
      }
      if (options?.title === "Add microscopy or medical images") {
        return values.openImagesMode === "cancel"
          ? { canceled: true, filePaths: [] }
          : { canceled: false, filePaths: [values.source] };
      }
      if (options?.title === "Open research study") {
        return { canceled: false, filePaths: [values.savedStudy] };
      }
      return { canceled: true, filePaths: [] };
    };
    dialog.showSaveDialog = async (...args) => {
      const options = args.at(-1);
      if (options?.title === "Save research study as") {
        return { canceled: false, filePath: values.savedStudy };
      }
      return { canceled: true, filePath: undefined };
    };
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }, {
    openImagesMode,
    source: sourcePath,
    legacyProject: legacyProjectPath,
    savedStudy: savedStudyPath,
  });
}

async function assertNoRawIpcError(action) {
  const body = await page.locator("body").innerText();
  assert.ok(!body.includes("Error invoking remote method"), `${action} exposed raw IPC text.`);
  assert.ok(!body.includes("Research project must be an existing plain directory"),
    `${action} exposed a raw engine path-state error.`);
}

async function close() {
  if (!app) return;
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }).catch(() => undefined);
  const closed = app.waitForEvent("close", { timeout: 30_000 }).catch(() => undefined);
  await app.evaluate(({ app }) => app.quit()).catch(() => undefined);
  await closed;
  app = undefined;
  page = undefined;
}

async function waitForStudyFile(study) {
  const deadline = performance.now() + 120_000;
  while (performance.now() < deadline) {
    if (await fs.access(path.join(study, "study.sqlite3")).then(() => true, () => false)) return;
    await page.waitForTimeout(100);
  }
  throw new Error(`Timed out waiting for ${study}.`);
}

async function revealWelcomeOpeningOptions() {
  const options = page.getByRole("button", { name: "More opening options", exact: true });
  const regionId = await options.getAttribute("aria-controls");
  assert.ok(regionId, "The opening-options control does not identify its reveal region.");
  await options.click();
  await page.waitForFunction((id) => {
    const toggle = document.querySelector(`[aria-controls="${id}"]`);
    const region = document.getElementById(id);
    if (!toggle || !region || toggle.getAttribute("aria-expanded") !== "true" ||
        region.hasAttribute("inert") || getComputedStyle(region).visibility !== "visible") return false;
    return Math.abs(region.getBoundingClientRect().height - region.scrollHeight) < 0.5;
  }, regionId, { timeout: 5_000 });
}

const journey = {};
try {
  ({ instance: app, window: page } = await launch());
  await installDialogs("cancel");
  await revealWelcomeOpeningOptions();
  await page.getByRole("button", { name: "Open .loci-project", exact: true }).click();
  await page.getByRole("main", { name: "Research workspace" }).waitFor({
    state: "visible",
    timeout: 120_000,
  });
  await page.getByLabel("Active image").filter({ hasText: "Legacy cells corrected" }).waitFor();
  const imported = await page.evaluate(() => window.lociResearch.getSnapshot());
  assert.equal(imported.sources.length, 1);
  assert.equal(imported.results.length, 1);
  assert.equal(imported.results[0].review.disposition, "reviewed");
  assert.equal(imported.results[0].parent_id, null);
  const correctionInfo = await page.evaluate(async (result) =>
    window.lociResearch.execute("correction_info", {
      result_id: result.id,
      revision_hash: result.revision_hash,
    }), imported.results[0]);
  assert.equal(correctionInfo.result_id, imported.results[0].id);
  assert.ok(correctionInfo.label_ids.length > 0);
  await page.locator(`[data-result-id="${imported.results[0].id}"]`).click();
  await selectWorkbenchTool(page, "Correction");
  await page.getByLabel("Correction label").waitFor({ state: "visible", timeout: 120_000 });
  await capture("01-legacy-reviewed-correctable");
  journey.legacy_import = {
    project_id: imported.project.project_id,
    source_id: imported.sources[0].id,
    source_sha256: imported.sources[0].sha256,
    result_id: imported.results[0].id,
    revision_hash: imported.results[0].revision_hash,
    review: imported.results[0].review,
    correctable_label_count: correctionInfo.label_ids.length,
  };

  await page.getByText("File", { exact: true }).click();
  await page.getByRole("button", { name: "Save as study…", exact: true }).click();
  await waitForStudyFile(savedStudyPath);
  const savedSnapshot = await page.evaluate(() => window.lociResearch.getSnapshot());
  const savedState = await page.evaluate(() => window.lociResearch.sessionState());
  assert.equal(savedState.storage, "saved");
  assert.equal(savedSnapshot.project.project_id, imported.project.project_id);
  assert.equal(savedSnapshot.results[0].review.disposition, "reviewed");
  journey.save_as = {
    study_sha256: await sha256(path.join(savedStudyPath, "study.sqlite3")),
    session: savedState,
  };

  const beforeCancelledOpen = preservedDocumentIdentity(savedSnapshot);
  await page.getByRole("button", { name: "Open images", exact: true }).click();
  await page.waitForTimeout(300);
  const afterCancelledOpen = await page.evaluate(() => window.lociResearch.getSnapshot());
  assert.deepEqual(preservedDocumentIdentity(afterCancelledOpen), beforeCancelledOpen,
    "Cancelling the add-images picker replaced or changed the active document content.");
  assert.equal((await page.evaluate(() => window.lociResearch.sessionState())).storage, "saved");

  await page.getByText("File", { exact: true }).click();
  await page.getByRole("button", { name: "Recent work", exact: true }).click();
  await page.getByRole("main", { name: "Loci workspace" }).waitFor({ state: "visible" });
  const emptyAfterLeave = await page.evaluate(async () => ({
    state: await window.lociResearch.sessionState(),
    snapshot: await window.lociResearch.getSnapshot(),
  }));
  assert.deepEqual(emptyAfterLeave, { state: { status: "empty" }, snapshot: null });
  await page.getByRole("heading", { name: "Recent work", exact: true }).waitFor();
  await capture("02-recent-saved-study");
  const savedRecent = page.locator(".recent-sessions").getByRole("button", {
    name: "Reviewed corrected legacy study", exact: true,
  });
  await savedRecent.click();
  await page.getByRole("main", { name: "Research workspace" }).waitFor();
  const reopened = await page.evaluate(async () => ({
    state: await window.lociResearch.sessionState(),
    snapshot: await window.lociResearch.getSnapshot(),
  }));
  assert.equal(reopened.state.storage, "saved");
  assert.equal(reopened.snapshot.project.project_id, imported.project.project_id);
  assert.equal(reopened.snapshot.results[0].review.disposition, "reviewed");
  assert.equal(reopened.snapshot.results[0].revision_hash, imported.results[0].revision_hash);
  journey.saved_recent_reopen = reopened.state;

  await page.getByText("File", { exact: true }).click();
  await page.getByRole("button", { name: "Recent work", exact: true }).click();
  await page.getByRole("main", { name: "Loci workspace" }).waitFor();
  await installDialogs("open");
  await page.getByRole("button", { name: "Open images", exact: true }).click();
  await page.getByRole("main", { name: "Research workspace" }).waitFor({
    state: "visible",
    timeout: 120_000,
  });
  const separate = await page.evaluate(async () => ({
    state: await window.lociResearch.sessionState(),
    snapshot: await window.lociResearch.getSnapshot(),
  }));
  assert.equal(separate.state.storage, "managed");
  assert.notEqual(separate.snapshot.project.project_id, imported.project.project_id);
  assert.equal(separate.snapshot.sources.length, 1);
  assert.equal(separate.snapshot.results.length, 0,
    "Opening images from Welcome appended to the prior saved study.");
  await capture("03-new-managed-session");
  journey.new_session_import = {
    project_id: separate.snapshot.project.project_id,
    source_count: separate.snapshot.sources.length,
    result_count: separate.snapshot.results.length,
    session: separate.state,
  };

  await page.getByText("File", { exact: true }).click();
  await page.getByRole("button", { name: "Recent work", exact: true }).click();
  await page.getByRole("main", { name: "Loci workspace" }).waitFor();
  const savedAgain = page.locator(".recent-sessions").getByRole("button", {
    name: "Reviewed corrected legacy study", exact: true,
  });
  await savedAgain.click();
  await page.getByRole("main", { name: "Research workspace" }).waitFor();
  const unchangedSaved = await page.evaluate(() => window.lociResearch.getSnapshot());
  assert.equal(unchangedSaved.sources.length, 1);
  assert.equal(unchangedSaved.results.length, 1);
  assert.equal(unchangedSaved.results[0].revision_hash, imported.results[0].revision_hash);
  await close();

  await fs.rename(savedStudyPath, temporarilyMovedStudyPath);
  ({ instance: app, window: page } = await launch());
  await installDialogs("cancel");
  const recovery = await page.evaluate(async () => ({
    state: await window.lociResearch.sessionState(),
    snapshot: await window.lociResearch.getSnapshot(),
  }));
  assert.equal(recovery.snapshot, null);
  assert.equal(recovery.state.status, "recoverable");
  assert.equal(recovery.state.reason, "saved-study-missing");
  await page.getByText("Reviewed corrected legacy study is unavailable", { exact: true }).waitFor();
  await assertNoRawIpcError("Missing saved-study recovery");
  assert.equal(await page.locator(".research-alert[role=alert]").count(), 0);
  await capture("04-missing-study-recovery");
  journey.missing_study = recovery.state;

  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);
  await close();
  await fs.rename(temporarilyMovedStudyPath, savedStudyPath);
  const completed = {
    schema: "loci.image-first-compatibility-qa/v1",
    status: "passed",
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    source: sourceIdentity,
    build: buildIdentity,
    fixtures: fixtureIdentity,
    journey,
    screenshots: captures,
    page_errors: pageErrors,
    console_errors: consoleErrors,
  };
  await fs.writeFile(path.join(runRoot, "qa-result.json"), `${JSON.stringify(completed, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ runRoot, ...completed }, null, 2)}\n`);
} catch (error) {
  if (page) await capture("failure").catch(() => undefined);
  const failure = {
    schema: "loci.image-first-compatibility-qa-failure/v1",
    status: "failed",
    error: error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error),
    source: sourceIdentity,
    build: buildIdentity,
    fixtures: fixtureIdentity,
    journey,
    screenshots: captures,
    page_errors: pageErrors,
    console_errors: consoleErrors,
  };
  await fs.writeFile(path.join(runRoot, "qa-failure.json"), `${JSON.stringify(failure, null, 2)}\n`);
  await close().catch(() => undefined);
  if (await fs.access(temporarilyMovedStudyPath).then(() => true, () => false)) {
    await fs.rename(temporarilyMovedStudyPath, savedStudyPath).catch(() => undefined);
  }
  throw error;
}
