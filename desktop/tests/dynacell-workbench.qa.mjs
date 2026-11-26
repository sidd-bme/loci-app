/**
 * Packaged macOS and Windows x64 DynaCell journey. Point LOCI_PACKAGED_APP at
 * the .app bundle or the Windows directory containing Loci.exe.
 * Required absolute paths: LOCI_PACKAGED_APP, LOCI_QA_OUTPUT_ROOT (new directory),
 * LOCI_QA_MODEL_SOURCE (paired CZYX OME-TIFF), LOCI_QA_EXPECTED_PREDICTION
 * (independently computed ZYX .npy), LOCI_QA_PYTHON (NumPy and tifffile).
 * LOCI_QA_DYNACELL_CHECKPOINT selects the offline import path. With no checkpoint
 * path, the workflow explicitly installs from Biohub. Set LOCI_QA_SOURCE_COMMIT
 * to pin the clean embedded revision and LOCI_QA_SCREENSHOTS=1 for local captures.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  close, dialogCalls, executableFile, fileIdentity, inside, launch, plainDirectory,
  plainFile, projectRoot, requiredPath, run, sha256, visible,
} from "./research-model-workbench.qa.mjs";
import { createEmptyStudy, fileMenuAction, sourceRowByName, waitForSnapshot } from "./workbench-qa-helpers.mjs";

const PICKER_SOURCE = "Add microscopy or medical images";
const PICKER_CREATE = "Create research study";
const PICKER_CHECKPOINT = "Choose the DynaCell iPSC nuclear checkpoint";
const windows = process.platform === "win32";
assert.ok(process.platform === "darwin" || (windows && process.arch === "x64"), "Use a supported packaged desktop");
const PICKER_PREDICT = windows ? "Create a virtual stain folder on a fixed local NTFS drive" : "Create a new folder for the virtual stain";
const PICKER_SAVE = "Save research study as";
const PICKER_REOPEN = "Open research study";
const SHA256 = /^[a-f0-9]{64}$/u;
const SOURCE_ID = /^[a-f0-9]{32}$/u;
const SHA1 = /^[a-f0-9]{40}$/u;

const bundle = requiredPath("LOCI_PACKAGED_APP");
const requestedOutput = requiredPath("LOCI_QA_OUTPUT_ROOT");
const source = requiredPath("LOCI_QA_MODEL_SOURCE");
const expected = requiredPath("LOCI_QA_EXPECTED_PREDICTION");
const python = requiredPath("LOCI_QA_PYTHON");
const checkpoint = process.env.LOCI_QA_DYNACELL_CHECKPOINT
  ? requiredPath("LOCI_QA_DYNACELL_CHECKPOINT") : null;
const output = path.join(await fs.realpath(path.dirname(requestedOutput)), path.basename(requestedOutput));
assert.ok(!inside(projectRoot, output) || inside(path.join(projectRoot, ".loci", "evidence"), output),
  "Use a fresh output directory outside the source tree or below .loci/evidence");
assert.ok(!inside(await fs.realpath(bundle), output), "Keep QA output outside the packaged app");
const resources = windows ? path.join(bundle, "resources") : path.join(bundle, "Contents", "Resources");
const executablePath = windows ? path.join(bundle, "Loci.exe") : path.join(bundle, "Contents", "MacOS", "Loci");
const worker = path.join(resources, "loci-engine", windows ? "loci-engine.exe" : "loci-engine");
const archive = path.join(resources, "app.asar");
const manifest = path.join(resources, "loci-build-identity.json");
const initialStudy = path.join(output, "initial.loci-study");
const savedStudy = path.join(output, "saved.loci-study");
const destination = path.join(output, "virtual-stain");
const profiles = ["initial-profile", "cold-profile"].map((name) => path.join(output, name));
const verifier = path.join(projectRoot, "scripts", "qa", "verify_dynacell_bundle.py");
const capture = process.env.LOCI_QA_SCREENSHOTS === "1";
const privatePaths = [bundle, output, source, expected, checkpoint, python].filter(Boolean);
const report = {
  schema: "loci.dynacell-workbench-packaged-qa/v1",
  platform: process.platform,
  architecture: process.arch,
  status: "running",
  stage: "preflight",
  started_at: new Date().toISOString(),
  checkpoint_route: checkpoint ? "offline import" : "Biohub install",
  claim_scope: "Packaged workflow and full-field agreement with an independent computational reference.",
  dialogs: {},
  network: {},
  screenshots: [],
};

function redact(value) {
  let message = String(value);
  for (const item of [...privatePaths, projectRoot].sort((a, b) => b.length - a.length)) {
    message = message.replaceAll(item, "<local>");
  }
  return message.replace(/(?:file:\/\/|https?:\/\/)[^\s"'<>]+/giu, "<url>")
    .replace(/(?:\/[^\s"'<>():]+){2,}/gu, "<path>").slice(0, 4000);
}

function assertPublicPayload(payload) {
  const json = JSON.stringify(payload);
  for (const item of privatePaths) {
    const escaped = JSON.stringify(item).slice(1, -1);
    assert.ok(!json.includes(escaped), "Renderer-safe payload disclosed a local path");
  }
}

async function installPickers(app, open, save) {
  await app.evaluate(({ dialog }, routes) => {
    globalThis.__lociModelQaDialogCalls = [];
    const pick = (kind, options) => {
      const title = options?.title;
      globalThis.__lociModelQaDialogCalls.push({ kind, title });
      if (!Object.hasOwn(routes[kind], title)) throw new Error(`Unexpected ${kind} picker: ${title}`);
      return routes[kind][title];
    };
    dialog.showOpenDialog = async (...args) => ({ canceled: false, filePaths: [pick("open", args.at(-1))] });
    dialog.showSaveDialog = async (...args) => ({ canceled: false, filePath: pick("save", args.at(-1)) });
  }, { open, save });
}

function offlineEnvironment() {
  const proxy = "http://127.0.0.1:9";
  return {
    ...process.env,
    HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1",
    HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy, NO_PROXY: "",
    http_proxy: proxy, https_proxy: proxy, all_proxy: proxy, no_proxy: "",
  };
}

async function guardNetwork(app) {
  await app.evaluate(({ session }) => {
    globalThis.__lociDynacellQaBlockedCount = 0;
    const network = session.defaultSession;
    network.enableNetworkEmulation({ offline: true });
    network.webRequest.onBeforeRequest((details, respond) => {
      const cancel = /^(?:https?|wss?):/iu.test(details.url);
      if (cancel) globalThis.__lociDynacellQaBlockedCount++;
      respond({ cancel });
    });
  });
}

async function checkNetwork(app, phase, proxyGuard) {
  const blocked = await app.evaluate(() => globalThis.__lociDynacellQaBlockedCount);
  report.network[phase] = { electron_session_offline: true, proxy_environment: proxyGuard, blocked_http_ws_requests: blocked };
  assert.equal(blocked, 0, "Unexpected network request in the offline Electron session");
}

async function openVirtualStain(page) {
  await fileMenuAction(page, "Model Zoo…");
  const zoo = page.getByRole("dialog", { name: /Model Zoo/u });
  await zoo.locator('[data-model-id="dynacell-ipsc-nucleus"] .model-zoo-card__select').click();
  await zoo.getByRole("button", { name: "Open virtual stain control", exact: true }).click();
  await zoo.waitFor({ state: "hidden" });
  return visible(page, page.getByRole("region", { name: "DynaCell virtual stain", exact: true }), "virtual stain controls");
}

async function expectActiveCanvas(page, sourceRecord) {
  assert.match(sourceRecord.id, SOURCE_ID);
  const row = await sourceRowByName(page, sourceRecord.name);
  const viewport = page.locator(`.image-viewport[data-viewer-source="${sourceRecord.id}"][data-prepared="true"]`);
  await visible(page, viewport.locator("canvas").first(), "prepared canvas for the exact source");
  assert.equal(await row.getAttribute("aria-current"), "true", "The expected source was not activated");
  assert.equal(await viewport.getAttribute("aria-label"), `Image viewer: ${sourceRecord.name}`);
  return viewport;
}

async function shot(locator, name) {
  if (!capture) return;
  const file = `${name}.png`;
  await locator.screenshot({ path: path.join(output, file) });
  report.screenshots.push(file);
}

async function absent(file) {
  await assert.rejects(fs.lstat(file), { code: "ENOENT" });
}

async function verify(...args) {
  const { stdout } = await run(python, [verifier, source, expected, ...args], { timeout: 120_000 });
  return JSON.parse(stdout);
}

const readJson = (file) => fs.readFile(file, "utf8").then(JSON.parse);
const buildHashes = async () => Object.fromEntries(await Promise.all(
  Object.entries({ executable: executablePath, worker, archive, identity: manifest })
    .map(async ([name, file]) => [name, await sha256(file)]),
));
const snapshot = (page) => page.evaluate(() => window.lociResearch.getSnapshot());
const picker = (kind, title) => ({ kind, title });
const sourceIdentity = (record) => ({
  id: record.id, sha256: record.sha256, size_bytes: record.size_bytes, metadata: record.metadata,
});

await fs.mkdir(output, { mode: 0o700 });
let app;
try {
  await Promise.all([
    plainFile(source, "Paired OME-TIFF"), plainFile(expected, "Independent prediction"),
    executableFile(python, "QA Python"), plainFile(executablePath, "Packaged app executable", true),
    plainFile(worker, "Packaged engine executable", true), plainFile(archive, "Packaged archive"),
    plainFile(manifest, "Packaged build identity"), ...(checkpoint ? [plainFile(checkpoint, "Checkpoint")] : []),
  ]);
  const [identity, hashes, original, reference] = await Promise.all([
    readJson(manifest), buildHashes(), fileIdentity(source), fileIdentity(expected),
  ]);
  assert.equal(identity.sourceDirty, false, "Packaged QA requires a clean embedded source identity");
  assert.match(identity.sourceRevision, SHA1);
  assert.match(identity.sourceTree, SHA1);
  assert.ok(Number.isSafeInteger(identity.buildNumber) && identity.buildNumber > 0);
  const pin = process.env.LOCI_QA_SOURCE_COMMIT ?? identity.sourceRevision;
  assert.match(pin, SHA1, "LOCI_QA_SOURCE_COMMIT must be a full Git revision");
  assert.equal(identity.sourceRevision, pin, "Packaged revision differs from LOCI_QA_SOURCE_COMMIT");
  const { stdout: tree } = await run("git", ["rev-parse", "--verify", `${pin}^{tree}`], { cwd: projectRoot });
  assert.equal(identity.sourceTree, tree.trim(), "Embedded tree differs from Git");
  report.build = { revision: pin, tree: identity.sourceTree, build_number: identity.buildNumber, sha256: hashes };
  report.harness_sha256 = { driver: await sha256(import.meta.filename), independent_verifier: await sha256(verifier) };
  report.fixture = await verify();
  report.source = { before: original };
  report.reference = reference;

  report.stage = "new-study";
  const initial = await launch(profiles[0], [], {
    executablePath, env: checkpoint ? offlineEnvironment() : process.env,
  });
  app = initial.app;
  const page = initial.page;
  if (checkpoint) await guardNetwork(app);
  await installPickers(app, {
    [PICKER_SOURCE]: source,
    ...(checkpoint ? { [PICKER_CHECKPOINT]: checkpoint } : {}),
  }, { [PICKER_CREATE]: initialStudy, [PICKER_PREDICT]: destination, [PICKER_SAVE]: savedStudy });
  await createEmptyStudy(page);
  await visible(page, page.getByRole("main", { name: "Research workspace" }), "new research workspace");
  await fileMenuAction(page, "Add images…");
  const imported = await waitForSnapshot(page, (state) => state?.sources?.length === 1, "declared input source", 120_000);
  const parent = imported.sources[0];
  assert.match(parent.id, SOURCE_ID);
  assert.equal(parent.sha256, original.sha256);
  assert.equal(parent.size_bytes, original.size_bytes);
  assert.deepEqual(parent.metadata.channel_names, ["Phase3D", "Nuclei"]);
  await expectActiveCanvas(page, parent);

  report.stage = "checkpoint-install";
  const panel = await openVirtualStain(page);
  const installLocal = panel.getByRole("button", { name: "Import checkpoint…", exact: true });
  const installPublisher = panel.getByRole("button", { name: "Install from Biohub", exact: true });
  const install = checkpoint ? installLocal : installPublisher;
  const missing = panel.getByText(/download from Biohub/u);
  const channel = panel.getByRole("combobox", { name: /^Reconstructed phase channel\b/u });
  const confirm = panel.getByRole("checkbox", { name: /This channel is reconstructed Phase3D/u });
  const predict = panel.getByRole("button", { name: "Predict nuclear stain…", exact: true });
  await visible(page, missing, "missing checkpoint in the fresh profile");
  await channel.selectOption({ label: "Phase3D" });
  await confirm.check();
  assert.equal(await predict.isDisabled(), true, "Confirmed phase still requires verified weights");
  await confirm.uncheck();
  assert.equal(await (checkpoint ? installPublisher : installLocal).isEnabled(), true);
  await install.click();
  const ready = panel.getByText("Verified checkpoint available offline", { exact: true });
  const installError = panel.getByRole("alert");
  await visible(page, ready.or(installError).first(), "checkpoint installation outcome", 600_000);
  if (await installError.isVisible()) throw new Error(await installError.innerText());
  if (!checkpoint) await guardNetwork(app);

  report.stage = "input-gates";
  await channel.selectOption({ label: "Nuclei" });
  await visible(page, panel.getByRole("status").filter({ hasText: /recorded as Phase3D/u }), "undeclared phase input");
  assert.equal(await confirm.count(), 0);
  assert.equal(await predict.isDisabled(), true, "Measured nuclear channel must not enable phase prediction");
  await channel.selectOption({ label: "Phase3D" });
  await visible(page, confirm, "phase confirmation gate");
  assert.equal(await confirm.isChecked(), false);
  assert.equal(await predict.isDisabled(), true, "Valid phase metadata alone must not enable prediction");
  const afterInstall = await snapshot(page);
  assert.deepEqual(afterInstall.sources.map(sourceIdentity), [sourceIdentity(parent)]);
  assert.deepEqual(afterInstall.results, imported.results);
  await absent(destination);
  const installDialogs = [picker("save", PICKER_CREATE), picker("open", PICKER_SOURCE)];
  if (checkpoint) installDialogs.push(picker("open", PICKER_CHECKPOINT));
  assert.deepEqual(await dialogCalls(app), installDialogs, "Checkpoint provisioning must not prompt for output");
  await shot(panel, "01-ready-awaiting-phase-confirmation");
  await confirm.check();
  assert.equal(await predict.isEnabled(), true);
  report.input_gates = { checkpoint_required: true, undeclared_channel_rejected: true, confirmation_required: true, install_without_inference: true };

  report.stage = "predict";
  await predict.click();
  const failed = page.locator(".research-alert[role=alert]").filter({ visible: true }).first();
  await visible(page, page.locator("[data-source-id]").filter({ hasText: /DynaCell predicted nuclei/u }).first().or(failed).first(),
    "published source or prediction error", 600_000);
  if (await failed.isVisible()) throw new Error(await failed.innerText());
  const published = await waitForSnapshot(page,
    (state) => state?.sources?.some((item) => item.name.startsWith("DynaCell predicted nuclei")),
    "published DynaCell source");
  assert.equal(published.sources.length, 2);
  const derived = published.sources.find((item) => item.id !== parent.id);
  assert.equal(derived.name, `DynaCell predicted nuclei · ${parent.name.slice(0, 210)} · T0`);
  assert.equal(derived.source_kind, "native");
  assert.deepEqual(published.results, imported.results);
  assert.deepEqual(sourceIdentity(published.sources.find((item) => item.id === parent.id)), sourceIdentity(parent));
  assertPublicPayload(published);
  await shot(await expectActiveCanvas(page, derived), "02-active-virtual-stain");

  report.stage = "independent-readback";
  await plainDirectory(destination, "Published artifact directory");
  const science = await verify("--bundle", destination);
  const record = await readJson(path.join(destination, "provenance.json"));
  assertPublicPayload(record);
  assert.equal(record.source_id, parent.id);
  assert.match(science.artifact_sha256, SHA256);
  assert.equal(derived.sha256, science.artifact_sha256);
  assert.deepEqual(derived.derivation, {
    schema: "loci.dynacell-derived-source/v1", record, provenance_sha256: science.provenance_sha256,
  });
  assert.deepEqual(derived.metadata.physical_calibration, { axes: "ZYX", unit: "µm", spacing: science.spacing_zyx_um });
  assert.deepEqual(derived.metadata.channel_names, science.channels);
  report.output = { ...science, source_id: derived.id, parent_source_id: parent.id };

  report.stage = "save";
  await fileMenuAction(page, "Save study");
  await visible(page, page.getByText("Saved locally", { exact: true }), "saved study");
  await plainFile(path.join(savedStudy, "study.sqlite3"), "Saved study database");
  const initialDialogs = await dialogCalls(app);
  assert.deepEqual(initialDialogs, [...installDialogs, picker("save", PICKER_PREDICT), picker("save", PICKER_SAVE)]);
  report.dialogs.initial = initialDialogs;
  await checkNetwork(app, "prediction", Boolean(checkpoint));
  await close(app);
  app = undefined;

  report.stage = "cold-reopen";
  const reopened = await launch(profiles[1], [], { executablePath, env: offlineEnvironment() });
  app = reopened.app;
  await guardNetwork(app);
  await installPickers(app, { [PICKER_REOPEN]: savedStudy }, {});
  const coldPage = reopened.page;
  await coldPage.getByRole("button", { name: "Open study", exact: true }).click();
  const cold = await waitForSnapshot(coldPage, (state) => state?.sources?.length === 2, "cold study sources", 120_000);
  assertPublicPayload(cold);
  const coldDerived = cold.sources.find((item) => item.id === derived.id);
  assert.deepEqual(sourceIdentity(coldDerived), sourceIdentity(derived));
  assert.deepEqual(coldDerived.derivation, derived.derivation);
  assert.deepEqual(sourceIdentity(cold.sources.find((item) => item.id === parent.id)), sourceIdentity(parent));
  const originalRow = await sourceRowByName(coldPage, parent.name);
  await originalRow.click();
  const coldPanel = await openVirtualStain(coldPage);
  await visible(coldPage, coldPanel.getByText(/download from Biohub/u), "fresh profile without a checkpoint");
  await (await sourceRowByName(coldPage, derived.name)).click();
  await shot(await expectActiveCanvas(coldPage, coldDerived), "03-cold-offline-virtual-stain");
  const reopenDialogs = await dialogCalls(app);
  assert.deepEqual(reopenDialogs, [picker("open", PICKER_REOPEN)]);
  report.dialogs.reopen = reopenDialogs;
  await checkNetwork(app, "cold_reopen", true);
  await close(app);
  app = undefined;

  report.stage = "final-integrity";
  report.source.after = await fileIdentity(source);
  assert.deepEqual(report.source.after, original, "Original source changed during QA");
  assert.deepEqual(await fileIdentity(expected), reference, "Independent reference changed during QA");
  assert.deepEqual(await buildHashes(), hashes, "Packaged binaries changed during QA");
  assert.equal(await sha256(path.join(destination, "image.ome.tif")), science.artifact_sha256);
  assert.equal(await sha256(path.join(destination, "provenance.json")), science.provenance_sha256);
  report.cold_reopen = { identical_source_and_derivation: true, rendered_without_checkpoint: true };
  report.stage = "complete";
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  // Assertion diffs can include whole metadata objects. Retain the headline only.
  const detail = error instanceof assert.AssertionError ? error.message.split("\n")[0]
    : error instanceof Error ? error.message : error;
  report.error = redact(detail);
  process.stderr.write(`DynaCell QA failed during ${report.stage}: ${report.error}\n`);
  process.exitCode = 1;
} finally {
  if (app) await app.close().catch(() => undefined);
  report.finished_at = new Date().toISOString();
  await fs.writeFile(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}
