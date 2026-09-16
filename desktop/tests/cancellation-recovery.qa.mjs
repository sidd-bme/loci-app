import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { _electron as electron } from "playwright";

const run = promisify(execFile);
const desktopRoot = path.resolve(import.meta.dirname, "..");
const projectRoot = path.resolve(desktopRoot, "..");
if (process.platform !== "darwin")
  throw new Error("The cancellation recovery packaged journey currently requires macOS.");

const appBundle = path.resolve(
  process.env.LOCI_PACKAGED_APP ??
    path.join(desktopRoot, "..", ".loci", "builds", "current", "Loci.app",),
);
const executablePath = path.join(appBundle, "Contents", "MacOS", "Loci");
const resourcesPath = path.join(appBundle, "Contents", "Resources");
const workerPath = path.join(resourcesPath, "loci-engine", "loci-engine");
const asarPath = path.join(resourcesPath, "app.asar");
const harnessPath = path.resolve(import.meta.filename);
const startedAt = new Date().toISOString();
const runName = startedAt.replaceAll(":", "-").replaceAll(".", "-");
const runRoot = path.resolve(
  process.env.LOCI_QA_OUTPUT_ROOT ?? path.join(os.tmpdir(), "loci-release-run"),
  "cancellation-recovery-" + runName,
);
const fixtureRoot = path.join(runRoot, "fixtures");
const fixturePath = path.join(fixtureRoot, "cancellation-owned-gray8.tif");
const studyPath = path.join(runRoot, "cancellation.loci-study");
const accessPath = path.join(runRoot, "bounded-agent-access");
const userData = path.join(runRoot, "user-data");
const screenshotsPath = path.join(runRoot, "screenshots");
const helperPath = path.join(runRoot, "persistent-mcp-cancellation.py");
const helperReportPath = path.join(runRoot, "persistent-mcp-report.json");
const width = 2200;
const height = 2200;
const memoryBytes = 512 * 1024 ** 2;
const estimatedWorkingBytes = width * height * (96 + 8);
const heavyKey = "packaged-cancel-running-v1";
const retryKey = "packaged-cancel-retry-v1";

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function identity(file) {
  const stat = await fs.stat(file);
  assert.ok(stat.isFile(), "Expected a regular file: " + file);
  return { sha256: await sha256(file), size_bytes: stat.size };
}

async function buildIdentity() {
  return {
    executable: await identity(executablePath),
    app_asar: await identity(asarPath),
    worker: await identity(workerPath),
  };
}

function writeGray8Tiff(file, imageWidth, imageHeight, pixels) {
  assert.equal(pixels.length, imageWidth * imageHeight);
  const entries = [
    [256, 4, 1, imageWidth],
    [257, 4, 1, imageHeight],
    [258, 3, 1, 8],
    [259, 3, 1, 1],
    [262, 3, 1, 1],
    [273, 4, 1, 134],
    [277, 3, 1, 1],
    [278, 4, 1, imageHeight],
    [279, 4, 1, pixels.length],
    [284, 3, 1, 1],
  ];
  const output = Buffer.alloc(134 + pixels.length);
  output.write("II", 0, "ascii");
  output.writeUInt16LE(42, 2);
  output.writeUInt32LE(8, 4);
  output.writeUInt16LE(entries.length, 8);
  entries.forEach(([tag, type, count, value], index) => {
    const offset = 10 + index * 12;
    output.writeUInt16LE(tag, offset);
    output.writeUInt16LE(type, offset + 2);
    output.writeUInt32LE(count, offset + 4);
    if (type === 3) output.writeUInt16LE(value, offset + 8);
    else output.writeUInt32LE(value, offset + 8);
  });
  output.writeUInt32LE(0, 130);
  Buffer.from(pixels).copy(output, 134);
  return fs.writeFile(file, output);
}

async function workerCli(...args) {
  const result = await run(workerPath, ["--cli", ...args], {
    cwd: desktopRoot,
    timeout: 180_000,
    maxBuffer: 64 * 1024 ** 2,
  });
  return JSON.parse(result.stdout);
}

async function launch() {
  const app = await electron.launch({
    executablePath,
    args: ["--user-data-dir=" + userData],
    cwd: desktopRoot,
    timeout: 120_000,
  });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setBounds({ width: 1280, height: 820 });
  });
  return { app, page };
}

