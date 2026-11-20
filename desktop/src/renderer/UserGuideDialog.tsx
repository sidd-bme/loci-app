import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  ChevronRight,
  ExternalLink,
  PanelLeft,
  Search,
  X,
} from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import guide from "../../../docs/USING_LOCI.md?raw";
import {
  parseGuide,
  resolveGuideTarget,
  safeLink,
  searchGuide,
  slug,
  splitHighlight,
} from "./user-guide-model";
import "./UserGuideDialog.css";

const { sections, groups } = parseGuide(guide);
const COMPACT_BREAKPOINT = "(max-width: 820px)";

function readIsCompact(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(COMPACT_BREAKPOINT).matches
    : false;
}

/** Render the bundled, repository-owned manual as text and JSX, never raw HTML. */
export function guideInline(text: string): ReactNode[] {
  return text
    .split(/(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g)
    .map((part, index) => {
      if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
        return <strong key={index}>{part.slice(2, -2)}</strong>;
      }
      if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
        return <em key={index}>{part.slice(1, -1)}</em>;
      }
      if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
        return <code key={index}>{part.slice(1, -1)}</code>;
      }
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
      if (link) {
        const href = safeLink(link[2]);
        if (!href) return link[1];
        const internal = href.startsWith("#");
        return (
          <a
            key={index}
            href={href}
            className={internal ? undefined : "manual-external-link"}
            target={internal ? undefined : "_blank"}
            rel={internal ? undefined : "noreferrer"}
          >
            {link[1]}
            {!internal && <ExternalLink size={12} strokeWidth={1.75} aria-hidden="true" />}
          </a>
        );
      }
      return part;
    });
}

function HighlightText({ text, terms }: { text: string; terms: string[] }) {
  const parts = splitHighlight(text, terms);
  return (
    <>
      {parts.map((part, index) => (part.match ? <mark key={index}>{part.text}</mark> : part.text))}
    </>
  );
}

