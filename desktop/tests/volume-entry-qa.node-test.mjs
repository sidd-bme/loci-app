import assert from "node:assert/strict";
import test from "node:test";

import {
  assertNavigationFocus,
  assertRecoveredMprRaster,
  centralSignal,
  focusExtentXYZ,
  focusSlicePositions,
  observeNavigationRequests,
  validateVolumeState,
} from "./volume-entry.qa.mjs";

const embryo = [2169, 2048, 988];
const center = [992, 672, 528];
const overview = {
  contextDimensions: "128x121x58",
  contextLevel: "4",
  contextByteLength: "3593216",
};

test("the wide detail window uses exact level-zero XYZ and clips at image edges", () => {
  assert.deepEqual(focusExtentXYZ(embryo, center, "wide"), [864, 1119, 544, 799, 496, 559]);
  assert.deepEqual(focusExtentXYZ([512, 512, 16], [0, 511, 12], "64"), [0, 63, 448, 511, 0, 15]);
});

test("the overview check binds known display dimensions, level and encoding", () => {
  const expected = { dimensions: [128, 121, 58], level: 4, bytesPerVoxel: 4 };
  const validated = validateVolumeState(overview, embryo, { expected });
  assert.equal(validated.context.byte_length, 3593216);
  assert.throws(() => validateVolumeState({ ...overview, contextDimensions: "121x128x58" },
    embryo, { expected }), /Wrong overview display dimensions/);
  assert.throws(() => validateVolumeState({ ...overview, contextByteLength: "1796608" },
    embryo, { expected }), /Wrong component encoding/);
});

test("native focus refuses wrong extents, resampled steps, wrong bytes and budget overruns", () => {
  const state = {
    ...overview,
    focusExtent: "864,1119,544,799,496,559",
    focusByteLength: "16777216",
    focusNativeSteps: "true",
  };
  const inputs = { center, span: "wide" };
  const valid = validateVolumeState(state, embryo, inputs);
  assert.deepEqual(valid.focus.displayed_dimensions_xyz, [256, 256, 64]);
  for (const [alteration, expectedError] of [
    [{ focusExtent: "865,1120,544,799,496,559" }, /Wrong level-zero focus extent/],
    [{ focusNativeSteps: "false" }, /consecutive native indices/],
    [{ focusByteLength: "8388608" }, /Focus bytes disagree/],
    [{ contextDimensions: "256x256x128", contextByteLength: "33554432" }, /aggregate budget/],
  ]) {
    assert.throws(() => validateVolumeState({ ...state, ...alteration }, embryo, inputs), expectedError);
  }
});

test("the screenshot check ignores a bright corner and recognizes central tonal variation", () => {
  const width = 20;
  const height = 20;
  const bitmap = Buffer.alloc(width * height * 4);
  bitmap[0] = 255;
  assert.deepEqual(centralSignal(bitmap, width, height), {
    distinct_maximum_intensities: 1, central_signal_fraction: 0,
    central_signal_width_fraction: 0, central_signal_height_fraction: 0,
  });
  for (let x = 4; x < 16; x += 1) bitmap[(10 * width + x) * 4] = 30 + x;
  const signal = centralSignal(bitmap, width, height);
  assert.equal(signal.distinct_maximum_intensities, 13);
  assert.ok(signal.central_signal_fraction > 0.002);
  assert.equal(signal.central_signal_width_fraction, 0, "A one-pixel line does not count as occupied tissue");
  for (let y = 6; y < 15; y++) for (let x = 4; x < 16; x++) bitmap[(y * width + x) * 4] = 40 + x;
  assert.equal(centralSignal(bitmap, width, height).central_signal_width_fraction, 12 / width);
});

test("sustained XY navigation steps by native Z through narrow or edge-clipped focus", () => {
  for (const [z, extent, first, last] of [
    [528, [864, 1119, 544, 799, 496, 559], 527, 523],
    [0, [0, 63, 0, 63, 0, 1], 1, 1],
    [63, [0, 63, 0, 63, 0, 63], 62, 58],
  ]) {
    const positions = focusSlicePositions(z, extent);
    assert.equal(positions.length, 29);
    assert.equal(positions[0], first);
    assert.equal(positions.at(-1), last);
    for (const [index, position] of positions.entries()) {
      assert.ok(position >= extent[4] && position <= extent[5]);
      assert.equal(Math.abs(position - (index === 0 ? z : positions[index - 1])), 1);
    }
  }
  assert.throws(() => focusSlicePositions(0, [0, 63, 0, 63, 0, 0]), /two focused Z slices/);
  assert.throws(() => focusSlicePositions(2, [0, 63, 0, 63, 0, 1]), /two focused Z slices/);
});