async function installDialogs(app) {
  await app.evaluate(({ dialog }, values) => {
    dialog.showOpenDialog = async (...args) => {
      if (args.at(-1)?.title === "Open research study")
        return { canceled: false, filePaths: [values.study] };
      return { canceled: true, filePaths: [] };
    };
    dialog.showSaveDialog = async (...args) => {
      if (args.at(-1)?.title === "Create private MCP access bundle")
        return { canceled: false, filePath: values.access };
      return { canceled: true, filePath: undefined };
    };
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }, { study: studyPath, access: accessPath });
}

async function openStudy(page) {
  await page.locator("main.image-first-empty, main.image-first-workbench").waitFor({ state: "visible", timeout: 30_000 });
  await page.locator("main.image-first-empty, main.image-first-workbench").waitFor();
  const workspace = page.getByRole("main", { name: "Research workspace" });
  if (!(await workspace.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: "Open study", exact: true }).click();
  }
  await workspace.waitFor({ state: "visible", timeout: 30_000 });
}

async function closeApp(app) {
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  });
  await app.close();
}

async function listFiles(root) {
  const found = [];
  async function visit(folder) {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) await visit(file);
      else found.push(path.relative(root, file));
    }
  }
  await visit(root);
  return found.sort();
}

await Promise.all([
  fs.mkdir(fixtureRoot, { recursive: true }),
  fs.mkdir(screenshotsPath, { recursive: true }),
  fs.access(executablePath, fs.constants.X_OK),
  fs.access(workerPath, fs.constants.X_OK),
]);
assert.ok(
  estimatedWorkingBytes <= memoryBytes,
  "The heavy cancellation request must remain within its explicit memory budget.",
);
const pixels = new Uint8Array(width * height);
for (let y = 800; y < 1400; y++) pixels.fill(100, y * width + 800, y * width + 1400);
await writeGray8Tiff(fixturePath, width, height, pixels);
const fixtureIdentity = await identity(fixturePath);
const buildBefore = await buildIdentity();
const git = async (...args) => (await run("git", args, { cwd: projectRoot })).stdout.trim();
const sourceIdentity = {
  head: await git("rev-parse", "HEAD"),
  tree: await git("rev-parse", "HEAD^{tree}"),
  status_before: await git("status", "--porcelain"),
  harness_sha256: await sha256(harnessPath),
};

await workerCli("create", "--project", studyPath, "--title", "Cancellation recovery QA");
const imported = await workerCli("import", "--project", studyPath, fixturePath);
assert.equal(imported.sources.length, 1);
const source = imported.sources[0];
assert.equal(source.sha256, fixtureIdentity.sha256);

const recipe = {
  steps: Array.from({ length: 32 }, () => ({ op: "gaussian", sigma: 16 })),
  segmentation: { method: "components", threshold: 50 },
  measurement_channels: [0],
  working_bytes: memoryBytes,
};
const heavyRequest = {
  source_id: source.id,
  selection: { x: 0, y: 0, width, height, z: 0 },
  recipe,
};
const renderer = { page_errors: [], console_errors: [], http_requests: [] };
let firstApp;
let firstPage;
let accessReceipt;
try {
  ({ app: firstApp, page: firstPage } = await launch());
  firstPage.on("pageerror", (error) => renderer.page_errors.push(error.message));
  firstPage.on("console", (message) => {
    if (message.type() === "error") renderer.console_errors.push(message.text());
  });
  firstPage.on("request", (request) => {
    if (/^https?:/iu.test(request.url())) renderer.http_requests.push(request.url());
  });
  await installDialogs(firstApp);
  await openStudy(firstPage);
  const opened = await firstPage.evaluate(() => window.lociResearch.getSnapshot());
  assert.equal(opened.sources[0].id, source.id);
  accessReceipt = await firstPage.evaluate(
    (request) => window.lociResearch.createAgentAccess(request),
    {
      ...heavyRequest,
      allow_preview: false,
      allow_run: true,
      allow_export: false,
      export_names: [],
      disclosures: ["geometry", "measurements", "provenance", "agent_metadata"],
      limits: { cpu_seconds: 120, memory_bytes: memoryBytes, concurrency: 1 },
    },
  );
  assert.equal(accessReceipt?.source_id, source.id);
  assert.deepEqual(accessReceipt?.operations, [
    "cancel_job", "inspect_source", "job_status", "result", "submit_recipe", "validate_recipe",
  ]);
  await firstPage.screenshot({
    path: path.join(screenshotsPath, "policy-created.png"),
    fullPage: true,
  });
  await closeApp(firstApp);
} catch (error) {
  await firstPage?.screenshot({
    path: path.join(screenshotsPath, "policy-creation-failure.png"), fullPage: true,
  }).catch(() => undefined);
  await firstApp?.close().catch(() => undefined);
  throw error;
}

