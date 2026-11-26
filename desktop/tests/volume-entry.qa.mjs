import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { placeQaWindow } from "../../scripts/qa/display-placement.mjs";
import { measureRafDuring, startProcessTreeRssSampler } from "./navigation-performance-qa-helpers.mjs";
import { waitForSnapshot } from "./workbench-qa-helpers.mjs";

const KIDNEY = {
  sha256: "83f9df040b58d0d4ee175730e3087216bb313cb4d450c59ac5d612525c6c9564",
  dimensions: [512, 512, 16],
  overview: { initial: [128, 128, 4], refined: [256, 256, 8] },
  center: [258, 258, 10],
  spacing: [1.24, 1.24, 1.25],
  origin: [0, 0, 0],
  unit: "um",
};

const AXES = ["X", "Y", "Z"];
const VOLUME_BUDGET = 128 * 1024 * 1024;
const TILE = '[data-viewer-source][data-cache-bytes]';
const AXIAL_CANVAS = '.mpr-pane[data-pane="axial"] canvas';
const NAVIGATION_STEP_MS = 150;
const NAVIGATION_SLICE_STEPS = 29;
const NAVIGATION_TIMEOUT_MS = 70_000;
const TWO_D_OPERATIONS = ["view", "result_view", "viewer_tile"];
const LAUNCH_BUTTONS = {
  direct: "Open image in 3D…",
  file: "Open images",
  zarr: "OME-Zarr store",
};
const PICKERS = {
  direct: "Choose one image file or OME-Zarr store to open in 3D",
  file: "Add microscopy or medical images",
  zarr: "Select an OME-Zarr image directory",
};

const usage = `Usage: node desktop/tests/volume-entry.qa.mjs --app /path/Loci.app --out /path/evidence
  On Windows pass the packaged Loci.exe or the directory containing it.
  --source /path/image.ome.tiff --sha256 HEX --dimensions X,Y,Z
  [--center X,Y,Z] [--span 64|wide] [--route direct|comparison|both]
  Optional exact checks: --overview-dimensions X,Y,Z --overview-level L --bytes-per-voxel N
  Optional specimen checks: --expect-preview --min-focus-width FRACTION --repeat-open N --navigate
  Optional direct entry check: --min-initial-mip-contrast N (foreground P90 minus P10, in 8-bit display levels)
  or --cases /path/fixtures.json (array of objects using the same option names)
  or --public-kidney --source /path/Kidney fluorescence.ome.tiff [--route direct|comparison|both]
  Optional: --timeout-ms MS --display NAME_OR_ID
  LOCI_PACKAGED_APP and LOCI_QA_OUTPUT_ROOT may supply --app and --out.`;

function vector(value, length, minimum, label, delimiter = ",") {
  const parts = Array.isArray(value) ? value : String(value ?? "").split(delimiter);
  const numbers = parts.map(Number);
  assert.ok(parts.length === length && parts.every((part) => /^\d+$/.test(String(part))) &&
    numbers.every((number) => Number.isSafeInteger(number) && number >= minimum), `Invalid ${label}`);
  return numbers;
}

function byteLength(value, label) {
  const [bytes] = vector([value], 1, 1, label);
  return bytes;
}

export function focusExtentXYZ(dimensions, center, span) {
  const requested = span === "wide" ? [256, 256, 64] : [64, 64, 64];
  return dimensions.flatMap((length, axis) => {
    const size = Math.min(requested[axis], length);
    const start = Math.max(0, Math.min(length - size, center[axis] - Math.floor(size / 2)));
    return [start, start + size - 1];
  });
}

export function validateVolumeState(state, dimensions, { center, span, expected, contextLimit = center ? 256 : 128 } = {}) {
  const contextDimensions = vector(state.contextDimensions, 3, 1, "context dimensions", "x");
  const [contextLevel] = vector([state.contextLevel], 1, 0, "context level");
  const contextBytes = byteLength(state.contextByteLength, "context byte length");
  const componentBytes = contextBytes / contextDimensions.reduce((product, size) => product * size, 1);
  // One to four scalar components, each storing 1, 2 or 4 bytes.
  assert.ok([1, 2, 3, 4, 6, 8, 12, 16].includes(componentBytes), "Invalid context bytes per voxel");
  assert.ok(contextDimensions.every((size, axis) => size <= dimensions[axis]),
    "Context display dimensions exceed the level-zero source");
  assert.ok(Math.max(...contextDimensions) <= contextLimit, "Context exceeds target size");
  if (expected?.dimensions) assert.deepEqual(contextDimensions, expected.dimensions, "Wrong overview display dimensions");
  if (expected?.level !== undefined) assert.equal(contextLevel, expected.level, "Wrong overview pyramid level");
  if (expected?.bytesPerVoxel !== undefined)
    assert.equal(componentBytes, expected.bytesPerVoxel, "Wrong component encoding");

  let focus = null;
  if (center) {
    assert.equal(state.focusNativeSteps, "true", "The focus did not retain consecutive native indices");
    const extent = vector(state.focusExtent, 6, 0, "focus extent");
    assert.deepEqual(extent, focusExtentXYZ(dimensions, center, span), "Wrong level-zero focus extent");
    const focusDimensions = dimensions.map((_, axis) => extent[2 * axis + 1] - extent[2 * axis] + 1);
    const bytes = byteLength(state.focusByteLength, "focus byte length");
    assert.equal(bytes, focusDimensions.reduce((product, size) => product * size, componentBytes),
      "Focus bytes disagree with its native extent and the context encoding");
    focus = { extent_xyzxyz: extent, displayed_dimensions_xyz: focusDimensions, byte_length: bytes };
  } else {
    assert.equal(state.focusExtent, undefined, "Unexpected focus at initial 3D entry");
  }
  const payloadBytes = contextBytes + (focus?.byte_length ?? 0);
  // CPU array, base64, decoded JS values and GPU texture, before decoder scratch.
  const aggregatePayloadEstimate = Math.ceil(payloadBytes * (3 + 4 / 3));
  assert.ok(aggregatePayloadEstimate <= VOLUME_BUDGET, "Volume payloads exceed the 128 MiB aggregate budget");
  return {
    context: { displayed_dimensions_xyz: contextDimensions, level: contextLevel, byte_length: contextBytes },
    focus,
    aggregate_payload_estimate_bytes: aggregatePayloadEstimate,
    aggregate_budget_bytes: VOLUME_BUDGET,
    bytes_per_voxel_across_components: componentBytes,
  };
}

