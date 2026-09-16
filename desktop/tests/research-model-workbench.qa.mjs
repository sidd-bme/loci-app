import assert from "node:assert/strict";
import { createEmptyStudy, selectWorkbenchTool, setSelectionField } from "./workbench-qa-helpers.mjs";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { _electron as electron } from "playwright";

const run = promisify(execFile);
const desktopRoot = path.resolve(import.meta.dirname, "..");
const projectRoot = path.resolve(desktopRoot, "..");
const TWO_GIB = 2 * 1024 ** 3;
const EXPECTED_SOURCE_SHA256 =
  "2b086faa8e3b55202ea40604da32aec01aa7e99c7a7df861d03e773430730539";
const EXPECTED_MODEL = {
  id: "nuclei-segmentation-boundary-model",
  version: "0.1.0-zenodo-v7",
  package_sha256:
    "94259d554d02f43c4d5fa116f0e9e647be4be5c7ed00fb7555b141a9e9f2937b",
  metadata_sha256:
    "dfde9bd3902187e53c537a10f94c93e67ebc3b11cc41ec40a1c3c4b4ef18c745",
  model_sha256:
    "df913b85947f5132bcdaf81d91af0963f60d44f4caf8a4fec672d96a2f327b44",
  reference_input_sha256:
    "c29bd6e16e3f7856217b407ba948222b1c2a0da41922a0f79297e25588614fe2",
  reference_output_sha256:
    "510181f38930e59e4fd8ecc03d6ea7c980eb6609759655f2d4a41fe36108d5f5",
  result_arrays: {
    image: "bd1676c1096983436be9d8e6627d3b18a74b6d69456528758c029c17d467185f",
    labels: "49c5403d08909cf31473562a871ad3ed6fe7c85a998ed4ae00fa66c28c638ee2",
    probabilities:
      "7d7611de29733d5448c2cbab6faa5bb70816cc5f0a718301925c122fbc8d9f5e",
  },
};

