/** Synthetic, pixel-identified Z baseline and regression journey. No protected images. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { _electron as electron } from "playwright";
import { measureRafDuring } from "./navigation-performance-qa-helpers.mjs";
const run = promisify(execFile);
const repository = path.resolve(import.meta.dirname, "../..");
const bundle = process.env.LOCI_PACKAGED_APP;
assert.ok(bundle, "Set LOCI_PACKAGED_APP to an identified macOS candidate");
const root = path.join(process.env.LOCI_QA_OUTPUT_ROOT ?? path.join(repository, ".loci/evidence/qa/plane-navigation"),
  new Date().toISOString().replaceAll(/[:.]/g, "-"));
await fs.mkdir(root, { recursive: true });
async function hash(file) { const h = createHash("sha256"); for await (const chunk of createReadStream(file)) h.update(chunk); return h.digest("hex"); }
const fixture = path.join(root, "synthetic-plane-identities.ome.tif");
const generator = path.join(root, "fixture.py");
await fs.writeFile(generator, `import numpy as np\nimport tifffile\na=np.empty((24,1024,1024),dtype=np.uint16)\nfor z in range(24):\n a[z]=20+8*z\n a[z,:128,:128]=250\ntifffile.imwrite(${JSON.stringify(fixture)},a,tile=(256,256),compression='zlib',ome=True,photometric='minisblack',metadata={'axes':'ZYX','PhysicalSizeX':0.5,'PhysicalSizeXUnit':'µm','PhysicalSizeY':0.75,'PhysicalSizeYUnit':'µm','PhysicalSizeZ':2,'PhysicalSizeZUnit':'µm'})\n`);
await run(path.join(repository, "engine/.venv/bin/python"), [generator]);
const identity = { executable: await hash(path.join(bundle, "Contents/MacOS/Loci")),
  asar: await hash(path.join(bundle, "Contents/Resources/app.asar")),
  worker: await hash(path.join(bundle, "Contents/Resources/loci-engine/loci-engine")),
  harness: await hash(import.meta.filename), fixture: await hash(fixture) };
const app = await electron.launch({ executablePath: path.join(bundle, "Contents/MacOS/Loci"),
  args: [`--user-data-dir=${path.join(root, "user-data")}`], cwd: path.join(repository, "desktop"), timeout: 120000 });
const page = await app.firstWindow();
const errors = []; page.on("pageerror", (e) => errors.push(e.message));
const report = { kind: "synthetic packaged plane navigation; 1024x1024x24; fixed linear white LUT", identity, samples: [], errors };
try {
  await app.evaluate(({ dialog, BrowserWindow }, fixture) => {
    BrowserWindow.getAllWindows()[0].setBounds({ x: 20, y: 40, width: 1280, height: 900 });
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixture] });
  }, fixture);
  await page.getByRole("button", { name: "Open images", exact: true }).click();
  await page.getByLabel("Z plane", { exact: true }).waitFor({ timeout: 60000 });
  const channel = page.locator(".source-channel").first();
  if (await channel.count()) await channel.evaluate((node) => { node.open = true; });
  // Set the UI's actual transfer curve; expected centre pixels are 20 + 8*Z.
  for (const [label, value] of [["Channel 1 low", "0"], ["Channel 1 high", "255"]]) {
    const node = page.getByLabel(label, { exact: true });
    if (!await node.isVisible()) await page.locator("details").filter({ has: node }).evaluate((item) => { item.open = true; });
    await node.fill(value); await node.press("Tab");
  }
  await page.getByLabel("Channel 1 color", { exact: true }).fill("#ffffff");
  await page.waitForFunction(() => {
    const c = document.querySelector(".image-viewport canvas");
    if (!c) return false;
    const p = c.getContext("2d").getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
    return [0, 1, 2].every((i) => Math.abs(p[i] - 20) <= 1);
  }, undefined, { timeout: 30000 });
  await page.evaluate(() => {
    window.__planeLongTasks = [];
    new PerformanceObserver(list => {
      window.__planeLongTasks.push(...list.getEntries().map(entry => ({ start: entry.startTime, duration: entry.duration })));
    }).observe({ type: "longtask", buffered: false });
  });
  const profiling = process.env.LOCI_QA_PROFILE === "1";
  report.profiling = profiling;
  report.input_measurement = "controlled slider/output observed at RAF before synchronous pixel readback; original combined duration retained per sample";
  assert.ok(!profiling || process.env.LOCI_QA_QUALIFY !== "1", "Profiling is diagnostic, not qualification");
  const profiler = profiling ? await page.context().newCDPSession(page) : null;
  if (profiler) { await profiler.send("Profiler.enable"); await profiler.send("Profiler.start"); }
  async function moveAndMeasure(z, phase) {
    return page.evaluate(async ({ z, phase }) => {
      const slider = document.querySelector('input[aria-label="Z plane"]');
      const start = performance.now();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(slider, String(z));
      slider.dispatchEvent(new Event("input", { bubbles: true }));
      const dispatchMs = performance.now() - start;
      const expected = 20 + 8 * z;
      return new Promise((resolve, reject) => {
        let inputMs = null, inputWithReadbackMs = null, stalePreparedFrames = 0, frames = 0;
        const frameDiagnostics = [];
        function tick() {
          const frameStart = performance.now();
          const viewer = document.querySelector(".image-viewport");
          const c = viewer.querySelector("canvas");
          // Time the controlled slider/output at the animation-frame boundary BEFORE
          // the pixel oracle forces a synchronous GPU readback. Retain that older
          // combined metric separately; it is not input feedback latency.
          const selected = slider.closest("label").querySelector("output")?.textContent?.startsWith(`${z + 1} /`);
          if (selected && inputMs === null) inputMs = performance.now() - start;
          const readbackStart = performance.now();
          const pixel = [...c.getContext("2d").getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data].slice(0, 3);
          const elapsed = performance.now() - start;
          if (frames < 3) frameDiagnostics.push({ raf_entry_ms: frameStart - start, readback_ms: performance.now() - readbackStart });
          if (selected && inputWithReadbackMs === null) inputWithReadbackMs = elapsed;
          const matched = pixel.every((value) => Math.abs(value - expected) <= 1);
          if (!matched && viewer.dataset.prepared === "true") stalePreparedFrames++;
          if (matched && inputMs !== null) resolve({ z, phase, input_ms: inputMs, settled_pixel_ms: elapsed, pixel, frames,
            dispatch_ms: dispatchMs, input_including_readback_ms: inputWithReadbackMs, first_frames: frameDiagnostics,
            stale_prepared_frames: stalePreparedFrames, cache_bytes: Number(viewer.dataset.cacheBytes) });
          else if (elapsed > 15000) reject(new Error(`Plane ${z} never reached expected pixel ${expected}; got ${pixel}`));
          else { frames++; requestAnimationFrame(tick); }
        }
        requestAnimationFrame(tick);
      });
    }, { z, phase });
  }
  report.coldFrames = await measureRafDuring(page, "cold sequential planes", async () => {
    for (let z = 1; z <= 8; z++) report.samples.push(await moveAndMeasure(z, "cold"));
  });
  if (profiler) {
    const { profile } = await profiler.send("Profiler.stop");
    await fs.writeFile(path.join(root, "cold-navigation.cpuprofile"), JSON.stringify(profile));
    await profiler.detach();
  }
  report.repeatFrames = await measureRafDuring(page, "repeat planes (cache observed, not assumed)", async () => {
    for (let z = 7; z >= 1; z--) report.samples.push(await moveAndMeasure(z, "repeat"));
  });
  report.longTasks = await page.evaluate(() => window.__planeLongTasks);
  await page.screenshot({ path: path.join(root, "repeat-plane.png") });

  // Rapid traversal: scrub rapidly through several planes and verify exact final plane pixels & readiness
  report.rapidTraversal = await page.evaluate(async () => {
    const slider = document.querySelector('input[aria-label="Z plane"]');
    const viewer = document.querySelector(".image-viewport");
    const c = viewer.querySelector("canvas");
    let stalePreparedFrames = 0;
    const start = performance.now();
    const targetZ = 16;
    for (let z = 2; z <= targetZ; z++) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(slider, String(z));
      slider.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise(requestAnimationFrame);
      const selected = Number(slider.value);
      const pixel = c.getContext("2d").getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
      if (viewer.dataset.prepared === "true" && [0, 1, 2].some(i => Math.abs(pixel[i] - (20 + 8 * selected)) > 1)) stalePreparedFrames++;
    }
    const inputDurationMs = performance.now() - start;
    const expected = 20 + 8 * targetZ;

    return new Promise((resolve, reject) => {
      let frames = 0;
      function tick() {
        const pixel = [...c.getContext("2d").getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data].slice(0, 3);
        const elapsed = performance.now() - start;
        const matched = pixel.every((value) => Math.abs(value - expected) <= 1);
        if (!matched && viewer.dataset.prepared === "true") stalePreparedFrames++;
        if (matched && viewer.dataset.prepared === "true") {
          resolve({
            target_z: targetZ,
            input_duration_ms: inputDurationMs,
            settled_pixel_ms: elapsed,
            pixel,
            frames,
            stale_prepared_frames: stalePreparedFrames,
            cache_bytes: Number(viewer.dataset.cacheBytes),
          });
        } else if (elapsed > 15000) {
          reject(new Error(`Rapid traversal to plane ${targetZ} never reached expected pixel ${expected}; got ${pixel}`));
        } else {
          frames++;
          requestAnimationFrame(tick);
        }
      }
      requestAnimationFrame(tick);
    });
  });
  await page.screenshot({ path: path.join(root, "rapid-plane.png") });

  // Real scientific input: a new uncached plane must reject point placement until it paints.
  await page.getByRole("button", { name: "Annotate", exact: true }).click();
  await page.getByRole("button", { name: "Point", exact: true }).click();
  const canvas = page.locator(".image-viewport canvas");
  const box = await canvas.boundingBox();
  await page.evaluate(() => {
    window.__planePointerEvidence = [];
    const viewer = document.querySelector(".image-viewport");
    viewer.addEventListener("pointerdown", () => window.__planePointerEvidence.push({
      phase: "down", prepared: viewer.dataset.prepared,
    }), true);
    viewer.addEventListener("pointerup", () => window.__planePointerEvidence.push({
      phase: "up", prepared: viewer.dataset.prepared,
    }), true);
  });
  await page.getByLabel("Z plane", { exact: true }).fill("22");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const pointerEvidence = await page.evaluate(() => window.__planePointerEvidence);
  assert.ok(pointerEvidence.some(event => event.prepared === "false"), "Must actually attempt a gesture during loading");
  await page.waitForFunction(() => document.querySelector(".image-viewport").dataset.prepared === "true");
  assert.equal(await page.getByRole("button", { name: "Save annotation", exact: true }).isEnabled(), false,
    "A gesture begun against stale pixels must not become an annotation");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.getByRole("button", { name: "Save annotation", exact: true }).click();
  await page.getByText("1 saved", { exact: true }).waitFor();
  const annotation = await page.evaluate(async () => {
    const snapshot = await window.lociResearch.getSnapshot();
    return window.lociResearch.execute("source_annotations", { source_id: snapshot.sources[0].id });
  });
  assert.equal(annotation.annotations.length, 1);
  assert.equal(annotation.annotations[0].z, 22);
  assert.equal(annotation.annotations[0].t, 0);
  report.annotation = { pointerEvidence, saved: annotation.annotations[0] };
  await page.screenshot({ path: path.join(root, "annotation-after-settle.png") });

  const percentile = (values) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
  report.p95 = Object.fromEntries(["cold", "repeat"].map((phase) => {
    const rows = report.samples.filter((entry) => entry.phase === phase);
    return [phase, { input_ms: percentile(rows.map((entry) => entry.input_ms)),
      settled_pixel_ms: percentile(rows.map((entry) => entry.settled_pixel_ms)) }];
  }));

  const allStalePrepared = report.samples.reduce((acc, s) => acc + (s.stale_prepared_frames || 0), 0) +
    (report.rapidTraversal?.stale_prepared_frames || 0);
  const maxCacheBytes = Math.max(...report.samples.map((s) => s.cache_bytes || 0), report.rapidTraversal?.cache_bytes || 0);

  report.diagnostics = {
    total_stale_prepared_frames: allStalePrepared,
    max_observed_cache_bytes: maxCacheBytes,
    cache_bound_ok: maxCacheBytes <= 64 * 1024 * 1024,
    rapid_settled_pixel_ms: report.rapidTraversal?.settled_pixel_ms,
  };

  if (process.env.LOCI_QA_QUALIFY === "1") {
    report.qualification = {
      p95_input_target_ms: 50,
      p95_settled_target_ms: 1000,
      meets_p95_cold_input: report.p95.cold.input_ms <= 50,
      meets_p95_repeat_input: report.p95.repeat.input_ms <= 50,
      meets_p95_cold_settled: report.p95.cold.settled_pixel_ms <= 1000,
      zero_stale_prepared: allStalePrepared === 0,
      cache_bounded: Number.isFinite(maxCacheBytes) && maxCacheBytes <= 64 * 1024 * 1024,
    };
    for (const [name, value] of Object.entries(report.qualification)) {
      if (typeof value === "boolean") assert.equal(value, true, `Qualification failed: ${name}`);
    }
  }

  report.status = process.env.LOCI_QA_QUALIFY === "1" ? "passed" : "observed";
  assert.equal(errors.length, 0);
} catch (error) {
  report.status = "failed"; report.failure = String(error);
  await page.screenshot({ path: path.join(root, "failure.png") }).catch(() => {});
  process.exitCode = 1;
} finally {
  await fs.writeFile(path.join(root, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await app.close();
}
console.log(JSON.stringify({ root, status: report.status, p95: report.p95, failure: report.failure }));
