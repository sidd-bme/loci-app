import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { _electron as electron } from "playwright";

const run = promisify(execFile);
const desktopRoot = path.resolve(import.meta.dirname, "..");
const projectRoot = path.resolve(desktopRoot, "..");
const appInput = process.env.LOCI_PACKAGED_APP;
assert.ok(process.platform === "darwin", "The patient MPR journey qualifies a packaged macOS app.");
assert.ok(appInput && path.isAbsolute(appInput), "LOCI_PACKAGED_APP must be an absolute path to Loci.app.");
const appBundle = path.resolve(appInput);
const outputRoot = path.resolve(process.env.LOCI_QA_OUTPUT_ROOT ??
  path.resolve(import.meta.dirname, "../../.loci/evidence/qa/patient-mpr"));
const runRoot = path.join(outputRoot, new Date().toISOString().replaceAll(/[:.]/g, "-"));
const shots = path.join(runRoot, "screenshots");
const fixture = path.join(runRoot, "synthetic-oblique-patient-volume.nii.gz");
const receiptPath = path.join(runRoot, "patient-mpr-receipt.json");
const failurePath = path.join(runRoot, "patient-mpr-failure.json");
const executable = path.join(appBundle, "Contents", "MacOS", "Loci");
const resources = path.join(appBundle, "Contents", "Resources");
const worker = path.join(resources, "loci-engine", "loci-engine");
const appAsar = path.join(resources, "app.asar");
const python = path.join(projectRoot, "engine", ".venv", "bin", "python");
const userData = path.join(runRoot, "user-data");
await Promise.all([fs.mkdir(shots, { recursive: true }), fs.mkdir(userData, { recursive: true })]);

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

const generator = path.join(runRoot, "generate_oblique_nifti.py");
await fs.writeFile(generator, String.raw`from pathlib import Path
import math
import numpy as np
import SimpleITK as sitk

out = Path(${JSON.stringify(fixture)})
z, y, x = np.indices((16, 20, 24), dtype=np.float32)
gradient = x * 41 + y * 23 + z * 17
ellipsoid = (((x - 8) / 4.5) ** 2 + ((y - 12) / 5.0) ** 2 + ((z - 6) / 3.5) ** 2) <= 1
data = (np.clip(gradient + ellipsoid * 1700, 0, 4095) * 16).astype(np.uint16)
assert int(data.max()) < 65535
image = sitk.GetImageFromArray(data)
angle = math.radians(20)
image.SetSpacing((0.7, 1.1, 2.3))
image.SetOrigin((12.0, -18.0, 30.0))
image.SetDirection((math.cos(angle), -math.sin(angle), 0.0,
                    math.sin(angle), math.cos(angle), 0.0,
                    0.0, 0.0, 1.0))
sitk.WriteImage(image, str(out), True)
readback = sitk.ReadImage(str(out))
assert readback.GetSize() == (24, 20, 16)
assert np.allclose(readback.GetSpacing(), (0.7, 1.1, 2.3))
assert np.allclose(readback.GetDirection(), image.GetDirection(), atol=1e-5)
`);
await run(python, [generator], { timeout: 120_000 });

const fixtureHash = await sha256(fixture);
// Medical sources bind an ordered file manifest, even for a single NIfTI.
// Independently reproduce its identity while retaining the raw-file hash below.
const encodedSize = Buffer.alloc(16);
encodedSize.writeBigUInt64BE(BigInt((await fs.stat(fixture)).size), 8);
const sourceManifestHash = createHash("sha256").update("Loci medical source identity v1\0")
  .update(encodedSize).update(Buffer.from(fixtureHash, "hex")).digest("hex");
const build = {
  executable_sha256: await sha256(executable),
  worker_sha256: await sha256(worker),
  app_asar_sha256: await sha256(appAsar),
  harness_sha256: await sha256(import.meta.filename),
};
const fixtureIdentity = {
  path: fixture, sha256: fixtureHash, medical_manifest_sha256: sourceManifestHash,
  synthetic_non_biological: true,
  format: "NIfTI", dimensions_xyz: [24, 20, 16], spacing_xyz_mm: [0.7, 1.1, 2.3],
  origin_xyz_mm: [12, -18, 30], frame: "LPS", rotation_about_z_degrees: 20,
  pattern: "known uint16 gradient plus ellipsoid",
};
const startedAt = new Date().toISOString();
const captures = {};
const pageErrors = [];
const consoleErrors = [];
let app;
let page;
let source;
let journey = {};

