import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { _electron as electron } from "playwright";
import { selectWorkbenchTool } from "./workbench-qa-helpers.mjs";

const desktopRoot = path.resolve(import.meta.dirname, "..");
const projectRoot = path.resolve(desktopRoot, "..");
for (const name of [
  "LOCI_PACKAGED_APP",
  "LOCI_QA_IMAGE",
  "LOCI_QA_OUTPUT_ROOT",
])
  assert.ok(
    process.env[name],
    `${name} is required; no empty-study or old-app fallback`,
  );
const appBundle = path.resolve(process.env.LOCI_PACKAGED_APP);
const fixture = path.resolve(process.env.LOCI_QA_IMAGE);
await fs.access(fixture);
const publicInput = process.env.LOCI_QA_CHROME_PUBLIC_INPUT
  ? JSON.parse(await fs.readFile(process.env.LOCI_QA_CHROME_PUBLIC_INPUT, "utf8")) : null;
const runRoot = path.join(
  path.resolve(process.env.LOCI_QA_OUTPUT_ROOT),
  new Date().toISOString().replaceAll(":", "-"),
);
await fs.mkdir(runRoot, { recursive: true });
const hash = async (file) =>
  createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex");
const git = (...args) =>
  execFileSync("git", args, { cwd: projectRoot, encoding: "utf8" }).trim();