const policyPath = path.join(accessPath, "agent-policy.json");
const configPath = path.join(accessPath, "mcp-config.json");
const approvedPath = path.join(accessPath, "approved-request.json");
const accessIdentities = {
  policy: await identity(policyPath),
  config: await identity(configPath),
  approved_request: await identity(approvedPath),
};
assert.equal(accessReceipt.policy_sha256, accessIdentities.policy.sha256);
assert.deepEqual(JSON.parse(await fs.readFile(approvedPath, "utf8")), {
  source_id: source.id,
  selection: { x: 0, y: 0, width, height, z: 0, t: 0, c: 0, level: 0 },
  recipe: { ...recipe, gates: [] },
});

await fs.writeFile(helperPath, String.raw`
import asyncio
import importlib.metadata
import json
import sys
import time

from fastmcp import Client


def structured(response):
    value = getattr(response, "structured_content", None)
    if not isinstance(value, dict):
        raise AssertionError("MCP response did not include structured content")
    return value


async def call(client, tool, arguments):
    return structured(await client.call_tool(tool, arguments))


async def await_state(client, job_id, accepted, transitions, timeout=120):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = await call(client, "job_status", {"job_id": job_id})
        job = value["job"]
        if not transitions or transitions[-1]["state"] != job["state"]:
            transitions.append({
                "state": job["state"],
                "cancel_requested": job["cancel_requested"],
                "observed_monotonic_seconds": time.monotonic(),
            })
        if job["state"] in accepted:
            return job
        await asyncio.sleep(0.02)
    raise TimeoutError(f"Timed out waiting for {accepted}: {job}")


async def main(config_path, request_path, report_path):
    with open(config_path, encoding="utf-8") as stream:
        config = json.load(stream)
    with open(request_path, encoding="utf-8") as stream:
        heavy = json.load(stream)
    cancelled_transitions = []
    retry_transitions = []
    started = time.monotonic()

    async with Client(config) as client:
        tool_names = sorted(tool.name for tool in await client.list_tools())
        submitted = (await call(client, "submit_recipe", {
            "request": heavy, "request_key": ${JSON.stringify(heavyKey)},
        }))["job"]
        job_id = submitted["id"]
        running = await await_state(client, job_id, {"running"}, cancelled_transitions)
        if running["state"] != "running":
            raise AssertionError(f"Heavy job never reached running: {running}")
        await asyncio.sleep(0.25)
        running_after_dwell = (await call(client, "job_status", {"job_id": job_id}))["job"]
        if running_after_dwell["state"] != "running":
            raise AssertionError(f"Heavy job did not remain in flight before cancellation: {running_after_dwell}")
        cancel_sent_at = time.monotonic()
        cancel_response = (await call(client, "cancel_job", {"job_id": job_id}))["job"]
        cancelled = await await_state(
            client, job_id, {"cancelled", "failed", "succeeded"}, cancelled_transitions,
        )
        if cancelled["state"] != "cancelled":
            raise AssertionError(f"Heavy job did not cancel: {cancelled}")
        if cancelled["result_ids"] or not cancelled["cancel_requested"]:
            raise AssertionError(f"Cancelled job published a result or lost cancellation: {cancelled}")
        repeated = (await call(client, "submit_recipe", {
            "request": heavy, "request_key": ${JSON.stringify(heavyKey)},
        }))["job"]
        if repeated["id"] != job_id or repeated["state"] != "cancelled":
            raise AssertionError(f"Same-key replay was not idempotent: {repeated}")

    restart_one = time.monotonic()
    retry = json.loads(json.dumps(heavy))
    retry["selection"].update({"x": 800, "y": 800, "width": 64, "height": 64})
    async with Client(config) as client:
        retry_submitted = (await call(client, "submit_recipe", {
            "request": retry, "request_key": ${JSON.stringify(retryKey)},
        }))["job"]
        retry_job_id = retry_submitted["id"]
        succeeded = await await_state(
            client, retry_job_id, {"cancelled", "failed", "succeeded"}, retry_transitions,
        )
        if succeeded["state"] != "succeeded" or len(succeeded["result_ids"]) != 1:
            raise AssertionError(f"New-key retry did not succeed: {succeeded}")

    restart_two = time.monotonic()
    async with Client(config) as client:
        reopened_cancelled = (await call(client, "job_status", {"job_id": job_id}))["job"]
        reopened_succeeded = (await call(client, "job_status", {"job_id": retry_job_id}))["job"]
        reopened_result = await call(
            client, "result", {"result_id": succeeded["result_ids"][0], "offset": 0, "limit": 100},
        )
    if reopened_cancelled["state"] != "cancelled" or reopened_succeeded["state"] != "succeeded":
        raise AssertionError("Durable jobs changed state after two MCP server restarts")
    if reopened_result["result"]["id"] != succeeded["result_ids"][0]:
        raise AssertionError("The completed retry result was unavailable after restart")

    report = {
        "fastmcp_version": importlib.metadata.version("fastmcp"),
        "tool_names": tool_names,
        "cancelled_job": cancelled,
        "running_after_dwell": running_after_dwell,
        "cancel_response": cancel_response,
        "same_key_replay": repeated,
        "retry_job": succeeded,
        "reopened_cancelled_job": reopened_cancelled,
        "reopened_retry_job": reopened_succeeded,
        "reopened_result": reopened_result,
        "cancelled_transitions": cancelled_transitions,
        "retry_transitions": retry_transitions,
        "timings_seconds": {
            "submit_to_cancel_sent": cancel_sent_at - started,
            "cancel_to_terminal": cancelled_transitions[-1]["observed_monotonic_seconds"] - cancel_sent_at,
            "first_server_closed": restart_one - started,
            "second_server_closed": restart_two - started,
            "total": time.monotonic() - started,
        },
        "server_restart_count": 2,
    }
    with open(report_path, "w", encoding="utf-8") as stream:
        json.dump(report, stream, indent=2)
        stream.write("\n")


asyncio.run(main(*sys.argv[1:]))
`);