export function validateKidneyOverview(state) {
  // The first observed stable frame may follow automatic refinement, which
  // doubles the 128-voxel target once, up to the worker's limit of 256.
  assert.equal(state.sourceSha256, KIDNEY.sha256, "Overview changed the bound kidney fingerprint");
  const stage = Object.keys(KIDNEY.overview).find((entry) => KIDNEY.overview[entry].join("x") === state.contextDimensions);
  assert.ok(stage, "The kidney overview is neither the initial nor the refined level-zero grid");
  const ranges = (state.transferRanges ?? "").split(",").filter(Boolean);
  assert.ok(ranges.length >= 1 && ranges.length <= 3, "Invalid number of kidney scalar component ranges");
  const dimensions = KIDNEY.overview[stage];
  return {
    ...validateVolumeState(state, KIDNEY.dimensions, {
      expected: { dimensions, level: 0, bytesPerVoxel: 2 * ranges.length },
      contextLimit: dimensions[0],
    }),
    entry_stage: stage,
  };
}

export function centralSignal(bitmap, width, height) {
  assert.equal(bitmap.length, width * height * 4, "Unexpected screenshot bitmap layout");
  const tones = new Set();
  let signal = 0;
  let total = 0;
  const columns = Array(width).fill(0);
  const rows = Array(height).fill(0);
  for (let y = Math.floor(height * 0.15); y < Math.ceil(height * 0.85); y += 1) {
    for (let x = Math.floor(width * 0.15); x < Math.ceil(width * 0.85); x += 1) {
      const offset = (y * width + x) * 4;
      const peak = Math.max(bitmap[offset], bitmap[offset + 1], bitmap[offset + 2]);
      tones.add(peak);
      total += 1;
      if (peak > 24) { signal += 1; columns[x] += 1; rows[y] += 1; }
    }
  }
  // Occupied scanlines reject isolated bright pixels and corner orientation markers.
  const supportedFraction = (counts, transverseLength) =>
    counts.filter((count) => count >= Math.max(2, Math.ceil(0.02 * transverseLength))).length / counts.length;
  return {
    distinct_maximum_intensities: tones.size, central_signal_fraction: signal / total,
    central_signal_width_fraction: supportedFraction(columns, height),
    central_signal_height_fraction: supportedFraction(rows, width),
  };
}

export function specimenForeground(bitmap, width, height) {
  assert.equal(bitmap.length, width * height * 4, "Unexpected screenshot bitmap layout");
  // A centered specimen that fills the viewport vertically can use this interior
  // square, away from the orientation axes and its silhouette against the surround.
  const halfSide = Math.min(width, height) / 4;
  const left = Math.ceil(width / 2 - halfSide);
  const right = Math.floor(width / 2 + halfSide);
  const top = Math.ceil(height / 2 - halfSide);
  const bottom = Math.floor(height / 2 + halfSide);
  const area = (right - left) * (bottom - top);
  assert.ok(right > left && bottom > top, "Canvas too small to measure specimen foreground");
  const histogram = new Uint32Array(256);
  let occupied = 0;
  let nearWhite = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const offset = (y * width + x) * 4;
      const peak = Math.max(bitmap[offset], bitmap[offset + 1], bitmap[offset + 2]);
      if (peak <= 24) continue;
      histogram[peak] += 1;
      occupied += 1;
      if (peak >= 248) nearWhite += 1;
    }
  }
  const percentile = (fraction) => {
    if (!occupied) return null;
    const rank = Math.ceil(fraction * occupied);
    let cumulative = 0;
    return histogram.findIndex((count) => (cumulative += count) >= rank);
  };
  const p10 = percentile(0.10), p90 = percentile(0.90);
  return {
    bounds_xyxy_end_exclusive: [left, top, right, bottom],
    foreground_fraction: occupied / area,
    near_white_fraction: occupied ? nearWhite / occupied : null,
    p10, p90, p90_minus_p10: occupied ? p90 - p10 : null,
  };
}

export function assertInitialMipContrast(overview, minimumContrast) {
  assert.equal(overview.initial_rendering_mode, "mip", "Direct 3D did not initially select maximum intensity");
  const foreground = overview.image.specimen_foreground;
  assert.ok(foreground.foreground_fraction >= 0.9, "The specimen does not fill the contrast measurement region");
  assert.ok(foreground.near_white_fraction < 0.5, "The initial specimen foreground is mostly near-white");
  assert.ok(foreground.p90_minus_p10 >= minimumContrast,
    `Initial specimen foreground contrast is ${foreground.p90_minus_p10}, below ${minimumContrast}`);
}

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
}

async function inspectBundle(bundle) {
  const windows = process.platform === "win32";
  const candidate = await fs.realpath(bundle);
  const packageRoot = (await fs.stat(candidate)).isDirectory() ? candidate
    : path.resolve(path.dirname(candidate), windows ? "." : "../..");
  const executable = path.join(packageRoot, windows ? "Loci.exe" : "Contents/MacOS/Loci");
  assert.ok(candidate === packageRoot || candidate === await fs.realpath(executable),
    "Pass the exact packaged Loci executable or its package directory.");
  const resources = path.join(packageRoot, windows ? "resources" : "Contents/Resources");
  const worker = path.join(resources, "loci-engine", windows ? "loci-engine.exe" : "loci-engine");
  const [identity, executableSha, asarSha, workerSha] = await Promise.all([
    fs.readFile(path.join(resources, "loci-build-identity.json"), "utf8").then(JSON.parse),
    sha256(executable),
    sha256(path.join(resources, "app.asar")),
    sha256(worker),
  ]);
  return { path: packageRoot, executable, identity, executable_sha256: executableSha, asar_sha256: asarSha, worker_sha256: workerSha };
}