export function GuideBody({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  for (let index = 0; index < lines.length; ) {
    if (!lines[index].trim()) {
      index++;
      continue;
    }
    const key = index;
    if (lines[index].startsWith("```")) {
      const content: string[] = [];
      index++;
      while (index < lines.length && !lines[index].startsWith("```")) content.push(lines[index++]);
      index++;
      blocks.push(
        <pre key={key}>
          <code>{content.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    if (lines[index].startsWith("### ")) {
      const heading = lines[index++].slice(4).trim();
      blocks.push(
        <h3 key={key} id={`manual-${slug(heading)}`} tabIndex={-1}>
          {guideInline(heading)}
        </h3>,
      );
      continue;
    }
    if (lines[index].startsWith("#### ")) {
      const heading = lines[index++].slice(5).trim();
      blocks.push(
        <h4 key={key} id={`manual-${slug(heading)}`} tabIndex={-1}>
          {guideInline(heading)}
        </h4>,
      );
      continue;
    }
    if (lines[index].startsWith(">")) {
      const paragraphs: string[][] = [[]];
      while (index < lines.length && lines[index].startsWith(">")) {
        const line = lines[index++].replace(/^>\s?/, "").trim();
        if (!line) {
          if (paragraphs[paragraphs.length - 1].length > 0) paragraphs.push([]);
        } else {
          paragraphs[paragraphs.length - 1].push(line);
        }
      }
      blocks.push(
        <aside className="manual-callout" key={key}>
          {paragraphs
            .filter((paragraph) => paragraph.length > 0)
            .map((paragraph, pIndex) => (
              <p key={pIndex}>{guideInline(paragraph.join(" "))}</p>
            ))}
        </aside>,
      );
      continue;
    }
    if (lines[index].startsWith("|")) {
      const rows: string[][] = [];
      while (index < lines.length && lines[index].startsWith("|")) {
        const row = lines[index++]
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((cell) => cell.trim());
        if (!row.every((cell) => /^:?-+:?$/.test(cell))) rows.push(row);
      }
      blocks.push(
        <div className="manual-table" key={key}>
          <table>
            <thead>
              <tr>
                {rows[0]?.map((cell, cellIndex) => (
                  <th key={cellIndex} scope="col">
                    {guideInline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(1).map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex}>{guideInline(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^[-*] /.test(lines[index]) || /^\d+\. /.test(lines[index])) {
      const ordered = /^\d+\. /.test(lines[index]);
      const items: ReactNode[] = [];
      const pattern = ordered ? /^\d+\. / : /^[-*] /;
      while (index < lines.length && pattern.test(lines[index])) {
        const itemKey = index;
        let content = lines[index++].replace(pattern, "");
        const subItems: string[] = [];
        while (index < lines.length && /^  +\S/.test(lines[index])) {
          const line = lines[index++];
          if (/^  +[-*] /.test(line)) {
            subItems.push(line.replace(/^  +[-*] /, "").trim());
          } else if (subItems.length > 0) {
            subItems[subItems.length - 1] += ` ${line.trim()}`;
          } else {
            content += ` ${line.trim()}`;
          }
        }
        items.push(
          <li key={itemKey}>
            {guideInline(content)}
            {subItems.length > 0 && (
              <ul>
                {subItems.map((sub, subIndex) => (
                  <li key={subIndex}>{guideInline(sub)}</li>
                ))}
              </ul>
            )}
          </li>,
        );
      }
      blocks.push(ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>);
      continue;
    }
    const content: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^(#{3,4} |\||>|[-*] |\d+\. |```)/.test(lines[index])
    ) {
      content.push(lines[index++].trim());
    }
    blocks.push(<p key={key}>{guideInline(content.join(" "))}</p>);
  }
  return <>{blocks}</>;
}

type HistoryEntry = { sectionId: string; headingId: string | null };

function resolveInitialEntry(initialSection?: string): HistoryEntry {
  const resolved = resolveGuideTarget(sections, initialSection);
  if (resolved) return { sectionId: resolved.section.id, headingId: resolved.headingId };
  return { sectionId: "welcome", headingId: null };
}

export default function UserGuideDialog({
  onClose,
  initialSection,
}: {
  onClose: () => void;
  initialSection?: string;
}) {
  const [query, setQuery] = useState("");
  const [history, setHistory] = useState<{ entries: HistoryEntry[]; index: number }>(() => ({
    entries: [resolveInitialEntry(initialSection)],
    index: 0,
  }));
  const [destination, setDestination] = useState<string | null>(null);
  const [activeHeadingId, setActiveHeadingId] = useState<string | null>(
    () => resolveInitialEntry(initialSection).headingId,
  );
  const [activeSearchIndex, setActiveSearchIndex] = useState(-1);
  const [isCompact, setIsCompact] = useState(readIsCompact);
  const [contentsOpen, setContentsOpen] = useState(() => !readIsCompact());

  const panel = useRef<HTMLDialogElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const search = useRef<HTMLInputElement>(null);
  const article = useRef<HTMLElement>(null);
  const contentsToggle = useRef<HTMLButtonElement>(null);
  const contentsNavId = useId();
  const searchResultsId = useId();

  const currentEntry = history.entries[history.index] ?? { sectionId: "welcome", headingId: null };
  const active = currentEntry.sectionId;
  const terms = useMemo(() => query.trim().toLowerCase().split(/\s+/).filter(Boolean), [query]);
  const searchMatches = useMemo(() => searchGuide(sections, query), [query]);
  const currentIndex = Math.max(0, sections.findIndex((section) => section.id === active));
  const current = sections[currentIndex] ?? sections[0];
  const headings = current.headings;
  const canGoBack = history.index > 0;
  const canGoForward = history.index < history.entries.length - 1;
  const activeHeading = headings.find((heading) => heading.id === activeHeadingId) ?? null;

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(COMPACT_BREAKPOINT);
    const update = () => {
      setIsCompact(media.matches);
      setContentsOpen(!media.matches);
    };
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);

  const openTopic = (id: string, options?: { recordHistory?: boolean }) => {
    const resolved = resolveGuideTarget(sections, id);
    if (!resolved) return;
    const nextEntry: HistoryEntry = {
      sectionId: resolved.section.id,
      headingId: resolved.headingId,
    };
    const recordHistory = options?.recordHistory ?? true;
    setHistory((prev) => {
      const currentTop = prev.entries[prev.index];
      if (
        !recordHistory ||
        (currentTop &&
          currentTop.sectionId === nextEntry.sectionId &&
          currentTop.headingId === nextEntry.headingId)
      ) {
        return prev;
      }
      const nextEntries = [...prev.entries.slice(0, prev.index + 1), nextEntry].slice(-40);
      return { entries: nextEntries, index: nextEntries.length - 1 };
    });
    setActiveHeadingId(nextEntry.headingId);
    setQuery("");
    setActiveSearchIndex(-1);
    setDestination(nextEntry.headingId ?? nextEntry.sectionId);
    if (isCompact) setContentsOpen(false);
  };

  const stepHistory = (direction: -1 | 1) => {
    const nextIndex = history.index + direction;
    if (nextIndex < 0 || nextIndex >= history.entries.length) return;
    const target = history.entries[nextIndex];
    setHistory((prev) => ({ ...prev, index: nextIndex }));
    setQuery("");
    setActiveSearchIndex(-1);
    setActiveHeadingId(target.headingId);
    setDestination(target.headingId ?? target.sectionId);
  };

  const priorEntry = useRef(initialSection);
  useEffect(() => {
    if (priorEntry.current === initialSection) return;
    priorEntry.current = initialSection;
    const entry = resolveInitialEntry(initialSection);
    setHistory((prev) => {
      const nextEntries = [...prev.entries.slice(0, prev.index + 1), entry].slice(-40);
      return { entries: nextEntries, index: nextEntries.length - 1 };
    });
    setActiveHeadingId(entry.headingId);
    setQuery("");
    setActiveSearchIndex(-1);
    setDestination(entry.headingId ?? entry.sectionId);
    if (isCompact) setContentsOpen(false);
  }, [initialSection, isCompact]);

  useEffect(() => {
    if (!destination) return;
    const heading = document.getElementById(`manual-${destination}`);
    if (destination === active) {
      if (article.current) article.current.scrollTop = 0;
    } else {
      heading?.scrollIntoView?.({ block: "start" });
    }
    heading?.focus({ preventScroll: true });
    setDestination(null);
  }, [active, destination]);

  useEffect(() => {
    const scroller = article.current;
    if (!scroller || terms.length > 0 || headings.length < 2) return;
    const syncOutline = () => {
      const top = scroller.getBoundingClientRect().top + 40;
      let reached: string | null = null;
      for (const heading of headings) {
        const node = document.getElementById(`manual-${heading.id}`);
        if (node && node.getBoundingClientRect().top <= top) reached = heading.id;
      }
      setActiveHeadingId(reached);
    };
    scroller.addEventListener("scroll", syncOutline, { passive: true });
    return () => scroller.removeEventListener("scroll", syncOutline);
  }, [active, headings, terms.length]);

  const queryRef = useRef(query);
  queryRef.current = query;
  const compactDrawerOpenRef = useRef(false);
  compactDrawerOpenRef.current = isCompact && contentsOpen;
  const historyNavRef = useRef(stepHistory);
  historyNavRef.current = stepHistory;

  const dismissStep = () => {
    if (queryRef.current) {
      setQuery("");
      setActiveSearchIndex(-1);
      search.current?.focus({ preventScroll: true });
    } else if (compactDrawerOpenRef.current) {
      setContentsOpen(false);
      contentsToggle.current?.focus({ preventScroll: true });
    } else {
      close.current();
    }
  };
  const dismissRef = useRef(dismissStep);
  dismissRef.current = dismissStep;

  useLayoutEffect(() => {
    const shell = panel.current;
    if (!shell) return;
    const prior = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (typeof shell.showModal === "function") {
      if (!shell.open) shell.showModal();
    } else {
      shell.setAttribute("open", "");
    }
    search.current?.focus({ preventScroll: true });
    return () => {
      if (typeof shell.close === "function") {
        if (shell.open) shell.close();
      } else {
        shell.removeAttribute("open");
      }
      if (prior?.isConnected) prior.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        dismissRef.current();
        return;
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "f"
      ) {
        event.preventDefault();
        search.current?.focus();
        search.current?.select();
        return;
      }
      if (
        event.key === "/" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        document.activeElement !== search.current &&
        !(document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement)
      ) {
        event.preventDefault();
        search.current?.focus();
        return;
      }
      if (
        event.altKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        (event.key === "ArrowLeft" || event.key === "ArrowRight")
      ) {
        event.preventDefault();
        historyNavRef.current(event.key === "ArrowLeft" ? -1 : 1);
        return;
      }
      if (event.key === "Tab") {
        const nodes = [
          ...(panel.current?.querySelectorAll<HTMLElement>(
            "button:not(:disabled),input:not(:disabled),a[href],[tabindex='0']",
          ) ?? []),
        ]
          .filter(
            (node) =>
              node.tabIndex >= 0 &&
              !node.closest("[hidden],[inert]") &&
              getComputedStyle(node).display !== "none" &&
              getComputedStyle(node).visibility !== "hidden",
          )
          .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
        if (!nodes.length) return;
        if (event.shiftKey && document.activeElement === nodes[0]) {
          event.preventDefault();
          nodes.at(-1)?.focus();
        } else if (!event.shiftKey && document.activeElement === nodes.at(-1)) {
          event.preventDefault();
          nodes[0]?.focus();
        }
      }
    };
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("keydown", key);
    };
  }, []);

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && query) {
      event.preventDefault();
      event.stopPropagation();
      setQuery("");
      setActiveSearchIndex(-1);
      return;
    }
    if (!terms.length || !searchMatches.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveSearchIndex((currentIdx) => (currentIdx + 1) % searchMatches.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveSearchIndex((currentIdx) =>
        currentIdx <= 0 ? searchMatches.length - 1 : currentIdx - 1,
      );
    } else if (event.key === "Enter") {
      const chosen = searchMatches[activeSearchIndex >= 0 ? activeSearchIndex : 0];
      if (chosen) {
        event.preventDefault();
        openTopic(chosen.section.id);
      }
    }
  };

  const sidebarVisible = contentsOpen;
  const hasOutline = !terms.length && headings.length > 1;

  return (
    <dialog
      ref={panel}
      role="dialog"
      aria-modal="true"
      aria-labelledby="user-guide-title"
      className={`user-guide-dialog${sidebarVisible ? " is-contents-open" : " is-contents-closed"}${isCompact ? " is-compact" : ""}`}
      onCancel={(event) => {
        event.preventDefault();
        dismissRef.current();
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="manual-shell">
        <header className="dialog-header manual-header">
          <div className="manual-header-left">
            <button
              ref={contentsToggle}
              type="button"
              className="manual-icon-btn"
              aria-label={sidebarVisible ? "Hide manual contents" : "Show manual contents"}
              aria-expanded={sidebarVisible}
              aria-controls={contentsNavId}
              title={sidebarVisible ? "Hide contents" : "Show contents"}
              onClick={() => setContentsOpen((open) => !open)}
            >
              <PanelLeft size={16} strokeWidth={1.75} aria-hidden="true" />
            </button>
            <div className="manual-history" role="group" aria-label="Reading history">
              <button
                type="button"
                className="manual-icon-btn"
                aria-label="Back to previous topic"
                title="Back (Alt+←)"
                disabled={!canGoBack}
                onClick={() => stepHistory(-1)}
              >
                <ArrowLeft size={15} strokeWidth={1.75} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="manual-icon-btn"
                aria-label="Forward to next topic"
                title="Forward (Alt+→)"
                disabled={!canGoForward}
                onClick={() => stepHistory(1)}
              >
                <ArrowRight size={15} strokeWidth={1.75} aria-hidden="true" />
              </button>
            </div>
            <h2 id="user-guide-title">
              <BookOpen size={18} strokeWidth={1.65} aria-hidden="true" />
              User manual
            </h2>
          </div>

          <label className="manual-search">
            <Search size={15} strokeWidth={1.75} aria-hidden="true" />
            <input
              ref={search}
              type="search"
              aria-label="Search user manual"
              aria-controls={terms.length ? searchResultsId : undefined}
              placeholder="Search topics, tools, or shortcuts…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveSearchIndex(-1);
              }}
              onKeyDown={onSearchKeyDown}
            />
            {query ? (
              <button
                type="button"
                className="manual-search-clear"
                aria-label="Clear manual search"
                onClick={() => {
                  setQuery("");
                  setActiveSearchIndex(-1);
                  search.current?.focus();
                }}
              >
                <X size={14} aria-hidden="true" />
              </button>
            ) : (
              <kbd className="manual-search-hint" aria-hidden="true">
                /
              </kbd>
            )}
          </label>

          <button
            type="button"
            className="button button-quiet icon-button manual-close"
            aria-label="Close user manual"
            onClick={onClose}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        <div className="manual-layout">
          {isCompact && sidebarVisible && (
            <div
              className="manual-drawer-scrim"
              aria-hidden="true"
              onMouseDown={() => setContentsOpen(false)}
            />
          )}
          <aside
            id={contentsNavId}
            className="manual-sidebar"
            hidden={!sidebarVisible}
            aria-label="Manual navigation"
          >
            <nav aria-label="Manual contents">
              {groups.map((group) => (
                <div className="manual-nav-group" key={group.id}>
                  <div className="manual-nav-group-label">{group.label}</div>
                  <div className="manual-nav-group-list">
                    {group.sections.map((section) => (
                      <button
                        type="button"
                        key={section.id}
                        aria-current={!terms.length && active === section.id ? "page" : undefined}
                        onClick={() => openTopic(section.id)}
                      >
                        {section.title}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </nav>
            <p className="manual-offline">Available offline · F1</p>
          </aside>

          <article
            ref={article}
            className="manual-article"
            aria-label="Loci user manual"
            tabIndex={0}
            onClick={(event) => {
              const target =
                event.target instanceof Element
                  ? event.target.closest<HTMLAnchorElement>("a[href^='#manual-']")
                  : null;
              if (target) {
                event.preventDefault();
                openTopic(target.getAttribute("href")!.slice("#manual-".length));
              }
            }}
          >
            {terms.length ? (
              <div className="manual-results" id={searchResultsId}>
                <h2>Search the manual</h2>
                <p role="status">
                  {searchMatches.length
                    ? `${searchMatches.length} matching ${searchMatches.length === 1 ? "topic" : "topics"}`
                    : "No matching section. Try a tool name such as “histogram”, “batch”, “MPR”, or “recovery”."}
                </p>
                <ul className="manual-result-list">
                  {searchMatches.map((match, index) => (
                    <li
                      key={match.section.id}
                      className={index === activeSearchIndex ? "is-highlighted" : undefined}
                    >
                      <button
                        type="button"
                        className="manual-result-card"
                        onClick={() => openTopic(match.section.id)}
                      >
                        <span className="manual-result-group">{match.section.groupLabel}</span>
                        <strong>
                          <HighlightText text={match.section.title} terms={terms} />
                        </strong>
                        <span className="manual-result-excerpt">
                          <HighlightText text={match.excerpt} terms={terms} />
                        </span>
                        <span className="manual-result-action">
                          Read topic
                          <ArrowRight size={14} aria-hidden="true" />
                        </span>
                      </button>
                      {match.matchedHeadings.length > 0 && (
                        <div className="manual-result-subheadings" aria-label={`Matching sections in ${match.section.title}`}>
                          {match.matchedHeadings.map((heading) => (
                            <button
                              type="button"
                              key={heading.id}
                              className="manual-result-chip"
                              onClick={() => openTopic(heading.id)}
                            >
                              <HighlightText text={heading.title} terms={terms} />
                            </button>
                          ))}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className={`manual-article-shell${hasOutline ? " has-outline" : ""}`}>
                <div className="manual-article-header">
                  <nav className="manual-breadcrumb" aria-label="Breadcrumb">
                    <button
                      type="button"
                      onClick={() => openTopic("welcome")}
                      disabled={current.id === "welcome" && !activeHeading}
                    >
                      User manual
                    </button>
                    <ChevronRight size={13} aria-hidden="true" />
                    <span className="manual-breadcrumb-group">{current.groupLabel}</span>
                    <ChevronRight size={13} aria-hidden="true" />
                    <button
                      type="button"
                      className="manual-breadcrumb-current"
                      aria-current={!activeHeading ? "page" : undefined}
                      onClick={() => openTopic(current.id)}
                    >
                      {current.title}
                    </button>
                    {activeHeading && (
                      <>
                        <ChevronRight size={13} aria-hidden="true" />
                        <span className="manual-breadcrumb-sub" aria-current="location">
                          {activeHeading.title}
                        </span>
                      </>
                    )}
                  </nav>

                  <h2 id={`manual-${current.id}`} tabIndex={-1}>
                    {current.title}
                  </h2>
                </div>

                {hasOutline && (
                  <nav className="manual-on-page" aria-label="On this page">
                    <span>On this page</span>
                    <div className="manual-on-page-links">
                      {headings.map((heading) => (
                        <a
                          key={heading.id}
                          href={`#manual-${heading.id}`}
                          aria-current={activeHeadingId === heading.id ? "location" : undefined}
                        >
                          {heading.title}
                        </a>
                      ))}
                    </div>
                  </nav>
                )}

                <div className="manual-article-body">
                  <section aria-labelledby={`manual-${current.id}`} className="manual-prose">
                    <GuideBody text={current.body} />
                  </section>

                  <nav className="manual-pagination" aria-label="Adjacent topics">
                    <div>
                      {currentIndex > 0 && (
                        <button
                          type="button"
                          onClick={() => openTopic(sections[currentIndex - 1].id)}
                        >
                          <ArrowLeft size={16} aria-hidden="true" />
                          <span>
                            <small>Previous</small> {sections[currentIndex - 1].title}
                          </span>
                        </button>
                      )}
                    </div>
                    <div>
                      {currentIndex < sections.length - 1 && (
                        <button
                          type="button"
                          onClick={() => openTopic(sections[currentIndex + 1].id)}
                        >
                          <span>
                            <small>Next</small> {sections[currentIndex + 1].title}
                          </span>
                          <ArrowRight size={16} aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  </nav>
                </div>
              </div>
            )}
          </article>
        </div>
      </div>
    </dialog>
  );
}
