import { BookOpen, Search, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import guide from "../../../docs/USING_LOCI.md?raw";
import "./UserGuideDialog.css";

const slug = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s+/g, "-");
const sections = guide.split(/^## /m).map((text, index) => {
  if (!index) return { title: "Welcome", id: "welcome", body: text.replace(/^# .*\n/, "").trim() };
  const split = text.indexOf("\n");
  const title = text.slice(0, split);
  return { title, id: slug(title), body: text.slice(split + 1).trim() };
});

function safeLink(target: string): string | null {
  if (target.startsWith("#")) return `#manual-${target.slice(1)}`;
  if (/^https:\/\//i.test(target)) return target;
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
      blocks.push(<h3 key={key}>{guideInline(lines[index++].slice(4))}</h3>); continue;
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

export default function UserGuideDialog({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState(""), [active, setActive] = useState("welcome");
  const panel = useRef<HTMLElement>(null), close = useRef(onClose); close.current = onClose;
  const search = useRef<HTMLInputElement>(null);
  const filtered = sections.filter((section) => `${section.title} ${section.body}`.toLowerCase().includes(query.trim().toLowerCase()));
  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null;
    search.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close.current(); }
      if (event.key === "Tab") {
        const nodes = [...(panel.current?.querySelectorAll<HTMLElement>("button:not(:disabled),input,a[href]") ?? [])];
        if (event.shiftKey && document.activeElement === nodes[0]) { event.preventDefault(); nodes.at(-1)?.focus(); }
        else if (!event.shiftKey && document.activeElement === nodes.at(-1)) { event.preventDefault(); nodes[0]?.focus(); }
      }
    };
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("keydown", key); if (prior?.isConnected) prior.focus(); };
  }, []);
  return <div className="modal-backdrop manual-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={panel} role="dialog" aria-modal="true" aria-labelledby="user-guide-title" className="user-guide-dialog">
      <header className="dialog-header"><div><span className="dialog-kicker">Loci · available offline</span><h2 id="user-guide-title"><BookOpen size={20} />User manual</h2></div>
        <button className="button button-quiet icon-button" aria-label="Close user manual" onClick={onClose}><X size={18} /></button></header>
      <div className="manual-layout"><aside className="manual-sidebar"><label className="manual-search"><Search size={15} /><input ref={search} aria-label="Search user manual" placeholder="Find a workflow…" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <nav aria-label="Manual contents">{filtered.map((section) => <button key={section.id} aria-current={active === section.id ? "location" : undefined} onClick={() => {
          setActive(section.id); document.getElementById(`manual-${section.id}`)?.scrollIntoView({ block: "start", behavior: "auto" });
        }}>{section.title}</button>)}</nav>
        <small>{query ? `${filtered.length} matching sections` : "The same guide is included in the repository."}</small>
      </aside><article className="manual-article" aria-label="Loci user manual">
        {filtered.map((section) => <section key={section.id} id={`manual-${section.id}`}><h2>{section.title}</h2><GuideBody text={section.body} /></section>)}
        {!filtered.length && <p role="status">No matching section. Try a tool name such as “histogram”, “batch” or “recovery”.</p>}
      </article></div>
    </section>
  </div>;
}
