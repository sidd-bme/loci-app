// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_PREFERENCES, type UserPreferences } from "./preferences";
import SettingsDialog from "./SettingsDialog";

afterEach(cleanup);

function show(overrides: Partial<UserPreferences> = {}, callbacks: {
  onChange?: (value: UserPreferences) => void; onClose?: () => void; onOpenGuide?: (sectionId?: string) => void;
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
  it("searches real settings, opens the category and focuses the exact control", () => {
    const onChange = vi.fn(); show({}, { onChange });
    const search = screen.getByRole("searchbox", { name: "Search settings" });
    fireEvent.change(search, { target: { value: "activity provenance" } });
    expect(screen.getByRole("status")).toHaveTextContent("1 matching setting");
    fireEvent.click(screen.getByRole("button", { name: /Expand activity records/ }));
    expect(screen.getByRole("tab", { name: "External agents" })).toHaveAttribute("aria-selected", "true");
    const activity = screen.getByRole("checkbox", { name: /Expand activity records/ });
    expect(activity).toHaveFocus();
    fireEvent.click(activity);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ agent: { followByDefault: false, expandActivityDetails: true } }));
    fireEvent.change(search, { target: { value: "guidance" } });
    fireEvent.click(screen.getByRole("button", { name: /Contextual guidance/ }));
    expect(screen.getByRole("checkbox", { name: /Contextual guidance/ })).toHaveFocus();
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("clears an empty-result search with Escape before closing and supports category keyboard selection", () => {
    const onClose = vi.fn(); show({}, { onClose });
    const search = screen.getByRole("searchbox", { name: "Search settings" });
    search.focus(); fireEvent.change(search, { target: { value: "missingqueryxyz" } });
    expect(screen.getByRole("status")).toHaveTextContent("No matching settings");
    fireEvent.keyDown(search, { key: "Escape" });
    expect(search).toHaveValue(""); expect(onClose).not.toHaveBeenCalled();
    const appearance = screen.getByRole("tab", { name: "Appearance" });
    appearance.focus(); fireEvent.keyDown(appearance, { key: "ArrowDown" });
    expect(screen.getByRole("tab", { name: "Viewing & help" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "Viewing & help" })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(window, { key: "Escape" }); expect(onClose).toHaveBeenCalledOnce();
  });

  it("opens contextual manual topics without changing agent permissions or preferences", () => {
    const onChange = vi.fn(), onOpenGuide = vi.fn(); show({}, { onChange, onOpenGuide });
    fireEvent.click(screen.getByRole("tab", { name: "External agents" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Follow agent by default/ }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ agent: { followByDefault: true, expandActivityDetails: false } }));
    fireEvent.click(screen.getByRole("button", { name: "Read the agent workflow" }));
    expect(onOpenGuide).toHaveBeenLastCalledWith("work-with-external-agents");
    fireEvent.click(screen.getByRole("tab", { name: "User guide" }));
    fireEvent.click(screen.getByRole("button", { name: "Reuse and continue workflows" }));
    expect(onOpenGuide).toHaveBeenLastCalledWith("compose-and-reuse-workflows");
    expect(onChange).toHaveBeenCalledOnce();
  });

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
    expect(screen.queryByText(/biological validation|clinical validation/)).not.toBeInTheDocument();
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
    const dpi = screen.getByRole("textbox", { name: "Default figure DPI" });
    fireEvent.change(dpi, { target: { value: "600" } });
    fireEvent.blur(dpi);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ figureDpi: 600 }));

    fireEvent.click(screen.getByRole("tab", { name: "User guide" }));
    fireEvent.click(screen.getByRole("button", { name: "Open user guide" }));
    expect(onOpenGuide).toHaveBeenCalledOnce();
  });

  it.each(["", "71", "1201", "300.5", "invalid"])("keeps invalid DPI draft %j without changing the saved preference", (draft) => {
    const onChange = vi.fn(); show({}, { onChange });
    fireEvent.click(screen.getByRole("tab", { name: "Saving & export" }));
    const dpi = screen.getByRole("textbox", { name: "Default figure DPI" });
    fireEvent.change(dpi, { target: { value: draft } });
    fireEvent.blur(dpi);
    expect(dpi).toHaveValue(draft);
    expect(dpi).toHaveAttribute("aria-invalid", "true");
    expect(dpi).toHaveAccessibleDescription(/Enter a whole number from 72 to 1200/);
    expect(screen.getByRole("alert")).toBeVisible();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: "Appearance" }));
    fireEvent.click(screen.getByRole("tab", { name: "Saving & export" }));
    expect(screen.getByRole("textbox", { name: "Default figure DPI" })).toHaveValue(draft);
  });

  it("restores the last valid DPI with Escape and permits keyboard correction", () => {
    const onClose = vi.fn(), onChange = vi.fn();
    function ControlledSettings() {
      const [preferences, setPreferences] = useState(DEFAULT_PREFERENCES);
      return <SettingsDialog preferences={preferences} onChange={(next) => {
        setPreferences(next); onChange(next);
      }} onClose={onClose} onQuit={vi.fn()} />;
    }
    render(<ControlledSettings />);
    fireEvent.click(screen.getByRole("tab", { name: "Saving & export" }));
    const dpi = screen.getByRole("textbox", { name: "Default figure DPI" });
    dpi.focus();
    fireEvent.change(dpi, { target: { value: "600" } });
    fireEvent.keyDown(dpi, { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ figureDpi: 600 }));
    fireEvent.change(dpi, { target: { value: "1201" } });
    fireEvent.keyDown(dpi, { key: "Enter" });
    expect(screen.getByRole("alert")).toHaveTextContent("Escape restores 600 DPI");
    expect(onChange).toHaveBeenCalledOnce();
    fireEvent.keyDown(dpi, { key: "Escape" });
    expect(dpi).toHaveValue("600");
    expect(dpi).toHaveFocus();
    expect(dpi).toHaveAttribute("aria-invalid", "false");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.change(dpi, { target: { value: "72" } });
    fireEvent.blur(dpi);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ figureDpi: 72 }));
  });

  it("preserves an invalid draft through unrelated preference changes", () => {
    const view = show();
    fireEvent.click(screen.getByRole("tab", { name: "Saving & export" }));
    const dpi = screen.getByRole("textbox", { name: "Default figure DPI" });
    fireEvent.change(dpi, { target: { value: "bad draft" } });
    fireEvent.blur(dpi);
    view.rerender(<SettingsDialog preferences={{ ...DEFAULT_PREFERENCES, theme: "aurora" }}
      onChange={vi.fn()} onClose={vi.fn()} onQuit={vi.fn()} />);
    expect(dpi).toHaveValue("bad draft");
    expect(dpi).toHaveAttribute("aria-invalid", "true");
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
    const dpi = screen.getByRole("textbox", { name: "Default figure DPI" });
    dpi.focus();
    view.rerender(<SettingsDialog preferences={{ ...DEFAULT_PREFERENCES, theme: "aurora" }}
      onChange={vi.fn()} onClose={latestClose} onQuit={vi.fn()} />);
    expect(screen.getByRole("textbox", { name: "Default figure DPI" })).toHaveFocus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(latestClose).toHaveBeenCalledOnce();
    view.unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });
});
