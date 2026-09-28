import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

import { _electron as electron } from "playwright";

const desktopRoot = path.resolve(import.meta.dirname, "..");
const projectRoot = path.resolve(desktopRoot, "..");
const appBundle = path.resolve(
  process.env.LOCI_PACKAGED_APP ??
    path.join(desktopRoot, "..", ".loci", "builds", "current", "Loci.app",),
);
const executablePath = path.join(appBundle, "Contents", "MacOS", "Loci");
const sourceFolder = process.env.LOCI_QA_FOLDER
  ? await fs.realpath(path.resolve(process.env.LOCI_QA_FOLDER))
  : undefined;
const supportedExtensions = new Set([
  ".tif", ".tiff", ".ims", ".png", ".jpg", ".jpeg", ".nii", ".nrrd",
  ".nhdr", ".svs", ".ndpi",
]);

if (process.platform !== "darwin") throw new Error("This smoke test currently targets packaged macOS builds.");
if (!sourceFolder) throw new Error("Set LOCI_QA_FOLDER to an authorized image folder.");

async function isLociExportBundleDirectory(directory) {
  const match = /^(.*)_loci$/i.exec(path.basename(directory));
  if (!match?.[1]) return false;
  const names = new Set(
    (await fs.readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name.normalize("NFC").toLocaleLowerCase("en-US")),
  );
  if (names.has("loci-export.json")) {
    try {
      const marker = JSON.parse(await fs.readFile(path.join(directory, "loci-export.json"), "utf8"));
      if (marker?.bundle_kind === "loci-export") return true;
    } catch {
      // A malformed marker is not authoritative; retain legacy recognition.
    }
  }
  return ["overlay.png", "labels.tiff", "measurements.csv", "analysis.json"]
    .every((suffix) => names.has(`${match[1]}_${suffix}`.normalize("NFC").toLocaleLowerCase("en-US")));
}

async function countSupportedImages(directory) {
  if (await isLociExportBundleDirectory(directory)) return 0;
  let count = 0;
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      count += await countSupportedImages(entryPath);
    }
    else if (entry.isFile()) {
      const lower = entry.name.toLowerCase();
      if (supportedExtensions.has(path.extname(lower)) || lower.endsWith(".nii.gz")) count += 1;
    }
  }
  return count;
}

const expectedCount = await countSupportedImages(sourceFolder);
assert.ok(expectedCount > 0, "The authorized folder contains no supported images.");
const outputRoot = process.env.LOCI_QA_OUTPUT_ROOT
  ? path.resolve(process.env.LOCI_QA_OUTPUT_ROOT)
  : path.join(projectRoot, ".loci", "qa");
const runRoot = path.join(
  outputRoot,
  `folder-import-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`,
);
await fs.mkdir(runRoot, { recursive: true });

const startedAt = Date.now();
const electronApp = await electron.launch({
  executablePath,
  args: [`--user-data-dir=${path.join(runRoot, "user-data")}`],
  cwd: desktopRoot,
  timeout: 60_000,
});

async function closeWithConfirmedQuit() {
  try {
    await electronApp.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    });
    const closed = electronApp.waitForEvent("close", { timeout: 15_000 });
    await electronApp.evaluate(({ app }) => app.quit());
    await closed;
  } catch (err) {
    await electronApp.close().catch(() => {});
    throw err;
  }
}

let primaryFailure = null;
try {
  const page = await electronApp.firstWindow();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.locator("main.image-first-empty").waitFor();
  await electronApp.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, sourceFolder);
  await page.getByRole("button", { name: "Open folder", exact: true }).click();
  const snapshotTimeoutMs = Number(process.env.LOCI_QA_TIMEOUT_MS ?? "120000");
  const snapshotDeadline = performance.now() + snapshotTimeoutMs;
  let observedSourceCount = null;
  while (performance.now() < snapshotDeadline) {
    observedSourceCount = await page.evaluate(async () =>
      (await window.lociResearch.getSnapshot())?.sources.length ?? null);
    if (observedSourceCount === expectedCount) break;
    await page.waitForTimeout(100);
  }
  assert.equal(observedSourceCount, expectedCount,
    `The folder snapshot did not reach the authorized supported-image count within ${snapshotTimeoutMs / 1000} seconds.`);
  const sourceSelector = ".research-sources button[data-source-id] .research-source-name";
  await page.waitForFunction(
    ({ selector, count }) => document.querySelectorAll(selector).length === count,
    { selector: sourceSelector, count: expectedCount },
    { timeout: snapshotTimeoutMs },
  );
  const renderedSourceCount = await page.locator(sourceSelector).count();
  assert.equal(renderedSourceCount, expectedCount);
  const snapshot = await page.evaluate(() => window.lociResearch.getSnapshot());
  assert.equal(new Set(snapshot.sources.map((source) => source.id)).size, expectedCount);
  assert.ok(snapshot.sources.every((source) => /^[a-f0-9]{64}$/.test(source.sha256)));
  assert.equal(snapshot.results.length, 0, "Folder opening must not run analysis");
  await page.screenshot({ path: path.join(runRoot, "folder-import.png") });
  assert.equal((await page.locator("body").innerText()).includes(sourceFolder), false);
  assert.equal(await page.getByText("100% offline", { exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  process.stdout.write(`${JSON.stringify({
    durationMs: Date.now() - startedAt,
    expectedCount,
    renderedSourceCount,
    sourceFolder,
    status: "passed",
  }, null, 2)}\n`);
} catch (err) {
  primaryFailure = err;
  try {
    const page = await electronApp.firstWindow();
    if (page && !page.isClosed()) {
      await page.screenshot({ path: path.join(runRoot, "failure.png") }).catch(() => {});
      const html = await page.content().catch(() => "");
      if (html) await fs.writeFile(path.join(runRoot, "failure-page.html"), html, "utf8").catch(() => {});
      const snapshot = await page.evaluate(() => window.lociResearch?.getSnapshot?.()).catch(() => null);
      if (snapshot) {
        await fs.writeFile(path.join(runRoot, "failure-snapshot.json"), JSON.stringify(snapshot, null, 2), "utf8").catch(() => {});
      }
    }
  } catch (diagErr) {
    console.error("Warning: failed to capture failure diagnostics:", diagErr.message);
  }
  throw err;
} finally {
  try {
    await closeWithConfirmedQuit();
  } catch (quitErr) {
    if (!primaryFailure) throw quitErr;
    console.error("Warning: clean application shutdown failed:", quitErr.message);
  }
}
