// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SegmentationAllowanceControl } from "./SegmentationAllowanceControl";
import { recipeResources } from "../shared/recipe-resources";
import type { ResearchDesktopApi } from "../shared/research-contracts";

afterEach(() => {
  cleanup();
});

function mockApi(overrides: Partial<ResearchDesktopApi> = {}): ResearchDesktopApi {
  return {
    createStudy: vi.fn(),
    openStudy: vi.fn(),
    getSnapshot: vi.fn(),
    addSources: vi.fn(),
    execute: vi.fn(),
    reviewResult: vi.fn(),
    exportResult: vi.fn(),
    cancelJob: vi.fn(),
    recipeResources: vi.fn().mockResolvedValue(recipeResources(8 * 1024 ** 3)),
    ...overrides,
  };
}

describe("SegmentationAllowanceControl", () => {
  it("renders accessible allowance select with GiB options and recommendation advice", async () => {
    const api = mockApi();
    const onWorkingBytesChange = vi.fn();

    render(
      <SegmentationAllowanceControl
        api={api}
        workingBytes={512 * 1024 ** 2}
        onWorkingBytesChange={onWorkingBytesChange}
        busy={false}
        accessibleName="Cellpose memory allowance"
        note="Model checkpoint and PyTorch runtime memory are additional."
      />,
    );

    const select = screen.getByLabelText("Cellpose memory allowance");
    expect(select).toBeVisible();
    expect(select).toHaveValue(String(512 * 1024 ** 2));
    expect(screen.queryByText(/Resolution and source precision stay unchanged/)).not.toBeInTheDocument();
    expect(screen.getByText("Model checkpoint and PyTorch runtime memory are additional.")).toBeVisible();

    await waitFor(() => {
      expect(screen.getByText(/8 GiB installed · 2 GiB recommended/)).toBeVisible();
    });

    const recommendedButton = screen.getByRole("button", { name: "Use recommended" });
    expect(recommendedButton).toBeVisible();
    fireEvent.click(recommendedButton);
    expect(onWorkingBytesChange).toHaveBeenCalledWith(2 * 1024 ** 3);

    fireEvent.change(select, { target: { value: String(2 * 1024 ** 3) } });
    expect(onWorkingBytesChange).toHaveBeenLastCalledWith(2 * 1024 ** 3);
  });

  it("shows advisory warning when selected allowance exceeds recommendation", async () => {
    const api = mockApi();
    const onWorkingBytesChange = vi.fn();

    render(
      <SegmentationAllowanceControl
        api={api}
        workingBytes={4 * 1024 ** 3}
        onWorkingBytesChange={onWorkingBytesChange}
        busy={false}
        accessibleName="Adaptive memory allowance"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/Above the 2 GiB recommendation/)).toBeVisible();
    });
  });

  it("disables controls when busy is true", () => {
    const api = mockApi();
    const onWorkingBytesChange = vi.fn();

    render(
      <SegmentationAllowanceControl
        api={api}
        workingBytes={512 * 1024 ** 2}
        onWorkingBytesChange={onWorkingBytesChange}
        busy={true}
        accessibleName="Cellpose memory allowance"
      />,
    );

    expect(screen.getByLabelText("Cellpose memory allowance")).toBeDisabled();
  });

  it("handles missing or failing hardware recommendation gracefully", async () => {
    const api = mockApi({
      recipeResources: vi.fn().mockRejectedValue(new Error("unavailable")),
    });

    render(
      <SegmentationAllowanceControl
        api={api}
        workingBytes={512 * 1024 ** 2}
        onWorkingBytesChange={vi.fn()}
        busy={false}
        accessibleName="Adaptive memory allowance"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Hardware recommendation unavailable.")).toBeVisible();
    });
  });
});
