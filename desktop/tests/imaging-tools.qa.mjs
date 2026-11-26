/** Packaged Apple-silicon QA on the full public kidney OME fixture.
 * Required absolute paths: LOCI_PACKAGED_APP, LOCI_QA_BIO_IMAGE,
 * LOCI_QA_OUTPUT_ROOT, LOCI_QA_PYTHON (numpy, tifffile, zarr installed).
 * Required pins: LOCI_QA_SOURCE_COMMIT, LOCI_QA_BIO_IMAGE_SHA256.
 * Optional LOCI_QA_SECONDARY_DISPLAY and LOCI_QA_IMAGING_ROUTES (JSON).
 * --detached-preprocess limits the journey to the native Preprocess inspector.
 * That mode uses numpy, tifffile and Pillow, and an existing external output root.
 * Run with Node 24.15.0. The harness substitutes only native picker responses
 * and the external URL dispatch. All app controls and conversions are real.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";

import { placeQaWindow } from "../../scripts/qa/display-placement.mjs";
import { checkZooDestinations, checkZooLayouts } from "./model-zoo-workflows-qa.mjs";
import { auditDetachedPreprocessing, auditPreprocessingInspector } from "./preprocessing-inspector-qa.mjs";
import { closeSettings, escapeSettings, measureSettingsPaint, openSettings } from "./settings-qa-helpers.mjs";
import { selectWorkbenchTool, waitForSnapshot } from "./workbench-qa-helpers.mjs";

const exec = promisify(execFile);
const desktop = path.resolve(import.meta.dirname, "..");
const env = process.env;
const detachedPreprocess = process.argv.includes("--detached-preprocess");
const kidneySha256 = "83f9df040b58d0d4ee175730e3087216bb313cb4d450c59ac5d612525c6c9564";
const paperUrl = "https://doi.org/10.1101/2025.04.28.651001";
const formats = [
  { id: "ome-tiff", label: "OME-TIFF", filename: "image.ome.tif" },
  { id: "ome-zarr", label: "OME-Zarr", filename: "image.ome.zarr" },
];
const routeDefaults = {
  // Nonempty libraryTool opens that Workbench tool before finding libraryButton.
  // Use libraryOption to open the dialog directly from an Analyze option.
  libraryGroup: "Analyze", libraryTool: "Segment & measure", libraryButton: "Browse Model Zoo…", libraryOption: "",
  conversionGroup: "View", conversionSection: "Import & conversion", conversionOption: "Convert image format",
};
const overrides = JSON.parse(env.LOCI_QA_IMAGING_ROUTES ?? "{}");
assert.ok(overrides && typeof overrides === "object" && !Array.isArray(overrides), "Routes must be a JSON object");
for (const [key, value] of Object.entries(overrides)) {
  assert.ok(Object.hasOwn(routeDefaults, key) && typeof value === "string", `Invalid imaging QA route ${key}`);
}
const routes = { ...routeDefaults, ...overrides };
const absolute = name => {
  assert.ok(path.isAbsolute(env[name] ?? ""), `${name} must be an absolute path`);
  return env[name];
};
assert.equal(process.platform, "darwin");
assert.equal(process.arch, "arm64");
assert.equal(process.versions.node, "24.15.0", "Use the pinned Node toolchain");
assert.equal(env.LOCI_QA_BIO_IMAGE_SHA256, kidneySha256, "Pin the repository's full public OME kidney fixture");
assert.match(env.LOCI_QA_SOURCE_COMMIT ?? "", /^[a-f0-9]{40}$/u);
const bundle = await fs.realpath(absolute("LOCI_PACKAGED_APP"));
const source = await fs.realpath(absolute("LOCI_QA_BIO_IMAGE"));
const python = absolute("LOCI_QA_PYTHON");
const outputRoot = absolute("LOCI_QA_OUTPUT_ROOT");
await fs.mkdir(outputRoot, { recursive: true });
const realOutputRoot = await fs.realpath(outputRoot);
const output = await fs.mkdtemp(path.join(realOutputRoot, detachedPreprocess ? "detached-preprocess-" : "imaging-tools-"));
const checker = path.resolve(desktop, detachedPreprocess
  ? "tests/fixtures/preprocessing-preview.py" : "../scripts/fixtures/imaging_tools_qa.py");
const artifacts = {
  executable: path.join(bundle, "Contents/MacOS/Loci"),
  asar: path.join(bundle, "Contents/Resources/app.asar"),
  worker: path.join(bundle, "Contents/Resources/loci-engine/loci-engine"),
  identity: path.join(bundle, "Contents/Resources/loci-build-identity.json"),
};

const report = {
  schema: "loci.packaged-imaging-tools-qa/v1", status: "running", stage: "preflight",
  started_at: new Date().toISOString(), expected_source_revision: env.LOCI_QA_SOURCE_COMMIT,
  fixture: { filename: path.basename(source), expected_sha256: kidneySha256 }, routes,
  timings: [], checks: [], screenshots: [], conversions: [], renderer_errors: [], blocked_requests: [],
  timing_method: "UI durations use Node monotonic time from action issue to readiness plus two renderer rAF callbacks. Settings paint uses trusted input and first matching compositor swap.",
  scope: [
    "One pinned public kidney fluorescence source. Engineering presentation and numerical conversion evidence.",
    "The input and output paths are selected through simulated native picker responses. The worker and asset writes run normally.",
    "The three measured channels are displayed with explicit illustrative LUTs selected through the channel controls.",
    "The model catalog is exercised without provisioning weights. The exact publisher link dispatch is intercepted in Electron.",
  ],
};
if (detachedPreprocess) {
  report.mode = "detached-preprocess";
  report.scope = [
    "One fingerprinted public fixture and a level-zero crop on one channel and plane.",
    "Real native inspector windows and renderer controls with a substituted file picker.",
    "Exact cached preview PNG pixel comparison after display normalization.",
  ];
}
const receipt = path.join(output, "receipt.json");
const save = () => fs.writeFile(receipt, JSON.stringify(report, null, 2) + "\n");
let app, page;
const sha256 = async file => {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
};
const button = (name, root = page) => root.getByRole("button", { name, exact: typeof name === "string" });
const dialog = (name, root = page) => root.getByRole("dialog", { name, exact: typeof name === "string" });
const paint = () => page.evaluate(() => new Promise(resolve =>
  requestAnimationFrame(first => requestAnimationFrame(next => resolve({ first, next })))));
async function requireFocus(locator, message) {
  try {
    await locator.and(page.locator(":focus")).waitFor({ timeout: 5000 });
  } catch (error) {
    throw new Error(message, { cause: error });
  }
}
const redacted = value => String(value).replaceAll(source, "<public fixture>").replaceAll(bundle, "<app bundle>")
  .replaceAll(output, "<QA output>").replaceAll(desktop, "<desktop checkout>");

async function capture(label, { nativeWindow = false, target = page } = {}) {
  if (target === page) await paint();
  const filename = `${label}.png`;
  let bytes;
  if (nativeWindow) {
    // Chromium CSS screenshots crop the compositor surface when Electron page zoom is above 100%.
    const window = await app.browserWindow(target);
    let bitmap;
    try {
      bitmap = await window.evaluate(async win => {
        const frame = await win.webContents.capturePage();
        const [width, height] = win.getContentSize();
        return { png: frame.toPNG().toString("base64"), width, height };
      });
    } finally {
      await window.dispose();
    }
    bytes = Buffer.from(bitmap.png, "base64");
    assert.ok(bytes.readUInt32BE(16) >= bitmap.width && bytes.readUInt32BE(20) >= bitmap.height,
      "Native capture must include the complete workbench content area");
    await fs.writeFile(path.join(output, filename), bytes);
  } else {
    bytes = await target.screenshot({ path: path.join(output, filename), scale: "css", animations: "allow" });
  }
  assert.ok(bytes.length > 2000, `Capture has little visible content: ${label}`);
  report.screenshots.push({ filename, sha256: createHash("sha256").update(bytes).digest("hex"),
    dimensions: [bytes.readUInt32BE(16), bytes.readUInt32BE(20)] });
}

async function timed(label, action) {
  const began = performance.now();
  const sample = { label, began_node_ms: began, status: "running" };
  report.timings.push(sample);
  try {
    const value = await action();
    sample.ready_node_ms = performance.now();
    sample.renderer_raf_ms = await paint();
    sample.status = "passed";
    return value;
  } catch (error) {
    sample.status = "failed";
    throw error;
  } finally {
    sample.finished_node_ms = performance.now();
    sample.elapsed_ms = sample.finished_node_ms - began;
  }
}

async function selectOption(group, option, section) {
  await button(group, page.getByRole("navigation", { name: "Task groups" })).click();
  await page.getByRole("combobox", { name: `${group} tool`, exact: true }).click();
  const choices = page.getByRole("listbox", { name: `${group} tool`, exact: true });
  const scope = section ? choices.getByRole("group", { name: section, exact: true }) : choices;
  await scope.getByRole("option", { name: option, exact: true }).click();
}

async function renderedSource(sourceId) {
  const viewer = page.locator(`.image-viewport[data-viewer-source="${sourceId}"][data-prepared="true"]`);
  await viewer.getByLabel("Source image and bound annotations").waitFor({ timeout: 90_000 });
  // Changing the channel controls can resize the stage. Wait for ResizeObserver
  // and the resulting backing-store paint before fingerprinting the displayed image.
  await page.waitForFunction(id => {
    const canvas = document.querySelector(`.image-viewport[data-viewer-source="${id}"][data-prepared="true"] > canvas`);
    if (!canvas) return false;
    const bounds = canvas.getBoundingClientRect();
    return canvas.width === Math.round(bounds.width * devicePixelRatio) &&
      canvas.height === Math.round(bounds.height * devicePixelRatio);
  }, sourceId);
  await paint();
  const state = await viewer.evaluate(async element => {
    const canvas = element.querySelector("canvas");
    const { x, y, width, height } = canvas.getBoundingClientRect();
    const sample = document.createElement("canvas");
    sample.width = sample.height = 64;
    const context = sample.getContext("2d", { willReadFrequently: true });
    context.drawImage(canvas, 0, 0, 64, 64);
    const pixels = context.getImageData(0, 0, 64, 64).data;
    let lit = 0, colored = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
      if (Math.max(r, g, b) >= 12) lit++;
      if (Math.max(r, g, b) - Math.min(r, g, b) >= 6) colored++;
    }
    const hash = await crypto.subtle.digest("SHA-256", pixels);
    return {
      source_id: element.dataset.viewerSource, camera: JSON.parse(element.dataset.camera),
      canvas: { x, y, width, height, backing: [canvas.width, canvas.height] },
      viewport: [innerWidth, innerHeight, devicePixelRatio], lit_samples: lit, colored_samples: colored,
      sample_sha256: Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join(""),
    };
  });
  assert.ok(state.canvas.width > 0 && state.canvas.height > 0 && state.lit_samples > 50 && state.colored_samples > 25,
    "The prepared canvas must show multichannel kidney pixels");
  return state;
}

async function auditGuideGeometry(guide) {
  const geometry = await guide.evaluate(element => {
    const { x, y, width, height } = element.getBoundingClientRect();
    const article = element.querySelector(".manual-article");
    const paragraph = article.querySelector(".manual-prose > p");
    const style = getComputedStyle(paragraph);
    const text = document.createElement("canvas").getContext("2d");
    text.font = `${style.fontSize} ${style.fontFamily}`;
    const proseWidth = paragraph.getBoundingClientRect().width;
    return { x, y, width, height, viewport: [innerWidth, innerHeight], prose_width: proseWidth,
      prose_ch: proseWidth / text.measureText("0").width,
      article_width: article.clientWidth, article_scroll_width: article.scrollWidth };
  });
  const [width, height] = geometry.viewport;
  assert.ok(geometry.x >= 0 && geometry.y >= 0 && geometry.x + geometry.width <= width + 1 &&
    geometry.y + geometry.height <= height + 1, "The manual must fit inside the visible workbench");
  assert.ok(geometry.width / width >= 0.74 && geometry.height / height >= 0.78, "The manual must occupy most of the workbench");
  assert.ok(geometry.prose_width >= Math.min(320, 0.65 * geometry.article_width) && geometry.prose_ch <= 90,
    "The guide must keep a generous, readable prose column");
  assert.ok(geometry.article_scroll_width <= geometry.article_width + 1, "The guide must not clip horizontally");
  return geometry;
}

async function auditSettingsAndGuide(binding) {
  const opener = button("Open settings");
  // The first compositor sample is the first Settings open in this app process.
  report.settings_toggle_paint = await measureSettingsPaint(app, page, 4);
  const settings = await timed("settings-open-ui", () => openSettings(app, page));
  assert.deepEqual(await renderedSource(binding.source_id), binding, "Settings must overlay the same rendered image and viewport");
  await capture("02-kidney-settings");
  await timed("settings-escape-ui", () => escapeSettings(settings));
  await requireFocus(opener, "Closing Settings must restore focus to its workbench trigger");
  assert.deepEqual(await renderedSource(binding.source_id), binding, "Settings changed the rendered source or viewport");
  const manual = dialog("User manual");
  const article = manual.getByRole("article", { name: "Loci user manual" });
  const heading = article.getByRole("heading", { level: 2 });
  const search = manual.getByRole("searchbox", { name: "Search user manual", exact: true });
  await opener.focus();
  await timed("guide-f1-ui", async () => {
    await page.keyboard.press("F1");
    await manual.waitFor();
    await heading.waitFor();
  });
  await requireFocus(search, "F1 must focus the guide search");
  const overview = await auditGuideGeometry(manual);
  await capture("03-guide-f1-welcome");

  await search.fill("qa-no-matching-topic-4908");
  await manual.getByRole("status").filter({ hasText: "No matching section" }).waitFor();
  await search.press("Escape");
  assert.equal(await search.inputValue(), "");
  assert.equal(await manual.isVisible(), true);
  await search.fill("histogram");
  const matched = manual.locator(".manual-result-card").first();
  await matched.waitFor();
  const result = await matched.locator("strong").innerText();
  await capture("04-guide-keyboard-search");
  await search.press("ArrowDown");
  await search.press("Enter");
  await heading.filter({ hasText: result }).waitFor();
  assert.equal(await heading.innerText(), result);
  await requireFocus(heading, "Search selection must move focus into the selected topic");

  const contents = manual.getByRole("navigation", { name: "Manual contents" });
  if (!(await contents.isVisible())) await button("Show manual contents", manual).click();
  await button("Read the workspace", contents).click();
  await heading.filter({ hasText: "Read the workspace" }).waitFor();
  await page.keyboard.press("Alt+ArrowLeft");
  await heading.filter({ hasText: result }).waitFor();
  await page.keyboard.press("Alt+ArrowRight");
  await heading.filter({ hasText: "Read the workspace" }).waitFor();
  const reading = await auditGuideGeometry(manual);
  await capture("05-guide-topic-navigation");
  await timed("guide-f1-close-ui", async () => {
    await page.keyboard.press("Escape");
    await manual.waitFor({ state: "hidden" });
  });
  await requireFocus(opener, "Guide dismissal must return to the focused workbench control");

  const reopened = await openSettings(app, page);
  await reopened.dialog.getByRole("tab", { name: "User guide", exact: true }).click();
  const guideButton = button("Open user guide", reopened.dialog);
  await timed("guide-settings-ui", async () => {
    await guideButton.click();
    await manual.waitFor();
  });
  await reopened.dialog.waitFor({ state: "hidden" });
  const fromSettings = await auditGuideGeometry(manual);
  await capture("06-guide-opened-from-settings");
  await button("Close user manual", manual).click();
  await manual.waitFor({ state: "hidden" });
  await reopened.dialog.waitFor();
  await requireFocus(guideButton, "Guide must restore focus inside Settings");
  await closeSettings(reopened);
  await requireFocus(opener, "Settings must restore its original workbench trigger after reading");
  assert.deepEqual(await renderedSource(binding.source_id), binding, "The manual changed the rendered source or viewport");
  report.checks.push({ name: "settings-and-offline-guide-on-kidney", overview, reading, from_settings: fromSettings, search_result: result });
}

async function sampleDecodedImage(locator) {
  return locator.evaluate(async (img) => {
    if (!(img instanceof HTMLImageElement)) throw new Error("Expected an HTMLImageElement");
    if (!img.complete) {
      await img.decode().catch(() => undefined);
    }
    const rect = img.getBoundingClientRect();
    const sample = document.createElement("canvas");
    sample.width = sample.height = 64;
    const context = sample.getContext("2d", { willReadFrequently: true });
    context.drawImage(img, 0, 0, 64, 64);
    const pixels = context.getImageData(0, 0, 64, 64).data;
    const digest = await crypto.subtle.digest("SHA-256", pixels);
    return {
      complete: img.complete,
      natural_width: img.naturalWidth,
      natural_height: img.naturalHeight,
      alt: img.alt,
      src_protocol: new URL(img.currentSrc || img.src, location.href).protocol,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      sample_sha256: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    };
  });
}

async function auditModelLibrary() {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  if (routes.libraryTool && !routes.libraryOption) await selectOption(routes.libraryGroup, routes.libraryTool);
  const zoo = dialog(/^Model Zoo$/iu);
  const open = button(routes.libraryButton).filter({ visible: true });
  await timed("model-zoo-open-ui", async () => {
    if (routes.libraryOption) await selectOption(routes.libraryGroup, routes.libraryOption);
    else await open.click();
    await zoo.waitFor();
  });

  // Zero legacy schematic SVGs and zero nested interactive buttons
  assert.equal(await zoo.locator(".model-schematic__task-layer, .model-library-stage__svg").count(), 0,
    "Model Zoo must not render legacy schematic SVG artwork");
  assert.equal(await zoo.locator("button button").count(), 0, "Model Zoo must not nest buttons");

  const cards = zoo.locator("article.model-zoo-card");
  assert.equal(await cards.count(), 8, "Model Zoo must render all eight curated registry entries");

  // Verify equal-height rows, image-first media proportion, and true decoding of every bundled specimen image
  const layoutSummary = await zoo.evaluate((root) => {
    const articles = [...root.querySelectorAll("article.model-zoo-card")];
    return articles.map((card) => {
      const cardRect = card.getBoundingClientRect();
      const mediaRect = card.querySelector(".model-zoo-card__media")?.getBoundingClientRect();
      return {
        model_id: card.dataset.modelId,
        example_kind: card.dataset.exampleKind,
        top: Math.round(cardRect.top),
        height: cardRect.height,
        media_ratio: mediaRect && cardRect.height > 0 ? mediaRect.height / cardRect.height : 0,
      };
    });
  });
  const firstRowTop = layoutSummary[0]?.top;
  const firstRow = layoutSummary.filter((item) => Math.abs(item.top - firstRowTop) <= 2);
  for (const item of firstRow) {
    assert.ok(Math.abs(item.height - firstRow[0].height) <= 2,
      `First-row cards must be equal height: ${JSON.stringify(firstRow)}`);
  }
  for (const item of layoutSummary) {
    assert.ok(item.media_ratio >= 0.45 && item.media_ratio <= 0.72,
      `Card media must be image-first (~55-60%): ${JSON.stringify(item)}`);
  }

  // Every bundled <img> must decode cleanly from local assets (zero HTTP(S) network egress)
  const cardImages = zoo.locator("article.model-zoo-card img.model-zoo-card__img");
  const cardImageCount = await cardImages.count();
  assert.equal(cardImageCount, 5, "All five credited microscopy examples must remain available");
  const decodedCards = [];
  for (let index = 0; index < cardImageCount; index++) {
    const info = await sampleDecodedImage(cardImages.nth(index));
    assert.ok(info.complete && info.natural_width > 0 && info.natural_height > 0,
      `Card image ${index} failed to decode: ${JSON.stringify(info)}`);
    assert.ok(info.alt.trim().length > 0, "Every specimen image must provide descriptive alt text");
    assert.ok(!/^https?:$/u.test(info.src_protocol), `Bundled image must be local, got ${info.src_protocol}`);
    decodedCards.push(info);
  }

  await capture("07a-model-zoo-atlas");
  report.model_zoo_layouts = await checkZooLayouts(app, page, zoo, capture);

  // Input-only cards must never expose prediction toggle controls
  const inputOnlyCards = zoo.locator('article.model-zoo-card[data-example-kind="input-only"]');
  for (let index = 0; index < await inputOnlyCards.count(); index++) {
    assert.equal(await inputOnlyCards.nth(index).locator(".model-zoo-card__layer-toggle").count(), 0,
      "Input-only card must not render Original/Overlay prediction controls");
  }

  // Verify genuine pair card initially shows Overlay and toggles to Original without reflow
  const cellposePaired = zoo.locator('article.model-zoo-card[data-model-id="cellpose-sam-v2"][data-example-kind="prediction"]');
  const pairedCard = (await cellposePaired.count()) > 0
    ? cellposePaired
    : zoo.locator('article.model-zoo-card[data-example-kind="prediction"]').first();
  assert.equal(await pairedCard.count(), 1, "Packaged Model Zoo must include at least one genuine prediction pair");
  const pairedModelId = await pairedCard.getAttribute("data-model-id");
  assert.equal(await pairedCard.getAttribute("data-preview-layer"), "overlay",
    "Paired card must initially display its overlay");
  const cardBoxBefore = await pairedCard.boundingBox();
  const cardOverlaySample = await sampleDecodedImage(pairedCard.locator("img.model-zoo-card__img"));

  await pairedCard.hover();
  const layerToggle = pairedCard.locator("button.model-zoo-card__layer-toggle");
  await layerToggle.click();
  await pairedCard.and(zoo.locator('[data-preview-layer="original"]')).waitFor();
  assert.equal(await layerToggle.getAttribute("aria-pressed"), "true");
  const cardOriginalSample = await sampleDecodedImage(pairedCard.locator("img.model-zoo-card__img"));
  assert.ok(cardOriginalSample.complete && cardOriginalSample.natural_width > 0 && cardOriginalSample.natural_height > 0);
  assert.notEqual(cardOriginalSample.sample_sha256, cardOverlaySample.sample_sha256,
    "Card Original and Overlay views must present genuinely different decoded images");
  const cardBoxAfter = await pairedCard.boundingBox();
  assert.ok(
    Math.abs(cardBoxBefore.width - cardBoxAfter.width) <= 0.5 &&
    Math.abs(cardBoxBefore.height - cardBoxAfter.height) <= 0.5,
    `Card toggle caused reflow: before=${JSON.stringify(cardBoxBefore)} after=${JSON.stringify(cardBoxAfter)}`,
  );
  await capture("07-model-zoo-card-toggle");
  await layerToggle.click();
  await pairedCard.and(zoo.locator('[data-preview-layer="overlay"]')).waitFor();

  // Verify search, empty-state feedback, Escape-to-clear search, and All/Local/External keyboard filtering
  const search = zoo.getByRole("searchbox", { name: "Search Model Zoo", exact: true });
  await search.fill("qa-no-matching-model-4908");
  await zoo.getByRole("status").filter({ hasText: "No models match" }).waitFor();
  await search.press("Escape");
  assert.equal(await search.inputValue(), "", "Escape inside search must clear the query without closing Model Zoo");
  assert.equal(await zoo.isVisible(), true);

  const filterGroup = zoo.getByRole("radiogroup", { name: "Filter models by execution route", exact: true });
  const allFilter = filterGroup.getByRole("radio", { name: /^All/u });
  await allFilter.focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(await cards.count(), 4, "Local filter must show the four optional local entries");
  await page.keyboard.press("ArrowRight");
  assert.equal(await cards.count(), 4, "External filter must show the four external entries");
  await page.keyboard.press("Home");
  assert.equal(await cards.count(), 8, "Home key must return to All models");

  // Select the paired model to verify contextual detail, aligned pixel space, and keyboard comparison slider
  const pairedTrigger = pairedCard.locator("button.model-zoo-card__select");
  await pairedTrigger.click();
  assert.equal(await page.getByRole("dialog").count(), 1, "Detail view must stay inside the single Model Zoo dialog");

  const detailOriginal = await sampleDecodedImage(zoo.locator('img[data-layer="original"]'));
  const detailOverlay = await sampleDecodedImage(zoo.locator('img[data-layer="overlay"]'));
  assert.ok(detailOriginal.complete && detailOriginal.natural_width > 0 && detailOriginal.natural_height > 0);
  assert.ok(detailOverlay.complete && detailOverlay.natural_width > 0 && detailOverlay.natural_height > 0);
  assert.equal(detailOriginal.natural_width, detailOverlay.natural_width, "Original and overlay natural widths must match");
  assert.equal(detailOriginal.natural_height, detailOverlay.natural_height, "Original and overlay natural heights must match");
  assert.ok(
    Math.abs(detailOriginal.rect.x - detailOverlay.rect.x) <= 0.5 &&
    Math.abs(detailOriginal.rect.y - detailOverlay.rect.y) <= 0.5 &&
    Math.abs(detailOriginal.rect.width - detailOverlay.rect.width) <= 0.5 &&
    Math.abs(detailOriginal.rect.height - detailOverlay.rect.height) <= 0.5,
    `Detail original/overlay must occupy the exact aligned pixel frame: orig=${JSON.stringify(detailOriginal.rect)} over=${JSON.stringify(detailOverlay.rect)}`,
  );
  const naturalAspect = detailOriginal.natural_width / detailOriginal.natural_height;
  const renderedAspect = detailOriginal.rect.width / detailOriginal.rect.height;
  assert.ok(Math.abs(naturalAspect - renderedAspect) <= 0.015,
    `Detail specimen must preserve natural aspect ratio without distortion: natural=${naturalAspect} rendered=${renderedAspect}`);
  assert.notEqual(detailOriginal.sample_sha256, detailOverlay.sample_sha256,
    "Detail original and overlay must decode to genuinely different images");

  const slider = zoo.getByRole("slider", { name: "Original and overlay comparison split", exact: true });
  await slider.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  assert.equal(await slider.inputValue(), "52", "Keyboard ArrowRight must adjust the comparison split");
  const clipAfterKey = await zoo.locator('img[data-layer="overlay"]').evaluate((el) => el.style.clipPath);
  assert.match(clipAfterKey, /^inset\(0(?:px)? 0(?:px)? 0(?:px)? 52%\)$/u);
  assert.match(await zoo.locator('img[data-layer="overlay"]').evaluate(el => getComputedStyle(el).clipPath), /52%/u);
  await capture("08-model-zoo-detail-compare");

  // Reduced motion disables transition animations cleanly without breaking interaction
  await page.emulateMedia({ reducedMotion: "reduce" });
  await zoo.and(page.locator('[data-reduced-motion="true"]')).waitFor();
  const reducedTransition = await zoo.locator("button.model-zoo-back-btn").evaluate(
    (element) => getComputedStyle(element).transitionDuration,
  );
  assert.ok(reducedTransition.split(",").every((duration) => parseFloat(duration) <= 0.00001));
  await capture("09-model-zoo-reduced-motion");
  await page.emulateMedia({ reducedMotion: "no-preference" });

  // Rights & provenance disclosure starts collapsed
  const provenanceDetails = zoo.locator("details.model-zoo-provenance");
  assert.equal(await provenanceDetails.evaluate((el) => el.open), false,
    "Rights and provenance disclosure must start collapsed");

  // Escape exits detail view back to grid and returns focus to the selected card
  await page.keyboard.press("Escape");
  await zoo.and(page.locator('[data-view="grid"]')).waitFor();
  await requireFocus(
    zoo.locator(`article.model-zoo-card[data-model-id="${pairedModelId}"] button.model-zoo-card__select`),
    "Closing detail with Escape must restore focus to the selected model card",
  );

  // Explicit publisher/paper link dispatch without background network activity
  assert.deepEqual(await app.evaluate(() => globalThis.__lociImagingTools.external), []);
  const cellposeTrigger = zoo.locator('article.model-zoo-card[data-model-id="cellpose-sam-v2"] button.model-zoo-card__select');
  await cellposeTrigger.click();
  const reference = button(/^Cellpose-SAM preprint \(DOI\)/i, zoo);
  await reference.click();
  const publisher = await app.evaluate(async () => {
    const deadline = Date.now() + 5000;
    while (!globalThis.__lociImagingTools.external.length && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return globalThis.__lociImagingTools.external;
  });
  assert.deepEqual(publisher, [paperUrl], "The explicit publisher action must request the exact registered URL");

  // Escape back to grid, then Escape again to close Model Zoo and restore workbench trigger focus
  await page.keyboard.press("Escape");
  await zoo.and(page.locator('[data-view="grid"]')).waitFor();
  await requireFocus(cellposeTrigger, "Escape from Cellpose detail must return focus to the Cellpose card");
  await timed("model-zoo-close-ui", async () => {
    await page.keyboard.press("Escape");
    await zoo.waitFor({ state: "hidden" });
  });
  if (!routes.libraryOption) await requireFocus(open, "Closing Model Zoo must restore its trigger");
  report.model_zoo_destinations = await checkZooDestinations(page);

  report.checks.push({
    name: "model-zoo-decoded-pair-search-comparison-motion-and-explicit-publisher-link",
    paired_model_id: pairedModelId,
    decoded_card_images: decodedCards.length,
    card_overlay_sha256: cardOverlaySample.sample_sha256,
    card_original_sha256: cardOriginalSample.sample_sha256,
    detail_geometry: [detailOriginal.natural_width, detailOriginal.natural_height],
    detail_original_sha256: detailOriginal.sample_sha256,
    detail_overlay_sha256: detailOverlay.sample_sha256,
    reduced_transition: reducedTransition,
    intercepted_publisher_url: publisher[0],
  });
}

async function convertBoth(sourceId, projectId) {
  await selectOption(routes.conversionGroup, routes.conversionOption, routes.conversionSection);
  const input = page.getByRole("group", { name: "Conversion input", exact: true });
  await button("Study image", input).click();
  assert.equal(await button("Study image", input).getAttribute("aria-pressed"), "true");
  const outputFormat = page.getByRole("combobox", { name: "Output format", exact: true });
  await outputFormat.waitFor();
  await page.getByText(path.basename(source), { exact: true }).filter({ visible: true }).last().waitFor();
  await capture("10-conversion-study-image");
  for (const format of formats) {
    report.stage = `convert-${format.id}`;
    const destination = path.join(output, format.id);
    await outputFormat.selectOption({ label: format.label });
    const success = page.getByRole("status").filter({ hasText: "Conversion verified" });
    assert.equal(await success.count(), 0, "The previous conversion receipt must clear when format changes");
    await timed(`conversion-${format.id}-ui`, async () => {
      await button("Convert image…").click();
      await success.waitFor({ timeout: 120_000 });
    });
    assert.match(await success.innerText(), new RegExp(format.filename.replaceAll(".", "\\.")));
    await capture(`11-conversion-${format.id}-verified`);
    const proof = await timed(`conversion-${format.id}-independent-readback`, async () => {
      const { stdout } = await exec(python, [checker, source, destination, format.id, kidneySha256, sourceId],
        { timeout: 90_000, maxBuffer: 1024 * 1024 });
      const value = JSON.parse(stdout);
      assert.deepEqual(value.shape, [1, 3, 16, 512, 512], "The entire public kidney grid must survive conversion");
      assert.equal(value.source_sha256_after, kidneySha256);
      assert.equal(value.pixels_compared, 3 * 16 * 512 * 512);
      assert.equal(value.planes_compared, 48);
      return value;
    });
    report.conversions.push({ folder: format.id, ...proof });
    assert.equal(await sha256(source), kidneySha256);
    const snapshot = await page.evaluate(() => window.lociResearch.getSnapshot());
    assert.equal(snapshot.project.project_id, projectId);
    assert.deepEqual(snapshot.sources.map(item => [item.id, item.sha256]), [[sourceId, kidneySha256]],
      "Exporting a copy must retain the single original study source");
    assert.equal(snapshot.results.length, 0);
    await save();
  }
  assert.equal(report.conversions[0].pixel_sha256, report.conversions[1].pixel_sha256);
}

try {
  report.identity = JSON.parse(await fs.readFile(artifacts.identity, "utf8"));
  assert.equal(report.identity.sourceRevision, env.LOCI_QA_SOURCE_COMMIT);
  assert.equal(report.identity.sourceDirty, false);
  report.artifact_sha256 = Object.fromEntries(await Promise.all(Object.entries(artifacts)
    .map(async ([key, file]) => [key, await sha256(file)])));
  report.harness_sha256 = await sha256(import.meta.filename);
  report.checker_sha256 = await sha256(checker);
  if (detachedPreprocess) {
    report.preprocess_driver_sha256 = await sha256(path.join(desktop, "tests/preprocessing-inspector-qa.mjs"));
  }
  if (!detachedPreprocess) {
    const mediaChecker = path.resolve(desktop, "../scripts/fixtures/model_zoo_media.py");
    const media = await exec(python, [mediaChecker]);
    report.model_zoo_source_media = JSON.parse(media.stdout);
    report.media_checker_sha256 = await sha256(mediaChecker);
  }
  report.fixture.size_bytes = (await fs.stat(source)).size;
  report.fixture.sha256_before = await sha256(source);
  assert.equal(report.fixture.sha256_before, kidneySha256);
  const readers = detachedPreprocess ? "numpy,tifffile,PIL" : "numpy,tifffile,zarr";
  const { stdout } = await exec(python, ["-c",
    `import json,${readers}; print(json.dumps({m.__name__:m.__version__ for m in [${readers}]}))`]);
  report.independent_reader_versions = JSON.parse(stdout);
  await save();

  report.stage = "launch";
  const launchEnvironment = { ...env };
  delete launchEnvironment.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: artifacts.executable, cwd: desktop,
    args: [`--user-data-dir=${path.join(output, "profile")}`], env: launchEnvironment, timeout: 120_000 });
  page = await app.firstWindow();
  page.setDefaultTimeout(30_000);
  page.on("pageerror", error => report.renderer_errors.push(redacted(error.message)));
  await page.context().route(/^https?:\/\//u, route => {
    const request = route.request();
    report.blocked_requests.push({ protocol: new URL(request.url()).protocol, type: request.resourceType() });
    return route.abort("blockedbyclient");
  });
  await placeQaWindow(app, { requestedDisplay: env.LOCI_QA_SECONDARY_DISPLAY, launch: 1 }, report);
  await app.evaluate(({ dialog: native, shell }, { source, output, formats, paperUrl }) => {
    const evidence = globalThis.__lociImagingTools = { pickers: [], external: [] };
    let conversion = 0;
    native.showOpenDialog = async (...args) => {
      const title = args.at(-1)?.title;
      if (title !== "Add microscopy or medical images" || evidence.pickers.length !== 0) throw new Error("Unexpected imaging QA open picker");
      evidence.pickers.push({ type: "open", title });
      return { canceled: false, filePaths: [source] };
    };
    native.showSaveDialog = async (...args) => {
      const title = args.at(-1)?.title;
      if (title !== "Save converted image" || conversion >= formats.length) throw new Error("Unexpected imaging QA save picker");
      const folder = formats[conversion++];
      evidence.pickers.push({ type: "save", title, folder });
      return { canceled: false, filePath: `${output}/${folder}` };
    };
    native.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    shell.openExternal = async url => {
      evidence.external.push(url === paperUrl ? url : "<unexpected URL>");
      if (url !== paperUrl) throw new Error("Unexpected external dispatch blocked by imaging QA");
    };
  }, { source, output, formats: detachedPreprocess ? [] : formats.map(format => format.id), paperUrl });

  report.stage = "render-kidney";
  const snapshot = await timed("open-and-render-kidney", async () => {
    await button("Open images").click();
    const value = await waitForSnapshot(page, state => state?.sources?.length === 1 && state.sources[0].sha256 === kidneySha256,
      "the pinned public kidney registered through the open picker", 90_000);
    await selectWorkbenchTool(page, "Display");
    const z = page.getByRole("slider", { name: "Z plane", exact: true });
    await z.press("Home");
    for (let plane = 0; plane < 8; plane++) await z.press("ArrowRight");
    assert.equal(await z.inputValue(), "8", "Expected the public middle plane");
    report.fixture.rendered_z_index = 8;
    if (detachedPreprocess) return value;
    const displayColors = ["#598cfa", "#64d88b", "#ee6462"];
    for (const [index, color] of displayColors.entries()) {
      const channel = index + 1;
      const row = page.locator(".source-channel").filter({ has: page.getByRole("checkbox", { name: `Channel ${channel} visible` }) });
      await row.getByRole("checkbox").check();
      await row.locator(":scope > summary").click();
      const picker = row.getByLabel(`Channel ${channel} color`, { exact: true });
      // Chromium's native colour chooser is outside Playwright. Deliver its chosen
      // value to the visible control, leaving React and the normal display path intact.
      await picker.evaluate((input, value) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }, color);
      assert.equal(await picker.inputValue(), color);
      await row.locator(":scope > summary").click();
    }
    report.fixture.display_luts = displayColors;
    report.rendered_source = await renderedSource(value.sources[0].id);
    return value;
  });
  const entry = snapshot.sources[0];
  assert.match(entry.id, /^[a-f0-9]{32}$/u);
  assert.equal(entry.locator_state ?? null, null, "The original source must be linked");
  if (detachedPreprocess) {
    report.stage = "detached-preprocess";
    report.preprocessing = { previews: [] };
    await auditDetachedPreprocessing({ app, page, entry, capture, evidence: report.preprocessing,
      output, source, python, save,
      onPageError: error => report.renderer_errors.push(redacted(error.message)) });
  } else {
    await capture("01-public-kidney-rendered");
    report.stage = "settings-guide";
    await auditSettingsAndGuide(report.rendered_source);
    await save();
    report.stage = "model-library";
    await auditModelLibrary();
    await save();
    report.stage = "conversion";
    await convertBoth(entry.id, snapshot.project.project_id);
    report.stage = "preprocessing";
    report.preprocessing = await auditPreprocessingInspector(page, entry.id, capture);
  }

  report.stage = "final-invariants";
  report.native_actions = await app.evaluate(() => globalThis.__lociImagingTools);
  assert.deepEqual(report.native_actions.pickers, [
    { type: "open", title: "Add microscopy or medical images" },
    ...(detachedPreprocess ? [] : formats.map(format => ({ type: "save", title: "Save converted image", folder: format.id }))),
  ]);
  assert.deepEqual(report.native_actions.external, detachedPreprocess ? [] : [paperUrl]);
  assert.deepEqual(report.blocked_requests, [], "A local journey attempted HTTP(S) renderer requests");
  assert.deepEqual(report.renderer_errors, []);
  report.fixture.sha256_after = await sha256(source);
  assert.equal(report.fixture.sha256_after, kidneySha256);
  report.status = "passed";
  report.stage = "complete";
} catch (error) {
  report.status = "failed";
  report.error = redacted(error.stack ?? error);
  if (page && !page.isClosed()) {
    try {
      const filename = "99-failure.png";
      const bytes = await page.screenshot({ path: path.join(output, filename), timeout: 5000 });
      report.failure_screenshot = { filename, sha256: createHash("sha256").update(bytes).digest("hex") };
    } catch (captureError) {
      report.failure_capture_error = redacted(captureError.message);
    }
  }
  throw new Error(`Imaging tools QA failed at ${report.stage}. Receipt: ${receipt}`, { cause: error });
} finally {
  if (app) {
    report.native_actions ??= await app.evaluate(() => globalThis.__lociImagingTools).catch(() => undefined);
    await app.close().catch(error => {
      report.close_error = redacted(error);
      if (report.status === "passed") {
        report.status = "failed";
        report.stage = "close-packaged-app";
      }
    });
  }
  report.fixture.sha256_after ??= await sha256(source).catch(() => null);
  report.finished_at = new Date().toISOString();
  await save();
}
if (report.status !== "passed") throw new Error(`Imaging tools QA failed at ${report.stage}. Receipt: ${receipt}`);
console.log(receipt);
