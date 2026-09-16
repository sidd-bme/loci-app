// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManagedSessionState, ResearchDesktopApi, ResearchSource } from "../shared/research-contracts";
import { ImageWelcome, WorkbenchTools } from "./WorkbenchChrome";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function welcome(recent: Array<Record<string, unknown>> = [],
  presentation: { dragActive?: boolean; busy?: boolean } = {}) {
  const onOpen = vi.fn(), onStudy = vi.fn(), onLegacy = vi.fn(), onEmptyStudy = vi.fn(), onRecovery = vi.fn();
  const api = {
    recoveryList: vi.fn(async () => recent),
    recoveryKeep: vi.fn(),
  } as unknown as ResearchDesktopApi;
  const view = render(<ImageWelcome api={api} state={{ status: "empty" } as ManagedSessionState}
    onOpen={onOpen} onStudy={onStudy} onLegacy={onLegacy} onEmptyStudy={onEmptyStudy}
    onError={vi.fn()} onRecovery={onRecovery} {...presentation} />);
  return { ...view, onOpen, onStudy, onLegacy, onEmptyStudy, onRecovery, api };
}

describe("image-first welcome", () => {
  it("keeps the main entry and reveals optional formats without remounting it", async () => {
    const { onOpen, onStudy, onLegacy, onEmptyStudy, api } = welcome();
    await waitFor(() => expect(api.recoveryList).toHaveBeenCalled());
    const primary = screen.getByRole("button", { name: "Open images" });
    const options = screen.getByRole("button", { name: "More opening options" });
    const region = document.getElementById(options.getAttribute("aria-controls")!)!;
    expect(region).toHaveAttribute("inert");
    fireEvent.click(primary);
    expect(onOpen).toHaveBeenCalledWith();
    fireEvent.click(screen.getByRole("button", { name: "Open folder" }));
    expect(onOpen).toHaveBeenLastCalledWith("folder");
    fireEvent.click(screen.getByRole("button", { name: "Open study" }));
    expect(onStudy).toHaveBeenCalledOnce();
    fireEvent.click(options);
    expect(options).toHaveAttribute("aria-expanded", "true");
    expect(region).not.toHaveAttribute("inert");
    expect(screen.getByRole("button", { name: "Open images" })).toBe(primary);
    fireEvent.click(screen.getByRole("button", { name: "DICOM series" }));
    expect(onOpen).toHaveBeenLastCalledWith("dicom");
    fireEvent.click(screen.getByRole("button", { name: "OME-Zarr store" }));
    expect(onOpen).toHaveBeenLastCalledWith("ome_zarr");
    fireEvent.click(screen.getByRole("button", { name: "Open .loci-project" }));
    expect(onLegacy).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "New empty study" }));
    expect(onEmptyStudy).toHaveBeenCalledOnce();
    fireEvent.click(options);
    expect(region).toHaveAttribute("inert");
    expect(options).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps the optical pulse keyboard accessible, independent, and bounded", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
    const { container } = welcome();
    const emblem = screen.getByRole("button", { name: "Activate the Loci optical phase pulse" });
    emblem.focus();
    expect(emblem).toHaveFocus();
    fireEvent.click(emblem, { detail: 0 });
    expect(container.querySelectorAll(".welcome-phase-pulse")).toHaveLength(1);
    fireEvent.click(emblem, { detail: 0 });
    fireEvent.click(emblem, { detail: 0 });
    let pulses = container.querySelectorAll(".welcome-phase-pulse");
    expect(pulses).toHaveLength(3);
    const retainedIds = [pulses[0].getAttribute("data-pulse-id"), pulses[2].getAttribute("data-pulse-id")];
    // jsdom lacks AnimationEvent, so React registers the WebKit fallback.
    fireEvent(pulses[1], new Event("webkitAnimationEnd", { bubbles: true }));
    pulses = container.querySelectorAll(".welcome-phase-pulse");
    expect(pulses).toHaveLength(2);
    expect([...pulses].map((pulse) => pulse.getAttribute("data-pulse-id"))).toEqual(retainedIds);
    for (let index = 0; index < 12; index++) fireEvent.click(emblem, { detail: 0 });
    pulses = container.querySelectorAll(".welcome-phase-pulse");
    expect(pulses).toHaveLength(6);
    for (const pulse of pulses) fireEvent(pulse, new Event("webkitAnimationEnd", { bubbles: true }));
    expect(container.querySelectorAll(".welcome-phase-pulse")).toHaveLength(0);
  });

  it("respects reduced motion when the mark is activated", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    const { container, api } = welcome();
    fireEvent.click(screen.getByRole("button", { name: "Activate the Loci optical phase pulse" }));
    await waitFor(() => expect(api.recoveryList).toHaveBeenCalled());
    expect(container.querySelectorAll(".welcome-phase-pulse")).toHaveLength(0);
  });

  it("cleans active propagation when reduced motion is enabled", () => {
    let change: (() => void) | undefined;
    const preference = {
      matches: false,
      addEventListener: vi.fn((_event: string, listener: () => void) => { change = listener; }),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal("matchMedia", vi.fn(() => preference));
    const { container } = welcome();
    fireEvent.click(screen.getByRole("button", { name: "Activate the Loci optical phase pulse" }));
    expect(container.querySelectorAll(".welcome-phase-pulse")).toHaveLength(1);
    preference.matches = true;
    act(() => change?.());
    expect(container.querySelectorAll(".welcome-phase-pulse")).toHaveLength(0);
  });

  it("shows a truthful drop state and disables opening actions while busy", () => {
    const { onOpen } = welcome([], { dragActive: true, busy: true });
    expect(screen.getByRole("heading", { name: "Drop to open" })).toBeVisible();
    expect(screen.getByText(/let Loci validate/)).toBeVisible();
    const primary = screen.getByRole("button", { name: "Open images" });
    expect(primary).toBeDisabled();
    fireEvent.click(primary);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("keeps truthful recent and manual research guidance visible when history is empty", async () => {
    const { api } = welcome();
    await waitFor(() => expect(api.recoveryList).toHaveBeenCalled());
    expect(screen.getByRole("heading", { name: "Recent work" })).toBeVisible();
    expect(screen.getByText("No recent work yet")).toBeVisible();
    expect(screen.getByText("Opened sessions and saved studies will appear here.")).toBeVisible();
    expect(screen.getByRole("region", { name: "Research tips" })).toBeVisible();
    expect(screen.getByText("Drag and drop to open")).toBeVisible();
  });

  it("shows five recent sessions until View all, exposes registry update time, and reopens one", async () => {
    const recent = Array.from({ length: 6 }, (_, index) => ({
      sessionId: `session-${index}`,
      title: `Study ${index}`,
      storage: "managed",
      saved: false,
      status: "ready",
      reason: null,
      canKeep: true,
      canDiscard: false,
      updatedAt: index === 0 ? "2026-09-08T02:30:00.000Z" : undefined,
    }));
    const { api, onRecovery } = welcome(recent);
    vi.mocked(api.recoveryKeep!).mockResolvedValue({ project: { title: "Study 0" } } as never);
    await screen.findByRole("button", { name: /Study 0/ });
    expect(screen.getAllByRole("button", { name: /Study [0-9]/ })).toHaveLength(5);
    expect(screen.getByText(/^Updated /)).toHaveAttribute("datetime", "2026-09-08T02:30:00.000Z");
    fireEvent.click(screen.getByRole("button", { name: "View all" }));
    expect(screen.getAllByRole("button", { name: /Study [0-9]/ })).toHaveLength(6);
    fireEvent.click(screen.getByRole("button", { name: "Show fewer" }));
    expect(screen.getAllByRole("button", { name: /Study [0-9]/ })).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: /Study 0/ }));
    await waitFor(() => expect(api.recoveryKeep).toHaveBeenCalledWith("session-0"));
    await waitFor(() => expect(onRecovery).toHaveBeenCalled());
  });

  it("moves through research tips by buttons and keyboard and runs their real open actions", () => {
    const { onOpen, onStudy } = welcome();
    const tips = screen.getByRole("region", { name: "Research tips" });
    fireEvent.click(screen.getByRole("button", { name: "Next tip" }));
    expect(screen.getByText("Inspect a DICOM series")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Choose DICOM files" }));
    expect(onOpen).toHaveBeenLastCalledWith("dicom");
    fireEvent.keyDown(tips, { key: "ArrowRight" });
    expect(screen.getByText("Open local multiscale data")).toBeVisible();
    fireEvent.keyDown(tips, { key: "ArrowLeft" });
    expect(screen.getByText("Inspect a DICOM series")).toBeVisible();
    fireEvent.keyDown(tips, { key: "End" });
    expect(screen.getByText("Resume a saved study")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Choose study" }));
    expect(onStudy).toHaveBeenCalledOnce();
    fireEvent.keyDown(tips, { key: "Home" });
    expect(screen.getByText("Drag and drop to open")).toBeVisible();
  });

  it("binds supported-format shortcuts to the matching explicit picker", () => {
    const { onOpen } = welcome();
    fireEvent.click(screen.getByRole("button", { name: "TIFF" }));
    expect(onOpen).toHaveBeenLastCalledWith();
    fireEvent.click(screen.getByRole("button", { name: "DICOM" }));
    expect(onOpen).toHaveBeenLastCalledWith("dicom");
    fireEvent.click(screen.getByRole("button", { name: "OME-Zarr" }));
    expect(onOpen).toHaveBeenLastCalledWith("ome_zarr");
  });
});

describe("workbench tool selector", () => {
  it("uses an anchored listbox that supports keyboard selection and dismissal", () => {
    const onTab = vi.fn();
    const source = { id: "source-1", metadata: { dimensions: { t: 1 } } } as unknown as ResearchSource;
    render(<WorkbenchTools tab="Study" onTab={onTab} source={source} hasResult={false} />);
    const trigger = screen.getByRole("combobox", { name: "Results tool" });
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      x: 30, y: 100, top: 100, right: 270, bottom: 136, left: 30, width: 240, height: 36,
      toJSON: () => ({}),
    });

    fireEvent.click(trigger);
    const listbox = screen.getByRole("listbox", { name: "Results tool" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(listbox).toHaveStyle({ top: "140px", left: "30px", width: "240px" });
    expect(listbox.style.maxHeight).toMatch(/px$/);

    fireEvent.keyDown(trigger, { key: "Home" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(onTab).toHaveBeenCalledWith("Info");
    expect(screen.queryByRole("listbox", { name: "Results tool" })).not.toBeInTheDocument();

    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("listbox", { name: "Results tool" })).not.toBeInTheDocument();

    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("listbox", { name: "Results tool" })).not.toBeInTheDocument();
  });
});
