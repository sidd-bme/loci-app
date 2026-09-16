/**
 * Records the Loci product-demo source clips from the final packaged app.
 *
 * This is intentionally a capture harness, not a regression suite. It uses
 * Chromium's CDP screencast of the real Electron renderer, samples the real
 * frames at 30 fps (repeating the last real frame only while the UI is idle),
 * and encodes each source clip with ffmpeg. It never draws a mock UI or alters
 * pixels before H.264 encoding.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, promises as fs, statSync } from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { _electron as electron } from "playwright";
import { selectWorkbenchTool } from "./workbench-qa-helpers.mjs";

const desktopRoot = path.resolve(import.meta.dirname, "..");
const projectRoot = path.resolve(desktopRoot, "..");
const manifestPath = path.join(projectRoot, "scripts", "demo", "demo-manifest.json");
const expected = {
  phase: "f5f1565e990650a87cabf7e6e8db1fd6da40b430b5fab52e3f598314d428cf76",
  kidney: "83f9df040b58d0d4ee175730e3087216bb313cb4d450c59ac5d612525c6c9564",
  svs: "ed92d5a9f2e86df67640d6f92ce3e231419ce127131697fbbce42ad5e002c8a7",
};
const publicRoot = path.resolve(process.env.LOCI_QA_PUBLIC_FIXTURES ??
  path.resolve(import.meta.dirname, "../../.loci/evidence/qa/image-first/public-fixtures"));
const wsiPath = path.resolve(process.env.LOCI_QA_PUBLIC_WSI ??
  "/tmp/loci-release-run/wsi/CMU-1-Small-Region.svs");
const packagedApp = process.env.LOCI_PACKAGED_APP;
const receiptPath = process.env.LOCI_DEMO_PUBLIC_RECEIPT;
const captureRoot = process.env.LOCI_DEMO_CAPTURE_ROOT;

for (const [name, value] of Object.entries({ LOCI_PACKAGED_APP: packagedApp,
  LOCI_DEMO_PUBLIC_RECEIPT: receiptPath, LOCI_DEMO_CAPTURE_ROOT: captureRoot })) {
  assert.ok(value && path.isAbsolute(value), `${name} must be an absolute path.`);
}
assert.ok(packagedApp.endsWith(".app"), "LOCI_PACKAGED_APP must point to Loci.app.");
assert.equal(process.platform, "darwin", "The demo harness records the macOS packaged app.");
assert.ok(path.relative(projectRoot, captureRoot).startsWith(".."), "LOCI_DEMO_CAPTURE_ROOT must be outside the repository.");
assert.equal(existsSync(captureRoot), false, "LOCI_DEMO_CAPTURE_ROOT must be new; media is never overwritten.");

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
function sleep(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
async function waitChild(child) {
  const [code] = await once(child, "close");
  assert.equal(code, 0, `ffmpeg exited ${code}.`);
}
async function probe(file) {
  const child = spawn("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code] = await once(child, "close");
  assert.equal(code, 0, `ffprobe failed: ${stderr}`);
  return JSON.parse(stdout);
}
function assertPassedReceipt(receipt, appHashes) {
  assert.equal(receipt.status, "passed", "The public-visual receipt did not pass.");
  assert.match(receipt.schema ?? "", /image-first-public-visual-packaged-qa\/v1$/,
    "The receipt is not packaged public-visual QA.");
  assert.equal(receipt.build?.mode, "packaged-binary", "Receipt is not bound to a packaged app.");
  assert.deepEqual({
    application_artifact_sha256: receipt.build.application_artifact_sha256,
    executable_sha256: receipt.build.executable_sha256,
    worker_sha256: receipt.build.worker_sha256,
  }, appHashes, "The selected packaged application differs from the passed public-visual receipt.");
  assert.equal(receipt.fixtures?.phase?.sha256, expected.phase);
  assert.equal(receipt.fixtures?.kidney?.sha256, expected.kidney);
  assert.equal(receipt.fixtures?.wsi?.sha256, expected.svs);
}
async function waitForViewer(page, sourceName) {
  const viewer = page.getByLabel(`Image viewer: ${sourceName}`);
  await viewer.waitFor({ state: "visible", timeout: 120_000 });
  await page.waitForFunction((name) => {
    const element = [...document.querySelectorAll(".image-viewport")].find(
      (item) => item.getAttribute("aria-label") === `Image viewer: ${name}`);
    return element && Number(element.getAttribute("data-cache-bytes")) > 0 &&
      !element.querySelector(".image-view-loading");
  }, sourceName, { timeout: 120_000 });
  return viewer;
}
async function waitForVolume(page, source) {
  const volume = page.getByRole("region", { name: "Raw whole-volume viewport", exact: true });
  await volume.waitFor({ state: "visible", timeout: 120_000 });
  await page.waitForFunction((expectedSource) => {
    const element = document.querySelector(".raw-volume");
    return element?.getAttribute("data-source-id") === expectedSource.id &&
      element.getAttribute("data-source-sha256") === expectedSource.sha256 &&
      Number(element.getAttribute("data-context-byte-length")) > 0;
  }, { id: source.id, sha256: source.sha256 }, { timeout: 120_000 });
  return volume;
}
async function assertPublicState(page, label) {
  assert.equal(await page.locator("details.source-information[open]").count(), 0,
    `${label}: source metadata is open.`);
  assert.equal(await page.locator("details.analysis-region-settings[open]").count(), 0,
    `${label}: advanced analysis details are open.`);
  assert.equal(await page.getByRole("dialog").count(), 0, `${label}: a dialog is visible.`);
  assert.equal(await page.locator(".research-alert[role=alert]").count(), 0, `${label}: a UI alert is visible.`);
}
async function closeAnalysisRegion(page) {
  const details = page.locator("details.analysis-region-settings");
  if (await details.count() && await details.evaluate((element) => element.open))
    await details.locator(":scope > summary").click();
}

/** Capture unchanged renderer frames at 30 fps. Duplicate samples are logged as idle repeats. */
async function recordSegment(page, cdp, output, segment, captureGeometry, action) {
  const videoPath = path.join(output, segment.file);
  const targetFrames = Math.round(segment.duration_seconds * 30);
  const encoder = spawn("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-threads", "2", "-f", "image2pipe", "-vcodec", "png",
    "-framerate", "30", "-i", "pipe:0", "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", videoPath],
  { stdio: ["pipe", "ignore", "pipe"] });
  let encoderError = "";
  let encoderClosed = false;
  encoder.stderr.on("data", (chunk) => { encoderError += chunk; });
  let latest = null;
  let sourceFrameCount = 0;
  let sourceSequence = 0;
  const received = [];
  const startedAt = performance.now();
  const onFrame = (event) => {
    sourceSequence += 1;
    sourceFrameCount += 1;
    latest = { bytes: Buffer.from(event.data, "base64"), sourceSequence, receivedMs: performance.now() - startedAt,
      cdpTimestamp: event.metadata?.timestamp ?? null };
    if (received.length < 500) received.push({ sourceSequence, receivedMs: latest.receivedMs, cdpTimestamp: latest.cdpTimestamp });
    void cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => undefined);
  };
  cdp.on("Page.screencastFrame", onFrame);
  try {
    await cdp.send("Page.startScreencast", { format: "png", quality: 100, maxWidth: 1600, maxHeight: 900, everyNthFrame: 1 });
    const readyBy = performance.now() + 10_000;
    while (!latest && performance.now() < readyBy) await sleep(20);
    assert.ok(latest, `${segment.id}: CDP did not provide a renderer frame.`);
    const captureStartedAt = performance.now();
    let actionFailure = null;
    const actionPromise = Promise.resolve().then(action).catch((error) => { actionFailure = error; });
    const encoded = [];
    let previousSource = null;
    for (let index = 0; index < targetFrames; index += 1) {
      const target = captureStartedAt + index * (1000 / 30);
      const remaining = target - performance.now();
      if (remaining > 0) await sleep(remaining);
      assert.ok(latest, `${segment.id}: renderer frame disappeared during capture.`);
      if (!encoder.stdin.write(latest.bytes)) await once(encoder.stdin, "drain");
      encoded.push({ frame: index, captureMs: performance.now() - captureStartedAt, sourceSequence: latest.sourceSequence,
        sourceReceivedMs: latest.receivedMs, repeated_previous_frame: latest.sourceSequence === previousSource });
      previousSource = latest.sourceSequence;
    }
    await actionPromise;
    if (actionFailure) throw actionFailure;
    await cdp.send("Page.stopScreencast");
    encoder.stdin.end();
    await waitChild(encoder);
    encoderClosed = true;
    assert.equal(encoderError, "", `${segment.id}: ffmpeg emitted ${encoderError}`);
    const media = await probe(videoPath);
    const stream = media.streams.find((item) => item.codec_type === "video");
    assert.equal(stream.width, captureGeometry.width, `${segment.id}: capture width drifted.`);
    assert.equal(stream.height, captureGeometry.height, `${segment.id}: capture height drifted.`);
    assert.ok(Math.abs(Number(media.format.duration) - segment.duration_seconds) <= 0.15,
      `${segment.id}: encoded duration is not the requested duration.`);
    return { id: segment.id, file: segment.file, sha256: await sha256(videoPath), source_frames_received: sourceFrameCount,
      encoded_frames: targetFrames, source_frame_events: received, encoded_frame_timing: encoded, duration_seconds: Number(media.format.duration) };
  } finally {
    cdp.off("Page.screencastFrame", onFrame);
    await cdp.send("Page.stopScreencast").catch(() => undefined);
    if (!encoderClosed) {
      if (!encoder.stdin.destroyed) encoder.stdin.destroy();
      if (encoder.exitCode === null) {
        if (!encoder.killed) encoder.kill("SIGTERM");
        await once(encoder, "close").catch(() => undefined);
      }
    }
  }
}