function requiredPath(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} to an explicit absolute path.`);
  assert.equal(path.isAbsolute(value), true, `${name} must be absolute`);
  return path.resolve(value);
}

const appBundle = requiredPath("LOCI_PACKAGED_APP");
const usefulPackage = requiredPath("LOCI_QA_MODEL_PACKAGE");
const sourcePath = requiredPath("LOCI_QA_MODEL_SOURCE");
const outputRoot = requiredPath("LOCI_QA_OUTPUT_ROOT");
const packageBuilderPython = path.resolve(
  process.env.LOCI_QA_PACKAGE_BUILDER_PYTHON ??
    path.join(projectRoot, "engine", ".venv", "bin", "python"),
);

if (!["darwin", "win32"].includes(process.platform)) {
  throw new Error(
    "Packaged research-model QA supports macOS and Windows only.",
  );
}

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
const reopenUserData = path.join(outputRoot, "reopen-user-data");
const studyParent = path.join(outputRoot, "study");
const studyPath = path.join(studyParent, "model-workbench.loci-study");
const exportParent = path.join(outputRoot, "export");
const exportPath = path.join(exportParent, "useful-model-result");
const unseenPackage = path.join(outputRoot, "unseen-conv3x3-model");
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
  "LOCI_QA_OUTPUT_ROOT must be outside the repository.",
);
assert.equal(
  inside(outputRoot, sourcePath),
  false,
  "The source fixture must be independent of QA output.",
);
assert.equal(
  inside(outputRoot, usefulPackage),
  false,
  "The useful model package must be independent of QA output.",
);

async function plainFile(file, label, executable = false) {
  const value = await fs.lstat(file);
  assert.equal(value.isFile(), true, `${label} must be a plain file`);
  assert.equal(value.isSymbolicLink(), false, `${label} must not be a symlink`);
  if (executable && process.platform !== "win32") {
    await fs.access(file, constants.X_OK);
  }
  return value;
}

async function executableFile(file, label) {
  const value = await fs.stat(file);
  assert.equal(value.isFile(), true, `${label} must resolve to a file`);
  if (process.platform !== "win32") await fs.access(file, constants.X_OK);
  return value;
}

async function plainDirectory(directory, label) {
  const value = await fs.lstat(directory);
  assert.equal(value.isDirectory(), true, `${label} must be a directory`);
  assert.equal(value.isSymbolicLink(), false, `${label} must not be a symlink`);
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

async function packageIdentity(directory) {
  const names = (await fs.readdir(directory)).sort();
  const files = [];
  for (const name of names) {
    const file = path.join(directory, name);
    const value = await fs.lstat(file);
    assert.equal(value.isFile(), true, `Unexpected package entry: ${name}`);
    assert.equal(
      value.isSymbolicLink(),
      false,
      `Package entry is a symlink: ${name}`,
    );
    files.push({ name, ...(await fileIdentity(file)) });
  }
  return { files };
}

async function noUiError(page, action) {
  const alert = page.locator(".research-alert[role=alert]");
  if (await alert.isVisible().catch(() => false)) {
    throw new Error(
      `${action}: ${(await alert.textContent()) ?? "unknown research UI error"}`,
    );
  }
}

async function visible(page, locator, label, timeout = 120_000) {
  await locator.waitFor({ state: "visible", timeout });
  await noUiError(page, `waiting for ${label}`);
  return locator;
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

async function close(app) {
  const closed = app.waitForEvent("close", { timeout: 30_000 });
  await app.evaluate(({ app }) => app.quit());
  await closed;
}

async function installInitialDialogs(app) {
  await app.evaluate(
    ({ dialog }, values) => {
      globalThis.__lociModelQaDialogCalls = [];
      let modelPackage = 0;
      const record = (kind, title) =>
        globalThis.__lociModelQaDialogCalls.push({ kind, title });
      dialog.showOpenDialog = async (...args) => {
        const title = args.at(-1)?.title;
        record("open", title);
        if (title === "Add microscopy or medical images") {
          return { canceled: false, filePaths: [values.source] };
        }
        if (title === "Import a local model package") {
          const selected = [values.usefulPackage, values.unseenPackage][
            modelPackage++
          ];
          if (!selected)
            throw new Error("Unexpected extra model-package picker");
          return { canceled: false, filePaths: [selected] };
        }
        throw new Error(`Unexpected open picker: ${String(title)}`);
      };
      dialog.showSaveDialog = async (...args) => {
        const title = args.at(-1)?.title;
        record("save", title);
        const exact = {
          "Create research study": values.study,
          "Export reviewed result bundle": values.exportPath,
        };
        if (!(title in exact)) {
          throw new Error(`Unexpected save picker: ${String(title)}`);
        }
        return { canceled: false, filePath: exact[title] };
      };
      dialog.showMessageBox = async () => ({
        response: 0,
        checkboxChecked: false,
      });
    },
    {
      source: sourcePath,
      usefulPackage,
      unseenPackage,
      study: studyPath,
      exportPath,
    },
  );
}

async function installReopenDialog(app) {
  await app.evaluate(({ dialog }, study) => {
    globalThis.__lociModelQaDialogCalls = [];
    dialog.showOpenDialog = async (...args) => {
      const title = args.at(-1)?.title;
      globalThis.__lociModelQaDialogCalls.push({ kind: "open", title });
      if (title !== "Open research study") {
        throw new Error(`Unexpected reopen picker: ${String(title)}`);
      }
      return { canceled: false, filePaths: [study] };
    };
    dialog.showSaveDialog = async (...args) => {
      const title = args.at(-1)?.title;
      throw new Error(`Unexpected reopen save picker: ${String(title)}`);
    };
    dialog.showMessageBox = async () => ({
      response: 0,
      checkboxChecked: false,
    });
  }, studyPath);
}

async function dialogCalls(app) {
  return app.evaluate(() => [...(globalThis.__lociModelQaDialogCalls ?? [])]);
}

async function launch(userDataPath, messages) {
  const app = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userDataPath}`],
    cwd: desktopRoot,
    timeout: 120_000,
  });
  const page = await app.firstWindow();
  page.on("console", (message) =>
    messages.push({ type: message.type(), text: message.text() }),
  );
  await visible(page, page.locator("main.image-first-empty, main.image-first-workbench"), "application shell");
  return { app, page };
}

