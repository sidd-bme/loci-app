// Run from desktop with an installed Chrome: node --test tests/smooth-source-tiles.qa.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { build } from "vite";

test("smooth tile joins match a contiguous raster on the same browser canvas", async (t) => {
  const bundle = await build({
    configFile: false, logLevel: "silent",
    build: { write: false, minify: false, lib: {
      entry: fileURLToPath(new URL("../src/renderer/smooth-source-tiles.ts", import.meta.url)),
      name: "tileSampling", formats: ["iife"],
    } },
  });
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const page = await browser.newPage();
    await page.addScriptTag({ content: bundle[0].output[0].code });
    const results = await page.evaluate(async () => {
      const canvas = (width, height) => Object.assign(document.createElement("canvas"), { width, height });
      const source = canvas(530, 531);
      const sourceContext = source.getContext("2d");
      // High contrast across both 512-pixel boundaries and partial alpha at
      // the join expose missing interpolation or double compositing.
      sourceContext.fillStyle = "#03170e";
      sourceContext.fillRect(0, 0, 512, 512);
      sourceContext.fillStyle = "#fb2d70";
      sourceContext.fillRect(512, 0, 18, 512);
      sourceContext.fillStyle = "#248ffc";
      sourceContext.fillRect(0, 512, 512, 19);
      sourceContext.fillStyle = "rgba(130,255,90,0.6)";
      sourceContext.fillRect(512, 512, 18, 19);
      const whole = await createImageBitmap(source);
      const tiles = new Map();
      for (const y of [0, 512]) for (const x of [0, 512]) {
        const width = Math.min(512, source.width - x), height = Math.min(512, source.height - y);
        const tile = { key: `0:${x}:${y}`, x, y, width, height, level: 0,
          left: x, top: y, sourceWidth: width, sourceHeight: height };
        tiles.set(tile.key, { tile, image: await createImageBitmap(source, x, y, width, height) });
      }
      const results = [];
      for (const [scaleX, scaleY, dpr, seamX, seamY] of [
        [4, 4, 1, 11, 9], [3.25, 2.625, 1, 11.35, 9.7], [1.75, 2.25, 2, 7.43, 9.24],
        [0.65, 0.55, 1, 13.4, 10.8], [2, 0.55, 1, 13.4, 10.8],
      ]) {
        const reference = canvas(128, 128), candidate = canvas(128, 128);
        const target = candidate.getContext("2d"), original = reference.getContext("2d");
        const ox = seamX - 512 * scaleX, oy = seamY - 512 * scaleY;
        for (const ctx of [original, target]) {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.fillStyle = "#25393d";
          ctx.fillRect(0, 0, 128, 128);
        }
        original.drawImage(whole, ox, oy, source.width * scaleX, source.height * scaleY);
        const scratch = { current: null };
        for (const item of tiles.values()) {
          const { tile } = item;
          tileSampling.drawSmoothSourceTile(target, item, tiles, scratch,
            ox + tile.x * scaleX, oy + tile.y * scaleY, tile.width * scaleX, tile.height * scaleY, dpr);
        }
        const expected = original.getImageData(0, 0, 128, 128).data;
        const actual = target.getImageData(0, 0, 128, 128).data;
        let maxDifference = 0, differentChannels = 0, changedBackgroundPixels = 0;
        for (let i = 0; i < expected.length; i++) {
          const difference = Math.abs(expected[i] - actual[i]);
          maxDifference = Math.max(difference, maxDifference);
          if (difference) differentChannels++;
        }
        for (let i = 0; i < expected.length; i += 4) {
          if (expected[i] === 37 && expected[i + 1] === 57 && expected[i + 2] === 61 &&
              (actual[i] !== 37 || actual[i + 1] !== 57 || actual[i + 2] !== 61)) changedBackgroundPixels++;
        }
        results.push({ scaleX, scaleY, dpr, maxDifference, differentChannels, changedBackgroundPixels });
      }
      // A missing lower-right tile stays empty, even while drawing the
      // adjacent colored borders. A different pyramid level cannot fill it.
      const sparse = new Map(tiles);
      const missing = sparse.get("0:512:512");
      sparse.delete("0:512:512");
      sparse.set("1:512:512", { ...missing, tile: { ...missing.tile, key: "1:512:512", level: 1 } });
      const incomplete = canvas(32, 32).getContext("2d");
      const scratch = { current: null };
      for (const item of tiles.values()) {
        const t = item.tile;
        if (!sparse.has(t.key)) continue;
        tileSampling.drawSmoothSourceTile(incomplete, item, sparse, scratch,
          12 + 4 * (t.x - 512), 12 + 4 * (t.y - 512), 4 * t.width, 4 * t.height, 1);
      }
      const hole = incomplete.getImageData(12, 12, 20, 20).data;
      return { samples: results, holeEmpty: hole.every(value => value === 0),
        neighborAlpha: incomplete.getImageData(11, 13, 1, 1).data[3] };
    });
    t.diagnostic(JSON.stringify({ chrome: browser.version(), ...results }));
    assert.equal(results.holeEmpty, true);
    assert.equal(results.neighborAlpha, 255);
    for (const result of results.samples) {
      // Fractional device coordinates can round a linear interpolation by one
      // 8-bit step when Skia evaluates it in tile-local coordinates.
      assert.ok(result.maxDifference <= 1, JSON.stringify(result));
      assert.equal(result.changedBackgroundPixels, 0, JSON.stringify(result));
    }
  } finally {
    await browser.close();
  }
});