async function caseSettings(item) {
  assert.ok(path.isAbsolute(item.source ?? ""), "Pass an absolute source path");
  assert.match(item.sha256 ?? "", /^[0-9a-f]{64}$/, "Pass the independently pinned source fingerprint");
  const dimensions = vector(item.dimensions, 3, 1, "native source dimensions");
  assert.ok(dimensions[2] >= 2, "The fixture must contain a volume");
  const center = item.center == null ? null : vector(item.center, 3, 0, "focus center");
  assert.ok(center === null || center.every((value, axis) => value < dimensions[axis]), "Focus center is outside source");
  const span = item.span ?? "64";
  assert.ok(["64", "wide"].includes(span), "Use --span 64 or wide");
  const route = item.route ?? "direct";
  assert.ok(["direct", "comparison", "both"].includes(route), "Use --route direct, comparison or both");
  const expected = {
    dimensions: item["overview-dimensions"] === undefined ? undefined
      : vector(item["overview-dimensions"], 3, 1, "overview dimensions"),
    level: item["overview-level"] === undefined ? undefined
      : vector([item["overview-level"]], 1, 0, "overview level")[0],
    bytesPerVoxel: item["bytes-per-voxel"] === undefined ? undefined
      : byteLength(item["bytes-per-voxel"], "expected bytes per voxel"),
  };
  const source = await fs.realpath(item.source);
  const status = await fs.stat(source);
  assert.ok(status.isFile() || status.isDirectory(), "The source must be a file or an OME-Zarr directory");
  const publicKidney = item["public-kidney"] === true;
  if (publicKidney) {
    assert.ok(status.isFile(), "The public kidney fixture must be an OME-TIFF file");
    assert.equal(await sha256(source), KIDNEY.sha256, "Public kidney fixture SHA-256 does not match");
  }
  const expectPreview = item["expect-preview"] ?? false;
  assert.ok(typeof expectPreview === "boolean" && (!expectPreview || (status.isDirectory() && route !== "comparison")),
    "An opening preview requires direct entry to a local OME-Zarr directory");
  const minFocusWidth = Number(item["min-focus-width"] ?? 0);
  assert.ok(Number.isFinite(minFocusWidth) && minFocusWidth >= 0 && minFocusWidth <= 0.7,
    "Focus width must be a fraction of the stage from 0 to 0.7");
  const minInitialMipContrast = item["min-initial-mip-contrast"] === undefined ? null
    : vector([item["min-initial-mip-contrast"]], 1, 1, "minimum initial MIP contrast")[0];
  assert.ok(minInitialMipContrast === null || (minInitialMipContrast <= 230 && route === "direct" && !expectPreview),
    "Initial MIP contrast must be 1 to 230 for a direct entry without preview interaction");
  const [repeatOpen] = vector([item["repeat-open"] ?? 0], 1, 0, "repeat open count");
  assert.ok(repeatOpen <= 20 && (!repeatOpen || route === "direct"), "Repeat up to 20 direct opens per session");
  const navigate = item.navigate ?? false;
  assert.equal(typeof navigate, "boolean", "Navigate must be true or false");
  return {
    source, sha256: item.sha256, dimensions, center, span, expected, expectPreview, minFocusWidth, minInitialMipContrast,
    repeatOpen, navigate, publicKidney,
    comparison: status.isDirectory() ? "zarr" : "file",
    routes: route === "both" ? ["direct", "comparison"] : [route],
  };
}

async function installObserver(page, sourceSha256) {
  await page.evaluate(({ sourceSha256, tileSelector }) => {
    window.__lociVolumeEntryObserver?.disconnect();
    const previousCanvas = document.querySelector(".raw-volume-stage canvas");
    const state = { clicks: {}, ready: {}, firstTwoDTile: null, failure: null };
    window.__lociVolumeEntry = state;
    const isPopulatedTile = (element) =>
      element?.matches?.(tileSelector) && Number(element.dataset.cacheBytes) > 0;
    const alertText = () => {
      const alert = Array.from(document.querySelectorAll(".research-alert")).find((node) => node.getClientRects().length);
      return alert?.textContent?.trim();
    };
    const capture = () => {
      const volume = document.querySelector(".raw-volume");
      if (state.clicks.open === undefined || !volume?.dataset.sourceSha256) return null;
      if (document.querySelector('.volume-opening-backdrop[data-ready="true"]')) return null;
      if (volume.dataset.sourceSha256 !== sourceSha256) {
        state.failure = "The rendered viewport belongs to a different source fingerprint.";
        return null;
      }
      const status = volume.querySelector(".raw-volume-status span")?.textContent;
      if (!status?.includes("source voxels ·") || !status.includes("display ·")) return null;
      const stage = volume.querySelector(".raw-volume-stage canvas");
      const mpr = [...volume.querySelectorAll(".mpr-pane-slot canvas")];
      if (!stage || stage === previousCanvas || mpr.length !== 3 || ![stage, ...mpr].every((canvas) =>
        canvas.width > 0 && canvas.height > 0 && canvas.getClientRects().length)) return null;
      const { activeView } = volume.dataset;
      const phase = ["level-zero-focus", "native-detail-focus"].includes(activeView) ? "focus" : "overview";
      if (phase === "overview" && activeView !== "whole-volume-context") return null;
      if (phase === "focus" && state.clicks.detail === undefined) return null;
      return { phase, state: { ...volume.dataset }, status, canvasPixels: [stage, ...mpr].map((canvas) =>
        [canvas.width, canvas.height]) };
    };
    const inspect = (records) => {
      if (state.clicks.open === undefined) return;
      const preview = document.querySelector('.volume-opening-backdrop[data-ready="true"]');
      if (!state.ready.preview && preview?.querySelector(".volume-opening-stage canvas")) {
        state.ready.preview = { rafScheduled: true };
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (preview.isConnected && preview.getClientRects().length)
            state.ready.preview.time = performance.now();
          else delete state.ready.preview;
        }));
      }
      if (state.firstTwoDTile === null) {
        const mutatedTile = records.some((record) => record.attributeName === "data-cache-bytes" &&
          record.target.matches(tileSelector) && (Number(record.oldValue) > 0 || isPopulatedTile(record.target)));
        const renderedTile = Array.from(document.querySelectorAll(tileSelector)).some(isPopulatedTile);
        if (mutatedTile || renderedTile) state.firstTwoDTile = performance.now();
      }
      state.failure ??= alertText() || null;
      const current = capture();
      if (!current || state.ready[current.phase]?.rafScheduled) return;
      const { phase } = current;
      state.ready[phase] = { rafScheduled: true };
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const final = capture();
        if (final?.phase === phase) state.ready[phase] = { ...final, time: performance.now(), rafScheduled: true };
        else delete state.ready[phase];
      }));
    };
    const observer = new MutationObserver(inspect);
    window.__lociVolumeEntryObserver = observer;
    observer.observe(document.body, {
      subtree: true, childList: true, attributes: true, characterData: true, attributeOldValue: true,
    });
  }, { sourceSha256, tileSelector: TILE });
}

async function timedClick(control, phase) {
  await control.evaluate((element, key) => {
    element.addEventListener("click", (event) => {
      if (event.isTrusted) window.__lociVolumeEntry.clicks[key] ??= performance.now();
    }, { capture: true });
  }, phase);
  await control.click();
}

async function waitForPhase(page, phase, timeout) {
  const ready = await page.waitForFunction((phase) => {
    const { failure, ready, firstTwoDTile } = window.__lociVolumeEntry;
    if (failure) return { failure };
    if (phase === "2d") return firstTwoDTile !== null;
    return ready[phase]?.time === undefined ? false : ready[phase];
  }, phase, { timeout });
  const result = await ready.jsonValue();
  await ready.dispose();
  assert.ok(!result.failure, result.failure);
  return result;
}