const sandboxProfile = "(version 1)(allow default)(deny network*)";
await run(
  "/usr/bin/sandbox-exec",
  [
    "-p", sandboxProfile,
    "uvx", "--offline", "--from", "fastmcp==4.0.3", "python", helperPath,
    configPath, approvedPath, helperReportPath,
  ],
  {
    cwd: runRoot,
    env: { ...process.env, UV_OFFLINE: "1", NO_PROXY: "*", no_proxy: "*" },
    timeout: 180_000,
    maxBuffer: 16 * 1024 ** 2,
  },
);
const mcp = JSON.parse(await fs.readFile(helperReportPath, "utf8"));
const cancelledStates = mcp.cancelled_transitions.map((item) => item.state);
assert.ok(cancelledStates.indexOf("running") >= 0);
assert.equal(cancelledStates.at(-1), "cancelled");
assert.ok(cancelledStates.indexOf("running") < cancelledStates.indexOf("cancelled"));
assert.equal(mcp.same_key_replay.id, mcp.cancelled_job.id);
assert.equal(mcp.retry_job.state, "succeeded");
assert.equal(mcp.server_restart_count, 2);

const durable = await workerCli("snapshot", "--project", studyPath);
assert.equal(durable.jobs.length, 2);
assert.equal(durable.results.length, 1);
const cancelledJob = durable.jobs.find((job) => job.id === mcp.cancelled_job.id);
const succeededJob = durable.jobs.find((job) => job.id === mcp.retry_job.id);
assert.equal(cancelledJob?.state, "cancelled");
assert.equal(cancelledJob?.cancel_requested, true);
assert.deepEqual(cancelledJob?.result_ids, []);
assert.equal(succeededJob?.state, "succeeded");
assert.deepEqual(succeededJob?.result_ids, [durable.results[0].id]);
const resultRecord = await workerCli(
  "execute", "--project", studyPath, "result", "--request",
  JSON.stringify({ result_id: durable.results[0].id, offset: 0, limit: 100 }),
);
const artifactFiles = await listFiles(path.join(studyPath, "artifacts"));
const expectedArtifactFiles = Object.values(resultRecord.result.arrays)
  .map((descriptor) => descriptor.sha256 + ".npy").sort();
assert.deepEqual(artifactFiles, expectedArtifactFiles);
assert.equal((await workerCli("jobs", "--project", studyPath)).jobs.length, 2);
assert.deepEqual(await identity(fixturePath), fixtureIdentity);
assert.equal((await workerCli("snapshot", "--project", studyPath)).sources[0].sha256, fixtureIdentity.sha256);

