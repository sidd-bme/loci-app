// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ResearchDesktopApi, ResearchSource } from "../shared/research-contracts";
import { OrganoidTrackerPanel } from "./OrganoidTrackerPanel";

afterEach(cleanup);

it("binds the picker to the declared series and visits explicit daughter endpoints", async () => {
  const source: ResearchSource = {
    id: "a".repeat(32), sha256: "b".repeat(64), name: "organoid.ome.tif",
    metadata: { dimensions: {t: 2, c: 1, z: 4, y: 12, x: 8}, format: "OME-TIFF",
      physical_calibration: {unit: "µm", spacing: [2, 0.5, 0.25]}, timing: {source: "ome-time-increment"} },
  };
  const api = { importOrganoidGraph: vi.fn(async () => ({
    source_id: source.id, source_sha256: source.sha256, id: "c".repeat(32), first: 17,
    spacing_xyz_um: [.25, .5, 2], interval_s: 30, origin: "manually-annotated",
    nodes: [[17,4,3,1],[18,5,4,2],[18,3,5,2]], edges: [[0,1,null,null],[0,2,0.21617879598060905,0.7576284217698984]],
  })) } as unknown as ResearchDesktopApi;
  const onPlane = vi.fn();
  render(<OrganoidTrackerPanel api={api} source={source} busy={false} canNavigate onPlane={onPlane}/>);
  const picker = screen.getByRole("button", {name: "Choose .aut graph…"});
  expect(picker).toBeDisabled();
  fireEvent.change(screen.getByLabelText(/time point at the first/), {target: {value: "17"}});
  fireEvent.change(screen.getByLabelText("Graph origin"), {target: {value: "manually-annotated"}});
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(picker);
  await screen.findByText(/3 positions · 2 links · 1 branch/);
  expect(api.importOrganoidGraph).toHaveBeenCalledWith({id:source.id, sha256:source.sha256},17,"manually-annotated");
  const missing = screen.getByText("Link 1 of 2 · Reported link probability unavailable · Marginal probability unavailable");
  expect(missing).toBeVisible();
  expect(missing.querySelector("data")).toBeNull();
  fireEvent.change(screen.getByLabelText("Inspect links"), {target: {value: "low"}});
  const link = screen.getByTitle("Reported link probability (full precision): 0.21617879598060905");
  const marginal = screen.getByTitle("Marginal probability (full precision): 0.7576284217698984");
  expect(link.parentElement).toHaveTextContent("Link 1 of 1 · Reported link probability 0.2162 · Marginal probability 0.7576");
  expect(link).toBeVisible();
  expect(marginal).toBeVisible();
  expect(link).toHaveProperty("value", "0.21617879598060905");
  expect(marginal).toHaveProperty("value", "0.7576284217698984");
  fireEvent.click(screen.getByText("View later source plane"));
  expect(onPlane).toHaveBeenCalledWith(1, [18,3,5,2]);
});