async function sourcePosition(page, dimensions, requestedCenter) {
  const center = [];
  for (const [axis, label] of AXES.entries()) {
    const slice = page.getByRole("slider", { name: `${label} slice`, exact: true });
    assert.equal(Number(await slice.getAttribute("min")), 0);
    assert.equal(Number(await slice.getAttribute("max")), dimensions[axis] - 1,
      `${label} slider disagrees with independently supplied native dimensions`);
    if (requestedCenter) {
      const requested = requestedCenter[axis];
      if (Number(await slice.inputValue()) !== requested) {
        const box = await slice.boundingBox();
        assert.ok(box && box.width > 16, `${label} slice slider is not visible`);
        // Place the thumb near the native index with a trusted pointer, then step exactly.
        const fraction = requested / Math.max(1, dimensions[axis] - 1);
        await slice.click({ position: { x: 8 + fraction * (box.width - 16), y: box.height / 2 } });
        let value = Number(await slice.inputValue());
        const distance = Math.abs(requested - value);
        assert.ok(distance <= 256, `${label} slice thumb missed the requested index by ${distance}`);
        const key = value < requested ? "ArrowRight" : "ArrowLeft";
        for (let step = 0; step < distance; step += 1) await slice.press(key);
        value = Number(await slice.inputValue());
        assert.equal(value, requested, `${label} slice did not reach the requested native index`);
      }
    }
    const value = Number(await slice.inputValue());
    const output = page.getByLabel(`${label} source index`, { exact: true });
    assert.equal(Number(await output.textContent()), value, `${label} source index readout differs from its slider`);
    center.push(value);
  }
  return center;
}

async function captureVolume(app, page, directory, name, selector, { measureForeground = false } = {}) {
  const filename = `${name}.png`;
  const stage = selector ?? page.getByLabel("Interactive three-dimensional volume", { exact: true }).locator("canvas");
  const png = await stage.screenshot({ path: path.join(directory, filename) });
  const decoded = await app.evaluate(({ nativeImage }, { encoded, measureForeground }) => {
    const image = nativeImage.createFromDataURL(`data:image/png;base64,${encoded}`);
    const original = image.getSize();
    const smaller = image.resize({ width: 160 });
    return {
      original, sample: smaller.getSize(), bitmap: smaller.toBitmap().toString("base64"),
      fullBitmap: measureForeground ? image.toBitmap().toString("base64") : null,
    };
  }, { encoded: png.toString("base64"), measureForeground });
  const bitmap = Buffer.from(decoded.bitmap, "base64");
  const values = centralSignal(bitmap, decoded.sample.width, decoded.sample.height);
  return {
    png: filename,
    sha256: createHash("sha256").update(png).digest("hex"),
    sampled_pixel_sha256: createHash("sha256").update(bitmap).digest("hex"),
    viewport_pixels: decoded.original,
    ...(decoded.fullBitmap ? {
      specimen_foreground: specimenForeground(Buffer.from(decoded.fullBitmap, "base64"),
        decoded.original.width, decoded.original.height),
    } : {}),
    ...values,
  };
}

function assertSignal(capture, name) {
  assert.ok(capture.distinct_maximum_intensities > 10 && capture.central_signal_fraction > 0.002,
    `${name} canvas has insufficient central signal or tonal variation`);
}

export function focusSlicePositions(center, extent) {
  const up = extent[5] - center;
  const down = center - extent[4];
  assert.ok(up >= 0 && down >= 0 && Math.max(up, down) > 0, "Need at least two focused Z slices");
  const travel = Math.min(6, Math.max(up, down));
  const direction = up >= down ? 1 : -1;
  // An odd number of unit steps ends away from the starting slice at any travel distance.
  return Array.from({ length: NAVIGATION_SLICE_STEPS }, (_, index) => {
    const phase = (index + 1) % (2 * travel);
    return center + direction * Math.min(phase, 2 * travel - phase);
  });
}

export function assertNavigationFocus(state, expectedState, sourceSha256, crosshair, expectedCrosshair) {
  assert.match(state.sourceId ?? "", /^[a-f0-9]{32}$/u, "Navigation did not use a registered source");
  assert.equal(state.sourceId, expectedState.sourceId, "Navigation switched the registered source");
  assert.equal(state.sourceSha256, sourceSha256, "Navigation changed the bound source fingerprint");
  assert.ok(["level-zero-focus", "native-detail-focus"].includes(state.activeView), "Navigation left native focus");
  for (const key of ["activeView", "focusExtent", "focusNativeSteps", "focusByteLength"])
    assert.equal(state[key], expectedState[key], `Navigation changed ${key}`);
  assert.deepEqual(crosshair, expectedCrosshair, "Navigation moved to a different source coordinate");
}

async function captureMprRaster(locator) {
  return locator.evaluate(async (canvas) => {
    const { width, height, dataset: { renderBinding } } = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx || width < 1 || height < 1 || !renderBinding) {
      throw new Error("The MPR canvas has no source-bound raster");
    }
    const { data } = ctx.getImageData(0, 0, width, height);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
    return {
      dimensions_xy: [width, height],
      rgba_sha256: Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
      render_binding: JSON.parse(renderBinding),
    };
  });
}

function kidneyWorld(index) {
  return index.map((native, axis) => KIDNEY.origin[axis] + native * KIDNEY.spacing[axis]);
}

function assertKidneyWorld(position, index) {
  const world = kidneyWorld(index);
  assert.deepEqual(position.index_xyz, index, "The native crosshair is on the wrong source voxel");
  assert.equal(position.world_readout, `World ${world.map((value) => value.toFixed(3)).join(", ")} ${KIDNEY.unit}`);
  return world;
}

export function assertKidneyLinkedSlice(before, after) {
  const start = KIDNEY.center;
  const end = [start[0], start[1], start[2] + 1];
  for (const [capture, index] of [[before, start], [after, end]]) {
    const world = assertKidneyWorld(capture, index);
    const [payload, plane, paintedWorld] = capture.raster.render_binding;
    assert.match(payload, /^[a-f0-9]{64}$/u);
    assert.equal(plane, "axial");
    assert.ok(paintedWorld?.length === 3 && paintedWorld.every((value, axis) => Math.abs(value - world[axis]) < 1e-6),
      "The painted XY plane is on the wrong physical source voxel");
    assert.match(capture.raster.rgba_sha256, /^[a-f0-9]{64}$/u);
  }
  const [beforePayload, , , ...beforeDisplay] = before.raster.render_binding;
  const [afterPayload, , , ...afterDisplay] = after.raster.render_binding;
  assert.equal(afterPayload, beforePayload, "Linked Z navigation swapped the native volume payload");
  assert.deepEqual(afterDisplay, beforeDisplay, "Linked Z navigation changed MPR display settings");
  assert.deepEqual(after.raster.dimensions_xy, before.raster.dimensions_xy);
  assert.notEqual(after.raster.rgba_sha256, before.raster.rgba_sha256,
    "Linked Z navigation did not change the painted native XY raster");
}

