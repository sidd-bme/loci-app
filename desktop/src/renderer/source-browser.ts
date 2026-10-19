import type { ResearchSource } from "../shared/research-contracts";

export type SourceBrowserNode = SourceBrowserFolder | SourceBrowserImage;
export type SourceBrowserFolder = {
  kind: "folder"; id: string; label: string; path: string;
  children: SourceBrowserNode[]; sourceIds: string[];
};
export type SourceBrowserImage = {
  kind: "image"; id: string; label: string; path: string; source: ResearchSource;
};

function location(source: ResearchSource) {
  const value = source.browser_location;
  // Consume only the explicit public DTO; never reconstruct a filesystem path.
  if (!value || !value.relative_path || value.relative_path.includes("\\") ||
    value.relative_path.split("/").some(part => !part || part === "." || part === "..")) return null;
  return value;
}

type BrowserIndex = { rootLabels: Map<string, string>; paths: Map<string, string> };
const indexes = new WeakMap<readonly ResearchSource[], BrowserIndex>();

/** One index per immutable source snapshot; rendering/search never rescan roots per leaf. */
export function sourceBrowserIndex(sources: readonly ResearchSource[]): BrowserIndex {
  const cached = indexes.get(sources);
  if (cached) return cached;
  const byName = new Map<string, Set<string>>();
  for (const source of sources) {
    const root = location(source)?.root;
    if (root) { if (!byName.has(root.name)) byName.set(root.name, new Set()); byName.get(root.name)!.add(root.id); }
  }
  const rootLabels = new Map<string, string>();
  for (const [name, ids] of byName) {
    const peers = [...ids].sort();
    peers.forEach((id, index) => {
      let length = 6;
      while (length < id.length && [peers[index - 1], peers[index + 1]].some(peer => peer?.startsWith(id.slice(0, length)))) length += 2;
      rootLabels.set(id, peers.length > 1 ? `${name} · ${id.slice(0, length)}` : name);
    });
  }
  const paths = new Map<string, string>();
  for (const source of sources) {
    const value = location(source);
    const label = value?.root ? rootLabels.get(value.root.id) : null;
    paths.set(source.id, value ? `${label ? label + "/" : ""}${value.relative_path}` : source.name);
  }
  const result = { rootLabels, paths }; indexes.set(sources, result); return result;
}

export function sourceDisplayPath(source: ResearchSource, sources: readonly ResearchSource[] = []): string {
  const value = location(source);
  if (!value) return source.name;
  return sourceBrowserIndex(sources).paths.get(source.id) ??
    `${value.root ? value.root.name + "/" : ""}${value.relative_path}`;
}

export function sourceLabelForId(sources: readonly ResearchSource[], sourceId: string): string {
  return sourceBrowserIndex(sources).paths.get(sourceId) ?? "Source unavailable";
}

/** Stable source/root identities, with sibling order inherited from the working list. */
export function buildSourceBrowser(sources: readonly ResearchSource[]): SourceBrowserNode[] {
  const roots: SourceBrowserNode[] = [];
  const folders = new Map<string, SourceBrowserFolder>();
  const index = sourceBrowserIndex(sources);
  for (const source of sources) {
    const value = location(source);
    const parts = value?.relative_path.split("/") ?? [source.name];
    const root = value?.root;
    const namespace = root ? `root:${root.id}` : "relative";
    const names = root ? [index.rootLabels.get(root.id)!, ...parts.slice(0, -1)] : parts.slice(0, -1);
    let children = roots;
    let parentKey = namespace;
    let display = "";
    for (let index = 0; index < names.length; index++) {
      const name = names[index];
      // Include root identity rather than its label: equal folder names never merge imports.
      const key = root && index === 0 ? namespace : `${parentKey}/${JSON.stringify(name)}`;
      display = display ? `${display}/${name}` : name;
      let folder = folders.get(key);
      if (!folder) {
        folder = { kind: "folder", id: key, label: name, path: display, children: [], sourceIds: [] };
        folders.set(key, folder); children.push(folder);
      }
      folder.sourceIds.push(source.id);
      children = folder.children; parentKey = key;
    }
    children.push({ kind: "image", id: `image:${source.id}`, label: parts.at(-1)!,
      path: sourceDisplayPath(source, sources), source });
  }
  return roots;
}

export function filterSourceBrowser(nodes: SourceBrowserNode[], query: string): SourceBrowserNode[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return nodes;
  return nodes.flatMap(node => {
    if (node.path.toLowerCase().includes(needle)) return [node];
    if (node.kind === "image") return [];
    const children = filterSourceBrowser(node.children, query);
    return children.length ? [{ ...node, children }] : [];
  });
}

export function sourceAncestors(nodes: SourceBrowserNode[], sourceId: string): string[] | null {
  for (const node of nodes) {
    if (node.kind === "image" && node.source.id === sourceId) return [];
    if (node.kind === "folder") {
      const children = sourceAncestors(node.children, sourceId);
      if (children) return [node.id, ...children];
    }
  }
  return null;
}

export type SourceBrowserRow = { node: SourceBrowserNode; level: number; parent: string | null };
export function visibleSourceRows(nodes: SourceBrowserNode[], expanded: ReadonlySet<string>, searching = false,
  level = 1, parent: string | null = null): SourceBrowserRow[] {
  return nodes.flatMap(node => [{ node, level, parent }, ...(node.kind === "folder" && (searching || expanded.has(node.id))
    ? visibleSourceRows(node.children, expanded, searching, level + 1, node.id) : [])]);
}