async function openResearch(page) {
  await page.locator("main.image-first-empty, main.image-first-workbench").waitFor();
}

async function selectModel(page, modelId) {
  await page.getByLabel("Model package").selectOption(modelId);
  await page.getByLabel("Model input 0 source channel").selectOption("0");
  await page.getByLabel("Model scale mode").selectOption("source");
  assert.equal(
    await page.getByLabel("Model working memory").inputValue(),
    String(TWO_GIB),
  );
}

async function previewAndAdopt(page, priorIds, label) {
  await page
    .getByRole("button", { name: "Preview model overlay", exact: true })
    .click();
  const pending = await visible(
    page,
    page.getByText(/^Pending preview [a-f0-9]{8}… is bound/u),
    `${label} exact preview`,
    600_000,
  );
  const pendingText = await pending.textContent();
  const prefix = pendingText?.match(/Pending preview ([a-f0-9]{8})/u)?.[1];
  assert.ok(prefix, `${label} preview id was not visible`);
  await screenshot(page, `${label}-preview`);
  await page
    .getByRole("button", { name: "Adopt exact preview", exact: true })
    .click();
  const snapshot = await waitFor(
    page,
    () => page.evaluate(() => window.lociResearch.getSnapshot()),
    (value) => value.results.some((item) => !priorIds.has(item.id)),
    `${label} adopted result`,
    600_000,
  );
  const summary = snapshot.results.find((item) => !priorIds.has(item.id));
  assert.ok(summary, `${label} did not publish a result`);
  const record = await page.evaluate(
    (result_id) => window.lociResearch.execute("result", { result_id }),
    summary.id,
  );
  assert.ok(
    record.provenance.model_preview.id.startsWith(prefix),
    `${label} adopted a different preview than the one shown`,
  );
  assert.match(record.provenance.model_preview.sha256, /^[a-f0-9]{64}$/u);
  await visible(
    page,
    page.locator(`[data-result-id="${summary.id}"]`),
    `${label} history revision`,
  );
  await screenshot(page, `${label}-adopted`);
  return { snapshot, summary, record };
}

function exactNumerics(record) {
  return {
    id: record.result.id,
    revision_hash: record.result.revision_hash,
    arrays: record.result.arrays,
    measurements: record.measurements,
    total_rows: record.total_rows,
    probabilities: record.provenance.probabilities,
    segmentation: record.provenance.segmentation,
    model_preview: record.provenance.model_preview,
  };
}

