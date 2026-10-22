// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StudyWorkspace, type StudySection } from "./StudyWorkspace";

afterEach(cleanup);
function Harness({ corrections = true }: { corrections?: boolean }) {
  const [section, onSection] = useState<StudySection>("samples");
  return <StudyWorkspace active section={section} onSection={onSection} focused={false} onToggleFocus={vi.fn()}
    sourceName="A long source name.ome.tiff" samples={<input aria-label="Sample draft" defaultValue="Initial draft" />}
    intensity={<p>Intensity evidence</p>} batch={<p>Batch recipe</p>} corrections={corrections ? <p>Correction effect</p> : undefined} />;
}
describe("StudyWorkspace", () => {
  it("uses conventional roving keyboard tabs with labelled panels and retains hidden draft nodes", () => {
    render(<Harness />);
    const samples = screen.getByRole("tab", { name: "Samples" });
    const intensity = screen.getByRole("tab", { name: "Intensity" });
    const draft = screen.getByRole("textbox", { name: "Sample draft" });
    fireEvent.change(draft, { target: { value: "Unapplied CSV" } });
    samples.focus();
    fireEvent.keyDown(samples, { key: "ArrowRight" });
    expect(intensity).toHaveFocus();
    expect(intensity).toHaveAttribute("aria-selected", "true");
    expect(samples).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("tabpanel", { name: "Intensity" })).toHaveAttribute("id", intensity.getAttribute("aria-controls"));
    expect(draft).not.toBeVisible();
    fireEvent.keyDown(intensity, { key: "End" });
    const corrections = screen.getByRole("tab", { name: "Corrections" });
    expect(corrections).toHaveFocus();
    expect(screen.getByRole("tabpanel", { name: "Corrections" })).toBeVisible();
    fireEvent.keyDown(corrections, { key: "ArrowRight" });
    expect(samples).toHaveFocus();
    expect(screen.getByRole("textbox", { name: "Sample draft" })).toBe(draft);
    expect(draft).toHaveValue("Unapplied CSV");
    fireEvent.keyDown(samples, { key: "ArrowLeft" });
    expect(corrections).toHaveFocus();
    fireEvent.keyDown(corrections, { key: "Home" });
    expect(samples).toHaveFocus();
  });
  it("omits unavailable Corrections and keeps the active panel valid if availability changes", () => {
    const view = render(<Harness />);
    fireEvent.click(screen.getByRole("tab", { name: "Corrections" }));
    view.rerender(<Harness corrections={false} />);
    expect(screen.queryByRole("tab", { name: "Corrections" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Samples" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Samples" })).toBeVisible();
  });
});
