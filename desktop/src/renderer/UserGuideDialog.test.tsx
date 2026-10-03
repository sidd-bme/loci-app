// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import UserGuideDialog, { GuideBody } from "./UserGuideDialog";

afterEach(cleanup);
describe("bundled user manual", () => {
  it("opens searchable offline content and supports keyboard dismissal", () => {
    const close = vi.fn();
    render(<UserGuideDialog onClose={close} />);
    expect(screen.getByRole("dialog", { name: "User manual" })).toBeVisible();
    const search = screen.getByRole("textbox", { name: "Search user manual" });
    expect(search).toHaveFocus();
    fireEvent.change(search, { target: { value: "histogram" } });
    expect(screen.getByRole("navigation", { name: "Manual contents" }).querySelectorAll("button").length).toBeGreaterThan(0);
    fireEvent.change(search, { target: { value: "missingtermzxy" } });
    expect(screen.getByRole("status")).toHaveTextContent("No matching section");
    fireEvent.keyDown(search, { key: "Escape" }); expect(close).toHaveBeenCalledOnce();
  });
  it("resolves repository manual links to the public documentation and retains local anchors", () => {
    render(<GuideBody text={'[Capabilities](CAPABILITY_MATRIX.md#learned-analysis-routes) [Release](RELEASE_STATUS.md) [Here](#open-images) [outside](../secret.md)'} />);
    expect(screen.getByRole("link", { name: "Capabilities" })).toHaveAttribute("href", "https://github.com/sidd-bme/loci-app/blob/main/docs/CAPABILITY_MATRIX.md#learned-analysis-routes");
    expect(screen.getByRole("link", { name: "Release" })).toHaveAttribute("href", "https://github.com/sidd-bme/loci-app/blob/main/docs/RELEASE_STATUS.md");
    expect(screen.getByRole("link", { name: "Here" })).toHaveAttribute("href", "#manual-open-images");
    expect(screen.queryByRole("link", { name: "outside" })).toBeNull();
  });
  it("renders code as text and declines executable link schemes", () => {
    const view = render(<GuideBody text={'<img src=x onerror=alert(1)>\n\n[unsafe](javascript:alert) and **exact source**\n\n| Action | Key |\n| --- | --- |\n| Fit | `F` |'} />);
    expect(view.container.querySelector("img")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("exact source").tagName).toBe("STRONG");
    expect(screen.getByRole("table")).toBeVisible();
  });
});
