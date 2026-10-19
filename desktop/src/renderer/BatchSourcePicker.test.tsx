// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ResearchSource } from "../shared/research-contracts";
import { BatchSourcePicker } from "./BatchSourcePicker";

afterEach(cleanup);
const sources: ResearchSource[] = ["FBS/Preview.tif", "SFM/Preview.tif", "FBS/Second.tif"].map((path, index) => ({
  id: `source-${index}`, name: path.split("/").at(-1)!, sha256: String(index).repeat(64), metadata: {},
  browser_location: { relative_path: path, root: null },
}));

it("selects exact folder descendants in working-list order with partial state, all and clear", () => {
  const selection = vi.fn(), preview = vi.fn();
  function Harness() {
    const [ids, setIds] = useState<string[]>([]);
    return <BatchSourcePicker sources={sources} selectedSourceIds={ids} onSelection={next => { setIds(next); selection(next); }}
      busy={false} previewDisabled={false} previewSourceId={null} onPreview={preview} />;
  }
  render(<Harness />);
  fireEvent.click(screen.getByRole("checkbox", { name: "Include FBS/Preview.tif in batch" }));
  const folder = screen.getByRole("checkbox", { name: "Include folder FBS in batch" });
  expect(folder).toBePartiallyChecked();
  fireEvent.click(folder);
  expect(selection).toHaveBeenLastCalledWith(["source-0", "source-2"]);
  expect(screen.getByRole("checkbox", { name: "Include SFM/Preview.tif in batch" })).not.toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "Select all batch images" }));
  expect(selection).toHaveBeenLastCalledWith(sources.map(source => source.id));
  fireEvent.click(screen.getByRole("button", { name: "Preview", description: "Preview SFM/Preview.tif" }));
  expect(preview).toHaveBeenCalledWith("source-1");
  fireEvent.click(screen.getByRole("button", { name: "Clear batch image selection" }));
  expect(selection).toHaveBeenLastCalledWith([]);
});

it("keeps 64-component batch paths compact under the inspector fieldset cascade", () => {
  const path = [...Array.from({ length: 63 }, (_, index) => `Folder ${index} Ω`), "Long image name.tif"].join("/");
  const source = { ...sources[0], browser_location: { relative_path: path, root: null } };
  const style = document.createElement("style");
  // The global inspector stylesheet can load after this component's stylesheet.
  style.textContent = readFileSync(resolve("src/renderer/SourceTree.css"), "utf8") +
    readFileSync(resolve("src/renderer/ResearchWorkbench.css"), "utf8");
  document.head.append(style);
  try {
    const { container } = render(<div className="research-panel"><BatchSourcePicker sources={[source]} selectedSourceIds={[]}
      onSelection={vi.fn()} busy={false} previewDisabled={false} previewSourceId={null} onPreview={vi.fn()} /></div>);
    const folders = [...container.querySelectorAll<HTMLFieldSetElement>("fieldset")];
    expect(folders).toHaveLength(63);
    for (const folder of folders) {
      const css = getComputedStyle(folder);
      expect(css.padding).toBe("0px"); expect(css.margin).toBe("0px"); expect(css.borderTopWidth).toBe("0px");
      expect(getComputedStyle(folder.querySelector("legend")!).padding).toBe("0px");
    }
    const labels = [...container.querySelectorAll<HTMLElement>("legend > label")];
    expect(labels[0].style.paddingInlineStart).toBe("0px");
    expect(labels.at(-1)!.style.paddingInlineStart).toBe("36px");
    const image = container.querySelector<HTMLElement>(".batch-source-picker__image")!;
    expect(image.style.paddingInlineStart).toBe("36px");
    expect(screen.getByRole("checkbox", { name: `Include ${path} in batch` })).toBeVisible();
  } finally { style.remove(); }
});
