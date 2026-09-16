// A deliberately small, real-process qualification smoke for an unsigned
// Windows bundle. It is not a clean-host installer or scientific validation.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { _electron as electron } from "playwright";
import { selectWorkbenchTool } from "./workbench-qa-helpers.mjs";

const run = promisify(execFile);
const desktopRoot = path.resolve(import.meta.dirname, "..");
const defaultBundle = path.join(desktopRoot, "out", "local-unsigned", "Loci-win32-x64");
const bundle = path.resolve(process.env.LOCI_PACKAGED_APP ?? defaultBundle);
const source = process.env.LOCI_QA_IMAGE;
assert.equal(process.platform, "win32", "This smoke is for a native Windows package.");
assert.ok(source && path.isAbsolute(source), "LOCI_QA_IMAGE must be an authorized absolute RGB or scalar fixture path.");
const outputRoot = path.resolve(process.env.LOCI_QA_OUTPUT_ROOT ?? path.join(os.tmpdir(), "loci-windows-smoke"));
assert.ok(path.relative(desktopRoot, outputRoot).startsWith(`..${path.sep}`), "LOCI_QA_OUTPUT_ROOT must be outside the checkout.");

const executable = path.join(bundle, "Loci.exe");
const worker = path.join(bundle, "resources", "loci-engine", "loci-engine.exe");
const runRoot = path.join(outputRoot, new Date().toISOString().replaceAll(":", "-"));
const userData = path.join(runRoot, "user-data");
const studyPath = path.join(runRoot, "windows-image-first.loci-study");
await fs.mkdir(userData, { recursive: true });

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
async function exists(file) {
  await fs.access(file);
  return true;
}
await Promise.all([exists(executable), exists(worker), exists(source)]);
const identity = { executable_sha256: await sha256(executable), worker_sha256: await sha256(worker) };
const health = await new Promise((resolve, reject) => {
  const child = spawn(worker, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("error", reject);
  child.once("close", (code) => {
    if (code !== 0) reject(new Error(`Frozen worker exited ${code}: ${stderr}`));
    else {
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    }
  });
  child.stdin.end('{"id":"windows-smoke-health","method":"health","params":{}}\n');
});
assert.equal(health.result?.status, "ready", "Packaged frozen worker health failed.");
const discovery = JSON.parse((await run(worker, ["--cli", "discover"], { windowsHide: true })).stdout);
assert.equal(discovery.schema, "loci.operations/v1", "Packaged frozen worker discovery contract failed.");

let app;
try {
  app = await electron.launch({
    executablePath: executable,
    args: ["--user-data-dir=" + userData],
    cwd: desktopRoot,
    timeout: 120_000,
  });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1100, height: 760 }));
  await app.evaluate(({ dialog }, values) => {
    dialog.showOpenDialog = async (...args) => {
      const options = args.at(-1);
      if (options?.title === "Add microscopy or medical images") return { canceled: false, filePaths: [values.source] };
      if (options?.title === "Open research study") return { canceled: false, filePaths: [values.study] };
      return { canceled: true, filePaths: [] };
    };
    dialog.showSaveDialog = async (...args) => args.at(-1)?.title === "Save research study as"
      ? { canceled: false, filePath: values.study } : { canceled: true, filePath: undefined };
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }, { source, study: studyPath });

  await page.locator("main.image-first-empty").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByRole("button", { name: "Open images", exact: true }).click();
  await page.getByRole("main", { name: "Research workspace" }).waitFor({ state: "visible", timeout: 60_000 });
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  await page.getByText(/histogram/i).first().waitFor({ state: "visible", timeout: 30_000 });
  await selectWorkbenchTool(page, "Analyze");
  await page.getByRole("button", { name: "Run recipe" }).click();
  await page.locator(".research-result-table tbody tr").first().waitFor({ state: "visible", timeout: 120_000 });
  await page.locator("details.workbench-file-menu summary").click();
  await page.getByRole("button", { name: "Save as study…", exact: true }).click();
  await fs.access(path.join(studyPath, "study.sqlite3"));
  await page.keyboard.press("F1");
  await page.getByRole("dialog", { name: "User manual" }).waitFor({ state: "visible" });
  await page.getByLabel("Close user manual").click();
  await page.getByLabel("Open settings").first().click();
  await page.getByRole("dialog", { name: "Settings" }).waitFor({ state: "visible" });
  await page.getByLabel("Close settings").click();
  await page.locator("details.workbench-file-menu summary").click();
  await page.getByRole("button", { name: "Open study", exact: true }).click();
  await page.getByRole("main", { name: "Research workspace" }).waitFor({ state: "visible", timeout: 60_000 });
  process.stdout.write(JSON.stringify({ status: "passed", bundle, source, studyPath, identity, worker_schema: discovery.schema }, null, 2) + "\n");
} finally {
  if (app) await app.close().catch(() => undefined);
}
