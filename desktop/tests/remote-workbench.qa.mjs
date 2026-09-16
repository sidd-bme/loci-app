import assert from "node:assert/strict";
import { selectWorkbenchTool } from "./workbench-qa-helpers.mjs";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";

import { _electron as electron } from "playwright";

if (process.platform !== "darwin")
  throw new Error("The current external remote-workbench qualification requires macOS.");

const desktopRoot = path.resolve(import.meta.dirname, "..");
const defaultBundle = path.join(
  desktopRoot, "..", ".loci", "builds", "current", "Loci.app",
);
const appBundle = path.resolve(process.env.LOCI_PACKAGED_APP ?? defaultBundle);
const studyPath = process.env.LOCI_REMOTE_QA_STUDY
  ? path.resolve(process.env.LOCI_REMOTE_QA_STUDY)
  : null;
if (!studyPath)
  throw new Error("Set LOCI_REMOTE_QA_STUDY to the exact qualified study directory.");

const runName = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const runRoot = path.resolve(
  process.env.LOCI_QA_OUTPUT_ROOT ?? path.join(desktopRoot, "..", ".loci", "qa"),
  "remote-workbench-" + runName,
);
const screenshots = path.join(runRoot, "screenshots");
const userData = path.join(runRoot, "user-data");
const reportPath = path.join(runRoot, "qa-report.json");
const failurePath = path.join(runRoot, "qa-failure.json");
const executablePath = path.join(appBundle, "Contents", "MacOS", "Loci");
const asarPath = path.join(appBundle, "Contents", "Resources", "app.asar");
const workerPath = path.join(
  appBundle, "Contents", "Resources", "loci-engine", "loci-engine",
);
const requestKey = "ee72cb3fd9984f7eb1ead860808018b8";
const requestSha = "d979e74711440f4db8dba145334280c60b70eb40766ee06f38d397a2a81fbf0c";
const jobId = "1354725.stdct-mgmt-02";
const attachedResultId = "df5ab20ecb4044c8b704d2be46136311";

async function sha256(file) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}

await Promise.all([
  fs.access(executablePath),
  fs.access(asarPath),
  fs.access(workerPath),
  fs.access(path.join(studyPath, "study.sqlite3")),
  fs.mkdir(screenshots, { recursive: true }),
  fs.mkdir(userData, { recursive: true }),
]);

const app = await electron.launch({
  executablePath,
  args: ["--user-data-dir=" + userData],
  cwd: desktopRoot,
  timeout: 120_000,
});
const page = await app.firstWindow();
const pageErrors = [];
const consoleErrors = [];
const networkRequests = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("request", (request) => {
  if (/^https?:/i.test(request.url())) networkRequests.push(request.url());
});
await app.evaluate(({ BrowserWindow, dialog }, study) => {
  BrowserWindow.getAllWindows()[0].setBounds({ width: 1280, height: 900 });
  dialog.showOpenDialog = async (...args) => {
    const options = args.at(-1);
    return options?.title === "Open research study"
      ? { canceled: false, filePaths: [study] }
      : { canceled: true, filePaths: [] };
  };
  dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
}, studyPath);

const alert = page.locator(".research-alert[role=alert], .research-remote-error[role=alert]");
const noUiError = async (action) => {
  if (await alert.isVisible().catch(() => false))
    throw new Error(`${action}: ${(await alert.textContent()) ?? "unknown UI error"}`);
};

