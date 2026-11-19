// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SettingsWindowApi, SettingsWindowNavigation } from "../shared/settings-window-api";
import { NativeSettingsWindow } from "./NativeSettingsWindow";
import { DEFAULT_PREFERENCES, PREFERENCES_STORAGE_KEY } from "./preferences";

function nativeSettings() {
  const unsubscribe = vi.fn();
  let navigate!: (route: SettingsWindowNavigation) => void;
  const api = {
    onNavigate: vi.fn((listener: typeof navigate) => { navigate = listener; return unsubscribe; }),
    getNavigation: vi.fn<SettingsWindowApi["getNavigation"]>().mockResolvedValue({ page: "appearance", revision: 1 }),
    close: vi.fn().mockResolvedValue(undefined),
    requestQuit: vi.fn().mockResolvedValue(undefined),
    computeTargets: vi.fn().mockResolvedValue({ targets: [], study_profiles: [] }),
  } satisfies SettingsWindowApi;
  return { api, navigate: (route: SettingsWindowNavigation) => act(() => navigate(route)), unsubscribe };
}

beforeEach(() => window.localStorage.clear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("accepts a newer native destination while the opening route is in flight", async () => {
  const { api, navigate, unsubscribe } = nativeSettings();
  let complete!: (route: SettingsWindowNavigation) => void;
  api.getNavigation.mockReturnValue(new Promise(resolve => { complete = resolve; }));
  const view = render(<NativeSettingsWindow api={api} />);
  navigate({ page: "compute", revision: 2 });
  expect(await screen.findByRole("tab", { name: "Compute", selected: true })).toBeVisible();
  expect(api.computeTargets).toHaveBeenCalledWith("list", {});
  await act(async () => complete({ page: "appearance", revision: 1 }));
  expect(screen.getByRole("tab", { name: "Compute", selected: true })).toBeVisible();
  navigate({ page: "appearance", revision: 3 });
  expect(screen.getByRole("tab", { name: "Appearance", selected: true })).toBeVisible();
  view.unmount();
  expect(unsubscribe).toHaveBeenCalledOnce();
});

it("returns from the manual to its settings category before Escape closes the window", async () => {
  const { api } = nativeSettings();
  render(<NativeSettingsWindow api={api} />);
  fireEvent.click(await screen.findByRole("tab", { name: "External agents" }));
  fireEvent.click(screen.getByRole("button", { name: "Read the agent workflow" }));
  expect(await screen.findByRole("heading", { name: "Work with external agents", level: 2 })).toBeVisible();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "User manual" })).toBeNull();
  expect(screen.getByRole("tab", { name: "External agents", selected: true })).toBeVisible();
  expect(api.close).not.toHaveBeenCalled();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(api.close).toHaveBeenCalledOnce();
});

it("reads saved appearance and cross-window changes without echoing them back to storage", async () => {
  const { api } = nativeSettings();
  const record = { ...DEFAULT_PREFERENCES, theme: "black", figureDpi: 600 };
  localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(record));
  const write = vi.spyOn(Storage.prototype, "setItem");
  render(<NativeSettingsWindow api={api} />);
  const theme = await screen.findByRole("combobox", { name: "Application theme" });
  expect(theme).toHaveValue("black");
  expect(write).not.toHaveBeenCalled();
  localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify({ ...record, theme: "paper" }));
  write.mockClear();
  fireEvent(window, new StorageEvent("storage", { key: PREFERENCES_STORAGE_KEY, storageArea: localStorage }));
  expect(theme).toHaveValue("paper");
  expect(document.documentElement).toHaveAttribute("data-theme", "paper");
  expect(write).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("radio", { name: "Comfortable" }));
  expect(write).toHaveBeenCalledOnce();
  expect(JSON.parse(localStorage.getItem(PREFERENCES_STORAGE_KEY)!)).toMatchObject({ density: "comfortable", theme: "paper", figureDpi: 600 });
});

it("preserves the applied appearance and reports a failed save", async () => {
  const { api } = nativeSettings();
  render(<NativeSettingsWindow api={api} />);
  const theme = await screen.findByRole("combobox", { name: "Application theme" });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
  fireEvent.change(theme, { target: { value: "black" } });
  expect(await screen.findByRole("alert")).toHaveTextContent("could not save");
  expect(theme).toHaveValue("graphite");
  expect(document.documentElement).toHaveAttribute("data-theme", "graphite");
});