let reopenedApp;
let reopenedPage;
try {
  ({ app: reopenedApp, page: reopenedPage } = await launch());
  reopenedPage.on("pageerror", (error) => renderer.page_errors.push(error.message));
  reopenedPage.on("console", (message) => {
    if (message.type() === "error") renderer.console_errors.push(message.text());
  });
  reopenedPage.on("request", (request) => {
    if (/^https?:/iu.test(request.url())) renderer.http_requests.push(request.url());
  });
  await installDialogs(reopenedApp);
  await openStudy(reopenedPage);
  const reopened = await reopenedPage.evaluate(() => window.lociResearch.getSnapshot());
  assert.equal(reopened.jobs.length, 2);
  assert.equal(reopened.results.length, 1);
  assert.equal(reopened.jobs.find((job) => job.id === cancelledJob.id)?.state, "cancelled");
  assert.equal(reopened.jobs.find((job) => job.id === succeededJob.id)?.state, "succeeded");
  await reopenedPage.getByText(`cancelled · ${cancelledJob.id.slice(0, 8)}`, { exact: true })
    .waitFor({ state: "visible" });
  await reopenedPage.getByText(`succeeded · ${succeededJob.id.slice(0, 8)}`, { exact: true })
    .waitFor({ state: "visible" });
  const reopenedResult = reopenedPage.locator(`[data-result-id="${durable.results[0].id}"]`);
  await reopenedResult.waitFor({ state: "visible" });
  await reopenedResult.click();
  await reopenedPage.waitForFunction(
    (resultId) => document.querySelector(`[data-result-id="${resultId}"]`)?.classList
      .contains("selected"),
    durable.results[0].id,
  );
  await reopenedPage.screenshot({
    path: path.join(screenshotsPath, "cancelled-and-retry-reopened.png"),
    fullPage: true,
  });
  await closeApp(reopenedApp);
} catch (error) {
  await reopenedPage?.screenshot({
    path: path.join(screenshotsPath, "reopen-failure.png"), fullPage: true,
  }).catch(() => undefined);
  await reopenedApp?.close().catch(() => undefined);
  throw error;
}

assert.deepEqual(renderer.page_errors, []);
assert.deepEqual(renderer.console_errors, []);
assert.deepEqual(renderer.http_requests, []);
assert.deepEqual(await buildIdentity(), buildBefore);
const sourceAfter = {
  head: await git("rev-parse", "HEAD"),
  tree: await git("rev-parse", "HEAD^{tree}"),
  status_after: await git("status", "--porcelain"),
};
assert.equal(sourceAfter.head, sourceIdentity.head);
assert.equal(sourceAfter.tree, sourceIdentity.tree);

const report = {
  schema: "loci.cancellation-recovery-packaged-qa/v1",
  status: "passed",
  app_bundle: appBundle,
  run_root: runRoot,
  study_path: studyPath,
  source: { ...sourceIdentity, ...sourceAfter },
  build: buildBefore,
  fixture: {
    ...fixtureIdentity,
    dimensions: { width, height },
    owned_synthetic: true,
  },
  policy: {
    receipt: accessReceipt,
    files: accessIdentities,
    limits: { cpu_seconds: 120, memory_bytes: memoryBytes, concurrency: 1 },
    estimated_working_bytes: estimatedWorkingBytes,
  },
  mcp,
  durable_state: {
    job_count: durable.jobs.length,
    result_count: durable.results.length,
    cancelled_job_id: cancelledJob.id,
    succeeded_retry_job_id: succeededJob.id,
    result_id: durable.results[0].id,
  },
  artifact_files: artifactFiles,
  expected_artifact_files: expectedArtifactFiles,
  no_partial_or_orphan_artifacts: true,
  fixture_identity_unchanged: true,
  build_identity_unchanged: true,
  app_reopen_usable: true,
  renderer,
  screenshots: (await fs.readdir(screenshotsPath)).sort(),
  hardware: {
    platform: os.platform(),
    arch: os.arch(),
    cpu: os.cpus()[0]?.model,
    total_memory_bytes: os.totalmem(),
  },
  started_at: startedAt,
  finished_at: new Date().toISOString(),
};
await fs.writeFile(path.join(runRoot, "qa-report.json"), JSON.stringify(report, null, 2) + "\n");
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