let report;
let closed = false;
try {
  await page.locator("main.image-first-empty, main.image-first-workbench").waitFor({ state: "visible", timeout: 60_000 });
  await page.locator("main.image-first-empty, main.image-first-workbench").waitFor();
  await page.getByRole("button", { name: "Open study" }).click();
  await page.getByRole("main", { name: "Research workspace" })
    .waitFor({ state: "visible", timeout: 60_000 });
  await selectWorkbenchTool(page, "Remote");
  await page.getByText("Saved remote state loaded.", { exact: true })
    .waitFor({ state: "visible", timeout: 60_000 });

  const profileReceipt = page.getByLabel("Saved remote profile receipt");
  await profileReceipt.waitFor({ state: "visible" });
  await page.getByText("Saved requested resources: 1 CPU · 4096 MiB · 0 GPU · 5 min", { exact: true })
    .waitFor({ state: "visible" });
  await page.getByText("Run requested resources: 1 CPU · 4096 MiB · 0 GPU · 5 min", { exact: true })
    .waitFor({ state: "visible" });
  const runtime = page.getByLabel("Attached result runtime");
  await runtime.waitFor({ state: "visible", timeout: 60_000 });
  assert.match((await runtime.textContent()) ?? "", /Requested deviceauto/);
  assert.match((await runtime.textContent()) ?? "", /Resolved devicecpu/);
  assert.match((await runtime.textContent()) ?? "", /Fallbacknone/);
  assert.equal(await page.getByLabel("Saved remote run").inputValue(), requestKey);
  assert.ok(await page.getByText(`job ${jobId}`, { exact: true }).isVisible());
  assert.ok(await page.getByText(requestSha, { exact: true }).isVisible());

  const before = await page.evaluate(() => window.lociResearch.getSnapshot());
  const beforeRemote = await page.evaluate(() => Promise.all([
    window.lociResearch.execute("remote_profile_list", {}),
    window.lociResearch.execute("remote_run_list", {}),
  ]));
  const beforeRun = beforeRemote[1].runs.find((item) => item.request_key === requestKey);
  assert.equal(beforeRun.state, "cleaned");
  assert.equal(beforeRun.remote_job_id, jobId);
  assert.deepEqual(beforeRun.resources, {
    cpus: 1, memory_mb: 4096, wall_minutes: 5, gpus: 0,
  });
  const beforeResult = await page.evaluate(
    (result_id) => window.lociResearch.execute("result", { result_id, offset: 0, limit: 1 }),
    attachedResultId,
  );
  assert.equal(beforeResult.provenance.runtime.requested_device, "auto");
  assert.equal(beforeResult.provenance.runtime.resolved_device, "cpu");
  assert.equal(beforeResult.provenance.runtime.fallback_reason, null);
  assert.equal(beforeResult.provenance.remote_attachment.request_key, requestKey);

  await page.getByRole("button", { name: "Test pinned connection" }).click();
  await page.getByText("Pinned connection verified.", { exact: true })
    .waitFor({ state: "visible", timeout: 120_000 });
  await noUiError("pinned connection test");

  const after = await page.evaluate(() => window.lociResearch.getSnapshot());
  const afterRemote = await page.evaluate(() => Promise.all([
    window.lociResearch.execute("remote_profile_list", {}),
    window.lociResearch.execute("remote_run_list", {}),
  ]));
  const afterRun = afterRemote[1].runs.find((item) => item.request_key === requestKey);
  assert.equal(afterRun.state, "cleaned");
  assert.equal(afterRun.remote_job_id, jobId);
  assert.equal(afterRemote[1].runs.length, beforeRemote[1].runs.length);
  assert.equal(after.results.length, before.results.length);
  const vanda = afterRemote[0].profiles.find((item) => item.alias === "vanda");
  assert.equal(vanda.connection.host_key_sha256, "SHA256:J0eBgNQAQkYMCq84GBB/wGxEq3T4KIitJd043DdZ8E0");

  const geometryMatrix = [];
  const layouts = [
    { width: 1024, height: 720, theme: "graphite", textSize: "normal" },
    { width: 1280, height: 900, theme: "midnight", textSize: "normal" },
    { width: 1024, height: 720, theme: "paper", textSize: "large" },
  ];
  for (const layout of layouts) {
    await app.evaluate(({ BrowserWindow }, bounds) => {
      BrowserWindow.getAllWindows()[0].setBounds(bounds);
    }, { width: layout.width, height: layout.height });
    await page.evaluate(({ theme, textSize }) => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.dataset.textSize = textSize;
    }, layout);
    await page.waitForTimeout(100);
    const geometry = await page.evaluate(() => {
      const inspector = document.querySelector(".research-inspector");
      const panel = document.querySelector(".research-remote");
      if (!(inspector instanceof HTMLElement) || !(panel instanceof HTMLElement))
        return { violations: ["Remote inspector or panel is missing."], inspector: null };
      const inspectorRect = inspector.getBoundingClientRect();
      const violations = [];
      const overflowSelectors = [
        ".research-remote", ".research-remote details", ".research-remote-grid",
        ".research-remote-sources", ".research-remote-sources fieldset",
        ".research-remote-map", ".research-remote-receipt", ".research-remote-runtime",
      ];
      for (const selector of overflowSelectors) {
        for (const element of document.querySelectorAll(selector)) {
          if (element instanceof HTMLElement && element.scrollWidth > element.clientWidth + 1)
            violations.push(`${selector} horizontal overflow ${element.scrollWidth}/${element.clientWidth}`);
        }
      }
      for (const control of panel.querySelectorAll("input, select, textarea, button")) {
        if (!(control instanceof HTMLElement)) continue;
        const rect = control.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        if (rect.left < inspectorRect.left - 1 || rect.right > inspectorRect.right + 1)
          violations.push(`${control.getAttribute("aria-label") ?? control.textContent ?? control.tagName} outside inspector ${rect.left.toFixed(1)}..${rect.right.toFixed(1)} vs ${inspectorRect.left.toFixed(1)}..${inspectorRect.right.toFixed(1)}`);
      }
      return {
        violations,
        inspector: {
          width: inspectorRect.width,
          clientWidth: inspector.clientWidth,
          scrollWidth: inspector.scrollWidth,
          panelClientWidth: panel.clientWidth,
          panelScrollWidth: panel.scrollWidth,
        },
      };
    });
    assert.deepEqual(geometry.violations, [], `${JSON.stringify(layout)}: ${geometry.violations.join(" | ")}`);
    const name = `${layout.width}x${layout.height}-${layout.theme}-${layout.textSize}.png`;
    await page.screenshot({ path: path.join(screenshots, name), fullPage: true });
    geometryMatrix.push({ ...layout, ...geometry, screenshot: path.join(screenshots, name) });
  }

  const screenshot = path.join(screenshots, "remote-cpu-recovery.png");
  await page.screenshot({ path: screenshot, fullPage: true });
  assert.deepEqual(pageErrors, [], `Renderer errors: ${pageErrors.join(" | ")}`);
  assert.deepEqual(consoleErrors, [], `Console errors: ${consoleErrors.join(" | ")}`);
  assert.deepEqual(networkRequests, [], `Unexpected HTTP requests: ${networkRequests.join(" | ")}`);
  report = {
    schema: "loci.remote-workbench-packaged-qa/v1",
    completed_at: new Date().toISOString(),
    app_bundle: appBundle,
    executable_sha256: await sha256(executablePath),
    app_asar_sha256: await sha256(asarPath),
    worker_sha256: await sha256(workerPath),
    study: studyPath,
    request_key: requestKey,
    request_sha256: requestSha,
    remote_job_id: jobId,
    saved_resources_visible: true,
    attached_runtime_visible: {
      requested_device: "auto", resolved_device: "cpu", fallback_reason: null,
    },
    pinned_connection_retested: true,
    run_count_unchanged: true,
    result_count_unchanged: true,
    geometry_matrix: geometryMatrix,
    renderer_errors: pageErrors,
    console_errors: consoleErrors,
    http_requests: networkRequests,
    screenshot,
    claim_boundary: "Packaged UI and remote identity recovery only; no new job and no biological or clinical accuracy claim.",
  };
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ runRoot, report }, null, 2) + "\n");
  const done = app.waitForEvent("close", { timeout: 30_000 });
  await app.evaluate(({ app }) => app.quit());
  await done;
  closed = true;
} catch (error) {
  const failureScreenshot = path.join(screenshots, "failure.png");
  const failure = {
    schema: "loci.remote-workbench-packaged-qa-failure/v1",
    status: "failed",
    error: error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : { name: "Unknown", message: String(error) },
    renderer_errors: pageErrors,
    console_errors: consoleErrors,
    http_requests: networkRequests,
    screenshot: await page.screenshot({ path: failureScreenshot, fullPage: true })
      .then(() => failureScreenshot).catch(() => null),
    ui_text: await page.locator("body").innerText().catch(() => "UI unavailable"),
  };
  await fs.writeFile(failurePath, JSON.stringify(failure, null, 2) + "\n");
  process.stderr.write(JSON.stringify({ runRoot, failure }, null, 2) + "\n");
  throw error;
} finally {
  if (!closed) await app.close().catch(() => undefined);
}
