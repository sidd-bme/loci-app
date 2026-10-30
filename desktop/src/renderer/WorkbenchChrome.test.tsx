// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManagedSessionState, ResearchDesktopApi, ResearchSource } from "../shared/research-contracts";
import { ImageWelcome, WorkbenchTools } from "./WorkbenchChrome";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

function welcome(recent: Array<Record<string, unknown>> = [],
  presentation: { dragActive?: boolean; busy?: boolean } = {}) {
  const onExample = vi.fn(), onOpen = vi.fn(), onStudy = vi.fn(), onLegacy = vi.fn(), onEmptyStudy = vi.fn(), onConvert = vi.fn(), onRecovery = vi.fn();
  const api = {
    recoveryList: vi.fn(async () => recent),
    recoveryKeep: vi.fn(),
  } as unknown as ResearchDesktopApi;
  const view = render(<ImageWelcome api={api} state={{ status: "empty" } as ManagedSessionState}
    onOpen={onOpen} onStudy={onStudy} onLegacy={onLegacy} onEmptyStudy={onEmptyStudy} onConvert={onConvert}
    onError={vi.fn()} onRecovery={onRecovery} onExample={onExample} {...presentation} />);
  return { ...view, onOpen, onStudy, onLegacy, onEmptyStudy, onRecovery, onExample, onConvert, api };
}

