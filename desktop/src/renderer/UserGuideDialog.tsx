import { ArrowLeft, ArrowRight, BookOpen, Search, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import guide from "../../../docs/USING_LOCI.md?raw";
import "./UserGuideDialog.css";

const slug = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s+/g, "-");
const sections = guide.split(/^## /m).map((text, index) => {
  if (!index) return { title: "Welcome", id: "welcome", body: text.replace(/^# .*\n/, "").trim() };
  const split = text.indexOf("\n");
  const title = text.slice(0, split);
  return { title, id: slug(title), body: text.slice(split + 1).trim() };
}).filter(section => section.id !== "contents");

const plainText = (text: string) => text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[*`#|]/g, "").replace(/\s+/g, " ").trim();
const sectionHeadings = (body: string) => [...body.matchAll(/^### (.+)$/gm)].map(match => ({ title: match[1], id: slug(match[1]) }));
function excerpt(body: string, query: string): string {
  const text = plainText(body), index = Math.max(0, text.toLowerCase().indexOf(query.toLowerCase().split(/\s+/)[0]) - 48);
  return `${index ? "…" : ""}${text.slice(index, index + 170)}${text.length > index + 170 ? "…" : ""}`;
}

function safeLink(target: string): string | null {
  if (target.startsWith("#")) return `#manual-${target.slice(1)}`;
  if (/^https:\/\//i.test(target)) return target;
  if (target === "workflows/FIRST_STUDY.md") return "https://github.com/sidd-bme/loci-app/blob/main/docs/workflows/FIRST_STUDY.md";
  if (/^[A-Za-z0-9_.-]+\.md(?:#[A-Za-z0-9_-]+)?$/.test(target)) return `https://github.com/sidd-bme/loci-app/blob/main/docs/${target}`;
  return null;
}

/** Render the bundled, repository-owned manual as text and JSX, never raw HTML. */
export function guideInline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index}>{part.slice(1, -1)}</code>;
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (link) {
      const href = safeLink(link[2]);
      return href ? <a key={index} href={href} target={href.startsWith("#") ? undefined : "_blank"} rel="noreferrer">{link[1]}</a> : link[1];
    }
    return part;
  });
}

export function GuideBody({ text }: { text: string }) {
  const lines = text.split("\n"), blocks: ReactNode[] = [];
  for (let index = 0; index < lines.length;) {
    if (!lines[index].trim()) { index++; continue; }
    const key = index;
    if (lines[index].startsWith("```")) {
      const content: string[] = []; index++;
      while (index < lines.length && !lines[index].startsWith("```")) content.push(lines[index++]);
      index++; blocks.push(<pre key={key}><code>{content.join("\n")}</code></pre>); continue;
    }
    if (lines[index].startsWith("### ")) {
      const heading = lines[index++].slice(4);
      blocks.push(<h3 key={key} id={`manual-${slug(heading)}`} tabIndex={-1}>{guideInline(heading)}</h3>); continue;
    }
    if (lines[index].startsWith("|")) {
      const rows: string[][] = [];
      while (index < lines.length && lines[index].startsWith("|")) {
        const row = lines[index++].trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
        if (!row.every((cell) => /^:?-+:?$/.test(cell))) rows.push(row);
      }
      blocks.push(<div className="manual-table" key={key}><table><thead><tr>{rows[0]?.map((cell, cellIndex) => <th key={cellIndex}>{guideInline(cell)}</th>)}</tr></thead>
        <tbody>{rows.slice(1).map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{guideInline(cell)}</td>)}</tr>)}</tbody></table></div>); continue;
    }
    if (/^[-*] /.test(lines[index]) || /^\d+\. /.test(lines[index])) {
      const ordered = /^\d+\. /.test(lines[index]), items: ReactNode[] = [];
      const pattern = ordered ? /^\d+\. / : /^[-*] /;
      while (index < lines.length && pattern.test(lines[index])) {
        let content = lines[index++].replace(pattern, "");
        while (index < lines.length && /^  +\S/.test(lines[index])) content += ` ${lines[index++].trim()}`;
        items.push(<li key={index}>{guideInline(content)}</li>);
      }
      blocks.push(ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>); continue;
    }
    const content: string[] = [];
    while (index < lines.length && lines[index].trim() && !/^(### |\||[-*] |\d+\. |```)/.test(lines[index])) content.push(lines[index++].trim());
    blocks.push(<p key={key}>{guideInline(content.join(" "))}</p>);
  }
  return <>{blocks}</>;
}