const report = {
  schema: "loci.workbench-chrome-qa/v1",
  status: "running",
  started_at: new Date().toISOString(),
  source: {
    head: git("rev-parse", "HEAD"),
    desktop_tree: git("rev-parse", "HEAD:desktop"),
    status: git("status", "--short"),
    harness_sha256: await hash(import.meta.filename),
  },
  app: {
    path: appBundle,
    executable_sha256: await hash(path.join(appBundle, "Contents/MacOS/Loci")),
    asar_sha256: await hash(
      path.join(appBundle, "Contents/Resources/app.asar"),
    ),
    worker_sha256: await hash(
      path.join(appBundle, "Contents/Resources/loci-engine/loci-engine"),
    ),
  },
  fixture: { path: fixture, sha256: await hash(fixture) },
  cases: [],
  screenshots: [],
};
if (publicInput) {
  assert.equal(report.fixture.sha256, publicInput.source_sha256);
  assert.equal(publicInput.interpretation, "Public phase microscopy with independent raw measurement oracle");
  report.public_input = { ...publicInput, manifest_sha256: await hash(process.env.LOCI_QA_CHROME_PUBLIC_INPUT) };
}
let app, page, failure;
const save = () =>
  fs.writeFile(
    path.join(runRoot, "receipt.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
const capture = async (name) => {
  const file = name + ".png";
  await page.screenshot({ path: path.join(runRoot, file) });
  report.screenshots.push(file);
};
const frame = () =>
  page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
async function focusVisible(locator, label, body = false) {
  const result = await locator.evaluate((el) => {
    const r = el.getBoundingClientRect(),
      h = document.querySelector(".workbench-tools").getBoundingClientRect();
    const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    const cs = getComputedStyle(el);
    // Text fields intentionally draw the two-pixel focus ring inside their
    // boundary: a one-pixel accent border plus one-pixel inset shadow. Verify
    // that exact visible treatment as well as the external outline used by
    // buttons/selects; requiring outline alone rejects a visible focus ring.
    const shadowColor = cs.boxShadow.match(/rgba?\([^)]+\)/)?.[0];
    const insetFieldRing = el.matches('input:not([type="range"]):not([type="checkbox"]):not([type="color"]):focus-visible') &&
      /0px 0px 0px 1px inset/.test(cs.boxShadow) && shadowColor &&
      ['Top', 'Right', 'Bottom', 'Left'].every(side => cs[`border${side}Style`] === 'solid' &&
        parseFloat(cs[`border${side}Width`]) >= 1 && cs[`border${side}Color`] === shadowColor) &&
      shadowColor !== cs.backgroundColor && !shadowColor.endsWith(', 0)');
    return {
      focused: document.activeElement === el,
      top: r.top,
      bottom: r.bottom,
      headerBottom: h.bottom,
      height: innerHeight,
      hit: Boolean(at && (el === at || el.contains(at))),
      outline: cs.outlineStyle,
      outlineWidth: parseFloat(cs.outlineWidth),
      insetFieldRing: Boolean(insetFieldRing),
      boxShadow: cs.boxShadow,
    };
  });
  assert.ok(
    result.focused &&
      result.hit &&
      result.top >= 0 &&
      result.bottom <= result.height,
    `${label}: focused control obscured: ${JSON.stringify(result)}`,
  );
  if (body)
    assert.ok(
      result.top >= result.headerBottom,
      `${label}: control lies under task header: ${JSON.stringify(result)}`,
    );
  assert.ok(
    (result.outline !== "none" && result.outlineWidth >= 1.5) || result.insetFieldRing,
    `${label}: keyboard focus has no visible ring: ${JSON.stringify(result)}`,
  );
  return result;
}
try {
  app = await electron.launch({
    executablePath: path.join(appBundle, "Contents/MacOS/Loci"),
    args: [`--user-data-dir=${path.join(runRoot, "user-data")}`],
    cwd: desktopRoot,
    timeout: 60_000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(30_000);
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
    dialog.showMessageBox = async () => ({
      response: 0,
      checkboxChecked: false,
    });
  }, fixture);
  await page.getByRole("button", { name: "Open images", exact: true }).click();
  await page.getByRole("main", { name: "Research workspace" }).waitFor();
  await selectWorkbenchTool(page, "Analyze");
  const opaque = () =>
    page.locator(".workbench-tools").evaluate((el) => {
      const cs = getComputedStyle(el),
        c = cs.backgroundColor
          .match(/rgba?\(([^)]+)\)/)?.[1]
          .split(",")
          .map(Number);
      return {
        color: cs.backgroundColor,
        opacity: cs.opacity,
        opaque: Boolean(
          c && (c.length === 3 || c[3] === 1) && cs.opacity === "1",
        ),
      };
    });
  // Decisive baseline failure precedes dependent interaction checks.
  const baseline = await opaque();
  await capture("initial-header");
  assert.ok(
    baseline.opaque,
    `Task header must be fully opaque: ${JSON.stringify(baseline)}`,
  );
  await selectWorkbenchTool(page, "Display");
  if (!publicInput) await page.getByLabel("Z", { exact: true }).fill("1");
  await selectWorkbenchTool(page, "Analyze");
  if (publicInput) {
    await page.getByRole("button", { name: "Whole image", exact: true }).click();
    await page.getByLabel("Segmentation method", { exact: true }).selectOption("components");
    await page.getByLabel("Object foreground", { exact: true }).selectOption("bright");
    await page.getByLabel("Minimum object measure", { exact: true }).fill(String(publicInput.minimum_measure));
    await page.getByLabel("Exclude border objects", { exact: true }).uncheck();
    await page.getByLabel("Measurement channel", { exact: true }).selectOption("0");
  }
  await page.getByLabel("Threshold", { exact: true }).fill(String(publicInput?.threshold ?? 50));
  await page.getByRole("button", { name: "Run recipe", exact: true }).click();
  await page.waitForFunction(
    expected => document.querySelectorAll(".research-result-table tbody tr").length === expected,
    publicInput?.measurements.length ?? 2,
  );
  if (publicInput) {
    const state = await page.evaluate(() => window.lociResearch.getSnapshot());
    assert.equal(state.results.length, 1);
    const result = state.results[0];
    assert.equal(result.source_sha256, publicInput.source_sha256);
    const record = await page.evaluate(id => window.lociResearch.execute("result", { result_id: id }), result.id);
    assert.deepEqual(record.provenance.selection, publicInput.selection);
    assert.equal(record.measurements.length, publicInput.measurements.length);
    for (const [i, expected] of publicInput.measurements.entries()) {
      const actual = record.measurements[i];
      assert.equal(actual.label, expected.label); assert.equal(actual.voxel_count, expected.voxel_count);
      assert.ok(Math.abs(actual.measure - expected.measure) < 1e-9);
      for (const [key, value] of Object.entries(expected.raw_intensity))
        assert.ok(Math.abs(Object.values(actual.intensity)[0][key] - value) <= 1e-9 + 1e-12 * Math.abs(value));
    }
    report.public_result = { id: result.id, revision_hash: result.revision_hash, object_count: result.object_count };
  } else assert.deepEqual(
    await page
      .locator(".research-result-table tbody tr")
      .evaluateAll((rows) =>
        rows.map((r) => Number(r.querySelectorAll("td")[1].textContent)),
      ),
    [10, 18],
  );

  for (const bounds of [
    { width: 1024, height: 720 },
    { width: 1440, height: 900 },
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, b) => BrowserWindow.getAllWindows()[0].setBounds(b),
      bounds,
    );
    for (const theme of ["graphite", "paper", "midnight"])
      for (const textSize of ["standard", "large"])
        for (const motion of ["no-preference", "reduce"]) {
          await page.emulateMedia({ reducedMotion: motion });
          await page
            .getByRole("button", { name: "Open settings", exact: true })
            .click();
          const settings = page.getByRole("dialog", {
            name: "Settings",
            exact: true,
          });
          await settings
            .getByRole("combobox", { name: "Application theme" })
            .selectOption(theme);
          await settings
            .getByRole("radio", {
              name: textSize === "large" ? /^Large/ : /^Standard/,
            })
            .click();
          await page.keyboard.press("Escape");
          await settings.waitFor({ state: "hidden" });
          const key = `${bounds.width}-${theme}-${textSize}-${motion}`;
          for (const tool of ["Analyze", "Annotate", "Info"]) {
            await selectWorkbenchTool(page, tool);
            await frame();
            assert.equal(
              await page.locator(".research-alert[role=alert]").count(),
              0,
              `${key}: unexpected UI error`,
            );
            assert.ok((await opaque()).opaque, `${key}: header transparency`);
            const inspector = page.locator(".research-inspector"),
              header = page.locator(".workbench-tools");
            await inspector.evaluate((el) => (el.scrollTop = 150));
            await frame();
            const geometry = await inspector.evaluate((el) => ({
              top: el.getBoundingClientRect().top,
              scroll: el.scrollTop,
              range: el.scrollHeight - el.clientHeight,
            }));
            const hb = await header.boundingBox();
            assert.ok(hb);
            assert.ok(
              Math.abs(hb.y - geometry.top) <= 2,
              `${key}/${tool}: header lost its anchor`,
            );
            if (tool === "Analyze" && bounds.width === 1024)
              assert.ok(
                geometry.scroll > 0,
                `${key}: no long-panel scrolling exercised`,
              );
            if (tool === "Analyze") await capture(`${key}-scrolled`);
            await inspector.evaluate((el) => (el.scrollTop = 0));
            const groupName = tool === "Info" ? "Results" : tool;
            const group = page
              .getByRole("navigation", { name: "Task groups" })
              .getByRole("button", { name: groupName, exact: true });
            await group.focus();
            await page.keyboard.press("Tab");
            await page.keyboard.press("Shift+Tab");
            await focusVisible(group, `${key}/${tool}/group`);
            const trigger = page.getByRole("combobox", {
              name: `${groupName} tool`,
              exact: true,
            });
            await trigger.focus();
            await trigger.press("ArrowDown");
            const popup = page.getByRole("listbox", {
              name: `${groupName} tool`,
              exact: true,
            });
            await popup.waitFor();
            await frame();
            const p = await popup.boundingBox(),
              v = await page.evaluate(() => ({
                width: innerWidth,
                height: innerHeight,
              }));
            assert.ok(
              p &&
                p.x >= 0 &&
                p.y >= 0 &&
                p.x + p.width <= v.width + 1 &&
                p.y + p.height <= v.height + 1,
              `${key}: menu leaves viewport`,
            );
            if (motion === "reduce")
              assert.ok(
                await popup.evaluate((el) =>
                  getComputedStyle(el)
                    .transitionDuration.split(",")
                    .every((value) => parseFloat(value) <= 0.00001),
                ),
                `${key}: reduced motion exceeds existing 0.01ms contract`,
              );
            await page.keyboard.press("Escape");
            await popup.waitFor({ state: "hidden" });
            await focusVisible(trigger, `${key}/menu return`);
            const search = page.getByRole("button", {
              name: "Search all tools",
              exact: true,
            });
            await search.click();
            const input = page.getByRole("combobox", {
              name: "Search all tools",
              exact: true,
            });
            await input.fill("model");
            await input.press("Escape");
            await input.waitFor({ state: "hidden" });
            await focusVisible(search, `${key}/search return`);
            // Actual keyboard transition from header into body must remain unobscured.
            await search.press("Tab");
            const focused = page.locator(":focus");
            await focusVisible(focused, `${key}/${tool}/body`, true);
            if (tool === "Analyze") {
              const threshold = page.getByLabel("Threshold", { exact: true });
              await threshold.evaluate((el) => {
                el.scrollIntoView({ block: "start" });
                el.focus();
              });
              await frame();
              await focusVisible(threshold, `${key}/scrollIntoView`, true);
            }
            if (tool === "Info") {
              const table = page.getByRole("region", {
                name: "Result measurements",
                exact: true,
              });
              await table.focus();
              await table.press("ArrowDown");
              const tableScroll = await table.evaluate((el) => {
                el.scrollLeft = el.scrollWidth;
                return {
                  range: el.scrollWidth - el.clientWidth,
                  scroll: el.scrollLeft,
                };
              });
              assert.ok(
                tableScroll.range > 0 && tableScroll.scroll > 0,
                `${key}: wide table must retain its own scrolling`,
              );
            }
            assert.equal(
              await page.evaluate(
                () =>
                  document.documentElement.scrollWidth <= innerWidth + 1 &&
                  document.body.scrollWidth <= innerWidth + 1,
              ),
              true,
              `${key}: global overflow`,
            );
            report.cases.push({ key, tool, geometry, viewport: v });
          }
          await save();
        }
  }
  report.status = "passed";
} catch (error) {
  failure = error;
  report.status = "failed";
  report.error = error.stack ?? String(error);
  if (page) {
    try {
      await capture("failure");
    } catch (captureError) {
      report.capture_error = String(captureError);
    }
  }
} finally {
  if (app) {
    try {
      await app.close();
    } catch (error) {
      report.close_error = String(error);
      failure ??= error;
      report.status = "failed";
    }
  }
  report.completed_at = new Date().toISOString();
  await save();
  console.log(path.join(runRoot, "receipt.json"));
}
if (failure) throw failure;
