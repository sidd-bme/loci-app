import assert from "node:assert/strict";

export async function checkZooLayouts(app, page, zoo, capture) {
  const zoom = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor());
  const width = await page.evaluate(() => window.innerWidth);
  const setZoom = value => app.evaluate(({ BrowserWindow }, factor) => {
    BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(factor);
  }, value);
  const layouts = [];
  try {
    for (const [target, columns] of [[840, 2], [570, 1]]) {
      await setZoom(zoom * width / target);
      await page.waitForFunction(goal => Math.abs(window.innerWidth - goal) <= 6, target);
      const geometry = await zoo.evaluate(root => {
        const grid = root.querySelector(".model-library-grid");
        const box = root.getBoundingClientRect();
        return { width: innerWidth, columns: getComputedStyle(grid).gridTemplateColumns.split(" ").length,
          dialogWidth: box.width, gridOverhang: grid.scrollWidth - grid.clientWidth };
      });
      assert.equal(geometry.columns, columns);
      assert.ok(geometry.dialogWidth <= geometry.width && geometry.gridOverhang <= 1);
      layouts.push(geometry);
      if (columns === 1) await capture("07b-model-zoo-compact", { nativeWindow: true });
    }
  } finally {
    await setZoom(zoom);
    await page.waitForFunction(original => Math.abs(window.innerWidth - original) <= 2, width);
  }
  return layouts;
}

export async function checkZooDestinations(page) {
  const opened = [];
  for (const modelId of ["cellpose-sam-v2", "micro-sam-vit-b-lm", "stardist-2d-versatile-fluo",
    "bioimageio-nuclei-boundary-onnx", "puma-tissue-cpu"]) {
    const file = page.locator("details.workbench-file-menu");
    await file.locator(":scope > summary").click();
    await file.getByRole("button", { name: "Model Zoo…", exact: true }).click();
    const zoo = page.getByRole("dialog", { name: "Model Zoo", exact: true });
    await zoo.locator('article[data-model-id="' + modelId + '"] .model-zoo-card__select').click();
    const launch = zoo.locator(".model-zoo-detail__primary-action button");
    const label = await launch.innerText();
    await launch.click();
    await zoo.waitFor({ state: "hidden" });
    if (modelId === "cellpose-sam-v2") {
      assert.equal(await page.getByRole("combobox", { name: "Segmentation model", exact: true }).inputValue(), "cellpose-sam-v2");
    } else if (modelId === "micro-sam-vit-b-lm") {
      await page.getByRole("button", { name: "Export native TIFF for μSAM", exact: true }).waitFor();
    } else if (modelId === "stardist-2d-versatile-fluo") {
      const summary = page.locator("details.external-labels-disclosure > summary").filter({ hasText: /^Import existing labels$/u });
      assert.ok(await summary.evaluate(s => s.parentElement.open));
      assert.equal(await page.getByRole("button", { name: "Export native TIFF for μSAM", exact: true }).isVisible(), false);
    } else if (modelId === "bioimageio-nuclei-boundary-onnx") {
      await page.getByRole("heading", { name: /no model packages in this study|^use a model$/iu }).first().waitFor();
    } else {
      await page.getByRole("region", { name: "Epidermis tissue model", exact: true }).waitFor();
    }
    opened.push({ model_id: modelId, action: label });
  }
  return opened;
}