const syntheticBuilder = String.raw`
import hashlib
import json
import math
import sys
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

root = Path(sys.argv[1])
root.mkdir()
shape = (1, 1, 64, 64)
raw = np.linspace(0.0, 1.0, np.prod(shape), dtype=np.float32).reshape(shape)
kernel = np.asarray(
    [[0.0008, -0.0004, 0.0], [0.0006, 0.0020, -0.0002], [0.0, 0.0004, 0.0008]],
    dtype=np.float32,
).reshape(1, 1, 3, 3)
bias = np.asarray([-0.4], dtype=np.float32)
padded = np.pad(raw, ((0, 0), (0, 0), (1, 1), (1, 1)), mode="constant")
logits = np.empty_like(raw)
for y in range(shape[2]):
    for x in range(shape[3]):
        logits[0, 0, y, x] = np.sum(
            padded[0, 0, y:y + 3, x:x + 3] * kernel[0, 0], dtype=np.float32
        ) + bias[0]
expected = (1.0 / (1.0 + np.exp(-logits))).astype(np.float32)
input_info = helper.make_tensor_value_info("raw", TensorProto.FLOAT, shape)
output_info = helper.make_tensor_value_info("probability", TensorProto.FLOAT, shape)
nodes = [
    helper.make_node("Conv", ["raw", "kernel", "bias"], ["logits"], pads=[1, 1, 1, 1]),
    helper.make_node("Sigmoid", ["logits"], ["probability"]),
]
graph = helper.make_graph(
    nodes,
    "unseen-conv3x3",
    [input_info],
    [output_info],
    [numpy_helper.from_array(kernel, "kernel"), numpy_helper.from_array(bias, "bias")],
)
model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 18)])
onnx.save_model(model, root / "model.onnx")
np.save(root / "reference-input.npy", raw)
np.save(root / "reference-output.npy", expected)

def sha(name):
    return hashlib.sha256((root / name).read_bytes()).hexdigest()

manifest = {
    "schema_version": "loci.model-package/1",
    "id": "unseen-synthetic-conv3x3-model",
    "version": "1.0.0-qa",
    "task": "semantic-segmentation",
    "model": {"source": "model.onnx", "sha256": sha("model.onnx"), "opset_version": 18},
    "input": {
        "id": "raw", "axes": "BCYX", "dtype": "float32", "shape": list(shape),
        "channels": [{"name": "synthetic-scalar-input", "source_index": 0}],
        "scale_yx": [1.0, 1.0], "scale_unit": "pixel",
    },
    "output": {
        "id": "probability", "axes": "BCYX", "dtype": "float32", "shape": list(shape),
        "channels": [{"name": "synthetic-probability", "source_index": 0}],
        "scale_yx": [1.0, 1.0], "scale_unit": "pixel", "semantics": "probabilities",
    },
    "preprocessing": [{"id": "ensure_dtype", "kwargs": {"dtype": "float32"}}],
    "tiling": {"input_yx": [64, 64], "halo_yx": [1, 1], "padding": "reflect"},
    "postprocessing": [{"id": "ensure_dtype", "kwargs": {"dtype": "float32"}}],
    "labels": {"threshold": 0.5, "channel": 0},
    "reference": {
        "input": {"source": "reference-input.npy", "sha256": sha("reference-input.npy")},
        "output": {"source": "reference-output.npy", "sha256": sha("reference-output.npy")},
        "rtol": 1e-5, "atol": 1e-6, "mismatched_elements_per_million": 0,
    },
    "citations": [{"text": "Synthetic 3 by 3 convolution QA fixture", "url": "https://example.org/loci/synthetic-conv3x3"}],
    "rights": {
        "license": "CC0-1.0", "redistribution": "allowed", "commercial_use": "allowed",
        "training_data": "none; deterministic synthetic coefficients and reference values",
    },
    "validation": {
        "status": "unvalidated",
        "summary": "Technical generality fixture only; no biological or clinical validation.",
    },
}
(root / "loci-model.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
`;

await Promise.all([
  plainDirectory(usefulPackage, "Useful model package"),
  plainFile(sourcePath, "Supplier reference source"),
  plainFile(executablePath, "Packaged application executable", true),
  plainFile(workerPath, "Packaged engine executable", true),
  plainFile(appArchivePath, "Packaged app archive"),
  executableFile(packageBuilderPython, "Package-builder Python"),
]);
await fs.mkdir(outputRoot, { recursive: false });
await Promise.all([
  fs.mkdir(userData),
  fs.mkdir(reopenUserData),
  fs.mkdir(studyParent),
  fs.mkdir(exportParent),
  fs.mkdir(screenshots),
]);
await run(packageBuilderPython, ["-c", syntheticBuilder, unseenPackage], {
  cwd: projectRoot,
  timeout: 120_000,
  maxBuffer: 1024 * 1024,
});

const [
  sourceBefore,
  usefulPackageIdentity,
  unseenPackageIdentity,
  executableIdentity,
  workerIdentity,
  archiveIdentity,
] = await Promise.all([
  fileIdentity(sourcePath),
  packageIdentity(usefulPackage),
  packageIdentity(unseenPackage),
  fileIdentity(executablePath),
  fileIdentity(workerPath),
  fileIdentity(appArchivePath),
]);
assert.equal(sourceBefore.sha256, EXPECTED_SOURCE_SHA256);

