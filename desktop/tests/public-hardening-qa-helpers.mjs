import { promises as fs } from "node:fs";
import path from "node:path";

export const researchSourceButtonSelector = ".research-sources button[data-source-id]";
export const researchSourceNameSelector = `${researchSourceButtonSelector} .research-source-name`;

export async function waitForRenderedSources(page, count, timeoutMs) {
  await page.waitForFunction(
    ({ selector, count }) => document.querySelectorAll(selector).length === count,
    { selector: researchSourceNameSelector, count },
    { timeout: timeoutMs },
  );
  return page.locator(researchSourceNameSelector).count();
}

export async function reopenStudyFromEmptyState(page) {
  if (await page.locator("main.image-first-empty").isVisible()) {
    await page.getByRole("button", { name: "Open study", exact: true }).click();
  }
}

export async function captureFolderImportFailure(electronApp, runRoot) {
  const page = await electronApp.firstWindow();
  if (!page || page.isClosed()) return;
  await page.screenshot({ path: path.join(runRoot, "failure.png") }).catch(() => {});
  const html = await page.content().catch(() => "");
  if (html) await fs.writeFile(path.join(runRoot, "failure-page.html"), html, "utf8").catch(() => {});
  const snapshot = await page.evaluate(() => window.lociResearch?.getSnapshot?.()).catch(() => null);
  if (snapshot) {
    await fs.writeFile(path.join(runRoot, "failure-snapshot.json"), JSON.stringify(snapshot, null, 2), "utf8").catch(() => {});
  }
}

export async function closeWithConfirmedQuit(electronApp) {
  try {
    await electronApp.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    });
    const closed = electronApp.waitForEvent("close", { timeout: 15_000 });
    // Observe early event failures while requesting quit, then await the original
    // promise so its failure still triggers fallback and remains visible.
    closed.catch(() => {});
    await electronApp.evaluate(({ app }) => app.quit());
    await closed;
  } catch (error) {
    await electronApp.close().catch(() => {});
    throw error;
  }
}