export default function UserGuideDialog({ onClose, initialSection }: { onClose: () => void; initialSection?: string }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(() => sections.find(section => section.id === initialSection)?.id ?? "welcome");
  const [destination, setDestination] = useState<string | null>(null);
  const panel = useRef<HTMLElement>(null), close = useRef(onClose); close.current = onClose;
  const search = useRef<HTMLInputElement>(null), article = useRef<HTMLElement>(null);
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const filtered = sections.filter(section => terms.every(term => `${section.title} ${plainText(section.body)}`.toLowerCase().includes(term)));
  const currentIndex = sections.findIndex(section => section.id === active);
  const current = sections[currentIndex];
  const headings = sectionHeadings(current.body);
  const openTopic = (id: string) => {
    const section = sections.find(item => item.id === id || sectionHeadings(item.body).some(heading => heading.id === id));
    if (!section) return;
    setActive(section.id); setQuery(""); setDestination(id);
  };
  const priorEntry = useRef(initialSection);
  useEffect(() => {
    if (priorEntry.current === initialSection) return;
    priorEntry.current = initialSection;
    const id = sections.find(section => section.id === initialSection)?.id ?? "welcome";
    setActive(id); setQuery(""); setDestination(id);
  }, [initialSection]);
  useEffect(() => {
    if (!destination) return;
    const heading = document.getElementById(`manual-${destination}`);
    if (destination === active) { if (article.current) article.current.scrollTop = 0; }
    else heading?.scrollIntoView?.({ block: "start" });
    heading?.focus({ preventScroll: true });
    setDestination(null);
  }, [active, destination]);
  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null;
    search.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); close.current(); }
      if (event.key === "Tab") {
        const nodes = [...(panel.current?.querySelectorAll<HTMLElement>("button:not(:disabled),input,a[href],[tabindex='0']") ?? [])].filter(node => node.tabIndex >= 0).sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
        if (event.shiftKey && document.activeElement === nodes[0]) { event.preventDefault(); nodes.at(-1)?.focus(); }
        else if (!event.shiftKey && document.activeElement === nodes.at(-1)) { event.preventDefault(); nodes[0]?.focus(); }
      }
    };
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("keydown", key); if (prior?.isConnected) prior.focus(); };
  }, []);
  return <div className="modal-backdrop manual-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={panel} role="dialog" aria-modal="true" aria-labelledby="user-guide-title" className="user-guide-dialog">
      <header className="dialog-header manual-header"><h2 id="user-guide-title"><BookOpen size={20} strokeWidth={1.5} aria-hidden="true" />User manual</h2>
        <label className="manual-search"><Search size={16} aria-hidden="true" /><input ref={search} type="search" aria-label="Search user manual" placeholder="Search topics and workflows…" value={query}
          onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === "Escape" && query) { event.preventDefault(); event.stopPropagation(); setQuery(""); } }} />
          {query && <button type="button" aria-label="Clear manual search" onClick={() => { setQuery(""); search.current?.focus(); }}><X size={14} aria-hidden="true" /></button>}
        </label>
        <button className="button button-quiet icon-button" aria-label="Close user manual" onClick={onClose}><X size={18} aria-hidden="true" /></button></header>
      <div className="manual-layout"><aside className="manual-sidebar">
        <nav aria-label="Manual contents">{sections.map(section => <button type="button" key={section.id} aria-current={!terms.length && active === section.id ? "page" : undefined}
          onClick={() => openTopic(section.id)}>{section.title}</button>)}</nav>
        <p className="manual-offline">Available offline</p>
      </aside><article ref={article} className="manual-article" aria-label="Loci user manual" tabIndex={0} onClick={event => {
        const target = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href^='#manual-']") : null;
        if (target) { event.preventDefault(); openTopic(target.getAttribute("href")!.slice("#manual-".length)); }
      }}>
        {terms.length ? <div className="manual-results"><h2>Search the manual</h2>
          <p role="status">{filtered.length ? `${filtered.length} matching ${filtered.length === 1 ? "topic" : "topics"}` : "No matching section. Try a tool name such as “histogram”, “batch” or “recovery”."}</p>
          <ul>{filtered.map(section => <li key={section.id}><button type="button" onClick={() => openTopic(section.id)}>
            <strong>{section.title}</strong><span>{excerpt(section.body, query.trim())}</span><span className="manual-result-action">Read topic<ArrowRight size={14} aria-hidden="true" /></span>
          </button></li>)}</ul>
        </div> : <><section aria-labelledby={`manual-${current.id}`}>
          <h2 id={`manual-${current.id}`} tabIndex={-1}>{current.title}</h2>
          {headings.length > 1 && <nav className="manual-on-page" aria-label="On this page"><span>On this page</span>{headings.map(heading => <a key={heading.id} href={`#manual-${heading.id}`}>{heading.title}</a>)}</nav>}
          <GuideBody text={current.body} />
        </section><nav className="manual-pagination" aria-label="Adjacent topics">
          <div>{currentIndex > 0 && <button type="button" onClick={() => openTopic(sections[currentIndex - 1].id)}><ArrowLeft size={16} aria-hidden="true" /><span><small>Previous</small>{" "}{sections[currentIndex - 1].title}</span></button>}</div>
          <div>{currentIndex < sections.length - 1 && <button type="button" onClick={() => openTopic(sections[currentIndex + 1].id)}><span><small>Next</small>{" "}{sections[currentIndex + 1].title}</span><ArrowRight size={16} aria-hidden="true" /></button>}</div>
        </nav></>}
      </article></div>
    </section>
  </div>;
}
