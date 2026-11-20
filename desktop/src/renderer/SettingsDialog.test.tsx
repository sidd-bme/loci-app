// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_PREFERENCES, LOCI_THEMES, type UserPreferences } from "./preferences";
import SettingsDialog from "./SettingsDialog";

afterEach(cleanup);

function show(overrides: Partial<UserPreferences> = {}, callbacks: {
  onChange?: (value: UserPreferences) => void; onClose?: () => void; onQuit?: () => void; onOpenGuide?: (sectionId?: string) => void;
} = {}) {
  const preferences: UserPreferences = {
    ...structuredClone(DEFAULT_PREFERENCES),
    ...overrides,
    viewer: { ...DEFAULT_PREFERENCES.viewer, ...overrides.viewer },
  };
  return render(<SettingsDialog preferences={preferences} onChange={callbacks.onChange ?? vi.fn()}
    onClose={callbacks.onClose ?? vi.fn()} onQuit={callbacks.onQuit ?? vi.fn()} onOpenGuide={callbacks.onOpenGuide} />);
}

describe("SettingsDialog", () => {
  it("searches real settings, opens the category and focuses the exact control", () => {
    const onChange = vi.fn(); show({}, { onChange });
    const search = screen.getByRole("searchbox", { name: "Search settings" });
    fireEvent.change(search, { target: { value: "activity provenance" } });
    expect(screen.getByRole("status")).toHaveTextContent("1 matching setting");
    fireEvent.click(screen.getByRole("button", { name: /Expand activity records/ }));
    expect(screen.getByRole("tab", { name: "External agents" })).toHaveAttribute("aria-selected", "true");
    const activity = screen.getByRole("switch", { name: "Expand activity records" });
    expect(activity).toHaveFocus();
    fireEvent.click(activity);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ agent: { followByDefault: false, expandActivityDetails: true } }));
    fireEvent.change(search, { target: { value: "guidance" } });
    fireEvent.click(screen.getByRole("button", { name: /Contextual guidance/ }));
    expect(screen.getByRole("switch", { name: "Contextual guidance" })).toHaveFocus();
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
    fireEvent.keyDown(document.activeElement!, { key: "Escape" }); expect(onClose).toHaveBeenCalledOnce();
  });

  it("opens contextual manual topics without changing agent permissions or preferences", () => {
    const onChange = vi.fn(), onOpenGuide = vi.fn(); show({}, { onChange, onOpenGuide });
    fireEvent.click(screen.getByRole("tab", { name: "External agents" }));
    fireEvent.click(screen.getByRole("switch", { name: "Follow agent by default" }));
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
    const themeControl = screen.getByRole("combobox", { name: "Application theme" });
    expect(themeControl).toBeVisible();
    expect(within(themeControl).getAllByRole("option").map(option => (option as HTMLOptionElement).value).sort()).toEqual([...LOCI_THEMES].sort());
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
    fireEvent.click(screen.getByRole("switch", { name: "Viewer scale bar" }));
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

  it("focuses the selected density from search and applies keyboard selection", () => {
    const onChange = vi.fn();
    show({ density: "comfortable" }, { onChange });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search settings" }), { target: { value: "density" } });
    fireEvent.click(screen.getByRole("button", { name: /Workbench density/ }));

    const density = screen.getByRole("radiogroup", { name: "Workbench density" });
    const comfortable = within(density).getByRole("radio", { name: "Comfortable" });
    const compact = within(density).getByRole("radio", { name: "Compact" });
    expect(comfortable).toHaveFocus();
    expect(comfortable).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(comfortable, { key: "ArrowLeft" });
    expect(compact).toHaveFocus();
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ density: "compact" }));
  });

  it("changes theme and locally available font through native selects", () => {
    const onChange = vi.fn(); show({}, { onChange });
    fireEvent.change(screen.getByRole("combobox", { name: "Application theme" }), { target: { value: "midnight" } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ theme: "midnight" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Interface font" }), { target: { value: "verdana" } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ font: "verdana" }));
    expect(screen.queryByText("Loci preferences")).not.toBeInTheDocument();
  });

  it("selects the exact Black theme from a keyboard-operable workbench preview and keeps Graphite as the default", () => {
    const onChange = vi.fn();
    function ControlledSettings() {
      const [preferences, setPreferences] = useState(DEFAULT_PREFERENCES);
      return <SettingsDialog preferences={preferences} onChange={next => { setPreferences(next); onChange(next); }}
        onClose={vi.fn()} onQuit={vi.fn()} />;
    }
    render(<ControlledSettings />);
    const palettes = screen.getByRole("radiogroup", { name: "Theme previews" });
    const graphite = within(palettes).getByRole("radio", { name: "Graphite" });
    const black = within(palettes).getByRole("radio", { name: "Black" });
    expect(graphite).toHaveAttribute("aria-checked", "true");
    expect(black.querySelector('[data-preview-theme="black"]')).toBeInTheDocument();
    graphite.focus(); fireEvent.keyDown(graphite, { key: "ArrowLeft" });
    expect(black).toHaveFocus();
    expect(black).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("combobox", { name: "Application theme" })).toHaveValue("black");
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ ...DEFAULT_PREFERENCES, theme: "black" });
  });

  it("navigates Back and Forward through settings pages, then returns to the workspace", () => {
    const onClose = vi.fn(), onQuit = vi.fn();
    show({}, { onClose, onQuit });
    const next = screen.getByRole("button", { name: "Next settings page" });
    expect(next).toBeDisabled();
    fireEvent.click(screen.getByRole("tab", { name: "User guide" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous settings page" }));
    expect(screen.getByRole("tabpanel", { name: "Appearance" })).toBeVisible();
    fireEvent.click(next);
    expect(screen.getByRole("tabpanel", { name: "User guide" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Previous settings page" }));
    fireEvent.click(screen.getByRole("button", { name: "Back to workspace" }));
    expect(onClose).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Quit Loci" }));
    expect(onQuit).toHaveBeenCalledOnce();
  });

  it("supports keyboard search result navigation and keeps focus on the setting that was selected", () => {
    show();
    const search = screen.getByRole("searchbox", { name: "Search settings" });
    fireEvent.change(search, { target: { value: "viewer" } });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    const first = screen.getByRole("button", { name: /Viewer scale bar/ });
    const second = screen.getByRole("button", { name: /Overview navigator/ });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(second).toHaveFocus();
    fireEvent.click(second);
    expect(screen.getByRole("switch", { name: "Overview navigator" })).toHaveFocus();
    fireEvent.change(search, { target: { value: "DPI" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(screen.getByRole("textbox", { name: "Default figure DPI" })).toHaveFocus();
  });

  it("adopts an explicit route without unmounting fields on a repeated request for the same page", () => {
    const props = { preferences: DEFAULT_PREFERENCES, onChange: vi.fn(), onClose: vi.fn(), onQuit: vi.fn() };
    const view = render(<SettingsDialog {...props} initialPage="saving" navigationRevision={1} />);
    expect(screen.getByRole("dialog", { name: "Settings" })).toHaveAttribute("aria-modal", "true");
    const dpi = screen.getByRole("textbox", { name: "Default figure DPI" });
    dpi.focus(); fireEvent.change(dpi, { target: { value: "invalid" } });
    view.rerender(<SettingsDialog {...props} initialPage="saving" navigationRevision={2} />);
    expect(screen.getByRole("textbox", { name: "Default figure DPI" })).toBe(dpi);
    expect(dpi).toHaveFocus(); expect(dpi).toHaveValue("invalid");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search settings" }), { target: { value: "motion" } });
    view.rerender(<SettingsDialog {...props} initialPage="compute" navigationRevision={3} />);
    expect(screen.getByRole("tabpanel", { name: "Compute" })).toBeVisible();
    expect(screen.getByRole("searchbox", { name: "Search settings" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "Back to workspace" })).toBeVisible();
  });

  it("opens Compute before its worker request and cancels deferred work after a fast switch", async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    const request = vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(id => { frames.delete(id); });
    const paint = () => {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(performance.now());
    };
    const computeTargets = vi.fn().mockResolvedValue({ targets: [], study_profiles: [], study_binding: null });
    const view = render(<SettingsDialog initialPage="compute" computeApi={{ computeTargets }}
      preferences={DEFAULT_PREFERENCES} onChange={vi.fn()} onClose={vi.fn()} onQuit={vi.fn()} />);
    try {
      expect(screen.getByRole("tabpanel", { name: "Compute" })).toBeVisible();
      expect(screen.getByRole("status")).toHaveTextContent("Loading compute targets");
      expect(computeTargets).not.toHaveBeenCalled();
      act(paint);
      expect(computeTargets).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("tab", { name: "Appearance" }));
      act(paint);
      expect(computeTargets).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("tab", { name: "Compute" }));
      act(paint);
      await act(async () => paint());
      expect(computeTargets).toHaveBeenCalledExactlyOnceWith("list", {});
    } finally {
      view.unmount();
      request.mockRestore();
      cancel.mockRestore();
    }
  });

  it("wraps keyboard focus at both edges of the open dialog", () => {
    show();
    const search = screen.getByRole("searchbox", { name: "Search settings" });
    const done = screen.getByRole("button", { name: "Done" });
    search.focus();
    fireEvent.keyDown(search, { key: "Tab", shiftKey: true });
    expect(done).toHaveFocus();
    fireEvent.keyDown(done, { key: "Tab" });
    expect(search).toHaveFocus();
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
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(latestClose).toHaveBeenCalledOnce();
    view.unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });
});