async function capture(name) {
  const target = path.join(shots, `${name}.png`);
  const bytes = await page.screenshot({ path: target });
  assert.ok(bytes.length > 2_000, `${name} did not capture substantive UI evidence.`);
  captures[name] = { file: path.relative(runRoot, target), bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex") };
}
async function noUiError(action) {
  const alert = page.locator(".research-alert[role=alert]");
  if (await alert.isVisible().catch(() => false))
    throw new Error(`${action}: ${(await alert.textContent()) ?? "unknown UI error"}`);
}
async function waitFor(check, action, timeout = 120_000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    await noUiError(action);
    const value = await check();
    if (value) return value;
    await page.waitForTimeout(50);
  }
  throw new Error(`${action}: timed out.`);
}
async function closeApp() {
  if (!app) return;
  const closing = app;
  await closing.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }).catch(() => undefined);
  const closed = closing.waitForEvent("close", { timeout: 30_000 }).catch(() => undefined);
  await closing.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
  await closed; app = undefined; page = undefined;
}
async function crosshairState() {
  const indices = await Promise.all(["X", "Y", "Z"].map(async (axis) =>
    Number(await page.getByLabel(`${axis} source index`, { exact: true }).textContent())));
  const marks = await page.locator(".mpr-pane:not(.mpr-pane-volume)").evaluateAll((panes) => panes.map((pane) => ({
    pane: pane.getAttribute("data-pane"),
    horizontal: pane.querySelector(".mpr-crosshair-horizontal")?.getAttribute("style"),
    vertical: pane.querySelector(".mpr-crosshair-vertical")?.getAttribute("style"),
  })));
  return { indices, marks };
}

