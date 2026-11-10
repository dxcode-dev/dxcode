/// <reference types="vite/client" />

/**
 * `search_dx_documentation`: dx's public docs (apps/docs), bundled into the
 * Worker at build time by Vite's `import.meta.glob`, split into sections and
 * ranked by the query's words. No network, no model, no index to deploy.
 * Comparison pages (`alternatives/`) are marketing, not how dx works, so
 * they are left out.
 */

const DOCS_SITE = "https://dxcode.dev/docs";

const pages = import.meta.glob<string>(
  [
    "../../../../docs/src/content/docs/**/*.{md,mdx}",
    "!../../../../docs/src/content/docs/alternatives/**",
    "../../../../docs/src/content/log/*.md",
  ],
  { query: "?raw", import: "default", eager: true },
);

interface Section {
  readonly title: string;
  readonly heading: string;
  readonly url: string;
  readonly text: string;
}

const STOPWORDS = new Set(
  "a an and are as at be by can do does for from how i in is it of on or the to what when where which who why with you your dx".split(
    " ",
  ),
);

const stem = (word: string) =>
  word.length > 4
    ? word.replace(/(?:ing|ed|es|s)$/u, "").replace(/(.)\1$/u, "$1")
    : word;

const words = (text: string) =>
  (text.toLowerCase().match(/[a-z0-9][a-z0-9.+-]*/g) ?? [])
    .map((word) => word.replace(/[.+-]+$/u, ""))
    .filter((word) => word.length > 1 && !STOPWORDS.has(word))
    .map(stem);

const anchor = (heading: string) =>
  heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");

/** Markdown as plain text: no images, HTML, link targets, or emphasis. */
const plain = (markdown: string) =>
  markdown
    .replace(/^import .*$/gm, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]+/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const sectionsOf = (path: string, source: string): Section[] => {
  const log = path.includes("/content/log/");
  const slug = (path.split(log ? "/content/log/" : "/content/docs/")[1] ?? "")
    .replace(/\.mdx?$/u, "")
    .replace(/(?:^|\/)index$/u, "");
  const base = log
    ? `${DOCS_SITE}/log/${slug}/`
    : `${DOCS_SITE}/${slug ? `${slug}/` : ""}`;
  const frontmatter = /^---\n([\s\S]*?)\n---\n?/u.exec(source);
  const title =
    /^title:\s*["']?(.+?)["']?\s*$/mu.exec(frontmatter?.[1] ?? "")?.[1] ?? slug;
  const description =
    /^description:\s*["']?(.+?)["']?\s*$/mu.exec(frontmatter?.[1] ?? "")?.[1] ??
    "";
  const body = source.slice(frontmatter?.[0].length ?? 0);
  const sections: Section[] = [];
  let heading = "";
  let lines: string[] = description === "" ? [] : [description];
  const flush = () => {
    const text = plain(lines.join("\n"));
    if (text !== "" || heading !== "")
      sections.push({
        title,
        heading,
        url: heading === "" ? base : `${base}#${anchor(heading)}`,
        text,
      });
  };
  for (const line of body.split("\n")) {
    const match = /^#{2,3}\s+(.+)$/u.exec(line);
    if (match?.[1] === undefined) lines.push(line);
    else {
      flush();
      heading = plain(match[1]);
      lines = [];
    }
  }
  flush();
  return sections;
};

let index:
  | ReadonlyArray<Section & { readonly words: ReadonlyArray<string> }>
  | undefined;

const sectionIndex = () => {
  index ??= Object.entries(pages).flatMap(([path, source]) =>
    sectionsOf(path, source).map((section) => ({
      ...section,
      words: words(`${section.text}`),
    })),
  );
  return index;
};

const excerpt = (text: string, terms: ReadonlyArray<string>) => {
  const lower = text.toLowerCase();
  const at = Math.max(
    0,
    Math.min(
      ...terms.map((term) => {
        const found = lower.indexOf(term);
        return found === -1 ? Number.POSITIVE_INFINITY : found;
      }),
    ),
  );
  const start = Number.isFinite(at) ? Math.max(0, at - 80) : 0;
  const cut = text
    .slice(start, start + 360)
    .replace(/\s+/g, " ")
    .trim();
  return `${start > 0 ? "…" : ""}${cut}${start + 360 < text.length ? "…" : ""}`;
};

export interface DocsSearchResult {
  readonly title: string;
  readonly section?: string;
  readonly url: string;
  readonly excerpt: string;
}

/** The best section of each matching page, best first, at most `limit`. */
export const searchDxDocumentation = (
  query: string,
  limit = 5,
): ReadonlyArray<DocsSearchResult> => {
  const terms = [...new Set(words(query))];
  if (terms.length === 0) return [];
  const best = new Map<string, { score: number; section: Section }>();
  for (const section of sectionIndex()) {
    const titleWords = new Set(words(section.title));
    const headingWords = new Set(words(section.heading));
    let matched = 0;
    let score = 0;
    for (const term of terms) {
      const inBody = section.words.filter((word) => word === term).length;
      const inTitle = titleWords.has(term) ? 1 : 0;
      const inHeading = headingWords.has(term) ? 1 : 0;
      if (inBody + inTitle + inHeading === 0) continue;
      matched += 1;
      score += Math.min(inBody, 6) + inTitle * 6 + inHeading * 4;
    }
    if (matched === 0) continue;
    // Sections that hold more of the query's words come first.
    const total = score * (matched / terms.length) ** 2;
    const page = section.url.split("#")[0] ?? section.url;
    const current = best.get(page);
    if (current === undefined || current.score < total)
      best.set(page, { score: total, section });
  }
  return [...best.values()]
    .toSorted((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ section }) => ({
      title: section.title,
      ...(section.heading === "" ? {} : { section: section.heading }),
      url: section.url,
      excerpt: excerpt(section.text, terms),
    }));
};
