// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import guideMarkdown from "../../../docs/USING_LOCI.md?raw";
import UserGuideDialog, { GuideBody } from "./UserGuideDialog";
import { isPublicManualDocUrl, parseGuide, resolveGuideTarget, safeLink } from "./user-guide-model";

const originalMatchMedia = window.matchMedia;

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: originalMatchMedia,
  });
  vi.restoreAllMocks();
});

function mockCompactViewport(matches: boolean) {
  const listeners = new Set<() => void>();
  const mql = {
    matches,
    media: "(max-width: 820px)",
    onchange: null,
    addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
  };
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn(() => mql as unknown as MediaQueryList),
  });
  return mql;
}

describe("bundled user manual", () => {
  it("synchronizes a changed entry point while open and clears search for the requested topic", () => {
    const onClose = vi.fn();
    const view = render(<UserGuideDialog onClose={onClose} initialSection="work-with-external-agents" />);
    const search = screen.getByRole("searchbox", { name: "Search user manual" });
    const article = screen.getByRole("article", { name: "Loci user manual" });
    fireEvent.change(search, { target: { value: "histogram" } });
    article.scrollTop = 240;
    view.rerender(<UserGuideDialog onClose={onClose} />);
    expect(search).toHaveValue("");
    expect(article.scrollTop).toBe(0);
    expect(screen.getByRole("heading", { name: "Welcome" })).toHaveFocus();
    view.rerender(<UserGuideDialog onClose={onClose} initialSection="compose-and-reuse-workflows" />);
    expect(screen.getByRole("heading", { level: 2, name: "Compose and reuse workflows" })).toHaveFocus();
    view.rerender(<UserGuideDialog onClose={onClose} initialSection="convert-study-images-to-ome-tiff-or-ome-zarr" />);
    expect(screen.getByRole("heading", { level: 3, name: "Convert study images to OME-TIFF or OME-Zarr" })).toHaveFocus();
    view.rerender(<UserGuideDialog onClose={onClose} initialSection="unknown-topic" />);
    expect(screen.getByRole("heading", { name: "Welcome" })).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("opens one requested topic and navigates through breadcrumbs, headings, adjacent topics, and history", () => {
    render(<UserGuideDialog onClose={vi.fn()} initialSection="work-with-external-agents" />);
    expect(screen.getByRole("heading", { level: 2, name: "Work with external agents" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Welcome" })).not.toBeInTheDocument();

    const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(breadcrumb).toHaveTextContent("Settings & automation");
    expect(breadcrumb).toHaveTextContent("Work with external agents");

    const contents = screen.getByRole("navigation", { name: "Manual contents" });
    expect(within(contents).getByRole("button", { name: "Work with external agents" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    fireEvent.click(screen.getByRole("link", { name: "Inspect evidence and review results" }));
    expect(screen.getByRole("heading", { name: "Inspect evidence and review results" })).toHaveFocus();
    expect(breadcrumb).toHaveTextContent("Inspect evidence and review results");

    fireEvent.click(
      within(screen.getByRole("navigation", { name: "Adjacent topics" })).getByRole("button", {
        name: /Next Compose and reuse workflows/,
      }),
    );
    expect(screen.getByRole("heading", { level: 2, name: "Compose and reuse workflows" })).toHaveFocus();

    const back = screen.getByRole("button", { name: "Back to previous topic" });
    const forward = screen.getByRole("button", { name: "Forward to next topic" });
    expect(back).toBeEnabled();
    expect(forward).toBeDisabled();

    fireEvent.click(back);
    expect(screen.getByRole("heading", { name: "Inspect evidence and review results" })).toHaveFocus();
    expect(forward).toBeEnabled();

    fireEvent.keyDown(window, { key: "ArrowRight", altKey: true });
    expect(screen.getByRole("heading", { level: 2, name: "Compose and reuse workflows" })).toHaveFocus();

    fireEvent.click(
      within(screen.getByRole("navigation", { name: "Adjacent topics" })).getByRole("button", {
        name: /Previous Work with external agents/,
      }),
    );
    expect(screen.getByRole("heading", { level: 2, name: "Work with external agents" })).toHaveFocus();
  });

  it("shows ranked search excerpts, matching subheading chips, and keyboard selection without rendering the entire manual", () => {
    render(<UserGuideDialog onClose={vi.fn()} />);
    const search = screen.getByRole("searchbox", { name: "Search user manual" });
    fireEvent.change(search, { target: { value: "Agent assessment" } });
    const article = screen.getByRole("article", { name: "Loci user manual" });
    expect(within(article).getByRole("status")).toHaveTextContent("2 matching topics");
    const match = within(article).getByRole("button", { name: /Work with external agents/ });
    expect(match).toHaveTextContent(/stated limitations/i);
    expect(match.querySelector("mark")).not.toBeNull();

    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(search).toHaveValue("");
    expect(screen.getByRole("heading", { level: 2, name: "Work with external agents" })).toHaveFocus();
    expect(screen.queryByRole("heading", { name: "First study with synthetic shapes" })).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: "continue unfinished" } });
    const subheadingChip = within(article).getByRole("button", { name: "Continue unfinished work" });
    fireEvent.click(subheadingChip);
    expect(screen.getByRole("heading", { level: 3, name: "Continue unfinished work" })).toHaveFocus();
  });

  it("keeps contents out of the way on compact viewports and lets Escape close the drawer before the dialog", () => {
    mockCompactViewport(true);
    const close = vi.fn();
    render(<UserGuideDialog onClose={close} />);

    const toggle = screen.getByRole("button", { name: "Show manual contents" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("navigation", { name: "Manual contents" })).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const contents = screen.getByRole("navigation", { name: "Manual contents" });
    expect(within(contents).getByRole("button", { name: "Terminal workflows" })).toBeVisible();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(close).not.toHaveBeenCalled();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveFocus();

    fireEvent.click(toggle);
    fireEvent.click(within(screen.getByRole("navigation", { name: "Manual contents" })).getByRole("button", { name: "Terminal workflows" }));
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("heading", { level: 2, name: "Terminal workflows" })).toHaveFocus();
  });

  it("falls back for an unknown topic, traps Tab focus across visible controls, and restores focus to its opener", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const close = vi.fn();
    const view = render(<UserGuideDialog onClose={close} initialSection="absent-topic" />);
    expect(screen.getByRole("heading", { name: "Welcome" })).toBeVisible();

    const firstControl = screen.getByRole("button", { name: "Hide manual contents" });
    const next = within(screen.getByRole("navigation", { name: "Adjacent topics" })).getByRole("button");
    next.focus();
    fireEvent.keyDown(next, { key: "Tab" });
    expect(firstControl).toHaveFocus();
    fireEvent.keyDown(firstControl, { key: "Tab", shiftKey: true });
    expect(next).toHaveFocus();

    view.unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it("opens searchable offline content and supports keyboard search shortcut and dismissal", () => {
    const close = vi.fn();
    render(<UserGuideDialog onClose={close} />);
    expect(screen.getByRole("dialog", { name: "User manual" })).toBeVisible();
    const search = screen.getByRole("searchbox", { name: "Search user manual" });
    expect(search).toHaveFocus();

    const closeBtn = screen.getByRole("button", { name: "Close user manual" });
    closeBtn.focus();
    fireEvent.keyDown(window, { key: "/" });
    expect(search).toHaveFocus();

    fireEvent.change(search, { target: { value: "histogram" } });
    expect(screen.getByRole("navigation", { name: "Manual contents" }).querySelectorAll("button").length).toBeGreaterThan(0);

    fireEvent.change(search, { target: { value: "missingtermzxy" } });
    expect(screen.getByRole("status")).toHaveTextContent("No matching section");
    fireEvent.keyDown(search, { key: "Escape" });
    expect(close).not.toHaveBeenCalled();
    expect(search).toHaveValue("");
    fireEvent.keyDown(search, { key: "Escape" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("opens as a top-layer modal dialog reachable over modal Settings and routes cancel events cleanly", () => {
    const showModal = vi.fn(function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    });
    const closeModal = vi.fn(function (this: HTMLDialogElement) {
      this.removeAttribute("open");
    });
    const origShowModal = HTMLDialogElement.prototype.showModal;
    const origClose = HTMLDialogElement.prototype.close;
    HTMLDialogElement.prototype.showModal = showModal;
    HTMLDialogElement.prototype.close = closeModal;

    try {
      const onClose = vi.fn();
      const view = render(<UserGuideDialog onClose={onClose} initialSection="convert-vendor-files-bio-formats" />);
      const dialog = screen.getByRole("dialog", { name: "User manual" });
      expect(dialog.tagName).toBe("DIALOG");
      expect(showModal).toHaveBeenCalledOnce();
      expect(screen.getByRole("heading", { level: 3, name: "Convert vendor files (Bio-Formats)" })).toBeVisible();

      const search = screen.getByRole("searchbox", { name: "Search user manual" });
      fireEvent.change(search, { target: { value: "Model library" } });
      fireEvent(dialog, new Event("cancel", { cancelable: true }));
      expect(onClose).not.toHaveBeenCalled();
      expect(search).toHaveValue("");

      fireEvent(dialog, new Event("cancel", { cancelable: true }));
      expect(onClose).toHaveBeenCalledOnce();

      fireEvent.mouseDown(dialog);
      expect(onClose).toHaveBeenCalledTimes(2);

      view.unmount();
      expect(closeModal).toHaveBeenCalledOnce();
    } finally {
      HTMLDialogElement.prototype.showModal = origShowModal;
      HTMLDialogElement.prototype.close = origClose;
    }
  });

  it("permits only official public manual docs and local anchors, rendering unmatched hrefs as plain text", () => {
    render(
      <GuideBody
        text={[
          "[Capabilities](CAPABILITY_MATRIX.md#learned-analysis-routes)",
          "[Release](RELEASE_STATUS.md)",
          "[Public release](https://github.com/sidd-bme/loci-app/blob/main/docs/RELEASE_STATUS.md)",
          "[First study](workflows/FIRST_STUDY.md)",
          "[Here](#open-images)",
          "[Arbitrary web](https://example.com/docs/README.md)",
          "[Other workflow](workflows/LARGE_IMAGE_ANALYSIS.md)",
          "[Private workflow](https://github.com/sidd-bme/loci-app/blob/main/docs/workflows/PRIVATE.md)",
          "[Other repo](https://github.com/sidd-bme/Other/blob/main/docs/README.md)",
          "[Query token](https://github.com/sidd-bme/loci-app/blob/main/docs/README.md?token=private)",
          "[Creds](https://user:secret@github.com/sidd-bme/loci-app/blob/main/docs/README.md)",
          "[Outside](../secret.md)",
          "[Nested](workflows/../secret.md)",
        ].join(" ")}
      />,
    );
    expect(screen.getByRole("link", { name: "Capabilities" })).toHaveAttribute(
      "href",
      "https://github.com/sidd-bme/loci-app/blob/main/docs/CAPABILITY_MATRIX.md#learned-analysis-routes",
    );
    expect(screen.getByRole("link", { name: "Release" })).toHaveAttribute(
      "href",
      "https://github.com/sidd-bme/loci-app/blob/main/docs/RELEASE_STATUS.md",
    );
    expect(screen.getByRole("link", { name: "Public release" })).toHaveAttribute(
      "href",
      "https://github.com/sidd-bme/loci-app/blob/main/docs/RELEASE_STATUS.md",
    );
    expect(screen.getByRole("link", { name: "First study" })).toHaveAttribute(
      "href",
      "https://github.com/sidd-bme/loci-app/blob/main/docs/workflows/FIRST_STUDY.md",
    );
    expect(screen.getByRole("link", { name: "Here" })).toHaveAttribute("href", "#manual-open-images");

    for (const label of [
      "Arbitrary web",
      "Other workflow",
      "Private workflow",
      "Other repo",
      "Query token",
      "Creds",
      "Outside",
      "Nested",
    ]) {
      expect(screen.queryByRole("link", { name: label }), label).not.toBeInTheDocument();
      expect(screen.getByText(new RegExp(label))).toBeVisible();
    }

    expect(isPublicManualDocUrl("https://github.com/sidd-bme/loci-app/blob/main/docs/VENDOR_CONVERSION.md")).toBe(true);
    expect(isPublicManualDocUrl("https://github.com/sidd-bme/loci-app/blob/main/docs/workflows/FIRST_STUDY.md")).toBe(true);
    expect(isPublicManualDocUrl("https://github.com.evil.test/sidd-bme/loci-app/blob/main/docs/README.md")).toBe(false);
    expect(isPublicManualDocUrl("file:///etc/passwd")).toBe(false);
  });

  it("renders nested lists, callouts, emphasis, and code as text while declining executable link schemes", () => {
    const view = render(
      <GuideBody
        text={
          '<img src=x onerror=alert(1)>\n\n> **Boundary:** *Original pixels* stay intact.\n\n1. Parent step:\n   - Nested detail\n\n[unsafe](javascript:alert) and **exact source**\n\n| Action | Key |\n| --- | --- |\n| Fit | `F` |'
        }
      />,
    );
    expect(view.container.querySelector("img")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("exact source").tagName).toBe("STRONG");
    expect(screen.getByText("Original pixels").tagName).toBe("EM");
    expect(view.container.querySelector("aside.manual-callout")).not.toBeNull();
    expect(view.container.querySelector("ol li ul li")).toHaveTextContent("Nested detail");
    expect(screen.getByRole("table")).toBeVisible();
  });

  it("maintains valid internal anchors, unique heading slugs, Settings deep links, and host-permitted doc links across USING_LOCI.md", () => {
    const { sections } = parseGuide(guideMarkdown);
    const allIds = new Set<string>();
    const duplicates: string[] = [];
    for (const section of sections) {
      if (allIds.has(section.id)) duplicates.push(section.id);
      allIds.add(section.id);
      for (const heading of section.headings) {
        if (allIds.has(heading.id)) duplicates.push(heading.id);
        allIds.add(heading.id);
      }
    }
    expect(duplicates).toEqual([]);

    for (const requiredDeepLink of [
      "read-the-workspace",
      "work-with-external-agents",
      "compose-and-reuse-workflows",
      "inspect-scalar-volumes-and-mpr",
      "review-batch-and-export-results",
      "convert-study-images-to-ome-tiff-or-ome-zarr",
      "convert-vendor-files-bio-formats",
    ]) {
      expect(resolveGuideTarget(sections, requiredDeepLink), requiredDeepLink).not.toBeNull();
    }

    const docsRoot = path.resolve(__dirname, "../../../docs");
    const links = [...guideMarkdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) => match[1]);
    expect(links.length).toBeGreaterThan(0);

    for (const target of links) {
      const resolved = safeLink(target);
      expect(resolved, `unsafe or unresolved link target: ${target}`).not.toBeNull();
      if (target.startsWith("#")) {
        const anchor = target.slice(1);
        expect(allIds.has(anchor), `broken internal anchor: #${anchor}`).toBe(true);
      } else {
        expect(isPublicManualDocUrl(resolved!), `link outside public doc policy: ${target}`).toBe(true);
        if (!/^https:\/\//i.test(target)) {
          const filePart = target.split("#")[0];
          expect(existsSync(path.join(docsRoot, filePart)), `missing linked doc: docs/${filePart}`).toBe(true);
        }
      }
    }
  });
});