describe("image-first welcome", () => {
  it("offers an optional offline example without blocking normal opening", () => {
    const { onExample, onOpen } = welcome();
    fireEvent.click(screen.getByRole("button", { name: "Try a synthetic example" }));
    expect(onExample).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Try a synthetic example" })).toBeVisible();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("keeps the main entry and reveals optional formats without remounting it", async () => {
    const { onOpen, onStudy, onLegacy, onEmptyStudy, onConvert, api } = welcome();
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
    fireEvent.click(screen.getByRole("button", { name: "Convert vendor image format" }));
    expect(onConvert).toHaveBeenCalledOnce();
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
    expect(screen.getByRole("button", { name: "Try a synthetic example" })).toBeDisabled();
    fireEvent.click(primary);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("keeps the empty history concise without duplicated opening guidance", async () => {
    const { api } = welcome();
    await waitFor(() => expect(api.recoveryList).toHaveBeenCalled());
    expect(screen.getByRole("heading", { name: "Recent work" })).toBeVisible();
    expect(screen.getByText("No recent work yet")).toBeVisible();
    expect(screen.queryByRole("region", { name: "Research tips" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Explore, annotate/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Opened sessions and saved studies/)).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Open images" })).toHaveLength(1);
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


  it("keeps unavailable sessions disabled and preserves discard with undo", async () => {
    const recent = [
      { sessionId: "ready", title: "Ready study", status: "ready", storage: "managed", canDiscard: true },
      { sessionId: "missing", title: "Disconnected study", status: "recoverable", storage: "study", canDiscard: false },
    ];
    const { api, onRecovery } = welcome(recent);
    const unavailable = await screen.findByRole("button", { name: "Disconnected study" });
    expect(unavailable).toBeDisabled();
    expect(unavailable).toHaveTextContent("unavailable");
    fireEvent.click(unavailable);
    expect(api.recoveryKeep).not.toHaveBeenCalled();
    api.recoveryDiscard = vi.fn().mockResolvedValue({ undoToken: "undo-ready" });
    api.recoveryUndo = vi.fn().mockResolvedValue(undefined);
    api.getSnapshot = vi.fn().mockResolvedValue(null);
    fireEvent.click(screen.getByRole("button", { name: "Discard Ready study" }));
    await screen.findByRole("button", { name: "Undo" });
    expect(api.recoveryDiscard).toHaveBeenCalledWith("ready");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(api.recoveryUndo).toHaveBeenCalledWith("undo-ready"));
    await waitFor(() => expect(onRecovery).toHaveBeenCalledWith(null));
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
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

  it("closes tool search with Escape and returns focus to the search button", () => {
    const onTab = vi.fn();
    const source = { id: "source-1", metadata: { dimensions: { t: 1 } } } as unknown as ResearchSource;
    render(<WorkbenchTools tab="Analyze" onTab={onTab} source={source} hasResult={false} />);
    const searchButton = screen.getByRole("button", { name: "Search all tools" });
    fireEvent.click(searchButton);

    const searchInput = screen.getByRole("combobox", { name: "Search all tools" });
    expect(searchInput).toHaveFocus();
    fireEvent.change(searchInput, { target: { value: "cell" } });
    expect(screen.getByRole("listbox", { name: "All tools" })).toBeInTheDocument();

    fireEvent.keyDown(searchInput, { key: "Escape" });
    expect(screen.queryByRole("combobox", { name: "Search all tools" })).not.toBeInTheDocument();
    expect(screen.queryByRole("listbox", { name: "All tools" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Search all tools" })).toHaveFocus();
  });

  it("constrains tool selector popup within viewport boundaries", () => {
    const onTab = vi.fn();
    const source = { id: "source-1", metadata: { dimensions: { t: 1 } } } as unknown as ResearchSource;
    window.innerWidth = 1024;
    window.innerHeight = 720;
    render(<WorkbenchTools tab="Analyze" onTab={onTab} source={source} hasResult={false} />);
    const trigger = screen.getByRole("combobox", { name: "Analyze tool" });

    // Place near bottom-right edge of a 1024x720 viewport
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      x: 800, y: 650, top: 650, right: 1020, bottom: 690, left: 800, width: 220, height: 40,
      toJSON: () => ({}),
    });

    fireEvent.click(trigger);
    const listbox = screen.getByRole("listbox", { name: "Analyze tool" });
    expect(listbox.className).toContain("is-above");
    const left = parseInt(listbox.style.left, 10);
    const width = parseInt(listbox.style.width, 10);
    expect(left + width).toBeLessThanOrEqual(1024 - 8);
    expect(left).toBeGreaterThanOrEqual(8);
  });

  it("remembers a chosen tool when returning to its group", () => {
    const onTab = vi.fn();
    const source = { id: "source-1", metadata: { dimensions: { t: 1 } } } as unknown as ResearchSource;
    const view = render(<WorkbenchTools tab="Analyze" onTab={onTab} source={source} hasResult={false} />);
    fireEvent.click(screen.getByRole("combobox", { name: "Analyze tool" }));
    fireEvent.click(screen.getByRole("option", { name: "Preprocess" }));
    expect(onTab).toHaveBeenLastCalledWith("Process");
    view.rerender(<WorkbenchTools tab="Process" onTab={onTab} source={source} hasResult={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Results" }));
    view.rerender(<WorkbenchTools tab="Info" onTab={onTab} source={source} hasResult={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Analyze" }));
    expect(onTab).toHaveBeenLastCalledWith("Process");
  });

  it("remembers externally selected tools and falls back when their requirements change", () => {
    const onTab = vi.fn();
    const source = { id: "source-1", metadata: { dimensions: { t: 3 } } } as unknown as ResearchSource;
    const view = render(<WorkbenchTools tab="Display" onTab={onTab} source={source} hasResult={false} />);
    view.rerender(<WorkbenchTools tab="Temporal" onTab={onTab} source={source} hasResult={false} />);
    view.rerender(<WorkbenchTools tab="Study" onTab={onTab} source={source} hasResult={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Analyze" }));
    expect(onTab).toHaveBeenLastCalledWith("Temporal");
    const stillSource = { ...source, metadata: { dimensions: { t: 1 } } } as unknown as ResearchSource;
    view.rerender(<WorkbenchTools tab="Study" onTab={onTab} source={stillSource} hasResult={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Analyze" }));
    expect(onTab).toHaveBeenLastCalledWith("Analyze");
  });

  it.each([
    ["Display", "View", "Import & conversion", "Convert vendor images", "Vendor import"],
    ["Analyze", "Analyze", "Connections", "Remote compute", "Remote"],
    ["Study", "Results", "Portable results", "Import & share results", "Portability"],
  ] as const)("exposes secondary tools from the %s selector", (tab, group, section, label, selected) => {
    const onTab = vi.fn();
    const source = { id: "source-1", metadata: { dimensions: { t: 1 } } } as unknown as ResearchSource;
    render(<WorkbenchTools tab={tab} onTab={onTab} source={source} hasResult={false} />);
    const trigger = screen.getByRole("combobox", { name: `${group} tool` });
    fireEvent.click(trigger);
    expect(screen.getByRole("group", { name: section })).toBeVisible();
    fireEvent.click(screen.getByRole("option", { name: label }));
    expect(onTab).toHaveBeenLastCalledWith(selected);
    expect(trigger).toHaveFocus();
  });

  it("exposes spatial donor density as a Results tool and searchable assay", () => {
    const onTab = vi.fn();
    const source = { id: "source-1", metadata: {} } as unknown as ResearchSource;
    render(<WorkbenchTools tab="Info" onTab={onTab} source={source} hasResult />);
    fireEvent.click(screen.getByRole("combobox", { name: "Results tool" }));
    fireEvent.click(screen.getByRole("option", { name: "Spatial donor density" }));
    expect(onTab).toHaveBeenLastCalledWith("Density");
    fireEvent.click(screen.getByRole("button", { name: "Search all tools" }));
    const input = screen.getByRole("combobox", { name: "Search all tools" });
    fireEvent.change(input, { target: { value: "donor" } });
    fireEvent.keyDown(input, { key: "ArrowDown" }); fireEvent.keyDown(input, { key: "Enter" });
    expect(onTab).toHaveBeenLastCalledWith("Density");
  });

  it("selects filtered search results with the keyboard and restores focus", () => {
    const onTab = vi.fn();
    const source = { id: "source-1", metadata: { dimensions: { t: 1 } } } as unknown as ResearchSource;
    render(<WorkbenchTools tab="Display" onTab={onTab} source={source} hasResult={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Search all tools" }));
    const input = screen.getByRole("combobox", { name: "Search all tools" });
    fireEvent.change(input, { target: { value: " remote " } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const option = screen.getByRole("option", { name: /Remote compute/ });
    expect(input).toHaveAttribute("aria-activedescendant", option.id);
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onTab).toHaveBeenLastCalledWith("Remote");
    expect(screen.queryByRole("listbox", { name: "All tools" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Search all tools" })).toHaveFocus();
  });

  it("skips unavailable search results and supports wraparound and endpoints", () => {
    const onTab = vi.fn();
    render(<WorkbenchTools tab="Display" onTab={onTab} source={null} hasResult={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Search all tools" }));
    const input = screen.getByRole("combobox", { name: "Search all tools" });
    const first = screen.getByRole("option", { name: /Import & share results/ });
    const last = screen.getByRole("option", { name: /Convert vendor images/ });
    expect(last.id).not.toMatch(/\s/); // aria-activedescendant requires one valid IDREF.
    expect(screen.getByRole("option", { name: /Segment & measure/ })).toBeDisabled();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", first.id);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input).toHaveAttribute("aria-activedescendant", last.id);
    fireEvent.keyDown(input, { key: "Home" });
    expect(input).toHaveAttribute("aria-activedescendant", first.id);
    fireEvent.keyDown(input, { key: "End" });
    expect(input).toHaveAttribute("aria-activedescendant", last.id);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onTab).toHaveBeenCalledWith("Vendor import");
  });

  it("shows no-match recovery and never activates an unavailable result", () => {
    const onTab = vi.fn();
    const source = { id: "source-1", metadata: { dimensions: { t: 1 } } } as unknown as ResearchSource;
    render(<WorkbenchTools tab="Analyze" onTab={onTab} source={source} hasResult={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Search all tools" }));
    const input = screen.getByRole("combobox", { name: "Search all tools" });
    fireEvent.change(input, { target: { value: "track" } });
    const unavailable = screen.getByRole("option", { name: /Track over time/ });
    expect(unavailable).toBeDisabled();
    expect(unavailable).toHaveTextContent("Tracking needs a time series or timed result set");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).not.toHaveAttribute("aria-activedescendant");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onTab).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "no-such-tool" } });
    expect(screen.getByRole("status")).toHaveTextContent("No tools match “no-such-tool”.");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onTab).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(input).toHaveValue("");
    expect(input).toHaveFocus();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(19);
    expect(screen.getByRole("option", { name: /Spatial donor density/ })).toBeVisible();
    expect(screen.getByRole("option", { name: /Workflow builder/ })).toBeEnabled();
  });

  it("opens prerequisite routes for scalar fluorescence and correction", () => {
    const onTab = vi.fn();
    const source = { id: "source-1", metadata: { dimensions: { t: 1 }, sample_semantics: "RGB" } } as unknown as ResearchSource;
    const view = render(<WorkbenchTools tab="Analyze" onTab={onTab} source={source} hasResult={false} />);
    fireEvent.click(screen.getByRole("combobox", { name: "Analyze tool" }));
    const fluorescence = screen.getByRole("option", { name: /Fluorescence & field assay/ });
    expect(fluorescence).toBeEnabled();
    fireEvent.click(fluorescence);
    expect(onTab).toHaveBeenLastCalledWith("Quantify");
    view.rerender(<WorkbenchTools tab="Annotate" onTab={onTab} source={source} hasResult={false} />);
    fireEvent.click(screen.getByRole("combobox", { name: "Annotate tool" }));
    const correction = screen.getByRole("option", { name: /Edit labels & ROIs/ });
    expect(correction).toBeEnabled();
    fireEvent.click(correction);
    expect(onTab).toHaveBeenLastCalledWith("Correction");
  });
});
