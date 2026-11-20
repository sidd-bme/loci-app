// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ImageConversionPanel } from "./ImageConversionPanel";
import type { ResearchDesktopApi, ResearchSnapshot, ResearchSource } from "../shared/research-contracts";

afterEach(cleanup);

const source: ResearchSource = { id: "a".repeat(32), sha256: "b".repeat(64), name: "Kidney",
  source_kind: "native", metadata: { sample_semantics: "none", channel_dtypes: ["uint16", "uint16"],
    dimensions: {t: 2, c: 2, z: 3, y:20, x:32} } };
const snapshot = { project: { title: "Cells" }, sources: [source] } as ResearchSnapshot;
const report = async <T,>(work: () => Promise<T>) => work();
function view(selected: ResearchSource | null, convertStudyImage = vi.fn()) {
  const api = { convertStudyImage } as unknown as ResearchDesktopApi;
  return render(<ImageConversionPanel source={selected} api={api} snapshot={snapshot} report={report}
    busy={false} onBusyChange={vi.fn()} onSnapshot={vi.fn()} />);
}

it("copies the bound full-resolution study series and reports success only after verification", async () => {
  const convert = vi.fn().mockResolvedValue({ artifact: "image.ome.zarr" });
  view(source, convert);
  expect(screen.getByText("Kidney")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Output format"), {target:{value:"ome-zarr"}});
  fireEvent.click(screen.getByRole("button", {name:"Convert image…"}));
  expect(convert).toHaveBeenCalledWith({source_id:source.id,source_sha256:source.sha256,format:"ome-zarr"});
  expect(await screen.findByText("Conversion verified")).toBeTruthy();
});

it("offers vendor input without an image and explains the empty study selection", () => {
  view(null);
  expect(screen.getByRole("button", {name:"Choose vendor image…"})).toBeTruthy();
  fireEvent.click(screen.getByRole("button", {name:"Study image"}));
  expect(screen.getByText(/Select an image in the study/)).toBeTruthy();
});

it("does not offer an ambiguous scalar conversion for RGB", () => {
  view({...source,metadata:{...source.metadata,sample_semantics:"RGB"}});
  expect(screen.queryByRole("button",{name:"Convert image…"})).toBeNull();
});
