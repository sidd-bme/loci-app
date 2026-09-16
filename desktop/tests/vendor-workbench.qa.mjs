import assert from "node:assert/strict";
import { createEmptyStudy, selectWorkbenchTool } from "./workbench-qa-helpers.mjs";
import { createHash } from "node:crypto";
import { constants, createReadStream, promises as fs } from "node:fs";
import path from "node:path";

import { _electron as electron } from "playwright";

const desktopRoot = path.resolve(import.meta.dirname, "..");
const projectRoot = path.resolve(desktopRoot, "..");

function requiredPath(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} to an explicit absolute path.`);
  assert.equal(path.isAbsolute(value), true, `${name} must be absolute`);
  return path.resolve(value);
}

const appBundle = requiredPath("LOCI_PACKAGED_APP");
const vendorSource = requiredPath("LOCI_QA_VENDOR_SOURCE");
const bioformatsJar = requiredPath("LOCI_QA_BIOFORMATS_JAR");
const javaExecutable = requiredPath("LOCI_QA_JAVA");
const outputRoot = requiredPath("LOCI_QA_OUTPUT_ROOT");

if (!["darwin", "win32"].includes(process.platform))
  throw new Error(
    "Packaged vendor-workbench QA supports macOS and Windows only.",
  );

const executablePath =
  process.platform === "darwin"
    ? path.join(appBundle, "Contents", "MacOS", "Loci")
    : path.join(appBundle, "Loci.exe");
const workerPath =
  process.platform === "darwin"
    ? path.join(
        appBundle,
        "Contents",
        "Resources",
        "loci-engine",
        "loci-engine",
      )
    : path.join(appBundle, "resources", "loci-engine", "loci-engine.exe");
const appArchivePath =
  process.platform === "darwin"
    ? path.join(appBundle, "Contents", "Resources", "app.asar")
    : path.join(appBundle, "resources", "app.asar");
const userData = path.join(outputRoot, "user-data");
const studyParent = path.join(outputRoot, "study");
const studyPath = path.join(studyParent, "vendor-workbench.loci-study");
const conversionParent = path.join(outputRoot, "conversion");
const conversionPath = path.join(conversionParent, "selected-plane");
const screenshots = path.join(outputRoot, "screenshots");
const reportPath = path.join(outputRoot, "qa-report.json");
const failurePath = path.join(outputRoot, "qa-failure.json");

function inside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(".." + path.sep) && relative !== "..")
  );
}

assert.equal(
  inside(projectRoot, outputRoot),
  false,
  "LOCI_QA_OUTPUT_ROOT must be outside the repository so QA evidence is not committed.",
);
assert.equal(
  inside(outputRoot, vendorSource),
  false,
  "The vendor source must be independent of QA output.",
);
assert.notEqual(
  studyPath,
  conversionPath,
  "Study and conversion destinations must be separate.",
);

async function plainFile(file, label, executable = false) {
  const value = await fs.lstat(file);
  assert.equal(value.isFile(), true, `${label} must be a plain file`);
  assert.equal(
    value.isSymbolicLink(),
    false,
    `${label} must not be a symbolic link`,
  );
  if (executable && process.platform !== "win32")
    await fs.access(file, constants.X_OK);
  return value;
}

async function sha256(file) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}

async function fileIdentity(file) {
  const value = await fs.stat(file);
  return {
    sha256: await sha256(file),
    size_bytes: value.size,
    modified_at: value.mtime.toISOString(),
  };
}

async function visible(page, locator, label, timeout = 120_000) {
  await locator.waitFor({ state: "visible", timeout });
  await noUiError(page, `waiting for ${label}`);
  return locator;
}

async function noUiError(page, action) {
  const alert = page.locator(".research-alert[role=alert]");
  if (await alert.isVisible().catch(() => false)) {
    throw new Error(
      `${action}: ${(await alert.textContent()) ?? "unknown research UI error"}`,
    );
  }
}

async function waitFor(page, read, predicate, label, timeout = 600_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    await noUiError(page, label);
    last = await read();
    if (predicate(last)) return last;
    await page.waitForTimeout(250);
  }
  throw new Error(
    `Timed out waiting for ${label}; last value: ${JSON.stringify(last)}`,
  );
}

async function screenshot(page, name) {
  const destination = path.join(screenshots, `${name}.png`);
  await page.screenshot({ path: destination, fullPage: true });
  process.stdout.write(`Checkpoint: ${destination}\n`);
  return destination;
}

async function installExactDialogs(app) {
  await app.evaluate(
    ({ dialog }, values) => {
      globalThis.__lociVendorQaDialogCalls = [];
      const record = (kind, title) => {
        globalThis.__lociVendorQaDialogCalls.push({ kind, title });
      };
      dialog.showOpenDialog = async (...args) => {
        const title = args.at(-1)?.title;
        record("open", title);
        const exact = {
          "Inspect a vendor file for explicit conversion": values.source,
          "Select the verified Bio-Formats 8.5.0 package JAR": values.jar,
          "Select your installed Java executable": values.java,
        };
        if (!(title in exact))
          throw new Error(`Unexpected open picker: ${String(title)}`);
        return { canceled: false, filePaths: [exact[title]] };
      };
      dialog.showSaveDialog = async (...args) => {
        const title = args.at(-1)?.title;
        record("save", title);
        const exact = {
          "Create research study": values.study,
          "Create a new derived OME-TIFF conversion folder": values.conversion,
        };
        if (!(title in exact))
          throw new Error(`Unexpected save picker: ${String(title)}`);
        return { canceled: false, filePath: exact[title] };
      };
      dialog.showMessageBox = async () => ({
        response: 0,
        checkboxChecked: false,
      });
    },
    {
      source: vendorSource,
      jar: bioformatsJar,
      java: javaExecutable,
      study: studyPath,
      conversion: conversionPath,
    },
  );
}

async function dialogCalls(app) {
  return app.evaluate(() => [...(globalThis.__lociVendorQaDialogCalls ?? [])]);
}

async function close(app) {
  const closed = app.waitForEvent("close", { timeout: 30_000 });
  await app.evaluate(({ app }) => app.quit());
  await closed;
}

await Promise.all([
  plainFile(vendorSource, "Vendor source"),
  plainFile(bioformatsJar, "Bio-Formats package"),
  plainFile(javaExecutable, "Java executable", true),
  plainFile(executablePath, "Packaged application executable", true),
  plainFile(workerPath, "Packaged engine executable", true),
  plainFile(appArchivePath, "Packaged app archive"),
]);
await fs.mkdir(outputRoot, { recursive: false });
await Promise.all([
  fs.mkdir(userData),
  fs.mkdir(studyParent),
  fs.mkdir(conversionParent),
  fs.mkdir(screenshots),
]);

const [
  sourceBefore,
  jarIdentity,
  executableIdentity,
  workerIdentity,
  archiveIdentity,
] = await Promise.all([
  fileIdentity(vendorSource),
  fileIdentity(bioformatsJar),
  fileIdentity(executablePath),
  fileIdentity(workerPath),
  fileIdentity(appArchivePath),
]);

let app;
let page;
const rendererMessages = [];
try {
  app = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userData}`],
    cwd: desktopRoot,
    timeout: 120_000,
  });
  page = await app.firstWindow();
  page.on("console", (message) =>
    rendererMessages.push({
      type: message.type(),
      text: message.text(),
    }),
  );
  await visible(page, page.locator("main.image-first-empty, main.image-first-workbench"), "application shell");
  await installExactDialogs(app);

  await page.locator("main.image-first-empty, main.image-first-workbench").waitFor();

  await createEmptyStudy(page);
  await visible(
    page,
    page.getByRole("main", { name: "Research workspace" }),
    "new research workspace",
  );

  await selectWorkbenchTool(page, "Vendor import");
  await visible(
    page,
    page.getByRole("button", {
      name: "Inspect local vendor source and reader",
      exact: true,
    }),
    "vendor import controls",
  );
  await page
    .getByRole("button", {
      name: "Inspect local vendor source and reader",
      exact: true,
    })
    .click();
  await visible(
    page,
    page.getByLabel("Exact vendor inspection"),
    "exact vendor inspection",
    600_000,
  );
  await visible(
    page,
    page.getByText(
      "Exact source, Bio-Formats package, and Java runtime inspected locally.",
      { exact: true },
    ),
    "vendor inspection completion",
  );
  const inspectionText = await page
    .getByLabel("Exact vendor inspection")
    .innerText();
  assert.match(
    inspectionText,
    /sample\.nd2/u,
    "The visible inspection must identify the selected ND2 file",
  );
  assert.ok(
    inspectionText.includes(sourceBefore.sha256),
    "The visible inspection must show the original source hash",
  );
  assert.ok(
    inspectionText.includes(jarIdentity.sha256),
    "The visible inspection must show the selected JAR hash",
  );
  await screenshot(page, "01-vendor-inspection");

  await page.getByLabel("Vendor series").selectOption("0");
  await page.getByLabel("Vendor channel").selectOption("0");
  await page.getByLabel("Vendor Z index").fill("0");
  await page.getByLabel("Vendor T index").fill("0");
  await page.getByLabel("Crop vendor plane").check();
  await page.getByLabel("Vendor crop X").fill("0");
  await page.getByLabel("Vendor crop Y").fill("0");
  await page.getByLabel("Vendor crop width").fill("64");
  await page.getByLabel("Vendor crop height").fill("64");
  assert.equal(
    await page
      .getByRole("button", {
        name: "Convert exact plane and import derived source",
        exact: true,
      })
      .isEnabled(),
    true,
    "The exact scalar crop must be eligible for conversion",
  );
  await screenshot(page, "02-exact-plane-selection");

  await page
    .getByRole("button", {
      name: "Convert exact plane and import derived source",
      exact: true,
    })
    .click();
  await visible(
    page,
    page.getByLabel("Vendor conversion receipt"),
    "vendor conversion receipt",
    600_000,
  );
  await visible(
    page,
    page.getByText(
      "Converted the exact selected plane and imported it as a derived OME-TIFF source.",
      { exact: true },
    ),
    "vendor conversion completion",
  );
  const derivedButton = page.locator(".research-sources").getByRole("button", {
    name: /^sample\.nd2 · converted S0 C0 Z0 T0/u,
  });
  await visible(page, derivedButton, "imported derived source");
  await derivedButton.click();
  await screenshot(page, "03-imported-derived-source");

  const convertedSnapshot = await page.evaluate(() =>
    window.lociResearch.getSnapshot(),
  );
  assert.equal(
    convertedSnapshot.sources.length,
    1,
    "The new study must contain one converted source",
  );
  const derivedSource = convertedSnapshot.sources[0];
  assert.equal(derivedSource.name, "sample.nd2 · converted S0 C0 Z0 T0");
  assert.deepEqual(derivedSource.metadata.dimensions, {
    c: 1,
    s: 1,
    t: 1,
    x: 64,
    y: 64,
    z: 1,
  });

  await selectWorkbenchTool(page, "Analyze");
  await page.getByLabel("Threshold", { exact: true }).fill("100");
  await selectWorkbenchTool(page, "Process");
  await page
    .getByRole("button", { name: "Preview selected crop", exact: true })
    .click();
  await visible(
    page,
    page.getByAltText("Bounded native image region"),
    "classical threshold preview",
    120_000,
  );
  await noUiError(page, "previewing the classical threshold recipe");
  await screenshot(page, "04-classical-threshold-preview");

  const beforeResultIds = new Set(
    convertedSnapshot.results.map((item) => item.id),
  );
  await selectWorkbenchTool(page, "Analyze");
  assert.equal(
    await page.getByLabel("Threshold", { exact: true }).inputValue(),
    "100",
  );
  await page.getByRole("button", { name: "Run recipe", exact: true }).click();
  const completedSnapshot = await waitFor(
    page,
    () => page.evaluate(() => window.lociResearch.getSnapshot()),
    (value) =>
      value.results.some(
        (item) =>
          item.source_id === derivedSource.id && !beforeResultIds.has(item.id),
      ),
    "durable classical threshold result",
    180_000,
  );
  const resultSummary = completedSnapshot.results.find(
    (item) =>
      item.source_id === derivedSource.id && !beforeResultIds.has(item.id),
  );
  assert.ok(
    resultSummary,
    "The visible run must publish a result for the converted source",
  );
  const resultRecord = await page.evaluate(
    (result_id) => window.lociResearch.execute("result", { result_id }),
    resultSummary.id,
  );
  await visible(
    page,
    page.locator(`[data-result-id="${resultSummary.id}"]`),
    "published result revision",
  );
  await screenshot(page, "05-classical-threshold-result");

  const derivation = resultRecord.provenance?.source_derivation;
  assert.equal(derivation?.schema, "loci.vendor-derived-source/v1");
  assert.deepEqual(
    derivation,
    derivedSource.derivation,
    "The result must retain the source's exact derivation",
  );
  assert.equal(derivation.receipt.source_sha256, sourceBefore.sha256);
  assert.equal(derivation.receipt.bioformats_jar_sha256, jarIdentity.sha256);
  assert.equal(derivation.record.source.sha256_before, sourceBefore.sha256);
  assert.equal(derivation.record.source.sha256_after, sourceBefore.sha256);
  assert.equal(derivation.record.source.format, "nd2");
  assert.deepEqual(derivation.receipt.selection, {
    series: 0,
    c: 0,
    z: 0,
    t: 0,
    crop_xywh: [0, 0, 64, 64],
  });
  assert.deepEqual(derivation.record.selection, derivation.receipt.selection);
  assert.equal(
    derivation.record.runtime.bioformats_jar_sha256,
    jarIdentity.sha256,
  );
  assert.equal(
    derivation.receipt.runtime.bioformats_jar_sha256,
    jarIdentity.sha256,
  );
  assert.equal(resultRecord.result.source_id, derivedSource.id);
  assert.equal(resultRecord.result.source_sha256, derivedSource.sha256);
  assert.equal(derivation.receipt.artifact.sha256, derivedSource.sha256);
  assert.deepEqual(resultRecord.provenance.selection, {
    x: 0,
    y: 0,
    width: 64,
    height: 64,
    t: 0,
    c: 0,
    z: 0,
    level: 0,
  });
  assert.equal(resultRecord.provenance.recipe.segmentation.threshold, 100);

  const convertedImage = path.join(conversionPath, "image.ome.tif");
  const convertedProvenance = path.join(conversionPath, "provenance.json");
  const [convertedImageIdentity, convertedProvenanceIdentity, sourceAfter] =
    await Promise.all([
      fileIdentity(convertedImage),
      fileIdentity(convertedProvenance),
      fileIdentity(vendorSource),
    ]);
  assert.equal(
    convertedImageIdentity.sha256,
    derivation.receipt.artifact.sha256,
  );
  assert.equal(
    convertedProvenanceIdentity.sha256,
    derivation.receipt.provenance.sha256,
  );
  assert.deepEqual(
    sourceAfter,
    sourceBefore,
    "The original ND2 identity changed during the journey",
  );

  const publicPayload = JSON.stringify({
    snapshot: completedSnapshot,
    result: resultRecord,
  });
  for (const privatePath of [
    vendorSource,
    bioformatsJar,
    javaExecutable,
    outputRoot,
    studyPath,
    conversionPath,
  ]) {
    assert.equal(
      publicPayload.includes(privatePath),
      false,
      `Renderer-safe payload disclosed a private path: ${privatePath}`,
    );
  }

  const calls = await dialogCalls(app);
  assert.deepEqual(calls, [
    { kind: "save", title: "Create research study" },
    { kind: "open", title: "Inspect a vendor file for explicit conversion" },
    {
      kind: "open",
      title: "Select the verified Bio-Formats 8.5.0 package JAR",
    },
    { kind: "open", title: "Select your installed Java executable" },
    { kind: "save", title: "Create a new derived OME-TIFF conversion folder" },
  ]);
  const runtime = await app.evaluate(({ app: electronApp }) => ({
    application_version: electronApp.getVersion(),
    electron: process.versions.electron,
    platform: process.platform,
    arch: process.arch,
  }));

  const report = {
    schema: "loci.vendor-workbench-packaged-qa/v1",
    status: "passed",
    paths: {
      app_bundle: appBundle,
      vendor_source: vendorSource,
      bioformats_jar: bioformatsJar,
      java_executable: javaExecutable,
      output_root: outputRoot,
      user_data: userData,
      study: studyPath,
      conversion: conversionPath,
    },
    package_identity: {
      executable: executableIdentity,
      worker: workerIdentity,
      app_archive: archiveIdentity,
    },
    runtime,
    dialog_calls: calls,
    original_source: { before: sourceBefore, after: sourceAfter },
    bioformats_jar: jarIdentity,
    executed_selection: derivation.receipt.selection,
    derived_artifact: convertedImageIdentity,
    provenance_artifact: convertedProvenanceIdentity,
    derived_source: {
      id: derivedSource.id,
      sha256: derivedSource.sha256,
      dimensions: derivedSource.metadata.dimensions,
    },
    result: {
      id: resultRecord.result.id,
      revision_hash: resultRecord.result.revision_hash,
      source_id: resultRecord.result.source_id,
      source_sha256: resultRecord.result.source_sha256,
      object_count: resultSummary.object_count,
      threshold: resultRecord.provenance.recipe.segmentation.threshold,
      selection: resultRecord.provenance.selection,
      source_derivation_sha256: createHash("sha256")
        .update(JSON.stringify(derivation))
        .digest("hex"),
    },
    renderer_messages: rendererMessages,
    screenshots: (await fs.readdir(screenshots)).sort(),
  };
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  await close(app);
  app = undefined;
} catch (error) {
  const failure = {
    schema: "loci.vendor-workbench-packaged-qa-failure/v1",
    status: "failed",
    error:
      error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : { name: "Unknown", message: String(error) },
    dialog_calls: app ? await dialogCalls(app).catch(() => []) : [],
    renderer_messages: rendererMessages,
  };
  if (page) {
    failure.screenshot = await screenshot(page, "failure").catch(() => null);
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