async function checkKidneyLinkedSlice(app, page, directory, detail, report, timeout) {
  const sourceId = detail.renderer.state.sourceId;
  const snapshot = await waitForSnapshot(page, (state) => state?.sources?.some((source) => source.id === sourceId),
    "registered public kidney", timeout);
  assert.equal(snapshot.sources.length, 1);
  const [source] = snapshot.sources;
  assert.equal(source.sha256, KIDNEY.sha256);
  const { x, y, z, c, t, s } = source.metadata.dimensions;
  assert.deepEqual([x, y, z, c, t, s], [...KIDNEY.dimensions, 3, 1, 1],
    "Registered specimen geometry or scalar channel count disagrees with the pinned kidney fixture");
  report.registered_source = { id: sourceId, sha256: source.sha256, dimensions: { x, y, z, c, t, s } };
  report.reference_geometry = { spacing_xyz: KIDNEY.spacing, origin_xyz: KIDNEY.origin, unit: KIDNEY.unit };
  const volume = page.locator(".raw-volume");
  // Use the visible native sliders at the zero vector before requesting a focus crop.
  assertKidneyWorld(report.origin_check, [0, 0, 0]);
  const axial = volume.locator(AXIAL_CANVAS);
  const read = async (name, index) => {
    const painted = await page.waitForFunction(({ selector, world }) => {
      const binding = document.querySelector(selector)?.dataset.renderBinding;
      const point = binding && JSON.parse(binding)[2];
      return Array.isArray(point) && point.length === 3 &&
        point.every((value, axis) => Math.abs(value - world[axis]) < 1e-6);
    }, { selector: AXIAL_CANVAS, world: kidneyWorld(index) }, { timeout });
    await painted.dispose();
    const indexXyz = await sourcePosition(page, KIDNEY.dimensions, null);
    const state = await volume.evaluate((element) => ({ ...element.dataset }));
    assertNavigationFocus(state, detail.renderer.state, KIDNEY.sha256, indexXyz, index);
    const image = await captureVolume(app, page, directory, name, axial);
    assertSignal(image, name);
    return {
      index_xyz: indexXyz, world_readout: await volume.locator(".raw-volume-world").textContent(),
      raster: await captureMprRaster(axial), image,
    };
  };
  report.before = await read("kidney-xy-native-z10", KIDNEY.center);
  await volume.getByRole("slider", { name: "Z slice", exact: true }).press("ArrowRight");
  report.after = await read("kidney-xy-native-z11", [...KIDNEY.center.slice(0, 2), KIDNEY.center[2] + 1]);
  assertKidneyLinkedSlice(report.before, report.after);
}

async function recordVolumeGraphics(app, page) {
  const receipt = { electron: null, webgl: null, model_compute_exercised: false };
  receipt.electron = await app.evaluate(async ({ app }) => {
    let timer;
    const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(null), 4_000); });
    const info = await Promise.race([app.getGPUInfo("basic").catch(() => null), deadline])
      .finally(() => clearTimeout(timer));
    return {
      version: process.versions.electron, hardware_acceleration_enabled: app.isHardwareAccelerationEnabled(),
      features: app.getGPUFeatureStatus(),
      devices: info?.gpuDevice?.map(({ active, vendorId, deviceId, vendorString, deviceString }) =>
        ({ active, vendorId, deviceId, vendorString, deviceString })) ?? null,
    };
  }).catch((error) => {
    receipt.electron_error = String(error);
    return null;
  });
  if (page && !page.isClosed()) {
    receipt.webgl = await page.evaluate(() => {
      const canvas = document.querySelector(".raw-volume-stage canvas");
      const gl = canvas?.getContext("webgl2") ?? canvas?.getContext("webgl");
      if (!gl || gl.isContextLost()) return null;
      const debug = gl.getExtension("WEBGL_debug_renderer_info");
      return {
        version: gl.getParameter(gl.VERSION), renderer: gl.getParameter(gl.RENDERER),
        unmasked_vendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null,
        unmasked_renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
      };
    }).catch((error) => {
      receipt.webgl_error = String(error);
      return null;
    });
  }
  return receipt;
}

export function assertRecoveredMprRaster(actual, baseline) {
  assert.deepEqual(actual.render_binding, baseline.render_binding,
    "The restored XY plane changed its payload, world position or display settings");
  assert.deepEqual(actual.dimensions_xy, baseline.dimensions_xy,
    "The restored XY plane changed its underlying raster dimensions");
  assert.equal(actual.rgba_sha256, baseline.rgba_sha256,
    "The restored XY plane changed its underlying RGBA pixels");
}

export async function observeNavigationRequests(app) {
  await app.evaluate(({ ipcMain }, operations) => {
    const channel = "loci-research:execute";
    const original = ipcMain._invokeHandlers?.get(channel);
    if (typeof original !== "function") throw new Error("Research IPC handler unavailable for navigation QA");
    const counts = Object.fromEntries(operations.map((name) => [name, 0]));
    // Observe requests from the isolated QA app and retain the original trust checks and response.
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, (event, operation, ...args) => {
      if (Object.hasOwn(counts, operation)) counts[operation]++;
      return original(event, operation, ...args);
    });
    globalThis.__lociFinishNavigationRequests = () => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, original);
      delete globalThis.__lociFinishNavigationRequests;
      return counts;
    };
  }, [...TWO_D_OPERATIONS, "viewer_volume"]);
}

