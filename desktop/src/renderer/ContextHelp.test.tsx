// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextHelp, ResearchError, sanitizeRendererError } from "./ContextHelp";

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("context help", () => {
  it("suppresses native bubbles and retains one tooltip across SVG children", () => {
    vi.useFakeTimers();
    render(<><button title="Fit the full image" aria-describedby="existing"><svg data-testid="icon"><path data-testid="path" /></svg></button><ContextHelp /></>);
    const button = screen.getByRole("button"), icon = screen.getByTestId("icon"), path = screen.getByTestId("path");
    expect(button).not.toHaveAttribute("title");
    fireEvent.pointerOver(icon);
    act(() => vi.advanceTimersByTime(500));
    const tooltip = screen.getByRole("tooltip");
    expect(button.getAttribute("aria-describedby")).toBe(`existing ${tooltip.id}`);
    fireEvent.pointerOut(icon, { relatedTarget: path });
    fireEvent.pointerOver(path);
    expect(screen.getByRole("tooltip")).toBe(tooltip);
    fireEvent.pointerOut(path, { relatedTarget: document.body });
    act(() => vi.advanceTimersByTime(80));
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(button).toHaveAttribute("aria-describedby", "existing");
  });

  it("supports keyboard focus and Escape without duplicating help in a status area", () => {
    vi.useFakeTimers();
    render(<><button title="Stable display range">Auto</button><ContextHelp /></>);
    const button = screen.getByRole("button");
    fireEvent.keyDown(document.body, { key: "Tab" });
    fireEvent.focusIn(button);
    act(() => vi.advanceTimersByTime(0));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Stable display range");
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.keyDown(button, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(button).not.toHaveAttribute("aria-describedby");
  });

  it("clears help after clicking even when the button keeps pointer focus", () => {
    vi.useFakeTimers();
    render(<><button title="Explore the complete raw volume">3D volume</button><ContextHelp /></>);
    const button = screen.getByRole("button");
    fireEvent.pointerOver(button);
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByRole("tooltip")).toBeVisible();
    fireEvent.pointerDown(button);
    fireEvent.focusIn(button);
    fireEvent.click(button);
    fireEvent.pointerOut(button, { relatedTarget: document.body });
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(button).not.toHaveAttribute("aria-describedby");
  });

  it("keeps hover help readable over the tooltip and cancels a pending hover on exit", () => {
    vi.useFakeTimers();
    render(<><button title="Secondary explanation">Action</button><ContextHelp /></>);
    const button = screen.getByRole("button");
    fireEvent.pointerOver(button);
    fireEvent.pointerOut(button, { relatedTarget: document.body });
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.pointerOver(button);
    act(() => vi.advanceTimersByTime(500));
    const tooltip = screen.getByRole("tooltip");
    fireEvent.pointerOut(button, { relatedTarget: tooltip });
    fireEvent.pointerOver(tooltip);
    act(() => vi.advanceTimersByTime(1000));
    expect(tooltip).toBeVisible();
    fireEvent.pointerOut(tooltip, { relatedTarget: document.body });
    act(() => vi.advanceTimersByTime(80));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("supports mouse hover events when a host does not dispatch pointer events", () => {
    vi.useFakeTimers();
    render(<><button title="Mouse explanation"><svg data-testid="mouse-icon" /></button><ContextHelp /></>);
    const button = screen.getByRole("button");
    fireEvent.mouseOver(screen.getByTestId("mouse-icon"));
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Mouse explanation");
    fireEvent.mouseOut(button, { relatedTarget: document.body });
    act(() => vi.advanceTimersByTime(80));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});

it("dismisses a tip using its visible close control", () => {
  vi.useFakeTimers();
  render(<><button title="Fit explanation">Fit</button><ContextHelp /></>);
  const owner = screen.getByRole("button", { name: "Fit" });
  fireEvent.pointerOver(owner); act(() => vi.advanceTimersByTime(500));
  fireEvent.click(screen.getByRole("button", { name: "Close tip" }));
  expect(screen.queryByRole("tooltip")).toBeNull();
  expect(owner).not.toHaveAttribute("aria-describedby");
});

describe("sanitizeRendererError and ResearchError", () => {
  it("redacts macOS paths with spaces while preserving subsequent error context", () => {
    const raw = "Failed to open /Users/alice/my experiment/specimen.tif: unsupported tile format";
    const sanitized = sanitizeRendererError(raw);
    expect(sanitized).toBe("Failed to open [local path redacted]: unsupported tile format");
  });

  it("redacts Linux paths including /home/ and system roots", () => {
    const raw = "Error: /home/bob/project/data.ims: HDF5 header damaged";
    const sanitized = sanitizeRendererError(raw);
    expect(sanitized).toBe("Error: [local path redacted]: HDF5 header damaged");

    const tmpError = "Failed to read /tmp/scratch/buffer.raw: unexpected EOF";
    expect(sanitizeRendererError(tmpError)).toBe("Failed to read [local path redacted]: unexpected EOF");
  });

  it("redacts Windows drive letters and UNC network paths", () => {
    const driveError = "Cannot access C:\\Users\\bob\\data\\test.ndpi: file locked";
    expect(sanitizeRendererError(driveError)).toBe("Cannot access [local path redacted]: file locked");

    const uncError = "Cannot access \\\\server\\share\\data\\test.ndpi: network timeout";
    expect(sanitizeRendererError(uncError)).toBe("Cannot access [local path redacted]: network timeout");
  });

  it("redacts quoted paths with single, double, or backtick quotes preserving delimiters and context", () => {
    const single = "Failed to load '/Users/sid/my lab/image.tif': corrupt file";
    expect(sanitizeRendererError(single)).toBe("Failed to load '[local path redacted]': corrupt file");

    const double = 'Failed to load "/home/alice/test with spaces.tif": bad magic';
    expect(sanitizeRendererError(double)).toBe('Failed to load "[local path redacted]": bad magic');

    const backtick = "Failed to load `C:\\Data\\specimen.tif`: invalid compression";
    expect(sanitizeRendererError(backtick)).toBe("Failed to load `[local path redacted]`: invalid compression");
  });

  it("strips IPC remote method wrapper prefix", () => {
    const raw = "Error invoking remote method 'loci-research-view': Error: Failed to open /Volumes/Ext/img.tif: corrupt";
    expect(sanitizeRendererError(raw)).toBe("Failed to open [local path redacted]: corrupt");
  });

  it("preserves safe non-path errors untouched", () => {
    const nonPathErrors = [
      "Value out of range: 10 > 5",
      "Division by zero in calculation",
      "Saved display settings do not match this source.",
      "HTTP 404: Not Found",
      "Channel index 3 is greater than total channels 2",
    ];
    for (const err of nonPathErrors) {
      expect(sanitizeRendererError(err)).toBe(err);
    }
  });

  it("renders ResearchError with alert role, redacted details, and responsive dismiss control", () => {
    const onDismiss = vi.fn();
    render(
      <ResearchError
        error="Failed to open /Users/researcher/data/image.tif: file corrupted"
        onDismiss={onDismiss}
      />
    );

    const alert = screen.getByRole("alert");
    expect(alert).toBeInTheDocument();
    expect(alert).toHaveTextContent("Failed to open [local path redacted]: file corrupted");

    // Path must not appear in plaintext anywhere in the rendered alert
    expect(alert.textContent).not.toContain("/Users/researcher/data/image.tif");

    // Dismissing calls the onDismiss callback
    const dismissButton = screen.getByRole("button", { name: "Dismiss" });
    fireEvent.click(dismissButton);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("provides tailored summaries for source changes and unavailable studies", () => {
    const { rerender } = render(
      <ResearchError
        error="Source sha256 checksum mismatch for /Volumes/Ext/sample.tif: expected abc, got def"
        onDismiss={() => {}}
      />
    );
    expect(screen.getByText("This source has changed. Reopen an intact copy to continue.")).toBeInTheDocument();

    rerender(
      <ResearchError
        error="Target study path is an unavailable study directory"
        onDismiss={() => {}}
      />
    );
    expect(screen.getByText("This study is unavailable. Locate it again or open another image.")).toBeInTheDocument();
  });
});
