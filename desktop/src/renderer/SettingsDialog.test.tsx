// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_PREFERENCES, type UserPreferences } from "./preferences";
import SettingsDialog from "./SettingsDialog";

afterEach(cleanup);

function show(overrides: Partial<UserPreferences> = {}, callbacks: {
  onChange?: (value: UserPreferences) => void; onClose?: () => void; onOpenGuide?: () => void;
} = {}) {
  const preferences: UserPreferences = {
    ...structuredClone(DEFAULT_PREFERENCES),
    ...overrides,
    viewer: { ...DEFAULT_PREFERENCES.viewer, ...overrides.viewer },
  };
  return render(<SettingsDialog preferences={preferences} onChange={callbacks.onChange ?? vi.fn()}
    onClose={callbacks.onClose ?? vi.fn()} onQuit={vi.fn()} onOpenGuide={callbacks.onOpenGuide} />);
}

describe("SettingsDialog", () => {
  it("presents concise current categories, themes, and capability boundaries", () => {
    show();
    const navigation = screen.getByRole("tablist", { name: "Settings categories" });
    for (const label of ["Appearance", "Viewing & help", "Saving & export", "Capabilities", "User guide"])
      expect(within(navigation).getByRole("tab", { name: label })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Application theme" })).toBeVisible();
    for (const theme of ["Graphite", "Midnight", "Paper", "Aurora", "Ember", "Lagoon"])
      expect(screen.getByRole("option", { name: theme })).toBeVisible();
    expect(screen.queryByText("Count summary CSV")).not.toBeInTheDocument();

    fireEvent.click(within(navigation).getByRole("tab", { name: "Capabilities" }));
    expect(screen.getByText("Large microscopy & pathology")).toBeVisible();
    expect(screen.getByText("Volumes, time & medical imaging")).toBeVisible();
    expect(screen.getByText("Configured as needed")).toBeVisible();
    expect(screen.getByText(/not universal reader coverage/)).toBeVisible();
    expect(screen.queryByText(/not installed yet/i)).not.toBeInTheDocument();
  });

  it("updates real viewing, motion, figure, and guide controls", () => {
    const onChange = vi.fn(), onOpenGuide = vi.fn();
    show({}, { onChange, onOpenGuide });
    fireEvent.click(screen.getByRole("radio", { name: /Reduce motion/ }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ motion: "reduced" }));

    fireEvent.click(screen.getByRole("tab", { name: "Viewing & help" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Viewer scale bar/ }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      viewer: expect.objectContaining({ showScaleBar: false }),
    }));

    fireEvent.click(screen.getByRole("tab", { name: "Saving & export" }));
    expect(screen.getByText("Rendered figures")).toBeVisible();
    expect(screen.getByText("Derived results")).toBeVisible();
    expect(screen.getByText("Recoverable local sessions")).toBeVisible();
    const dpi = screen.getByRole("spinbutton", { name: "Default figure DPI" });
    fireEvent.change(dpi, { target: { value: "600" } });
    fireEvent.blur(dpi);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ figureDpi: 600 }));

    fireEvent.click(screen.getByRole("tab", { name: "User guide" }));
    fireEvent.click(screen.getByRole("button", { name: "Open user guide" }));
    expect(onOpenGuide).toHaveBeenCalledOnce();
  });

  it("changes theme and locally available font through native selects", () => {
    const onChange = vi.fn(); show({}, { onChange });
    fireEvent.change(screen.getByRole("combobox", { name: "Application theme" }), { target: { value: "midnight" } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ theme: "midnight" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Interface font" }), { target: { value: "verdana" } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ font: "verdana" }));
    expect(screen.queryByText("Loci preferences")).not.toBeInTheDocument();
  });

  it("does not steal focus on preference rerenders and restores prior focus on close", () => {
    const opener = document.createElement("button");
    document.body.append(opener); opener.focus();
    const firstClose = vi.fn(), latestClose = vi.fn();
    const view = show({}, { onClose: firstClose });
    expect(screen.getByRole("button", { name: "Close settings" })).toHaveFocus();
    fireEvent.click(screen.getByRole("tab", { name: "Saving & export" }));
    const dpi = screen.getByRole("spinbutton", { name: "Default figure DPI" });
    dpi.focus();
    view.rerender(<SettingsDialog preferences={{ ...DEFAULT_PREFERENCES, theme: "aurora" }}
      onChange={vi.fn()} onClose={latestClose} onQuit={vi.fn()} />);
    expect(screen.getByRole("spinbutton", { name: "Default figure DPI" })).toHaveFocus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(latestClose).toHaveBeenCalledOnce();
    view.unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });
});