async function runNavigation(app, page, directory, fixture, center, detail, report, signal) {
  const volume = page.locator(".raw-volume");
  const stage = volume.getByLabel("Interactive three-dimensional volume", { exact: true });
  const canvas = stage.locator("canvas");
  const xy = volume.locator(AXIAL_CANVAS);
  const status = volume.locator(".raw-volume-status > span");
  const dataset = () => volume.evaluate((element) => ({ ...element.dataset }));
  const expected = detail.renderer.state;
  const assertFocus = async (point) => {
    assertNavigationFocus(await dataset(), expected, fixture.sha256,
      await sourcePosition(page, fixture.dimensions, null), point);
  };
  await assertFocus(center);
  const captures = report.captures;
  captures.before_3d = detail.mip ?? detail.image;
  captures.before_xy = await captureVolume(app, page, directory, "navigation-before-xy", xy);
  captures.before_xy.raster = await captureMprRaster(xy);
  assertSignal(captures.before_xy, "Initial navigation XY");
  const box = await stage.boundingBox();
  assert.ok(box && box.width >= 120 && box.height >= 100, "Navigation requires a visible 3D stage");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const step = async (action) => {
    signal.throwIfAborted();
    await action();
    await delay(NAVIGATION_STEP_MS, undefined, { signal });
  };
  const pointerPhase = async (name, button, dx, dy) => {
    const moveCount = 24;
    report.phases[name] = await measureRafDuring(page, name, async () => {
      await page.mouse.move(x, y);
      await page.mouse.down({ button });
      try {
        for (let index = 1; index <= moveCount; index++) {
          await step(() => page.mouse.move(x + dx * index / moveCount, y + dy * index / moveCount));
        }
      } finally {
        if (!signal.aborted) await page.mouse.up({ button });
      }
    });
    report.phases[name].pointer_moves = moveCount;
    captures[name] = await captureVolume(app, page, directory, `navigation-${name}`);
    assertSignal(captures[name], name);
    await assertFocus(center);
  };
  await pointerPhase("orbit", "left", box.width * 0.14, box.height * 0.08);
  assert.notEqual(captures.orbit.sampled_pixel_sha256, captures.before_3d.sampled_pixel_sha256,
    "The orbit did not change the displayed 3D pixels");
  await pointerPhase("pan", "right", box.width * 0.12, -box.height * 0.09);
  assert.notEqual(captures.pan.sampled_pixel_sha256, captures.orbit.sampled_pixel_sha256,
    "The pan did not change the displayed 3D pixels");

  const z = volume.getByRole("slider", { name: "Z slice", exact: true });
  const positions = focusSlicePositions(center[2], detail.focus.extent_xyzxyz);
  let current = center[2];
  const moveTo = async (position) => {
    await page.keyboard.press(position > current ? "ArrowRight" : "ArrowLeft");
    assert.equal(Number(await z.inputValue()), position, "Z navigation did not advance to the exact native index");
    current = position;
  };
  await z.focus();
  report.phases.xy_slices = await measureRafDuring(page, "xy_slices", async () => {
    for (const position of positions) await step(() => moveTo(position));
  });
  report.phases.xy_slices.native_z_positions = positions;
  captures.resliced_xy = await captureVolume(app, page, directory, "navigation-resliced-xy", xy);
  captures.resliced_xy.raster = await captureMprRaster(xy);
  assertSignal(captures.resliced_xy, "Resliced navigation XY");
  assert.notDeepEqual(captures.resliced_xy.raster.render_binding, captures.before_xy.raster.render_binding,
    "Native Z navigation did not redraw the bound XY plane");
  assert.notEqual(captures.resliced_xy.raster.rgba_sha256, captures.before_xy.raster.rgba_sha256,
    "Native Z navigation did not change the underlying XY slice pixels");
  await assertFocus([center[0], center[1], current]);
  while (current !== center[2]) await moveTo(current + Math.sign(center[2] - current));
  await assertFocus(center);

  signal.throwIfAborted();
  const canLoseContext = await canvas.evaluate((element) => {
    const gl = element.getContext("webgl2") ?? element.getContext("webgl");
    const extension = gl?.getExtension("WEBGL_lose_context");
    if (!extension) return false;
    window.__lociNavigationLostCanvas = element;
    window.__lociNavigationContext = extension;
    extension.loseContext();
    return true;
  });
  assert.ok(canLoseContext, "WEBGL_lose_context is unavailable in the packaged renderer");
  await status.filter({ hasText: "Graphics context lost" }).waitFor({ timeout: 10_000 });
  const recoveryStart = performance.now();
  await page.evaluate(() => {
    window.__lociNavigationContext.restoreContext();
    delete window.__lociNavigationContext;
  });
  await page.waitForFunction(() => {
    const stageCanvas = document.querySelector(".raw-volume-stage canvas");
    const statusText = document.querySelector(".raw-volume-status > span")?.textContent;
    return stageCanvas && stageCanvas !== window.__lociNavigationLostCanvas &&
      stageCanvas.width > 0 && stageCanvas.height > 0 &&
      statusText?.includes("source voxels ·") && statusText.includes("display ·");
  }, null, { timeout: 20_000 });
  report.webgl_recovery_ms = performance.now() - recoveryStart;
  await page.evaluate(() => { delete window.__lociNavigationLostCanvas; });
  await assertFocus(center);
  captures.recovered_3d = await captureVolume(app, page, directory, "navigation-recovered-3d");
  captures.recovered_xy = await captureVolume(app, page, directory, "navigation-recovered-xy", xy);
  captures.recovered_xy.raster = await captureMprRaster(xy);
  assertSignal(captures.recovered_3d, "Recovered focus 3D");
  assertSignal(captures.recovered_xy, "Recovered focus XY");
  report.final_state = await dataset();
  report.final_crosshair_xyz = await sourcePosition(page, fixture.dimensions, null);
  assertNavigationFocus(report.final_state, expected, fixture.sha256, report.final_crosshair_xyz, center);
  assertRecoveredMprRaster(captures.recovered_xy.raster, captures.before_xy.raster);
}

