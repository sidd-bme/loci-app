export type GuideGroupId = "start" | "view" | "analyze" | "results" | "reference";

export interface GuideHeading {
  title: string;
  id: string;
}

export interface GuideSection {
  id: string;
  title: string;
  group: GuideGroupId;
  groupLabel: string;
  body: string;
  headings: GuideHeading[];
  searchText: string;
}

export interface GuideGroup {
  id: GuideGroupId;
  label: string;
  sections: GuideSection[];
}

export interface GuideSearchMatch {
  section: GuideSection;
  matchedHeadings: GuideHeading[];
  excerpt: string;
  score: number;
}

const GROUP_LABELS: Record<GuideGroupId, string> = {
  start: "Start here",
  view: "View & display",
  analyze: "Annotate & analyze",
  results: "Review & export",
  reference: "Settings & automation",
};

const GROUP_ORDER: GuideGroupId[] = ["start", "view", "analyze", "results", "reference"];

const SECTION_GROUP_MAP: Record<string, GuideGroupId> = {
  welcome: "start",
  "start-save-and-return": "start",
  "first-study-with-synthetic-shapes": "start",
  "read-the-workspace": "start",
  "view-images-and-set-display": "view",
  "use-histograms-deliberately": "view",
  "inspect-scalar-volumes-and-mpr": "view",
  "annotate-and-define-analysis-scope": "analyze",
  "run-practical-analysis-workflows": "analyze",
  "medical-temporal-and-registration-work": "analyze",
  "review-batch-and-export-results": "results",
  "export-rendered-figures": "results",
  "settings-recovery-and-help": "reference",
  "work-with-external-agents": "reference",
  "compose-and-reuse-workflows": "reference",
  "terminal-workflows": "reference",
};

export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

