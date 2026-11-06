// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import UserGuideDialog, { GuideBody } from "./UserGuideDialog";

afterEach(cleanup);
describe("bundled user manual", () => {
  it("synchronizes a changed entry point while open and clears search for the requested topic", () => {
    const onClose = vi.fn();
    const view = render(<UserGuideDialog onClose={onClose} initialSection="work-with-external-agents" />);
    const search = screen.getByRole("searchbox", { name: "Search user manual" });
    const article = screen.getByRole("article", { name: "Loci user manual" });
    fireEvent.change(search, { target: { value: "histogram" } }); article.scrollTop = 240;
    view.rerender(<UserGuideDialog onClose={onClose} />);
    expect(search).toHaveValue(""); expect(article.scrollTop).toBe(0);
    expect(screen.getByRole("heading", { name: "Welcome" })).toHaveFocus();
    view.rerender(<UserGuideDialog onClose={onClose} initialSection="compose-and-reuse-workflows" />);
    expect(screen.getByRole("heading", { level: 2, name: "Compose and reuse workflows" })).toHaveFocus();
    view.rerender(<UserGuideDialog onClose={onClose} initialSection="unknown-topic" />);
    expect(screen.getByRole("heading", { name: "Welcome" })).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("opens one requested topic and navigates through headings and adjacent topics", () => {
    render(<UserGuideDialog onClose={vi.fn()} initialSection="work-with-external-agents" />);
    expect(screen.getByRole("heading", { level: 2, name: "Work with external agents" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Welcome" })).not.toBeInTheDocument();
    const contents = screen.getByRole("navigation", { name: "Manual contents" });
    expect(within(contents).getByRole("button", { name: "Work with external agents" })).toHaveAttribute("aria-current", "page");
    fireEvent.click(screen.getByRole("link", { name: "Inspect evidence and review results" }));
    expect(screen.getByRole("heading", { name: "Inspect evidence and review results" })).toHaveFocus();
    fireEvent.click(within(screen.getByRole("navigation", { name: "Adjacent topics" })).getByRole("button", { name: /Next Compose and reuse workflows/ }));
    expect(screen.getByRole("heading", { level: 2, name: "Compose and reuse workflows" })).toHaveFocus();
    fireEvent.click(within(screen.getByRole("navigation", { name: "Adjacent topics" })).getByRole("button", { name: /Previous Work with external agents/ }));
    expect(screen.getByRole("heading", { level: 2, name: "Work with external agents" })).toHaveFocus();
  });

  it("shows readable search excerpts and opens a matching topic without rendering the entire manual", () => {
    render(<UserGuideDialog onClose={vi.fn()} />);
    const search = screen.getByRole("searchbox", { name: "Search user manual" });
    fireEvent.change(search, { target: { value: "cancels" } });
    const article = screen.getByRole("article", { name: "Loci user manual" });
    expect(within(article).getByRole("status")).toHaveTextContent("2 matching topics");
    const match = within(article).getByRole("button", { name: /Work with external agents/ });
    expect(match).toHaveTextContent(/plan record/);
    fireEvent.click(match);
    expect(search).toHaveValue("");
    expect(screen.getByRole("heading", { level: 2, name: "Work with external agents" })).toHaveFocus();
    expect(screen.queryByRole("heading", { name: "First study with synthetic shapes" })).not.toBeInTheDocument();
  });

  it("falls back for an unknown topic and restores focus to its opener", () => {
    const opener = document.createElement("button"); document.body.append(opener); opener.focus();
    const close = vi.fn(); const view = render(<UserGuideDialog onClose={close} initialSection="absent-topic" />);
    expect(screen.getByRole("heading", { name: "Welcome" })).toBeVisible();
    const next = within(screen.getByRole("navigation", { name: "Adjacent topics" })).getByRole("button");
    next.focus(); fireEvent.keyDown(next, { key: "Tab" });
    expect(screen.getByRole("searchbox", { name: "Search user manual" })).toHaveFocus();
    view.unmount(); expect(opener).toHaveFocus(); opener.remove();
  });

  it("opens searchable offline content and supports keyboard dismissal", () => {
    const close = vi.fn();
    render(<UserGuideDialog onClose={close} />);
    expect(screen.getByRole("dialog", { name: "User manual" })).toBeVisible();
    const search = screen.getByRole("searchbox", { name: "Search user manual" });
    expect(search).toHaveFocus();
    fireEvent.change(search, { target: { value: "histogram" } });
    expect(screen.getByRole("navigation", { name: "Manual contents" }).querySelectorAll("button").length).toBeGreaterThan(0);
    fireEvent.change(search, { target: { value: "missingtermzxy" } });
    expect(screen.getByRole("status")).toHaveTextContent("No matching section");
    fireEvent.keyDown(search, { key: "Escape" }); expect(close).not.toHaveBeenCalled();
    expect(search).toHaveValue("");
    fireEvent.keyDown(search, { key: "Escape" }); expect(close).toHaveBeenCalledOnce();
  });
  it("resolves public documentation fragments and retains local anchors without path escapes", () => {
    render(<GuideBody text="[Capabilities](CAPABILITY_MATRIX.md#learned-analysis-routes) [Release](RELEASE_STATUS.md) [First study](workflows/FIRST_STUDY.md) [Here](#open-images) [outside](../secret.md)" />);
    expect(screen.getByRole("link", { name: "Capabilities" })).toHaveAttribute("href", "https://github.com/sidd-bme/loci-app/blob/main/docs/CAPABILITY_MATRIX.md#learned-analysis-routes");
    expect(screen.getByRole("link", { name: "Release" })).toHaveAttribute("href", "https://github.com/sidd-bme/loci-app/blob/main/docs/RELEASE_STATUS.md");
    expect(screen.getByRole("link", { name: "First study" })).toHaveAttribute("href", "https://github.com/sidd-bme/loci-app/blob/main/docs/workflows/FIRST_STUDY.md");
    expect(screen.getByRole("link", { name: "Here" })).toHaveAttribute("href", "#manual-open-images");
    expect(screen.queryByRole("link", { name: "outside" })).not.toBeInTheDocument();
  });
  it("renders code as text and declines executable link schemes", () => {
    const view = render(<GuideBody text={'<img src=x onerror=alert(1)>\n\n[unsafe](javascript:alert) and **exact source**\n\n| Action | Key |\n| --- | --- |\n| Fit | `F` |'} />);
    expect(view.container.querySelector("img")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("exact source").tagName).toBe("STRONG");
    expect(screen.getByRole("table")).toBeVisible();
  });
});
