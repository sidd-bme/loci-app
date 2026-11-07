// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VolumeWorkspaceControls, type VolumeWorkspaceControlsProps } from "./VolumeWorkspaceControls";

afterEach(cleanup);
const props = (overrides: Partial<VolumeWorkspaceControlsProps> = {}): VolumeWorkspaceControlsProps => ({
  selectedObject: 42, readiness: "ready", labelsVisible: true, labelOpacity: .4, selectedOnly: false,
  canLocate: true, canCorrect: true, onVisibilityChange: vi.fn(), onOpacityChange: vi.fn(),
  onSelectedOnlyChange: vi.fn(), onLocateObject: vi.fn(), onCorrectObject: vi.fn(), onClearSelection: vi.fn(), ...overrides,
});

describe("controlled volume label tools", () => {
  it("reports display intent and object actions without owning a second selection", () => {
    const input = props(); render(<VolumeWorkspaceControls {...input} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Labels" }));
    fireEvent.change(screen.getByRole("slider", { name: "Label opacity" }), { target: { value: "65" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Selected only" }));
    fireEvent.click(screen.getByRole("button", { name: "Locate object" }));
    fireEvent.click(screen.getByRole("button", { name: "Correct" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear object selection" }));
    expect(input.onVisibilityChange).toHaveBeenCalledWith(false);
    expect(input.onOpacityChange).toHaveBeenCalledWith(.65);
    expect(input.onSelectedOnlyChange).toHaveBeenCalledWith(true);
    expect(input.onLocateObject).toHaveBeenCalledOnce(); expect(input.onCorrectObject).toHaveBeenCalledOnce();
    expect(input.onClearSelection).toHaveBeenCalledOnce();
    expect(screen.getByRole("checkbox", { name: "Labels" })).toBeChecked();
    expect(screen.getByText("Object 42")).toBeVisible();
  });
  it.each([
    ["raw-only", "Choose a label result to inspect objects alongside the raw volume."],
    ["loading", "Loading labels for this result…"],
    ["stale", "Labels no longer match the selected result. Load its current revision to continue."],
    ["unavailable", "Labels are unavailable for this volume."],
  ] as const)("disables revision-bound actions while %s", (readiness, message) => {
    const input = props({ readiness }); render(<VolumeWorkspaceControls {...input} />);
    expect(screen.getByRole("checkbox", { name: "Labels" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Correct" }));
    expect(input.onCorrectObject).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Locate object" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Labels" })).toHaveAccessibleDescription(message);
    expect(screen.getByText(message)).toHaveAttribute("role", "status");
  });
  it("keeps a hidden selection explicit and offers independent locate and correction availability", () => {
    render(<VolumeWorkspaceControls {...props({ selectionHiddenReason: "Object 42 is outside the clipping plane.", canCorrect: false,
      correctionReason: "Open a source-grid plane to correct this object." })} />);
    expect(screen.getByText("Object 42 is outside the clipping plane.")).toHaveAttribute("role", "status");
    expect(screen.getByRole("button", { name: "Locate object" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Correct" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Correct" })).toHaveAccessibleDescription("Open a source-grid plane to correct this object.");
  });
  it("does not offer object-only operations with no selection", () => {
    render(<VolumeWorkspaceControls {...props({ selectedObject: null })} />);
    expect(screen.getByRole("checkbox", { name: "Selected only" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Correct" })).toBeNull();
    expect(screen.getByText("Select a label in the image or object table.")).toBeVisible();
  });
  it("blocks controls during mutation or errors and preserves the reported target", () => {
    const view = render(<VolumeWorkspaceControls {...props({ busy: true })} />);
    expect(screen.getByRole("button", { name: "Clear object selection" })).toBeDisabled();
    expect(screen.getByText("Object 42")).toBeVisible();
    view.rerender(<VolumeWorkspaceControls {...props({ error: "Labels do not match this revision." })} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Labels do not match this revision.");
    expect(screen.getByRole("checkbox", { name: "Labels" })).toBeDisabled();
  });
});