export function plainText(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^>\s?/gm, "")
    .replace(/[*`#|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function sectionHeadings(body: string): GuideHeading[] {
  return [...body.matchAll(/^### (.+)$/gm)].map((match) => ({
    title: match[1].trim(),
    id: slug(match[1].trim()),
  }));
}

const PUBLIC_MANUAL_DOCS_BASE = "https://github.com/sidd-bme/loci-app/blob/main/docs/";
const PUBLIC_MANUAL_DOC_PATH_RE =
  /^\/sidd-bme\/loci-app\/blob\/main\/docs\/(?:[A-Za-z0-9_.-]+|workflows\/FIRST_STUDY)\.md$/;

/** Match only official public Loci manual documentation URLs permitted by host link policy. */
export function isPublicManualDocUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      url.port ||
      url.username ||
      url.password ||
      url.search
    ) {
      return false;
    }
    if (url.pathname.includes("..")) return false;
    if (url.hash && !/^#[A-Za-z0-9_-]+$/.test(url.hash)) return false;
    return PUBLIC_MANUAL_DOC_PATH_RE.test(url.pathname);
  } catch {
    return false;
  }
}

export function safeLink(target: string): string | null {
  if (target.startsWith("#")) {
    const fragment = target.slice(1).trim();
    return /^[\p{L}\p{N}_-]+$/u.test(fragment) ? `#manual-${fragment}` : null;
  }
  if (target.includes("..")) return null;
  if (/^workflows\/FIRST_STUDY\.md(?:#[A-Za-z0-9_-]+)?$/.test(target)) {
    const candidate = `${PUBLIC_MANUAL_DOCS_BASE}${target}`;
    return isPublicManualDocUrl(candidate) ? candidate : null;
  }
  if (/^[A-Za-z0-9_.-]+\.md(?:#[A-Za-z0-9_-]+)?$/.test(target)) {
    const candidate = `${PUBLIC_MANUAL_DOCS_BASE}${target}`;
    return isPublicManualDocUrl(candidate) ? candidate : null;
  }
  return isPublicManualDocUrl(target) ? target : null;
}

export function parseGuide(markdown: string): { sections: GuideSection[]; groups: GuideGroup[] } {
  const sections: GuideSection[] = markdown
    .split(/^## /m)
    .map((chunk, index) => {
      if (!index) {
        const body = chunk.replace(/^# .*\n/, "").trim();
        const group: GuideGroupId = "start";
        return {
          title: "Welcome",
          id: "welcome",
          group,
          groupLabel: GROUP_LABELS[group],
          body,
          headings: sectionHeadings(body),
          searchText: plainText(body),
        };
      }
      const split = chunk.indexOf("\n");
      const title = (split === -1 ? chunk : chunk.slice(0, split)).trim();
      const id = slug(title);
      const body = split === -1 ? "" : chunk.slice(split + 1).trim();
      const group: GuideGroupId = SECTION_GROUP_MAP[id] ?? "reference";
      return {
        title,
        id,
        group,
        groupLabel: GROUP_LABELS[group],
        body,
        headings: sectionHeadings(body),
        searchText: plainText(body),
      };
    })
    .filter((section) => section.id !== "contents");

  const groups: GuideGroup[] = GROUP_ORDER.map((groupId) => ({
    id: groupId,
    label: GROUP_LABELS[groupId],
    sections: sections.filter((section) => section.group === groupId),
  })).filter((group) => group.sections.length > 0);

  return { sections, groups };
}

export function resolveGuideTarget(
  sections: GuideSection[],
  targetId?: string,
): { section: GuideSection; headingId: string | null } | null {
  if (!targetId) return null;
  const direct = sections.find((section) => section.id === targetId);
  if (direct) return { section: direct, headingId: null };
  for (const section of sections) {
    const heading = section.headings.find((item) => item.id === targetId);
    if (heading) return { section, headingId: heading.id };
  }
  return null;
}

export function buildExcerpt(searchText: string, terms: string[]): string {
  if (!searchText) return "";
  const lower = searchText.toLowerCase();
  const phrase = terms.join(" ");
  let earliest = phrase ? lower.indexOf(phrase) : -1;
  if (earliest < 0) {
    for (const term of terms) {
      const pos = lower.indexOf(term);
      if (pos >= 0 && (earliest === -1 || pos < earliest)) earliest = pos;
    }
  }
  const start = Math.max(0, (earliest >= 0 ? earliest : 0) - 52);
  const nextWord = start > 0 ? searchText.indexOf(" ", start) + 1 : 0;
  const index = nextWord > 0 && nextWord < searchText.length ? nextWord : start;
  const limit = Math.min(searchText.length, index + 185);
  const lastWord = limit < searchText.length ? searchText.lastIndexOf(" ", limit) : limit;
  const end = lastWord > index ? lastWord : limit;
  return `${index > 0 ? "…" : ""}${searchText.slice(index, end)}${end < searchText.length ? "…" : ""}`;
}

export function searchGuide(sections: GuideSection[], rawQuery: string): GuideSearchMatch[] {
  const terms = rawQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];

  const matches: GuideSearchMatch[] = [];
  for (const section of sections) {
    const titleLower = section.title.toLowerCase();
    const groupLower = section.groupLabel.toLowerCase();
    const bodyLower = section.searchText.toLowerCase();
    const combined = `${titleLower} ${groupLower} ${bodyLower}`;
    if (!terms.every((term) => combined.includes(term))) continue;

    let score = 0;
    const phrase = terms.join(" ");
    if (titleLower.includes(phrase)) score += 100;
    for (const term of terms) {
      if (titleLower.includes(term)) score += 40;
      if (bodyLower.includes(term)) score += 10;
    }

    const matchedHeadings = section.headings.filter((heading) => {
      const headingLower = heading.title.toLowerCase();
      return terms.some((term) => headingLower.includes(term));
    });
    if (matchedHeadings.length > 0) score += 28;
    if (bodyLower.includes(phrase)) score += 22;

    matches.push({
      section,
      matchedHeadings: matchedHeadings.slice(0, 4),
      excerpt: buildExcerpt(section.searchText, terms),
      score,
    });
  }

  return matches.sort((a, b) => b.score - a.score);
}

export function splitHighlight(text: string, terms: string[]): Array<{ text: string; match: boolean }> {
  const unique = [...new Set(terms.map((term) => term.trim()).filter(Boolean))];
  if (!unique.length || !text) return [{ text, match: false }];
  const escaped = unique
    .sort((a, b) => b.length - a.length)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const matcher = new RegExp(`(${escaped.join("|")})`, "gi");
  const lowerSet = new Set(unique.map((term) => term.toLowerCase()));
  return text
    .split(matcher)
    .filter((part) => part.length > 0)
    .map((part) => ({ text: part, match: lowerSet.has(part.toLowerCase()) }));
}