let app;
let page;
const consoleErrors = [];
const pageErrors = [];
const networkRequests = [];
try {
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  assert.equal(manifest.schema, "loci.product-demo/v1");
  assert.equal(manifest.segments.length, 8);
  assert.ok(manifest.segments.every((segment) => segment.kind === "clip" && segment.duration_seconds >= 10 && segment.duration_seconds <= 11),
    "The capture manifest must contain eight 10–11 second real clips.");
  const appAsar = path.join(packagedApp, "Contents", "Resources", "app.asar");
  const executable = path.join(packagedApp, "Contents", "MacOS", "Loci");
  const worker = path.join(packagedApp, "Contents", "Resources", "loci-engine", "loci-engine");
  for (const file of [appAsar, executable, worker, receiptPath]) assert.ok(existsSync(file), `Missing input ${file}.`);
  const appHashes = { application_artifact_sha256: await sha256(appAsar), executable_sha256: await sha256(executable), worker_sha256: await sha256(worker) };
  const publicReceiptHash = await sha256(receiptPath);
  const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
  assertPassedReceipt(receipt, appHashes);
  const phasePath = path.join(publicRoot, "Phase cell.ome.tiff");
  const kidneyPath = path.join(publicRoot, "Kidney fluorescence.ome.tiff");
  for (const [key, file] of Object.entries({ phase: phasePath, kidney: kidneyPath, svs: wsiPath })) {
    assert.ok(existsSync(file) && statSync(file).isFile(), `Missing public ${key} fixture.`);
    assert.equal(await sha256(file), expected[key], `Unexpected ${key} fixture identity.`);
  }
  await fs.mkdir(path.dirname(captureRoot), { recursive: true });
  await fs.mkdir(captureRoot, { recursive: false });
  const userData = path.join(captureRoot, "user-data");
  app = await electron.launch({ executablePath: executable, args: [`--user-data-dir=${userData}`], cwd: desktopRoot, timeout: 120_000 });
  page = await app.firstWindow();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("request", (request) => { if (/^https?:/i.test(request.url())) networkRequests.push(request.url()); });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1600, 900));
  await page.waitForFunction(() => Math.abs(innerWidth / innerHeight - 16 / 9) < 0.001, { timeout: 30_000 });
  const captureGeometry = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio }));
  assert.ok(captureGeometry.width > 0 && captureGeometry.height > 0, "The capture viewport is empty.");
  assert.ok(captureGeometry.width <= 1600 && captureGeometry.height <= 900,
    "The capture viewport exceeded the requested 1600x900 CSS box.");
  await app.evaluate(({ dialog }, sources) => {
    dialog.showOpenDialog = async (...args) => args.at(-1)?.title === "Add microscopy or medical images"
      ? { canceled: false, filePaths: sources } : { canceled: true, filePaths: [] };
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }, [phasePath, kidneyPath, wsiPath]);
  await page.getByRole("main", { name: "Image-first workspace" }).waitFor({ state: "visible", timeout: 30_000 }).catch(async () =>
    page.locator("main.image-first-empty").waitFor({ state: "visible", timeout: 30_000 }));
  const cdp = await page.context().newCDPSession(page);
  const records = [];
  const welcome = manifest.segments.find((item) => item.id === "01-welcome");
  records.push(await recordSegment(page, cdp, captureRoot, welcome, captureGeometry, async () => {
    await sleep(1_500);
    const options = page.getByRole("button", { name: "More opening options", exact: true });
    await options.click(); await sleep(1_500); await options.click();
  }));
  await assertPublicState(page, "welcome");
  await page.screenshot({ path: path.join(captureRoot, "01-readme-welcome.png") });

  await page.getByRole("button", { name: "Open images", exact: true }).click();
  await page.getByRole("main", { name: "Research workspace" }).waitFor({ state: "visible", timeout: 120_000 });
  const snapshot = await page.evaluate(() => window.lociResearch.getSnapshot());
  const byName = Object.fromEntries(snapshot.sources.map((source) => [source.name, source]));
  const phaseName = path.basename(phasePath), kidneyName = path.basename(kidneyPath), wsiName = path.basename(wsiPath);
  for (const [name, hash] of [[phaseName, expected.phase], [kidneyName, expected.kidney], [wsiName, expected.svs]]) assert.equal(byName[name]?.sha256, hash);
  const sourceButton = (name) => page.locator(".research-sources").getByRole("button", { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) });
  await sourceButton(phaseName).click();
  const phaseViewer = await waitForViewer(page, phaseName);
  const openPhase = manifest.segments.find((item) => item.id === "02-open-phase");
  records.push(await recordSegment(page, cdp, captureRoot, openPhase, captureGeometry, async () => {
    await sleep(1_500); await phaseViewer.locator(".image-view-tools").getByRole("button", { name: "Fit" }).click();
    await sleep(1_500); await phaseViewer.hover({ position: { x: 650, y: 430 } }); await page.mouse.wheel(0, -360);
  }));
  await assertPublicState(page, "phase");
  await page.screenshot({ path: path.join(captureRoot, "02-readme-direct-opening-phase.png") });

  const annotate = manifest.segments.find((item) => item.id === "03-annotate-phase");
  records.push(await recordSegment(page, cdp, captureRoot, annotate, captureGeometry, async () => {
    await sleep(1_000); await selectWorkbenchTool(page, "Annotate");
    await page.getByRole("button", { name: "Rectangle", exact: true }).click();
    // Fit first, then use a restrained zoom. The corners below are derived from
    // a documented bright phase-cell region (source pixels 384–440, 340–430),
    // transformed through the live viewer camera rather than placed on background.
    await phaseViewer.getByLabel("Fit image", { exact: true }).click();
    await phaseViewer.hover({ position: { x: 650, y: 430 } }); await page.mouse.wheel(0, -100);
    await sleep(750);
    const corners = await phaseViewer.evaluate((element, points) => {
      const camera = JSON.parse(element.getAttribute("data-camera") ?? "{}");
      const bounds = element.getBoundingClientRect();
      if (![camera.x, camera.y, camera.scale].every(Number.isFinite) || !bounds.width || !bounds.height) throw new Error("Live phase camera is unavailable.");
      return points.map(({ x, y }) => ({
        x: bounds.width / 2 + (x - camera.x) * camera.scale,
        y: bounds.height / 2 + (y - camera.y) * camera.scale,
      }));
    }, [{ x: 384, y: 340 }, { x: 440, y: 430 }]);
    const canvas = phaseViewer.getByLabel("Source image and bound annotations");
    await page.getByLabel("Annotation label", { exact: true }).fill("Example region");
    await canvas.click({ position: corners[0] }); await canvas.click({ position: corners[1] });
    await page.getByRole("button", { name: "Save annotation", exact: true }).click();
    await page.getByText("1 saved", { exact: true }).waitFor({ timeout: 30_000 });
  }));
  await assertPublicState(page, "annotation");
  await page.screenshot({ path: path.join(captureRoot, "03-readme-phase-raw-annotation.png") });

  await selectWorkbenchTool(page, "Analyze");
  await page.getByLabel("Segmentation model", { exact: true }).selectOption("adaptive");
  const beforeResults = await page.evaluate(() => window.lociResearch.getSnapshot().then((state) => state.results.map((item) => item.id)));
  await page.getByRole("button", { name: "Segment image", exact: true }).click();
  const resultDeadline = performance.now() + 120_000;
  let phaseResult = null;
  while (!phaseResult && performance.now() < resultDeadline) {
    phaseResult = await page.evaluate(async ({ sourceId, before }) => {
      const state = await window.lociResearch.getSnapshot();
      return state.results.find((item) => item.source_id === sourceId && !before.includes(item.id)) ?? null;
    }, { sourceId: byName[phaseName].id, before: beforeResults });
    if (!phaseResult) await page.waitForTimeout(100);
  }
  assert.ok(phaseResult, "Adaptive segmentation did not create a result in the demo fixture.");
  assert.equal(phaseResult.source_sha256, expected.phase);
  await page.getByText(/Result on source/).waitFor({ timeout: 120_000 });
  await assertPublicState(page, "illustrative segmentation");
  await page.screenshot({ path: path.join(captureRoot, "04-readme-phase-illustrative-segmentation.png") });

  const svs = manifest.segments.find((item) => item.id === "04-native-svs");
  records.push(await recordSegment(page, cdp, captureRoot, svs, captureGeometry, async () => {
    await sourceButton(wsiName).click(); const viewer = await waitForViewer(page, wsiName);
    await selectWorkbenchTool(page, "Display"); await closeAnalysisRegion(page); await sleep(1_500);
    await viewer.locator(".image-view-tools").getByRole("button", { name: "1:1" }).click();
  }));
  await assertPublicState(page, "SVS");
  await page.screenshot({ path: path.join(captureRoot, "05-readme-native-svs-histology.png") });

  const multi = manifest.segments.find((item) => item.id === "05-multichannel");
  records.push(await recordSegment(page, cdp, captureRoot, multi, captureGeometry, async () => {
    await sourceButton(kidneyName).click(); const kidneyViewer = await waitForViewer(page, kidneyName);
    await selectWorkbenchTool(page, "Display"); await closeAnalysisRegion(page);
    const inspector = page.locator(".research-inspector");
    // Establish the plane before Auto so its stable ranges describe the visible Z 9 plane.
    const z = inspector.getByLabel("Z plane", { exact: true }); await z.focus(); await z.press("Home");
    for (let index = 0; index < 8; index += 1) await z.press("ArrowRight");
    await page.getByText(/Z 9 \/ /).waitFor({ timeout: 30_000 }); await waitForViewer(page, kidneyName);
    await inspector.getByRole("button", { name: "Auto", exact: true }).click();
    const expectedAuto = await page.evaluate((sourceId) => window.lociResearch.execute("viewer_defaults", {
      source_id: sourceId, t: 0, z: 8, auto: true,
    }), byName[kidneyName].id);
    assert.equal(expectedAuto.source_sha256, expected.kidney);
    assert.equal(expectedAuto.basis?.z, 8, "Auto ranges were not calculated for the visible Z 9 plane.");
    assert.equal(expectedAuto.channels?.length, 3);
    const channelToggles = inspector.locator('input[aria-label$=" visible"]');
    assert.equal(await channelToggles.count(), 3, "Kidney capture requires its three visible scalar channels.");
    for (let index = 0; index < 3; index += 1) if (!await channelToggles.nth(index).isChecked()) await channelToggles.nth(index).click();
    // These changes pass through the real colour controls and their React change handlers.
    const demoColours = ["#00d7ff", "#ff4fc3", "#ffe45c"];
    for (let index = 0; index < 3; index += 1) {
      const colour = inspector.getByLabel(`Channel ${index + 1} color`, { exact: true });
      await colour.evaluate((input, value) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        if (!setter) throw new Error("The native colour control does not expose its value setter.");
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }, demoColours[index]);
      assert.equal(await colour.inputValue(), demoColours[index]);
    }
    await page.waitForFunction((defaults) => {
      const inspector = document.querySelector(".research-inspector");
      const toggles = [...(inspector?.querySelectorAll('input[aria-label$=" visible"]') ?? [])];
      return toggles.length === 3 && toggles.every((input) => input.checked) && defaults.channels.every((channel, index) => {
        const low = inspector?.querySelector(`input[aria-label="Channel ${index + 1} low"]`);
        const high = inspector?.querySelector(`input[aria-label="Channel ${index + 1} high"]`);
        return Number(low?.value) === channel.low && Number(high?.value) === channel.high;
      });
    }, expectedAuto, { timeout: 120_000 });
    // Collapsed summaries retain all three explicit swatches and channel labels without obscuring the image.
    for (const channel of await inspector.locator("details.source-channel").all()) if (await channel.evaluate((element) => element.open)) await channel.locator(":scope > summary").click();
    await waitForViewer(page, kidneyName);
  }));
  await assertPublicState(page, "multichannel");
  await page.screenshot({ path: path.join(captureRoot, "06-readme-multichannel-kidney.png") });

  const volume = manifest.segments.find((item) => item.id === "06-raw-volume");
  // Complete the expensive bounded context preparation before the 11-second editorial clip starts.
  await page.getByRole("button", { name: "3D volume", exact: true }).click();
  const raw = await waitForVolume(page, byName[kidneyName]);
  const exportPng = raw.getByRole("button", { name: /^Export PNG/ });
  await exportPng.waitFor({ state: "visible", timeout: 120_000 });
  await page.waitForFunction(() => {
    const raw = document.querySelector(".raw-volume");
    const exportPng = [...(raw?.querySelectorAll("button") ?? [])].find((button) => /^Export PNG/.test(button.textContent ?? ""));
    const status = raw?.querySelector(".raw-volume-status span")?.textContent ?? "";
    return Boolean(raw && exportPng && !exportPng.disabled && !/^Loading bounded whole-volume detail/.test(status));
  }, undefined, { timeout: 120_000 });
  // Volume transfers are independent from the 2D display; set their real colour controls explicitly.
  const volumeColours = ["#00d7ff", "#ff4fc3", "#ffe45c"];
  const volumeColourInputs = raw.locator('input[aria-label$=" colour"]');
  assert.equal(await volumeColourInputs.count(), 3, "Raw kidney volume requires three channel colour controls.");
  for (let index = 0; index < 3; index += 1) {
    const colour = volumeColourInputs.nth(index);
    await colour.evaluate((input, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (!setter) throw new Error("The native volume colour control does not expose its value setter.");
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, volumeColours[index]);
    assert.equal(await colour.inputValue(), volumeColours[index]);
  }
  await page.waitForFunction((colours) => {
    const raw = document.querySelector(".raw-volume");
    const inputs = [...(raw?.querySelectorAll('input[aria-label$=" colour"]') ?? [])];
    const exportPng = [...(raw?.querySelectorAll("button") ?? [])].find((button) => /^Export PNG/.test(button.textContent ?? ""));
    return inputs.length === colours.length && inputs.every((input, index) => input.value === colours[index]) && Boolean(exportPng && !exportPng.disabled);
  }, volumeColours, { timeout: 120_000 });
  // Preserve readable raw intensity and depth: this independent 3D view presents one explicit channel.
  const volumeOpacityInputs = raw.locator('input[aria-label$=" opacity"]');
  const volumeVisibilityInputs = raw.locator('input[aria-label$=" visible"]');
  assert.equal(await volumeOpacityInputs.count(), 3, "Raw kidney volume requires three channel opacity controls.");
  assert.equal(await volumeVisibilityInputs.count(), 3, "Raw kidney volume requires three channel visibility controls.");
  for (let index = 0; index < 3; index += 1) {
    const opacity = volumeOpacityInputs.nth(index);
    await opacity.evaluate((input) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (!setter) throw new Error("The native volume opacity control does not expose its value setter.");
      setter.call(input, "0.2"); input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    assert.equal(await opacity.inputValue(), "0.2");
    const visible = volumeVisibilityInputs.nth(index);
    if (await visible.isChecked() !== (index === 0)) await visible.click();
  }
  await page.waitForFunction(() => {
    const raw = document.querySelector(".raw-volume");
    const opacities = [...(raw?.querySelectorAll('input[aria-label$=" opacity"]') ?? [])];
    const visibility = [...(raw?.querySelectorAll('input[aria-label$=" visible"]') ?? [])];
    const exportPng = [...(raw?.querySelectorAll("button") ?? [])].find((button) => /^Export PNG/.test(button.textContent ?? ""));
    return opacities.length === 3 && opacities.every((input) => input.value === "0.2") &&
      visibility.length === 3 && visibility[0].checked && !visibility[1].checked && !visibility[2].checked && Boolean(exportPng && !exportPng.disabled);
  }, undefined, { timeout: 120_000 });
  await assertPublicState(page, "raw volume preparation");
  let rawEditorialActionMilliseconds = null;
  const rawEditorialRecord = await recordSegment(page, cdp, captureRoot, volume, captureGeometry, async () => {
    const actionStartedAt = performance.now();
    // Hold the ready whole-context volume before and after a controlled oblique orbit.
    await sleep(1_250);
    const stage = raw.getByLabel("Interactive three-dimensional volume", { exact: true }); await stage.focus();
    for (let index = 0; index < 5; index += 1) await stage.press("ArrowRight");
    for (let index = 0; index < 3; index += 1) await stage.press("ArrowUp");
    await sleep(1_250);
    await assertPublicState(page, "raw 3D before MPR");
    await page.screenshot({ path: path.join(captureRoot, "07-readme-raw3d-kidney.png") });
    const mpr = raw.getByRole("button", { name: "MPR", exact: true });
    await mpr.click(); await mpr.getAttribute("aria-pressed").then((value) => assert.equal(value, "true"));
    await stage.focus(); await stage.press("PageUp");
    await sleep(1_250);
    rawEditorialActionMilliseconds = performance.now() - actionStartedAt;
    assert.ok(rawEditorialActionMilliseconds <= (volume.duration_seconds - 1) * 1000,
      "Raw-volume editorial action did not leave one second of stable in-clip footage.");
  });
  assert.ok(rawEditorialActionMilliseconds !== null, "Raw-volume editorial action did not finish during capture.");
  rawEditorialRecord.editorial_action_ms = rawEditorialActionMilliseconds;
  records.push(rawEditorialRecord);
  await assertPublicState(page, "raw volume");

  const results = manifest.segments.find((item) => item.id === "07-results");
  records.push(await recordSegment(page, cdp, captureRoot, results, captureGeometry, async () => {
    await sourceButton(phaseName).click(); await waitForViewer(page, phaseName);
    const selectedResult = page.locator(`[data-result-id="${phaseResult.id}"]`); await selectedResult.click();
    await page.locator(`[data-result-id="${phaseResult.id}"][aria-pressed="true"]`).waitFor({ state: "visible", timeout: 30_000 });
    await selectWorkbenchTool(page, "Info");
    const review = page.getByRole("button", { name: "Mark reviewed", exact: true }); await review.waitFor({ state: "visible", timeout: 30_000 }); await review.click();
    await page.getByText("Reviewed", { exact: true }).waitFor({ timeout: 30_000 });
    const exportRevision = page.getByRole("button", { name: "Export revision", exact: true });
    await exportRevision.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await exportRevision.isEnabled(), true, "The reviewed result did not enable its real export action.");
  }));
  const reviewed = await page.evaluate(async (id) => (await window.lociResearch.getSnapshot()).results.find((item) => item.id === id)?.review?.disposition, phaseResult.id);
  assert.equal(reviewed, "reviewed", "The visible result was not genuinely reviewed.");
  await assertPublicState(page, "review");

  const close = manifest.segments.find((item) => item.id === "08-close");
  records.push(await recordSegment(page, cdp, captureRoot, close, captureGeometry, async () => {
    await sleep(1_500); await selectWorkbenchTool(page, "Display"); await closeAnalysisRegion(page);
  }));
  await assertPublicState(page, "close");

  const pngs = (await fs.readdir(captureRoot)).filter((file) => file.endsWith(".png"));
  assert.equal(pngs.length, 7, "Expected seven clean README PNG captures for editorial selection.");
  const pngGeometry = {
    css_width: captureGeometry.width, css_height: captureGeometry.height, device_pixel_ratio: captureGeometry.dpr,
    pixel_width: Math.round(captureGeometry.width * captureGeometry.dpr),
    pixel_height: Math.round(captureGeometry.height * captureGeometry.dpr),
  };
  const readmePngs = [];
  for (const png of pngs) {
    const media = await probe(path.join(captureRoot, png));
    const stream = media.streams.find((item) => item.codec_type === "video");
    assert.equal(stream.width, pngGeometry.pixel_width, `${png}: unexpected device-pixel width.`);
    assert.equal(stream.height, pngGeometry.pixel_height, `${png}: unexpected device-pixel height.`);
    readmePngs.push({ file: png, sha256: await sha256(path.join(captureRoot, png)), width: stream.width, height: stream.height });
  }
  assert.deepEqual({ application_artifact_sha256: await sha256(appAsar), executable_sha256: await sha256(executable), worker_sha256: await sha256(worker) }, appHashes,
    "The packaged app changed during capture.");
  assert.equal(await sha256(phasePath), expected.phase, "Phase fixture changed during capture.");
  assert.equal(await sha256(kidneyPath), expected.kidney, "Kidney fixture changed during capture.");
  assert.equal(await sha256(wsiPath), expected.svs, "SVS fixture changed during capture.");
  assert.equal(await sha256(receiptPath), publicReceiptHash, "Public-visual receipt changed during capture.");
  assert.deepEqual(pageErrors, [], "The renderer emitted page errors during capture.");
  assert.deepEqual(consoleErrors, [], "The renderer emitted console errors during capture.");
  assert.deepEqual(networkRequests, [], "The capture made network requests.");
  await fs.writeFile(path.join(captureRoot, "capture-receipt.json"), `${JSON.stringify({
    schema: "loci.product-demo-capture/v1", status: "passed", manifest: { path: manifestPath, sha256: await sha256(manifestPath) },
    public_visual_receipt: { path: receiptPath, sha256: publicReceiptHash }, app: { path: packagedApp, ...appHashes }, video_geometry: captureGeometry,
    readme_png_geometry: pngGeometry,
    fixtures: { phase: { path: phasePath, sha256: expected.phase }, kidney: { path: kidneyPath, sha256: expected.kidney }, svs: { path: wsiPath, sha256: expected.svs } },
    clips: records, readme_pngs: readmePngs,
    renderer_page_errors: pageErrors, renderer_console_errors: consoleErrors, network_requests: networkRequests
  }, null, 2)}\n`);
} finally {
  if (app) {
    await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
    await app.waitForEvent("close", { timeout: 30_000 }).catch(() => undefined);
  }
}