let app;
let page;
const rendererMessages = [];
const reopenRendererMessages = [];
try {
  ({ app, page } = await launch(userData, rendererMessages));
  await installInitialDialogs(app);
  await openResearch(page);

  await createEmptyStudy(page);
  await visible(
    page,
    page.getByRole("main", { name: "Research workspace" }),
    "new research workspace",
  );

  await page.getByRole("button", { name: "Open images", exact: true }).click();
  const sourceButton = page.locator(".research-sources").getByRole("button", {
    name: "supplier-reference-nuclei.tif 1 C / 1 Z",
    exact: true,
  });
  await visible(page, sourceButton, "imported supplier reference source");
  const importedSnapshot = await page.evaluate(() =>
    window.lociResearch.getSnapshot(),
  );
  assert.equal(importedSnapshot.sources.length, 1);
  const source = importedSnapshot.sources[0];
  assert.equal(source.name, "supplier-reference-nuclei.tif");
  assert.equal(source.sha256, sourceBefore.sha256);
  assert.deepEqual(source.metadata.dimensions, {
    c: 1,
    s: 1,
    t: 1,
    x: 256,
    y: 256,
    z: 1,
  });

  await selectWorkbenchTool(page, "Display");
  for (const [label, value] of [
    ["C", "0"],
    ["Z", "0"],
    ["T", "0"],
    ["X", "0"],
    ["Y", "0"],
    ["Width", "256"],
    ["Height", "256"],
  ]) {
    await setSelectionField(page, label, value);
  }
  await screenshot(page, "01-selected-source-region");

  await selectWorkbenchTool(page, "Model");
  await visible(
    page,
    page.getByRole("heading", { name: "Managed model package", exact: true }),
    "model workbench",
  );
  await page.getByLabel("Model working memory").selectOption(String(TWO_GIB));
  await page
    .getByRole("button", { name: "Import managed package", exact: true })
    .click();
  const usefulModels = await waitFor(
    page,
    () => page.evaluate(() => window.lociResearch.execute("model_list", {})),
    (value) => value.models.length === 1,
    "useful model reference qualification with selected memory",
    600_000,
  );
  const usefulModel = usefulModels.models[0];
  assert.equal(usefulModel.package.id, EXPECTED_MODEL.id);
  assert.equal(usefulModel.package.version, EXPECTED_MODEL.version);
  assert.equal(
    usefulModel.package.package_sha256,
    EXPECTED_MODEL.package_sha256,
  );
  assert.equal(
    usefulModel.package.metadata_sha256,
    EXPECTED_MODEL.metadata_sha256,
  );
  assert.equal(usefulModel.package.model.sha256, EXPECTED_MODEL.model_sha256);
  assert.equal(
    usefulModel.package.reference.input.sha256,
    EXPECTED_MODEL.reference_input_sha256,
  );
  assert.equal(
    usefulModel.package.reference.output.sha256,
    EXPECTED_MODEL.reference_output_sha256,
  );
  assert.equal(usefulModel.reference_qualification.compatible, true);
  assert.equal(
    usefulModel.reference_qualification.comparison.mismatched_elements,
    0,
  );
  assert.equal(
    usefulModel.reference_qualification.runtime.backend,
    "onnxruntime",
  );
  assert.equal(
    usefulModel.reference_qualification.runtime.onnx_version,
    "1.22.0",
  );
  assert.equal(
    usefulModel.reference_qualification.runtime.onnxruntime_version,
    "1.29.0",
  );
  assert.deepEqual(
    usefulModel.reference_qualification.runtime.session_providers,
    ["CPUExecutionProvider"],
  );
  assert.deepEqual(
    usefulModel.reference_qualification.comparison.shape,
    [1, 2, 224, 224],
  );
  assert.equal(
    usefulModel.reference_qualification.comparison.maximum_absolute_error,
    0.00003445148468017578,
  );
  assert.equal(usefulModel.scientific_validation.status, "unvalidated");
  assert.equal(
    usefulModel.usage_rights.review_state,
    "independent-rights-review-required",
  );
  assert.equal(usefulModel.import_working_bytes, TWO_GIB);

  await selectModel(page, usefulModel.model_id);
  await visible(
    page,
    page
      .locator(".research-model-records")
      .filter({ hasText: "reference-qualified on the recorded CPU runtime" }),
    "visible useful model qualification",
  );
  await screenshot(page, "02-useful-model-qualified");

  const usefulRun = await previewAndAdopt(
    page,
    new Set(importedSnapshot.results.map((item) => item.id)),
    "03-useful-model",
  );
  const usefulRecord = usefulRun.record;
  assert.equal(usefulRun.summary.object_count, 45);
  assert.equal(usefulRecord.result.kind, "model-segmentation");
  assert.equal(usefulRecord.result.source_id, source.id);
  assert.equal(usefulRecord.result.source_sha256, sourceBefore.sha256);
  assert.deepEqual(usefulRecord.provenance.selection, {
    x: 0,
    y: 0,
    width: 256,
    height: 256,
    t: 0,
    z: 0,
    level: 0,
  });
  assert.deepEqual(usefulRecord.provenance.channel_mapping, [
    {
      model_input_index: 0,
      model_channel: "declared-fluorescence-intensity",
      package_source_slot: 0,
      source_channel: 0,
    },
  ]);
  assert.deepEqual(usefulRecord.provenance.source_scale, {
    mode: "source",
    source_geometry: { scale_yx: [1, 1], scale_unit: "pixel" },
    model_input: { scale_yx: [1, 1], scale_unit: "pixel" },
    override_declaration: null,
    override_scope: "model-input-compatibility-only",
    scientific_output_geometry: "registered-source-geometry-unchanged",
    resampled: false,
  });
  assert.equal(usefulRecord.provenance.model.id, EXPECTED_MODEL.id);
  assert.equal(
    usefulRecord.provenance.model.package_sha256,
    EXPECTED_MODEL.package_sha256,
  );
  assert.equal(usefulRecord.provenance.runtime.backend, "onnxruntime");
  assert.equal(
    usefulRecord.provenance.reference_qualification.compatible,
    true,
  );
  assert.equal(usefulRecord.provenance.working_bytes, TWO_GIB);
  assert.deepEqual(usefulRecord.result.arrays.labels.shape, [256, 256]);
  assert.deepEqual(
    usefulRecord.result.arrays.probabilities.shape,
    [2, 256, 256],
  );
  assert.equal(
    usefulRecord.result.arrays.image.sha256,
    EXPECTED_MODEL.result_arrays.image,
  );
  assert.equal(
    usefulRecord.result.arrays.labels.sha256,
    EXPECTED_MODEL.result_arrays.labels,
  );
  assert.equal(
    usefulRecord.result.arrays.probabilities.sha256,
    EXPECTED_MODEL.result_arrays.probabilities,
  );

  await selectWorkbenchTool(page, "Info");
  await page
    .getByRole("button", { name: "Mark reviewed", exact: true })
    .click();
  const reviewedSnapshot = await waitFor(
    page,
    () => page.evaluate(() => window.lociResearch.getSnapshot()),
    (value) =>
      value.results.some(
        (item) =>
          item.id === usefulRecord.result.id &&
          item.review?.disposition === "reviewed",
      ),
    "human review of useful model result",
  );
  await page
    .getByRole("button", { name: "Export revision", exact: true })
    .click();
  await waitFor(
    page,
    () => fs.stat(path.join(exportPath, "manifest.json")).catch(() => null),
    (value) => value?.isFile() === true && value.size > 0,
    "atomic reviewed-result export",
  );
  await screenshot(page, "05-useful-model-reviewed-exported");

  await selectWorkbenchTool(page, "Model");
  await page
    .getByRole("button", { name: "Import managed package", exact: true })
    .click();
  const bothModels = await waitFor(
    page,
    () => page.evaluate(() => window.lociResearch.execute("model_list", {})),
    (value) => value.models.length === 2,
    "unseen convolution package reference qualification",
    600_000,
  );
  const generalityModel = bothModels.models.find(
    (item) => item.package.id === "unseen-synthetic-conv3x3-model",
  );
  assert.ok(
    generalityModel,
    "The separate unseen convolution model was not imported",
  );
  assert.equal(generalityModel.reference_qualification.compatible, true);
  assert.equal(
    generalityModel.reference_qualification.comparison.mismatched_elements,
    0,
  );
  assert.equal(generalityModel.scientific_validation.status, "unvalidated");
  assert.match(
    generalityModel.scientific_validation.summary,
    /Technical generality fixture only/u,
  );
  await selectModel(page, generalityModel.model_id);
  await screenshot(page, "06-unseen-conv3x3-qualified");

  const generalityRun = await previewAndAdopt(
    page,
    new Set(reviewedSnapshot.results.map((item) => item.id)),
    "07-unseen-conv3x3",
  );
  const generalityRecord = generalityRun.record;
  assert.equal(
    generalityRecord.provenance.model.id,
    "unseen-synthetic-conv3x3-model",
  );
  assert.equal(generalityRecord.provenance.runtime.backend, "onnxruntime");
  assert.deepEqual(
    generalityRecord.result.arrays.probabilities.shape,
    [1, 256, 256],
  );
  assert.ok(
    generalityRun.summary.object_count >= 1,
    "The unseen nonidentity convolution should create a measurable output",
  );

  const sourceAfterRuns = await fileIdentity(sourcePath);
  assert.deepEqual(
    sourceAfterRuns,
    sourceBefore,
    "The source identity changed during model execution",
  );
  const publicPayload = JSON.stringify({
    snapshot: generalityRun.snapshot,
    usefulModels,
    bothModels,
    usefulRecord,
    generalityRecord,
  });
  for (const privatePath of [
    sourcePath,
    usefulPackage,
    unseenPackage,
    outputRoot,
    studyPath,
    exportPath,
  ]) {
    assert.equal(
      publicPayload.includes(privatePath),
      false,
      `Renderer-safe payload disclosed a private path: ${privatePath}`,
    );
  }
  const initialCalls = await dialogCalls(app);
  assert.deepEqual(initialCalls, [
    { kind: "save", title: "Create research study" },
    { kind: "open", title: "Add microscopy or medical images" },
    { kind: "open", title: "Import a local model package" },
    { kind: "save", title: "Export reviewed result bundle" },
    { kind: "open", title: "Import a local model package" },
  ]);
  const runtime = await app.evaluate(({ app: electronApp }) => ({
    application_version: electronApp.getVersion(),
    electron: process.versions.electron,
    platform: process.platform,
    arch: process.arch,
  }));
  await close(app);
  app = undefined;
  page = undefined;

  ({ app, page } = await launch(reopenUserData, reopenRendererMessages));
  await installReopenDialog(app);
  await openResearch(page);
  await visible(
    page,
    page.getByRole("button", { name: "Open study", exact: true }),
    "fresh-profile research welcome",
  );
  await page.getByRole("button", { name: "Open study", exact: true }).click();
  await visible(
    page,
    page.getByRole("main", { name: "Research workspace" }),
    "reopened research workspace",
  );
  const reopenedSnapshot = await page.evaluate(() =>
    window.lociResearch.getSnapshot(),
  );
  assert.equal(reopenedSnapshot.sources.length, 1);
  assert.equal(reopenedSnapshot.sources[0].sha256, sourceBefore.sha256);
  assert.equal(reopenedSnapshot.results.length, 2);
  const [reopenedUseful, reopenedGenerality] = await Promise.all([
    page.evaluate(
      (result_id) => window.lociResearch.execute("result", { result_id }),
      usefulRecord.result.id,
    ),
    page.evaluate(
      (result_id) => window.lociResearch.execute("result", { result_id }),
      generalityRecord.result.id,
    ),
  ]);
  assert.deepEqual(exactNumerics(reopenedUseful), exactNumerics(usefulRecord));
  assert.deepEqual(
    exactNumerics(reopenedGenerality),
    exactNumerics(generalityRecord),
  );
  assert.equal(reopenedUseful.result.review.disposition, "reviewed");
  await page.locator(`[data-result-id="${usefulRecord.result.id}"]`).click();
  await visible(
    page,
    page.getByAltText("Exact selected result revision"),
    "reopened useful-model result",
  );
  await screenshot(page, "09-reopened-numerically-identical-results");
  const reopenCalls = await dialogCalls(app);
  assert.deepEqual(reopenCalls, [
    { kind: "open", title: "Open research study" },
  ]);

  const [sourceAfter, exportedNames] = await Promise.all([
    fileIdentity(sourcePath),
    fs.readdir(exportPath).then((items) => items.sort()),
  ]);
  assert.deepEqual(sourceAfter, sourceBefore);
  const exportIdentities = Object.fromEntries(
    await Promise.all(
      exportedNames.map(async (name) => [
        name,
        await fileIdentity(path.join(exportPath, name)),
      ]),
    ),
  );
  for (const [array, descriptor] of Object.entries(
    usefulRecord.result.arrays,
  )) {
    assert.equal(
      exportIdentities[`${array}.npy`]?.sha256,
      descriptor.sha256,
      `Exported ${array}.npy differs from the adopted result`,
    );
  }

  const report = {
    schema: "loci.research-model-workbench-packaged-qa/v1",
    status: "passed",
    claim_boundary:
      "Technical model compatibility and workflow exercise. The supplier image has no adjudicated local ground truth; scripted review is a QA action. The generated convolution is a synthetic technical-generality fixture only.",
    paths: {
      app_bundle: appBundle,
      useful_model_package: usefulPackage,
      source: sourcePath,
      output_root: outputRoot,
      study: studyPath,
      export: exportPath,
      unseen_model_package: unseenPackage,
    },
    package_identity: {
      executable: executableIdentity,
      worker: workerIdentity,
      app_archive: archiveIdentity,
    },
    runtime,
    dialog_calls: { initial: initialCalls, reopen: reopenCalls },
    original_source: { before: sourceBefore, after: sourceAfter },
    useful_model_input_package: usefulPackageIdentity,
    useful_model: {
      model_id: usefulModel.model_id,
      package_sha256: usefulModel.package.package_sha256,
      model_sha256: usefulModel.package.model.sha256,
      metadata_sha256: usefulModel.package.metadata_sha256,
      reference_qualification: usefulModel.reference_qualification,
      scientific_validation: usefulModel.scientific_validation,
      usage_rights: usefulModel.usage_rights,
      selected_region: usefulRecord.provenance.selection,
      channel_mapping: usefulRecord.provenance.channel_mapping,
      scale: usefulRecord.provenance.source_scale,
      working_bytes: usefulRecord.provenance.working_bytes,
      result: exactNumerics(usefulRecord),
      object_count: usefulRun.summary.object_count,
      reviewed: true,
      export_files: exportIdentities,
      reopen_numerically_identical: true,
    },
    unseen_model_input_package: unseenPackageIdentity,
    unseen_synthetic_generality: {
      model_id: generalityModel.model_id,
      package_sha256: generalityModel.package.package_sha256,
      model_sha256: generalityModel.package.model.sha256,
      reference_qualification: generalityModel.reference_qualification,
      scientific_validation: generalityModel.scientific_validation,
      architecture: "nonidentity Conv 3x3 followed by Sigmoid",
      source_id: generalityRecord.result.source_id,
      source_sha256: generalityRecord.result.source_sha256,
      result: exactNumerics(generalityRecord),
      object_count: generalityRun.summary.object_count,
      reopen_numerically_identical: true,
    },
    renderer_messages: {
      initial: rendererMessages,
      reopen: reopenRendererMessages,
    },
    screenshots: (await fs.readdir(screenshots)).sort(),
  };
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  await close(app);
  app = undefined;
} catch (error) {
  const failure = {
    schema: "loci.research-model-workbench-packaged-qa-failure/v1",
    status: "failed",
    error:
      error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : { name: "Unknown", message: String(error) },
    dialog_calls: app ? await dialogCalls(app).catch(() => []) : [],
    renderer_messages: {
      initial: rendererMessages,
      reopen: reopenRendererMessages,
    },
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
