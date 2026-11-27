/** Packaged macOS researcher journey on the designated Sidecar display.
 * Run from desktop with LOCI_QA_SECONDARY_DISPLAY, LOCI_PACKAGED_APP,
 * LOCI_QA_SOURCE_COMMIT, LOCI_QA_PYTHON, LOCI_QA_BBBC039_SOURCE and
 * LOCI_QA_OUTPUT_ROOT set:
 * node --import ../scripts/qa/secondary-display-loader.mjs tests/live-assistant-study.qa.mjs
 * Optional LOCI_QA_ASSISTANT=codex (default antigravity). For another public
 * BBBC039 plane, supply LOCI_QA_BBBC039_SHA256 and LOCI_QA_THRESHOLD.
 * Set LOCI_QA_ONNX_PACKAGE to the pinned local package to run two-method QA.
 * Run with --preflight and without the display preload for headless validation.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { _electron as electron } from "playwright";

import { close, executableFile, noUiError, plainFile, projectRoot, requiredPath, run, sha256 } from "./research-model-workbench.qa.mjs";
import { selectResultSection, selectWorkbenchTool, setSelectionField, sourceRowByName, waitForSnapshot } from "./workbench-qa-helpers.mjs";
import {
  compareSavedMethods, comparisonPreflight, comparisonRequest, importComparisonModel, inspectSavedDifferences, modelPickerTitle,
  runScopedModel, verifyComparisonPackage,
} from "./live-assistant-comparison.qa.mjs";

const fixtureHash = "502822d7b7f4a7164b6f7e1c2b35807724e1f755efba4678b60b4ea492db3ad9";
const openTitle = "Open research study";
const setupTitle = "Create private MCP access bundle";
const clientId = "Loci study QA SDK";
const json = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const hashText = (text) => createHash("sha256").update(text).digest("hex");

// Reuse the same official Python SDK controller as agent-sessions.qa.mjs. The
// caller verifies the exact generated command and arguments before spawning it.
function startSdk(python, helper, worker, policy, name = clientId) {
  const child = spawn(python, [helper, "serve", worker, policy, "--client-name", name],
    { stdio: ["pipe", "pipe", "pipe"] });
  let diagnostic = "";
  child.stderr.setEncoding("utf8").on("data", (text) => { diagnostic = (diagnostic + text).slice(-4096); });
  child.stdin.on("error", () => {}); // A write callback or the close event reports a dead controller.
  const exited = once(child, "close");
  exited.catch(() => {});
  const responses = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let nextId = 0;
  let pending = false;
  async function read() {
    const signal = AbortSignal.timeout(30_000);
    const result = await Promise.race([
      responses.next(),
      once(signal, "abort").then(() => { throw new Error("MCP controller response timed out"); }),
      exited.then(() => { throw new Error(`MCP controller exited before returning a response: ${diagnostic}`); }),
    ]);
    assert.equal(result.done, false, "MCP controller ended its response stream");
    return JSON.parse(result.value);
  }
  async function request(message) {
    assert.equal(pending, false, "Drive only one outstanding SDK request at a time");
    pending = true;
    try {
      const id = ++nextId;
      await new Promise((resolve, reject) => child.stdin.write(JSON.stringify({ id, ...message }) + "\n",
        (error) => error ? reject(error) : resolve()));
      const response = await read();
      assert.equal(response.id, id, "MCP controller response did not match its command");
      assert.ok(!response.controller_error, response.message ?? response.controller_error);
      return response;
    } finally {
      pending = false;
    }
  }
  return {
    read,
    request,
    async callResponse(name, args = {}, expectedError = false) {
      const response = await request({ action: "call", name, arguments: args });
      assert.equal(response.is_error, expectedError, `Unexpected MCP response for ${name}: ${JSON.stringify(response.content).slice(0, 4096)}`);
      return response;
    },
    async call(name, args = {}) {
      const response = await this.callResponse(name, args);
      assert.ok(response.structured_content, `Missing structured response: ${name}`);
      return response.structured_content;
    },
    async close() {
      // EOF also cancels a call waiting for approval. The SDK reaps its worker.
      child.stdin.end();
      const [code] = await Promise.race([exited, once(AbortSignal.timeout(10_000), "abort").then(() => {
        child.kill();
        throw new Error("MCP controller failed to close");
      })]);
      assert.equal(code, 0, "MCP controller shutdown failed");
    },
  };
}

async function preflight() {
  assert.equal(process.platform, "darwin", "This journey requires a macOS Loci package");
  const appBundle = await fs.realpath(requiredPath("LOCI_PACKAGED_APP"));
  const python = requiredPath("LOCI_QA_PYTHON");
  const fixture = requiredPath("LOCI_QA_BBBC039_SOURCE");
  const expectedHash = process.env.LOCI_QA_BBBC039_SHA256 ?? fixtureHash;
  const sourceCommit = process.env.LOCI_QA_SOURCE_COMMIT;
  const assistant = process.env.LOCI_QA_ASSISTANT ?? "antigravity";
  assert.ok(["antigravity", "codex"].includes(assistant));
  assert.match(sourceCommit ?? "", /^[a-f0-9]{40}$/, "Use the exact packaged commit");
  assert.match(expectedHash, /^[a-f0-9]{64}$/, "Pin the public fixture bytes");
  const threshold = Number(process.env.LOCI_QA_THRESHOLD ?? 520);
  assert.ok(Number.isFinite(threshold) && threshold > 0 && threshold <= 65535);
  const comparison = await comparisonPreflight();
  if (comparison) assert.equal(expectedHash, fixtureHash, "Two-method QA uses the pinned full BBBC039 plane");
  const contents = path.join(appBundle, "Contents");
  const worker = path.join(contents, "Resources/loci-engine/loci-engine");
  const asar = path.join(contents, "Resources/app.asar");
  const executable = path.join(contents, "MacOS/Loci");
  const identityFile = path.join(contents, "Resources/loci-build-identity.json");
  const helper = path.join(projectRoot, "scripts/qa/agent-session-client.py");
  const loader = path.join(projectRoot, "scripts/qa/secondary-display-loader.mjs");
  await Promise.all([plainFile(fixture, "Public BBBC039 plane"), executableFile(python, "Python"),
    executableFile(worker, "Packaged worker"), executableFile(executable, "Packaged app")]);
  const identity = await json(identityFile);
  assert.equal(identity.sourceRevision, sourceCommit);
  assert.equal(identity.sourceDirty, false, "Package must represent a clean source revision");
  const [{ stdout }, actualHash, ...hashes] = await Promise.all([
    run(python, ["-c", "from importlib.metadata import version; from mcp.client.stdio import stdio_client; print(version('mcp'))"], { timeout: 15_000 }),
    sha256(fixture), ...[executable, asar, worker, identityFile, helper, loader, import.meta.filename,
      path.join(import.meta.dirname, "live-assistant-comparison.qa.mjs")].map(sha256),
  ]);
  assert.equal(actualHash, expectedHash, "Public BBBC039 plane differs from the pin");
  const build = Object.fromEntries(["executable", "asar", "worker", "identity", "sdk_helper", "display_loader", "journey", "comparison_driver"]
    .map((name, index) => [`${name}_sha256`, hashes[index]]));
  return { python, worker, executable, helper, loader, fixture, fixtureName: path.basename(fixture),
    expectedHash, threshold, assistant, sourceCommit, sdkVersion: stdout.trim(), build, comparison };
}

// Explicitly serialize portable portions of actual snapshots. The private study,
// bundle, profile and copied fixture live outside this evidence directory.
function snapshotEvidence(snapshot) {
  const state = snapshot.agent_sessions;
  return {
    project: { id: snapshot.project.id, title: snapshot.project.title },
    sources: snapshot.sources.map(({ id, name, sha256, metadata }) => ({ id, name, sha256, dimensions: metadata.dimensions })),
    jobs: snapshot.jobs.map(({ id, state, operation, owner, request_hash, result_ids }) =>
      ({ id, state, operation, owner, request_hash, result_ids })),
    results: snapshot.results.map(({ id, source_id, revision_hash, kind, review }) =>
      ({ id, source_id, revision_hash, kind, review: review?.disposition ?? null })),
    agent_sessions: {
      status: state.status, connected_count: state.connected_count,
      policies: state.policies.map(({ policy_sha256, state, permission_mode }) => ({ policy_sha256, state, permission_mode })),
      sessions: state.sessions.map(({ session_id, client_id, policy_sha256, state, owned_job_ids, recent_result_ids }) =>
        ({ session_id, client_id, policy_sha256, state, owned_job_ids, recent_result_ids })),
      approvals: state.approvals.map(({ id, state, policy_sha256, session_id, operation, request_hash, source_id, source_sha256 }) =>
        ({ id, state, policy_sha256, session_id, operation, request_hash, source_id, source_sha256 })),
      tasks: state.tasks,
    },
  };
}

async function pollJob(sdk, id, timeout) {
  const deadline = Date.now() + timeout;
  let job;
  do {
    job = (await sdk.call("job_status", { job_id: id })).job;
    if (!job.owned_worker_active && !["queued", "running"].includes(job.state)) break;
    await delay(150);
  } while (Date.now() < deadline);
  assert.equal(job.state, "succeeded", job.error);
  assert.equal(job.owned_worker_active, false);
  return job;
}

async function assertSidecar(app, initialId) {
  const inventory = await app.evaluate(({ BrowserWindow, screen }) => ({
    primaryId: screen.getPrimaryDisplay().id,
    displays: screen.getAllDisplays().map(({ id, workArea }) => ({ id, workArea })),
    windows: BrowserWindow.getAllWindows().map((window) => {
      const bounds = window.getBounds();
      return { bounds, id: screen.getDisplayMatching(bounds).id };
    }),
  }));
  assert.ok(inventory.windows.length, "There must be a workbench window");
  const id = initialId ?? inventory.windows[0].id;
  assert.notEqual(id, inventory.primaryId, "Workbench appeared on the primary display");
  const display = inventory.displays.find((item) => item.id === id);
  assert.ok(display, "Sidecar display disappeared");
  const area = display.workArea;
  for (const window of inventory.windows) {
    const { x, y, width, height } = window.bounds;
    assert.equal(window.id, id, "A QA window left Sidecar");
    assert.ok(x >= area.x && y >= area.y && x + width <= area.x + area.width && y + height <= area.y + area.height,
      "A QA window extended outside Sidecar");
  }
  return { id, window_count: inventory.windows.length, window_size: inventory.windows.map(({ bounds }) => [bounds.width, bounds.height]) };
}

async function journey(config) {
  const display = process.env.LOCI_QA_SECONDARY_DISPLAY;
  assert.ok(display, "Set the exact Sidecar display name");
  const preloadIndex = process.execArgv.indexOf("--import");
  assert.ok(preloadIndex >= 0 && path.resolve(process.execArgv[preloadIndex + 1]) === config.loader,
    "Use the official secondary-display loader with node --import before launching the test");
  const root = requiredPath("LOCI_QA_OUTPUT_ROOT");
  await fs.mkdir(root, { recursive: true });
  const output = await fs.mkdtemp(path.join(await fs.realpath(root), "live-assistant-"));
  const evidence = path.join(output, "portable");
  const local = path.join(output, "local");
  await Promise.all([fs.mkdir(evidence), fs.mkdir(local)]);
  const study = path.join(local, "BBBC039 assistant study.loci-study");
  const access = path.join(local, "setup");
  const ungrantedAccess = config.comparison ? path.join(local, "setup-without-model") : null;
  const profile = path.join(local, "profile");
  const input = path.join(local, config.fixtureName);
  const policyPath = path.join(access, "agent-policy.json");
  const cli = async (...args) => JSON.parse((await run(config.worker, ["--loci", "--json", ...args],
    { timeout: 30_000, maxBuffer: 8 * 1024 ** 2 })).stdout);
  const snapshot = () => cli("snapshot", "--project", study);
  const receipt = {
    schema: "loci.live-assistant-study-qa/v1", status: "running", started_at: new Date().toISOString(),
    source_commit: config.sourceCommit, build: config.build, selected_host: config.assistant,
    fixture: { dataset: "BBBC039v1", license: "CC0", source_url: "https://bbbc.broadinstitute.org/BBBC039",
      name: config.fixtureName, sha256: config.expectedHash },
    scope: { controls: "Playwright on packaged macOS with profile-scoped picker substitution",
      execution_approval: "Actual native Loci approval clicked by the harness",
      mcp_client: clientId, branded_host_execution: "Separate qualification",
      scientific_review: "Pending researcher review",
      verified_onnx_comparison: config.comparison ? "This journey" : "Separate qualification" },
    checkpoints: [],
  };
  const save = () => fs.writeFile(path.join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  let app, page, sdk, displayId;
  let stage = "initialize-study";
  let rendererErrorCount = 0;
  async function record(filename, record) {
    const body = JSON.stringify(record, null, 2) + "\n";
    for (const location of [local, config.fixture, config.worker, config.comparison?.directory].filter(Boolean))
      assert.ok(!body.includes(location), "A local path was present in the portable evidence");
    await fs.writeFile(path.join(evidence, filename), body);
    return { filename, sha256: await sha256(path.join(evidence, filename)) };
  }
  async function checkpoint(name, nativeSnapshot) {
    await noUiError(page, name);
    const placement = await assertSidecar(app, displayId);
    displayId = placement.id;
    const screenshot = `${name}.png`;
    await page.screenshot({ path: path.join(evidence, screenshot), scale: "css" });
    const native = await record(`${name}.json`, snapshotEvidence(nativeSnapshot ?? await snapshot()));
    receipt.checkpoints.push({ name, native, screenshot: { filename: screenshot, sha256: await sha256(path.join(evidence, screenshot)) },
      sidecar: { window_count: placement.window_count, window_size: placement.window_size } });
    await save();
  }

  try {
    await save();
    await fs.copyFile(config.fixture, input);
    assert.equal(await sha256(input), config.expectedHash);
    await cli("create", "--project", study, "--title", "BBBC039 assistant study");
    const imported = await cli("import", "--project", study, input);
    assert.equal(imported.sources.length, 1);
    const source = imported.sources[0];
    const dimensions = source.metadata.dimensions;
    assert.equal(source.sha256, config.expectedHash);
    assert.deepEqual([dimensions.c, dimensions.z, dimensions.t], [1, 1, 1], "Use a single-channel, single-plane fixture");
    const sourceTarget = { kind: "source", id: source.id, sha256: source.sha256 };

    stage = "researcher-grant";
    app = await electron.launch({ executablePath: config.executable, args: [`--user-data-dir=${profile}`], timeout: 120_000 });
    page = await app.firstWindow();
    page.setDefaultTimeout(30_000);
    page.on("pageerror", () => { rendererErrorCount++; });
    displayId = (await assertSidecar(app)).id;
    await app.evaluate(({ dialog, app }, targets) => {
      if (app.getPath("userData") !== targets.profile) throw new Error("QA picker substitution requires the isolated profile");
      const verify = (args, title) => {
        if (args.at(-1)?.title !== title) throw new Error(`Unexpected native QA picker: ${args.at(-1)?.title}`);
      };
      const unexpected = () => { throw new Error("Unexpected native QA dialog"); };
      const destinations = [targets.ungrantedAccess, targets.access].filter(Boolean);
      dialog.showOpenDialog = async (...args) => {
        if (targets.modelPackage && args.at(-1)?.title === targets.modelPickerTitle)
          return { canceled: false, filePaths: [targets.modelPackage] };
        verify(args, targets.openTitle);
        return { canceled: false, filePaths: [targets.study] };
      };
      dialog.showSaveDialog = async (...args) => {
        verify(args, targets.setupTitle);
        const filePath = destinations.shift();
        if (!filePath) throw new Error("Unexpected repeat assistant grant");
        return { canceled: false, filePath };
      };
      for (const name of ["showOpenDialogSync", "showSaveDialogSync", "showMessageBox", "showMessageBoxSync", "showErrorBox"]) dialog[name] = unexpected;
    }, { profile, study, access, ungrantedAccess, openTitle, setupTitle, modelPickerTitle, modelPackage: config.comparison?.directory });
    await page.getByRole("button", { name: "Open study", exact: true }).click();
    await sourceRowByName(page, source.name);
    await selectWorkbenchTool(page, "Display");
    for (const [label, value] of [["X", 0], ["Y", 0], ["Width", dimensions.x], ["Height", dimensions.y]])
      await setSelectionField(page, label, value);
    let installedModel;
    if (config.comparison) {
      stage = "offline-model-qualification";
      installedModel = await importComparisonModel({ page, checkpoint });
      receipt.model = await record("qualified-onnx-package.json", installedModel);
      stage = "researcher-grant";
    }
    await selectWorkbenchTool(page, "Analyze");
    await page.getByLabel("Segmentation model", { exact: true }).selectOption("classical");
    await page.getByLabel("Segmentation method", { exact: true }).selectOption("components");
    for (const [label, value] of [["Threshold", config.threshold], ["Minimum object measure", 20]]) {
      const field = page.getByLabel(label, { exact: true });
      await field.fill(String(value));
      await field.press("Tab");
    }
    await selectWorkbenchTool(page, "Agent");
    const panel = page.locator(".research-agent");
    const grant = panel.getByRole("button", { name: `Grant selected access to ${source.name}`, exact: true });
    const setup = panel.getByLabel("Created agent access receipt", { exact: true });
    await panel.getByLabel("Assistant client", { exact: true }).selectOption(config.assistant);
    await panel.getByLabel("Assistant access level", { exact: true }).selectOption("analyze");
    await panel.getByLabel("Session permission mode", { exact: true }).selectOption("ask_approval");
    if (installedModel) {
      const grantModel = panel.getByRole("checkbox", { name: "Use installed nuclei ONNX model", exact: true });
      await grantModel.waitFor();
      assert.equal(await grantModel.isChecked(), false, "Analyze must require a separate ONNX opt-in");
      await checkpoint("model-03-ungranted-by-default");
      await grant.click();
      await setup.getByRole("status").filter({ hasText: /^Waiting for your assistant$/ }).waitFor();
      const ungrantedPolicy = path.join(ungrantedAccess, "agent-policy.json");
      const ungranted = await json(path.join(ungrantedAccess, "approved-request.json"));
      sdk = startSdk(config.python, config.helper, config.worker, ungrantedPolicy, `${clientId} without model grant`);
      assert.equal((await sdk.read()).initialized, false);
      assert.equal((await sdk.request({ action: "initialize" })).initialized, true);
      const refusal = await sdk.callResponse("submit_action", {
        operation: "model_preview", request: comparisonRequest(source.id, ungranted.selection, installedModel),
        request_key: "onnx-without-native-grant",
      }, true);
      assert.match(JSON.stringify(refusal.content), /grant|policy|permitted|scope/i);
      const denied = await snapshot();
      assert.deepEqual(denied.jobs, []);
      assert.deepEqual(denied.agent_sessions.approvals, []);
      receipt.model_prerequisite = {
        without_model_opt_in: "MCP preview denied before approval or job creation",
        policy_sha256: await sha256(ungrantedPolicy),
      };
      await sdk.close();
      sdk = null;
      await grantModel.check();
    }
    await panel.getByLabel("Exact recipe validation", { exact: true }).waitFor();
    await grant.click();

    stage = "configuration-ready";
    await fs.access(policyPath).catch(async () => {
      // A previous setup receipt can still exist while creating the new bundle.
      await waitForSnapshot(page, (s) => s?.agent_sessions?.policies.length === (config.comparison ? 2 : 1), "created assessor policy");
    });
    await setup.getByRole("status").filter({ hasText: /^Waiting for your assistant$/ }).waitFor();
    const policy = await json(policyPath);
    const policySha = await sha256(policyPath);
    assert.equal(policy.schema, "loci.agent-policy/v5");
    assert.equal(policy.permission_mode, "ask_approval");
    assert.equal(policy.delegation.client_id, config.assistant);
    for (const name of ["submit_recipe", "result", "review_history", "agent_task_read", "agent_task_write"])
      assert.ok(policy.operations.includes(name), `Analyze grant omitted ${name}`);
    for (const name of ["review_result", "export_result"])
      assert.ok(!policy.operations.includes(name), `Analyze grant unexpectedly permits ${name}`);
    const request = await json(path.join(access, "approved-request.json"));
    assert.equal(request.source_id, source.id);
    assert.equal(request.recipe.segmentation.method, "components");
    assert.equal(request.recipe.segmentation.threshold, config.threshold);
    assert.deepEqual([request.selection.level, request.selection.x, request.selection.y, request.selection.width, request.selection.height],
      [0, 0, 0, dimensions.x, dimensions.y]);
    const configFile = path.join(access, config.assistant === "codex"
      ? "codex-workspace/.codex/config.toml" : "antigravity-workspace/.agents/mcp_config.json");
    const serverId = `loci-research-${policySha.slice(0, 12)}`;
    const mcpServers = config.assistant === "codex" ? JSON.parse((await run(config.python, ["-c",
      "import json, sys, tomllib; from pathlib import Path; print(json.dumps(tomllib.loads(Path(sys.argv[1]).read_text())['mcp_servers']))",
      configFile], { timeout: 15_000 })).stdout) : (await json(configFile)).mcpServers;
    assert.deepEqual(Object.keys(mcpServers), [serverId]);
    assert.deepEqual(mcpServers[serverId], { command: config.worker, args: ["--cli", "mcp", "--policy", policyPath] });
    const prompt = await setup.getByRole("textbox", { name: "First prompt", exact: true }).inputValue();
    assert.ok(prompt.includes(serverId) && prompt.includes(policySha) && prompt.includes(source.id));
    const readme = await fs.readFile(path.join(access, "README.txt"), "utf8");
    assert.ok(readme.includes(prompt), "The prompt must match the selected host's instructions");
    await setup.getByRole("button", { name: "Copy prompt", exact: true }).click();
    await setup.getByRole("button", { name: "Prompt copied", exact: true }).waitFor();
    // Read only the newly copied prompt. Record a hash, never raw clipboard text.
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), prompt, "Copied prompt differs from the displayed prompt");
    receipt.grant = { policy_sha256: policySha, config_sha256: await sha256(configFile), server_id: serverId,
      prompt_sha256: hashText(prompt), permission_mode: policy.permission_mode, operations: policy.operations };
    await setup.getByRole("button", { name: "Check connection", exact: true }).click();
    const ready = await snapshot();
    assert.equal(ready.agent_sessions.connected_count, 0);
    assert.equal(ready.agent_sessions.policies.find((item) => item.policy_sha256 === policySha).state, "configuration_ready");
    assert.ok(!ready.agent_sessions.sessions.some((item) => item.policy_sha256 === policySha));
    if (!config.comparison) {
      assert.equal(ready.agent_sessions.status, "configuration_ready");
      await page.getByRole("button", { name: "Agent session status", exact: true })
        .getByText("Agent bundle ready · Not connected", { exact: true }).waitFor();
    }
    await checkpoint("01-configuration-ready", ready);

    stage = "mcp-initialize";
    sdk = startSdk(config.python, config.helper, config.worker, policyPath);
    const transport = await sdk.read();
    assert.equal(transport.initialized, false);
    assert.equal(transport.mcp_sdk, config.sdkVersion);
    assert.equal((await snapshot()).agent_sessions.connected_count, 0, "STDIO ping alone created a live session");
    const handshake = await sdk.request({ action: "initialize" });
    assert.equal(handshake.initialized, true);
    assert.ok(handshake.server?.protocolVersion);
    receipt.mcp = { sdk_version: transport.mcp_sdk, protocol_version: handshake.server.protocolVersion,
      server: handshake.server.serverInfo?.name, client: clientId };
    assert.equal((await sdk.call("inspect_source", { source_id: source.id })).verified, true);
    const sessionButton = page.getByRole("button", { name: "Agent session status", exact: true });
    const drawer = page.getByRole("region", { name: "Agent session and approvals", exact: true });
    const openDrawer = async () => {
      if (await sessionButton.getAttribute("aria-expanded") !== "true") await sessionButton.click();
      await drawer.waitFor();
    };
    const closeDrawer = () => drawer.getByRole("button", { name: "Close agent session drawer", exact: true }).click();
    await setup.getByRole("status").filter({ hasText: /^Assistant connected$/ }).waitFor();
    const connected = await waitForSnapshot(page, (s) => s?.agent_sessions?.sessions.some((row) =>
      row.policy_sha256 === policySha && row.client_id === clientId && row.state === "connected_idle"), "initialized SDK client");
    const session = connected.agent_sessions.sessions.find((row) => row.client_id === clientId);
    assert.equal(connected.agent_sessions.connected_count, 1);
    await openDrawer();
    await drawer.getByText(clientId, { exact: true }).first().waitFor();
    await drawer.getByRole("switch", { name: "Follow agent", exact: true }).check();
    await checkpoint("02-live-sdk-session");
    await closeDrawer();

    stage = "publish-plan";
    const taskId = randomUUID().replaceAll("-", "");
    const goal = "Run the granted classical segmentation and record evidence for review";
    const plan = { task_id: taskId, expected_revision: 0, state: "active", goal, targets: [sourceTarget],
      steps: [{ id: "classical", title: "Run classical connected components", state: "planned", note: "", targets: [sourceTarget] }] };
    const published = await sdk.call("agent_task_write", { operation: "publish_plan", request: plan });
    assert.equal(published.task.session_id, session.session_id);
    assert.equal(published.task.revision, 1);
    await openDrawer();
    await drawer.getByRole("button", { name: "Plan & evidence", exact: true }).click();
    await drawer.getByText(goal, { exact: true }).waitFor();
    await checkpoint("03-shared-plan");

    stage = "approve-classical-run";
    const submit = sdk.call("submit_recipe", { request, request_key: "live-study-classical" });
    submit.catch(() => {}); // The UI must resolve the outstanding request.
    const pending = await waitForSnapshot(page, (s) => s?.agent_sessions?.approvals.some((row) =>
      row.operation === "submit_recipe" && row.session_id === session.session_id && row.state === "pending"), "exact execution approval");
    const approval = pending.agent_sessions.approvals.find((row) => row.operation === "submit_recipe" && row.state === "pending");
    assert.equal(approval.source_id, source.id);
    assert.equal(approval.source_sha256, source.sha256);
    assert.equal(approval.policy_sha256, policySha);
    assert.deepEqual(pending.jobs, [], "Job started before execution approval");
    const approve = drawer.getByRole("button", { name: "Approve submit_recipe", exact: true });
    await approve.scrollIntoViewIfNeeded();
    await checkpoint("04-pending-execution-approval");
    await approve.click();
    const { job } = await submit;
    await closeDrawer();

    stage = "read-retained-evidence";
    const completed = await pollJob(sdk, job.id, 30_000);
    assert.equal(completed.result_ids.length, 1);
    const resultId = completed.result_ids[0];
    const retained = await sdk.call("result", { result_id: resultId, limit: 10 });
    assert.equal(retained.result.source_id, source.id);
    assert.equal(retained.result.review, null);
    assert.ok(retained.total_rows > 0, "Expected measurements for the pinned plane and threshold");
    const review = await sdk.call("review_history", { result_id: resultId });
    assert.deepEqual(review.events, [], "Execution approval changed scientific review");
    const native = await snapshot();
    const nativeJob = native.jobs.find((row) => row.id === job.id);
    const nativeResult = native.results.find((row) => row.id === resultId);
    assert.equal(nativeJob.owner.session_id, session.session_id);
    assert.equal(nativeJob.state, "succeeded");
    assert.equal(nativeResult.revision_hash, retained.result.revision_hash);
    assert.equal(native.agent_sessions.approvals.find((row) => row.id === approval.id).state, "consumed");
    receipt.result = await record("classical-result.json", { job: completed, ...retained, review });
    const row = page.locator(`.research-sources [data-result-id="${resultId}"]`);
    await row.waitFor();
    receipt.follow = { enabled: true, selected_after_job: await row.getAttribute("aria-pressed") === "true" };
    await checkpoint("05-retained-job");

    let comparison;
    if (config.comparison) {
      stage = "scoped-model-and-comparison";
      const submitAction = async (operation, request, requestKey, beforeApproval) => {
        const response = sdk.call("submit_action", { operation, request, request_key: requestKey });
        response.catch(() => {});
        const isApproval = (item) => item.operation === "submit_action" && item.action_name === operation &&
          item.session_id === session.session_id && item.state === "pending";
        const state = await Promise.race([
          waitForSnapshot(page, (s) => s?.agent_sessions?.approvals.some(isApproval), `${operation} execution approval`),
          response.then(() => { throw new Error(`${operation} returned before researcher approval`); }),
        ]);
        const pending = state.agent_sessions.approvals.find(isApproval);
        assert.equal(pending.policy_sha256, policySha);
        assert.equal(pending.source_id, source.id);
        assert.equal(pending.source_sha256, source.sha256);
        assert.ok(!state.jobs.some((item) => item.operation === operation), "Job started before approval");
        await openDrawer();
        const card = drawer.getByLabel("Pending approval for submit_action", { exact: true });
        await card.waitFor();
        const originalApprove = card.getByRole("button", { name: "Approve submit_action", exact: true });
        const approve = beforeApproval ? await beforeApproval({ card, originalApprove, pending }) : originalApprove;
        await approve.scrollIntoViewIfNeeded();
        await checkpoint(`model-approval-${operation}`);
        await approve.click();
        const { job } = await response;
        if (await drawer.isVisible()) await closeDrawer();
        const completed = await pollJob(sdk, job.id, 90_000);
        const actual = await snapshot();
        const durableJob = actual.jobs.find((item) => item.id === job.id);
        const consumed = actual.agent_sessions.approvals.find((item) => item.id === pending.id);
        assert.equal(durableJob.owner.session_id, session.session_id);
        assert.equal(consumed.state, "consumed");
        assert.equal(consumed.decided_by, "human");
        await record(`model-approval-${operation}-consumed.json`, {
          id: pending.id, action_name: operation, policy_sha256: pending.policy_sha256, session_id: pending.session_id,
          request_hash: pending.request_hash, source_id: pending.source_id, source_sha256: pending.source_sha256,
          state: consumed.state, decided_by: consumed.decided_by, job_id: job.id,
        });
        return completed;
      };
      const ctx = { page, source, sdk, checkpoint, snapshot, record, submitAction, hashText };
      const prediction = await runScopedModel({ ...ctx, model: installedModel, approvedSelection: request.selection });
      comparison = await compareSavedMethods({ ...ctx, classical: nativeResult, prediction: prediction.result });
      receipt.two_method = { prediction: prediction.evidence, agreement: comparison.comparison };
    }

    stage = "open-exact-result";
    const evidenceResult = comparison?.result ?? nativeResult;
    const target = { kind: "result", id: evidenceResult.id, revision_hash: evidenceResult.revision_hash,
      source_id: source.id, source_sha256: source.sha256 };
    const summary = comparison ? "The two saved predictions are ready for comparison and researcher review."
      : "Classical connected components are ready for researcher review.";
    const classicalTarget = { ...target, id: resultId, revision_hash: nativeResult.revision_hash };
    const finalPlan = await sdk.call("agent_task_write", { operation: "publish_plan", request: {
      ...plan, expected_revision: published.task.revision, state: "awaiting_review",
      targets: comparison ? [sourceTarget, classicalTarget, target] : [sourceTarget, target],
      steps: [{ ...plan.steps[0], state: "complete", targets: [classicalTarget] },
        ...(comparison ? [{ id: "compare", title: "Compare the two saved predictions", state: "complete", note: "", targets: [target] }] : [])],
    } });
    const assessmentRequest = { task_id: taskId, expected_revision: finalPlan.task.revision, summary,
      targets: [target], observations: [`The retained result contains ${retained.total_rows} object measurement rows.`],
      limitations: ["One public BBBC039 plane. This is execution evidence without a reference comparison."] };
    const assessment = await sdk.call("agent_task_write", { operation: "publish_assessment", request: assessmentRequest });
    const readback = (await sdk.call("agent_task_read", { operation: "get", request: { task_id: taskId } })).task;
    assert.deepEqual(readback, assessment.task);
    assert.deepEqual(readback.assessments.at(-1).targets, [target]);
    const assessedSnapshot = await snapshot();
    assert.deepEqual(assessedSnapshot.agent_sessions.tasks.find((task) => task.id === taskId), readback);
    receipt.plan = await record("plan-and-assessment.json", readback);
    await openDrawer();
    const assessmentPanel = drawer.getByRole("region", { name: "Agent assessment", exact: true });
    await assessmentPanel.getByText(summary, { exact: true }).waitFor();
    // Open from the source view even if Follow already selected the exact result.
    await closeDrawer();
    const original = page.getByRole("button", { name: "Original image", exact: true });
    await original.click();
    assert.equal(await original.getAttribute("aria-pressed"), "true");
    assert.equal(await row.getAttribute("aria-pressed"), "false");
    await openDrawer();
    const openResult = assessmentPanel.getByRole("button", { name: `Open result ${evidenceResult.id}`, exact: true });
    await openResult.scrollIntoViewIfNeeded();
    await checkpoint("06-exact-result-evidence", assessedSnapshot);
    await openResult.click();
    if (await drawer.isVisible()) await closeDrawer();
    await page.waitForFunction((id) => document.querySelector(`.research-sources [data-result-id="${id}"]`)
      ?.getAttribute("aria-pressed") === "true", evidenceResult.id);
    await selectResultSection(page, "Review");
    await checkpoint("07-exact-result-review");
    if (comparison) {
      stage = "inspect-saved-disagreements";
      receipt.two_method.located = await inspectSavedDifferences({ page, source, result: comparison.result, checkpoint, record });
    }

    stage = "disconnect";
    await sdk.close();
    sdk = null;
    await waitForSnapshot(page, (s) => s?.agent_sessions?.sessions.some((row) =>
      row.session_id === session.session_id && row.state === "disconnected"), "clean SDK disconnect");
    await checkpoint("08-disconnected");
    assert.equal(rendererErrorCount, 0, "Renderer errors during this journey");
    const [studyCopySha, originalSourceSha] = await Promise.all([sha256(input), sha256(config.fixture)]);
    assert.equal(studyCopySha, config.expectedHash, "Study copy changed");
    assert.equal(originalSourceSha, config.expectedHash, "Source fixture changed");
    if (config.comparison) await verifyComparisonPackage(config.comparison);
    receipt.immutable_inputs = { study_copy_sha256: studyCopySha, original_source_sha256: originalSourceSha,
      ...(config.comparison ? { original_model_package_sha256: config.comparison.package_sha256 } : {}) };
    receipt.status = "passed";
  } catch (error) {
    receipt.status = "failed";
    receipt.failure = { stage, type: error.name, renderer_error_count: rendererErrorCount };
    // Keep diagnostics local. Playwright and worker errors can include paths.
    await fs.writeFile(path.join(local, "failure.txt"), String(error.stack ?? error) + "\n");
    process.exitCode = 1;
  } finally {
    for (const [name, cleanup] of [["sdk", sdk && (() => sdk.close())], ["app", app && (() => close(app))]]) {
      if (!cleanup) continue;
      await cleanup().catch(async (error) => {
        receipt.status = "failed";
        (receipt.cleanup_failures ??= []).push(name);
        process.exitCode = 1;
        await fs.writeFile(path.join(local, `${name}-cleanup.txt`), String(error.stack ?? error) + "\n");
      });
    }
    receipt.finished_at = new Date().toISOString();
    await save();
    console.log(JSON.stringify({ status: receipt.status, output, failure: receipt.failure }));
  }
}

const config = await preflight();
if (process.argv.includes("--preflight")) {
  console.log(JSON.stringify({ status: "preflight-passed", source_commit: config.sourceCommit,
    fixture: config.fixtureName, fixture_sha256: config.expectedHash, sdk: config.sdkVersion,
    model_package_sha256: config.comparison?.package_sha256 }));
} else {
  await journey(config);
}