async function runBoundedNavigation(app, page, directory, fixture, center, detail, report) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const failure = new Error(`Navigation exceeded ${NAVIGATION_TIMEOUT_MS / 1_000} seconds`);
      controller.abort(failure);
      reject(failure);
    }, NAVIGATION_TIMEOUT_MS);
  });
  const interact = async () => {
    const started = performance.now();
    await observeNavigationRequests(app);
    try {
      await runNavigation(app, page, directory, fixture, center, detail, report, controller.signal);
    } finally {
      report.requests = await app.evaluate(() => globalThis.__lociFinishNavigationRequests());
      report.elapsed_ms = performance.now() - started;
    }
    for (const operation of TWO_D_OPERATIONS)
      assert.equal(report.requests[operation], 0, `Navigation sent an unexpected ${operation} request`);
    report.total_input_interval_ms = Object.values(report.phases)
      .reduce((sum, phase) => sum + phase.interaction_duration_ms, 0);
    assert.ok(report.total_input_interval_ms >= 10_000, "Navigation did not sustain at least ten seconds of input");
  };
  try {
    await Promise.race([interact(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function runCase(electron, bundle, fixture, route, outputRoot, timeout, display) {
  const kind = route === "direct" ? "direct" : fixture.comparison;
  const directory = await fs.mkdtemp(path.join(outputRoot, `${route}-`));
  const report = {
    schema: "loci.packaged-volume-entry-qa/v1",
    started_at: new Date().toISOString(),
    status: "running",
    package: bundle,
    source: { path: fixture.source, sha256: fixture.sha256, dimensions_xyz: fixture.dimensions },
    expected_overview: fixture.publicKidney ? { allowed_grids_xyz: KIDNEY.overview, level: 0 } : fixture.expected,
    route, focus_span: fixture.span, requested_center_xyz: fixture.center,
    timing_basis: "Trusted renderer click to bound 3D and three MPR canvases followed by two animation frames",
    profile: "Isolated profile and processes for each route. OS file cache uncontrolled.",
    display_check: "Canvas brightness/variation and source binding. Native intensity fidelity requires an independent source run.",
    page_errors: [], renderer_http_requests: [],
  };
  if (fixture.publicKidney) {
    report.host = { platform: process.platform, arch: process.arch, os_release: os.release() };
    report.source.sha256_before = fixture.sha256;
    report.graphics = { electron: null, webgl: null, model_compute_exercised: false };
  }
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.PYTHONPATH;
  let app;
  let page;
  let sampler;
  const fail = (error) => {
    report.status = "failed";
    (report.failures ??= []).push(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  };
  try {
    app = await electron.launch({
      executablePath: bundle.executable,
      args: [`--user-data-dir=${path.join(directory, "profile")}`],
      env: environment,
      timeout,
    });
    page = await app.firstWindow({ timeout });
    page.setDefaultTimeout(timeout);
    page.on("pageerror", (error) => report.page_errors.push({
      at: new Date().toISOString(), stack: error.stack ?? error.message,
    }));
    page.on("request", (request) => {
      if (/^https?:/i.test(request.url())) report.renderer_http_requests.push(request.url());
    });
    // A 1024 × 720 work area can fit the Windows window at its full minimum size.
    const margin = fixture.publicKidney && process.platform === "win32" ? 0 : undefined;
    await placeQaWindow(app, { requestedDisplay: display, margin, launch: 1 }, report);
    await app.evaluate(({ dialog }, fixture) => {
      globalThis.__lociVolumeEntryPickers = [];
      dialog.showOpenDialog = async (...args) => {
        const { title, properties } = args.at(-1);
        globalThis.__lociVolumeEntryPickers.push({ title, properties });
        return title === fixture.title
          ? { canceled: false, filePaths: [fixture.source] }
          : { canceled: true, filePaths: [] };
      };
    }, { title: PICKERS[kind], source: fixture.source });
    await page.locator(".image-first-empty").waitFor();
    if (kind === "zarr") await page.getByRole("button", { name: "More opening options", exact: true }).click();
    const open = page.getByRole("button", { name: LAUNCH_BUTTONS[kind], exact: true });
    if (process.platform === "win32") {
      report.rss = { status: "unavailable", reason: "The QA process-tree sampler uses POSIX ps." };
    } else {
      sampler = await startProcessTreeRssSampler(app.process().pid, {
        intervalMs: 250, workerCommandIncludes: "/Resources/loci-engine/",
      });
    }

    await installObserver(page, fixture.sha256);
    await timedClick(open, "open");
    if (route === "direct" && fixture.expectPreview) {
      await waitForPhase(page, "preview", timeout);
      const preview = page.getByRole("region", { name: "Opening 3D preview" });
      const stage = preview.getByLabel("Interactive 3D preview");
      report.preview = await captureVolume(app, page, directory, "opening-preview", stage.locator("canvas"));
      assertSignal(report.preview, "Opening preview");
      await stage.press("ArrowRight");
      await preview.getByRole("button", { name: "XY slice", exact: true }).click();
      const slider = preview.getByRole("slider", { name: "Preview Z" });
      const previous = Number(await slider.inputValue());
      await slider.press("ArrowRight");
      assert.equal(Number(await slider.inputValue()), previous + 1);
      report.preview.xy = await captureVolume(app, page, directory, "opening-xy", preview.getByLabel("XY preview slice"));
      assertSignal(report.preview.xy, "Opening XY slice");
      await preview.getByRole("button", { name: "3D", exact: true }).click();
      if (fixture.navigate) {
        // The verified view may replace a preview while the researcher is rotating it.
        const canvas = stage.locator("canvas");
        const box = await canvas.boundingBox();
        assert.ok(box && box.width > 60 && box.height > 60);
        const x = box.x + box.width / 2, y = box.y + box.height / 2;
        await stage.focus();
        await page.mouse.move(x, y);
        await page.mouse.down();
        try {
          await page.mouse.move(x + 24, y + 16, { steps: 4 });
          await page.keyboard.press("Escape");
          await preview.waitFor({ state: "hidden" });
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        } finally {
          await page.mouse.up();
        }
        report.preview.dismissed_during_orbit = true;
      }
    }
    if (route === "comparison") {
      await waitForPhase(page, "2d", timeout);
      await timedClick(page.getByRole("button", { name: "3D volume", exact: true }), "enter3d");
    }
    const overview = await waitForPhase(page, "overview", timeout);
    report.overview = {
      ...(fixture.publicKidney ? validateKidneyOverview(overview.state)
        : validateVolumeState(overview.state, fixture.dimensions, { expected: fixture.expected })),
      renderer: overview,
    };
    const measureForeground = fixture.minInitialMipContrast !== null;
    if (measureForeground) {
      report.overview.minimum_specimen_contrast = fixture.minInitialMipContrast;
      report.overview.initial_rendering_mode = await page.getByRole("combobox", { name: "3D rendering mode" }).inputValue();
    }
    report.overview.image = await captureVolume(app, page, directory, "overview", undefined, { measureForeground });
    assertSignal(report.overview.image, "Overview");
    if (measureForeground) assertInitialMipContrast(report.overview, fixture.minInitialMipContrast);

    if (fixture.publicKidney) {
      const volume = page.locator(".raw-volume");
      for (const axis of AXES) await volume.getByRole("slider", { name: `${axis} slice`, exact: true }).press("Home");
      report.kidney_linked_mpr = {
        origin_check: {
          index_xyz: await sourcePosition(page, KIDNEY.dimensions, null),
          world_readout: await volume.locator(".raw-volume-world").textContent(),
        },
        displayed_scalar_components: await volume.locator('.raw-volume-channel input[aria-label$=" visible"]').count(),
      };
      assert.ok(report.kidney_linked_mpr.displayed_scalar_components >= 1 &&
        report.kidney_linked_mpr.displayed_scalar_components <= 3, "Wrong number of displayed scalar channel controls");
      assert.equal(2 * report.kidney_linked_mpr.displayed_scalar_components, report.overview.bytes_per_voxel_across_components,
        "Volume controls disagree with the overview's uint16 component count");
    }
    const center = await sourcePosition(page, fixture.dimensions, fixture.center);
    report.focus_center_xyz = center;
    await page.getByText("Rendering & detail", { exact: true }).click();
    await page.getByLabel("Detail span", { exact: true }).selectOption(fixture.span);
    await timedClick(page.getByRole("button", { name: "Detail at crosshair", exact: true }), "detail");
    const focus = await waitForPhase(page, "focus", timeout);
    report.detail = {
      ...validateVolumeState(focus.state, fixture.dimensions, {
        center, span: fixture.span, expected: fixture.publicKidney
          ? { dimensions: KIDNEY.overview.refined, level: 0, bytesPerVoxel: report.overview.bytes_per_voxel_across_components }
          : { bytesPerVoxel: fixture.expected.bytesPerVoxel },
      }),
      renderer: focus,
    };
    report.detail.image = await captureVolume(app, page, directory, "focus");
    assertSignal(report.detail.image, "Focus");
    assert.notEqual(report.detail.image.sha256, report.overview.image.sha256, "Focus reuses the overview image");
    if (fixture.minFocusWidth > 0) {
      assert.ok(report.detail.image.central_signal_width_fraction >= fixture.minFocusWidth,
        "The native focus occupies too little of the stage for this specimen");
      const xy = page.locator(AXIAL_CANVAS);
      report.detail.xy = await captureVolume(app, page, directory, "focus-xy", xy);
      assertSignal(report.detail.xy, "Native focus XY");
      const mode = page.getByRole("combobox", { name: "3D rendering mode" });
      const initialMode = await mode.inputValue();
      await mode.selectOption("mip");
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      report.detail.mip = await captureVolume(app, page, directory, "focus-mip");
      assertSignal(report.detail.mip, "Native focus maximum intensity");
      if (initialMode !== "mip") assert.notEqual(report.detail.image.sha256, report.detail.mip.sha256);
    }
    if (fixture.navigate) {
      report.navigation = {
        timing_basis: "Renderer requestAnimationFrame intervals during trusted input. Presentation rate is unmeasured.",
        input_step_delay_ms: NAVIGATION_STEP_MS,
        phases: {},
        captures: {},
      };
      await runBoundedNavigation(app, page, directory, fixture, center, report.detail, report.navigation);
    }
    if (fixture.publicKidney) {
      await checkKidneyLinkedSlice(app, page, directory, report.detail, report.kidney_linked_mpr, timeout);
    }
    if (fixture.repeatOpen) {
      report.marks = await page.evaluate(() => window.__lociVolumeEntry);
      report.same_session_reopens = [];
      for (let index = 0; index < fixture.repeatOpen; index++) {
        await page.locator("summary").filter({ hasText: /^File$/u }).click();
        await installObserver(page, fixture.sha256);
        await timedClick(page.getByRole("button", { name: LAUNCH_BUTTONS.direct, exact: true }), "open");
        const bound = await waitForPhase(page, "overview", timeout);
        validateVolumeState(bound.state, fixture.dimensions, { expected: fixture.expected });
        const marks = await page.evaluate(() => window.__lociVolumeEntry);
        assert.equal(marks.firstTwoDTile, null, "Reopen rendered an unexpected 2D tile");
        report.same_session_reopens.push({
          sequence: index + 1,
          first_interactive_ms: (marks.ready.preview?.time ?? bound.time) - marks.clicks.open,
          verified_overview_ms: bound.time - marks.clicks.open,
          first_was_preview: Boolean(marks.ready.preview?.time),
        });
      }
    }
    report.status = "passed";
  } catch (error) {
    fail(error);
    if (fixture.publicKidney && page && !page.isClosed()) {
      report.renderer_volume_status = await page.evaluate(() =>
        document.querySelector(".raw-volume-status")?.textContent?.trim() ?? null).catch(() => null);
    }
    await page?.screenshot({ path: path.join(directory, "failure.png"), timeout: 5_000 }).catch(() => {});
  } finally {
    try {
      if (page) report.marks ??= await page.evaluate(() => window.__lociVolumeEntry);
      if (app) report.pickers = await app.evaluate(() => globalThis.__lociVolumeEntryPickers);
      if (report.status === "passed") {
        const { clicks, ready, firstTwoDTile } = report.marks;
        const { overview, focus } = ready;
        report.timings_ms = {
          open_click_to_interactive_preview: ready.preview?.time === undefined ? null : ready.preview.time - clicks.open,
          open_click_to_rendered_overview: overview.time - clicks.open,
          enter_3d_click_to_rendered_overview: route === "comparison" ? overview.time - clicks.enter3d : null,
          detail_click_to_rendered_focus: focus.time - clicks.detail,
          open_click_to_first_2d_tile: firstTwoDTile === null ? null : firstTwoDTile - clicks.open,
        };
        assert.ok(Object.values(report.timings_ms).every((value) =>
          value === null || (Number.isFinite(value) && value >= 0)), "Missing trusted click or invalid timing");
        assert.equal(firstTwoDTile === null, route === "direct", "2D tile activity disagrees with the entry route");
        assert.deepEqual(report.pickers.map(({ title }) => title), Array(1 + fixture.repeatOpen).fill(PICKERS[kind]));
        if (fixture.comparison === "zarr")
          assert.ok(report.pickers[0].properties.includes("openDirectory"), "Picker could not select a Zarr directory");
        assert.deepEqual(report.renderer_http_requests, []);
      }
    } catch (error) {
      fail(error);
    }
    if (sampler) {
      try { report.rss = await sampler.stop(); } catch (error) { fail(error); }
    }
    if (app) {
      if (fixture.publicKidney) report.graphics = await recordVolumeGraphics(app, page);
      try { await app.close(); } catch (error) { fail(error); }
    }
    if (fixture.publicKidney) {
      try {
        report.source.sha256_after = await sha256(fixture.source);
        assert.equal(report.source.sha256_after, fixture.sha256, "Public kidney fixture changed during the journey");
      } catch (error) { fail(error); }
    }
    if (report.page_errors.length) fail(new Error("Uncaught renderer exception during the volume journey"));
    report.completed_at = new Date().toISOString();
    await fs.writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(`${report.status}: ${path.join(directory, "report.json")}`, report.timings_ms ?? report.failures);
  }
}

async function main(args) {
  const { values } = parseArgs({ args, options: {
    app: { type: "string" }, out: { type: "string" }, cases: { type: "string" },
    source: { type: "string" }, sha256: { type: "string" }, dimensions: { type: "string" },
    center: { type: "string" }, span: { type: "string" }, route: { type: "string" },
    "overview-dimensions": { type: "string" }, "overview-level": { type: "string" },
    "bytes-per-voxel": { type: "string" },
    "expect-preview": { type: "boolean" }, "min-focus-width": { type: "string" }, "repeat-open": { type: "string" },
    "min-initial-mip-contrast": { type: "string" },
    "public-kidney": { type: "boolean" },
    navigate: { type: "boolean" },
    "timeout-ms": { type: "string" }, display: { type: "string" }, help: { type: "boolean" },
  } });
  if (values.help) { console.log(usage); return; }
  if (values.cases) {
    assert.ok(["source", "sha256", "dimensions", "center", "span", "route",
      "overview-dimensions", "overview-level", "bytes-per-voxel", "expect-preview", "min-focus-width", "repeat-open",
      "min-initial-mip-contrast", "navigate", "public-kidney"]
      .every((key) => values[key] === undefined), "Use --cases or single-source options");
  }
  const bundlePath = values.app ?? process.env.LOCI_PACKAGED_APP;
  const outputRoot = values.out ?? process.env.LOCI_QA_OUTPUT_ROOT;
  assert.ok(path.isAbsolute(bundlePath ?? "") && path.isAbsolute(outputRoot ?? ""), usage);
  let cases = values.cases ? JSON.parse(await fs.readFile(values.cases, "utf8")) : [values];
  if (values["public-kidney"]) {
    assert.ok(Object.keys(values).every((key) =>
      ["app", "out", "public-kidney", "source", "route", "timeout-ms", "display"].includes(key)),
      "Use only --source, --route and runner options with --public-kidney.");
    cases = [{ ...values, sha256: KIDNEY.sha256, dimensions: KIDNEY.dimensions, center: KIDNEY.center }];
  }
  assert.ok(Array.isArray(cases) && cases.length > 0, "Supply a nonempty fixture array");
  const [timeout] = vector([values["timeout-ms"] ?? 180_000], 1, 1, "timeout");
  const [bundle, fixtures] = await Promise.all([inspectBundle(bundlePath), Promise.all(cases.map(caseSettings))]);
  await fs.mkdir(outputRoot, { recursive: true });
  const { _electron: electron } = await import("playwright");
  for (const fixture of fixtures) {
    for (const route of fixture.routes)
      await runCase(electron, bundle, fixture, route, outputRoot, timeout, values.display ?? process.env.LOCI_QA_DISPLAY);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
}
