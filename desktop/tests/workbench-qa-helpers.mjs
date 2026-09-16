import assert from "node:assert/strict";

const toolGroup = {
  Display: "View", Annotate: "Annotate", Epidermis: "Annotate", Correction: "Annotate", Analyze: "Analyze",
  Process: "Analyze", Model: "Analyze", Quantify: "Analyze", Temporal: "Analyze",
  Registration: "Analyze", Info: "Results", Study: "Results",
};
const advancedLabel = { Agent: "Connect an assistant", Remote: "Remote compute",
  Portability: "Import & share results", "Vendor import": "Convert vendor images" };
const toolLabel = { Display: "Image & channels", Annotate: "Draw & measure", Epidermis: "Epidermal thickness", Correction: "Edit labels & ROIs",
  Analyze: "Segment & measure", Process: "Preprocess", Model: "Use a model", Quantify: "Fluorescence & field assay",
  Temporal: "Track over time", Registration: "Register & resample", Info: "Review & export", Study: "Study & batch" };

/** Exercise the same task-group and search controls available to a researcher. */
export async function selectWorkbenchTool(page, tool) {
  if (advancedLabel[tool]) {
    await page.getByRole("button", { name: "Search all tools", exact: true }).click();
    await page.getByRole("textbox", { name: "Search all tools", exact: true }).fill(advancedLabel[tool]);
    await page.getByRole("button", { name: advancedLabel[tool], exact: true }).click();
  } else {
    const group = toolGroup[tool];
    assert.ok(group, `Unknown workbench tool: ${tool}`);
    await page.getByRole("navigation", { name: "Task groups" }).getByRole("button", { name: group, exact: true }).click();
    await page.getByRole("combobox", { name: `${group} tool`, exact: true }).click();
    await page.getByRole("listbox", { name: `${group} tool`, exact: true })
      .getByRole("option", { name: toolLabel[tool], exact: true }).click();
  }
  if (tool === "Display") await revealAnalysisRegion(page);
}

export async function revealAnalysisRegion(page) {
  const details = page.locator("details.analysis-region-settings");
  if (await details.count() && !(await details.evaluate((element) => element.open)))
    await details.locator(":scope > summary").click();
}

export async function createEmptyStudy(page) {
  const options = page.getByRole("button", { name: "More opening options", exact: true });
  if (await options.getAttribute("aria-expanded") !== "true") await options.click();
  await page.getByRole("button", { name: "New empty study", exact: true }).click();
}

export async function fileMenuAction(page, name) {
  const action = page.getByRole("button", { name, exact: true });
  const visible = await action.filter({ visible: true }).count();
  if (visible) return action.filter({ visible: true }).first().click();
  const menu = page.locator("details.workbench-file-menu");
  if (!(await menu.evaluate((element) => element.open))) await menu.locator(":scope > summary").click();
  await menu.getByRole("button", { name, exact: true }).click();
}

export async function setSelectionField(page, label, value) {
  const input = page.getByLabel(label, { exact: true });
  if (!(await input.count()) && ["Z", "T"].includes(label)) {
    assert.equal(Number(value), 0, `Absent ${label} axis only accepts its single zero-based plane`);
    const dimension = await page.evaluate(async (axis) => {
      const snapshot = await window.lociResearch.getSnapshot();
      const name = document.querySelector('[aria-label="Active image"]')?.textContent;
      const source = snapshot.sources.find((item) => item.name === name);
      return source?.metadata.dimensions?.[axis];
    }, label.toLowerCase());
    assert.equal(dimension, 1, `Absent ${label} control must correspond to one verified plane`);
    return;
  }
  await input.fill(String(value));
}