test("navigation recovery must keep the registered source, native focus, and crosshair", () => {
  const state = {
    sourceId: "1".repeat(32),
    sourceSha256: "2".repeat(64),
    activeView: "level-zero-focus",
    focusExtent: "864,1119,544,799,496,559",
    focusByteLength: "16777216",
    focusNativeSteps: "true",
  };
  const verify = (current, position = center) =>
    assertNavigationFocus(current, state, state.sourceSha256, position, center);
  assert.doesNotThrow(() => verify({ ...state }));
  for (const [alteration, reason] of [
    [{ sourceId: undefined }, /registered source/],
    [{ sourceId: "3".repeat(32) }, /switched the registered source/],
    [{ sourceSha256: "4".repeat(64) }, /bound source fingerprint/],
    [{ activeView: "whole-volume-context" }, /left native focus/],
    [{ focusExtent: "865,1120,544,799,496,559" }, /changed focusExtent/],
    [{ focusByteLength: "8388608" }, /changed focusByteLength/],
    [{ focusNativeSteps: "false" }, /changed focusNativeSteps/],
  ]) {
    assert.throws(() => verify({ ...state, ...alteration }), reason);
  }
  assert.throws(() => verify(state, [992, 672, 529]), /different source coordinate/);
});

test("navigation request counting retains the original wrapped IPC handler and arguments", async () => {
  const channel = "loci-research:execute";
  const event = { sender: "packaged-workbench" };
  const request = { source_id: "source" };
  const options = { lane: "focus" };
  const permissionFailure = new Error("Denied by the original handler");
  const original = async (...args) => {
    if (args[1] === "view") throw permissionFailure;
    return args;
  };
  const handlers = new Map([[channel, original]]);
  const ipcMain = {
    _invokeHandlers: handlers,
    handle: (key, handler) => handlers.set(key, handler),
    removeHandler: (key) => handlers.delete(key),
  };
  await observeNavigationRequests({ evaluate: (callback, operations) => callback({ ipcMain }, operations) });
  let counts;
  try {
    const invoke = handlers.get(channel);
    assert.deepEqual(await invoke(event, "viewer_volume", request, options),
      [event, "viewer_volume", request, options]);
    await assert.rejects(invoke(event, "view", request), permissionFailure);
    await invoke(event, "viewer_tile", request);
    await invoke(event, "update_view_document", request);
  } finally {
    counts = globalThis.__lociFinishNavigationRequests();
  }
  assert.deepEqual(counts, { view: 1, result_view: 0, viewer_tile: 1, viewer_volume: 1 });
  assert.equal(handlers.get(channel), original);
});

test("MPR recovery compares exact backing pixels and render settings across CSS sizes", () => {
  const raster = {
    render_binding: ["a".repeat(64), "axial", [3, 4, 5], [{ channel_index: 0 }], null, null, null],
    dimensions_xy: [256, 256],
    rgba_sha256: "b".repeat(64),
  };
  const before = { viewport_pixels: { width: 240, height: 240 }, raster };
  const recovered = { viewport_pixels: { width: 234, height: 234 }, raster: structuredClone(raster) };
  assert.doesNotThrow(() => assertRecoveredMprRaster(recovered.raster, before.raster));
  recovered.raster.render_binding[2][2] += 1;
  assert.throws(() => assertRecoveredMprRaster(recovered.raster, before.raster), /world position/);
  recovered.raster = { ...raster, dimensions_xy: [234, 234] };
  assert.throws(() => assertRecoveredMprRaster(recovered.raster, before.raster), /raster dimensions/);
  recovered.raster = { ...raster, rgba_sha256: "c".repeat(64) };
  assert.throws(() => assertRecoveredMprRaster(recovered.raster, before.raster), /RGBA pixels/);
});