try {
  app = await electron.launch({ executablePath: executable,
    args: [`--user-data-dir=${userData}`], cwd: desktopRoot, timeout: 120_000 });
  page = await app.firstWindow(); page.setDefaultTimeout(30_000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  await app.evaluate(({ BrowserWindow, dialog }, sourcePath) => {
    const window = BrowserWindow.getAllWindows()[0];
    window?.setBounds({ width: 1320, height: 900 }); window?.show(); window?.focus();
    dialog.showOpenDialog = async (...args) => args.at(-1)?.title === "Add microscopy or medical images"
      ? { canceled: false, filePaths: [sourcePath] } : { canceled: true, filePaths: [] };
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }, fixture);
  await page.getByRole("button", { name: "Open images", exact: true }).click();
  await page.getByRole("main", { name: "Research workspace" }).waitFor({ timeout: 120_000 });
  source = await waitFor(async () => {
    const snapshot = await page.evaluate(() => window.lociResearch.getSnapshot());
    return snapshot.sources.length === 1 ? snapshot.sources[0] : null;
  }, "importing the synthetic oblique NIfTI");
  assert.equal(source.identity_kind, "ordered-medical-source-manifest-sha256");
  assert.equal(source.sha256, sourceManifestHash, "The managed source does not match the fixture manifest.");
  const volumeButton = page.getByRole("button", { name: "3D volume", exact: true });
  await volumeButton.waitFor({ state: "visible", timeout: 120_000 }); await volumeButton.click();
  const viewport = page.locator(".raw-volume");
  await viewport.waitFor({ state: "visible", timeout: 120_000 });
  await waitFor(async () => (await viewport.locator(".raw-volume-status").textContent())?.includes("display"),
    "rendering the patient-frame volume");
  await page.getByText("Patient-frame planes · radiological orientation · linked crosshair · resliced display samples, not native measurements", { exact: true }).waitFor();
  await page.getByText(/Rotating source XYZ axes · LPS frame/).waitFor();
  const geometry = await page.evaluate(async (sourceId) => {
    const result = await window.lociResearch.execute("viewer_volume", {
      source_id: sourceId, t: 0, channel_indices: [0], target_long_axis: 128,
    });
    const { source_id, source_sha256, dimensions_xyz, spacing_xyz, origin_xyz,
      direction_3x3, unit, frame } = result.context;
    return { source_id, source_sha256, dimensions_xyz, spacing_xyz, origin_xyz, direction_3x3, unit, frame };
  }, source.id);
  const angle = 20 * Math.PI / 180;
  const close = (actual, expected) => actual.length === expected.length &&
    actual.every((value, index) => Math.abs(value - expected[index]) < 1e-5);
  assert.equal(geometry.source_id, source.id); assert.equal(geometry.source_sha256, sourceManifestHash);
  assert.deepEqual(geometry.dimensions_xyz, [24, 20, 16]); assert.equal(geometry.frame, "LPS"); assert.equal(geometry.unit, "mm");
  assert.ok(close(geometry.spacing_xyz, [0.7, 1.1, 2.3]) && close(geometry.origin_xyz, [12, -18, 30]));
  assert.ok(close(geometry.direction_3x3,
    [Math.cos(angle), Math.sin(angle), 0, -Math.sin(angle), Math.cos(angle), 0, 0, 0, 1]),
  "The packaged worker did not preserve the oblique source direction.");

  const expected = { Axial: ["R", "L", "A", "P"], Coronal: ["R", "L", "S", "I"], Sagittal: ["A", "P", "S", "I"] };
  const planes = {};
  for (const [name, edges] of Object.entries(expected)) {
    const pane = page.getByRole("region", { name: `${name} view`, exact: true });
    await pane.waitFor({ state: "visible" });
    assert.deepEqual(await pane.locator(".mpr-orientation").allTextContents(), edges,
      `${name} orientation labels do not match radiological LPS convention.`);
    assert.match((await pane.locator(".mpr-plane-position").textContent()) ?? "", / mm$/);
    const pixels = await pane.locator(`canvas[aria-label="${name} resliced image"]`).evaluate((canvas) => {
      const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      let bright = 0; const levels = new Set();
      for (let i = 0; i < data.length; i += 4) { const level = Math.max(data[i], data[i + 1], data[i + 2]); if (level >= 24) bright++; levels.add(level); }
      return { width: canvas.width, height: canvas.height, bright_pixels: bright, intensity_levels: levels.size };
    });
    assert.ok(pixels.width * pixels.height >= 80 && pixels.bright_pixels >= 20 && pixels.intensity_levels >= 8,
      `${name} does not contain substantive resliced scalar pixels.`);
    planes[name] = { orientation_edges: edges, pixels };
    await page.getByRole("button", { name: `Expand ${name} view`, exact: true }).click();
    assert.equal(await page.locator(".mpr-pane:visible").count(), 1, `${name} did not expand alone.`);
    await page.getByRole("button", { name: `Restore ${name} view`, exact: true }).click();
    assert.equal(await page.locator(".mpr-pane:visible").count(), 4, `${name} restore did not recover four panes.`);
  }

  const before = await crosshairState();
  const axial = page.locator('canvas[aria-label="Axial resliced image"]');
  const box = await axial.boundingBox(); assert.ok(box && box.width > 20 && box.height > 20);
  await page.mouse.click(box.x + box.width * 0.62, box.y + box.height * 0.43);
  const after = await waitFor(async () => {
    const state = await crosshairState();
    return JSON.stringify(state.indices) !== JSON.stringify(before.indices) ? state : null;
  }, "moving the linked crosshair from the Axial pane", 10_000);
  assert.equal(after.marks.length, 3);
  for (const mark of after.marks) assert.notDeepEqual(mark, before.marks.find((item) => item.pane === mark.pane),
    `${mark.pane} did not reflect the linked patient-frame crosshair move.`);
  await capture("01-patient-frame-mpr");
  journey = { source: { id: source.id, name: source.name, sha256: source.sha256 }, geometry, planes,
    crosshair: { before, after, input: "real primary-pointer click at Axial 62% x, 43% y" } };

  const finalSnapshot = await page.evaluate(() => window.lociResearch.getSnapshot());
  assert.equal(finalSnapshot.sources.find((item) => item.id === source.id)?.sha256, sourceManifestHash);
  assert.equal(await sha256(fixture), fixtureHash, "Viewing changed the synthetic NIfTI bytes.");
  assert.deepEqual(await Promise.all([sha256(executable), sha256(worker), sha256(appAsar)]),
    [build.executable_sha256, build.worker_sha256, build.app_asar_sha256], "Packaged artifacts changed during QA.");
  assert.deepEqual(pageErrors, [], "The renderer emitted page errors.");
  assert.deepEqual(consoleErrors, [], "The renderer emitted console errors.");
  await closeApp();
  await fs.writeFile(receiptPath, `${JSON.stringify({ schema: "loci.patient-mpr-packaged-qa/v1", status: "passed",
    started_at: startedAt, completed_at: new Date().toISOString(), invocation: `LOCI_PACKAGED_APP=${appBundle} node tests/patient-mpr.qa.mjs`,
    assumptions: ["Synthetic NIfTI geometry is interpreted by the medical reader in LPS millimetres.", "All display assertions exercise the packaged renderer and frozen worker through the real Open images and 3D volume controls."],
    build, fixture: fixtureIdentity, journey, screenshots: captures,
    assertions: { patient_plane_names_and_radiological_orientation_labels: true, substantive_three_plane_pixels: true,
      every_plane_expand_restore: true, linked_crosshair_pointer_move: true, source_and_build_bytes_unchanged: true },
    renderer: { page_errors: pageErrors, console_errors: consoleErrors } }, null, 2)}\n`);
  process.stdout.write(`${receiptPath}\n`);
} catch (error) {
  let failureScreenshot;
  if (page) try { await capture("99-failure"); failureScreenshot = captures["99-failure"]; } catch {}
  let closeError;
  try { await closeApp(); } catch (caught) { closeError = caught instanceof Error ? caught.message : String(caught); }
  await fs.writeFile(failurePath, `${JSON.stringify({ schema: "loci.patient-mpr-qa-failure/v1", status: "failed",
    started_at: startedAt, failed_at: new Date().toISOString(), error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined, close_error: closeError, build, fixture: fixtureIdentity,
    source, journey, screenshot: failureScreenshot, renderer: { page_errors: pageErrors, console_errors: consoleErrors } }, null, 2)}\n`);
  throw error;
}
