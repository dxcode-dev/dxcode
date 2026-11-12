import type { PluginLinkPattern } from "@dx/api";

/**
 * Installed plugins' link patterns as a remark plugin: matching text in
 * prose (not code, and not text already in a link) becomes a link to the
 * pattern's URL, with `$0`…`$9` filled from the match. Patterns compile
 * once per answer; a pattern that does not compile, or matches empty text,
 * is skipped.
 */

export interface MarkdownNode {
  type: string;
  value?: string;
  url?: string;
  title?: string | null;
  children?: MarkdownNode[];
}

interface Rule {
  readonly regex: RegExp;
  readonly url: string;
  readonly title: string;
}

const compile = (link: PluginLinkPattern): Rule | undefined => {
  try {
    return {
      regex: new RegExp(link.pattern, `${link.flags ?? ""}g`),
      url: link.url,
      title: link.title ?? link.plugin,
    };
  } catch {
    return undefined;
  }
};

const fill = (template: string, match: RegExpExecArray) =>
  template.replace(/\$(\d)/g, (_all, index: string) =>
    encodeURIComponent(match[Number(index)] ?? ""),
  );

/** The earliest match of any rule in `text` from `from`. */
const nextMatch = (rules: ReadonlyArray<Rule>, text: string, from: number) => {
  let best: { match: RegExpExecArray; rule: Rule } | undefined;
  for (const rule of rules) {
    rule.regex.lastIndex = from;
    const match = rule.regex.exec(text);
    if (match === null || match[0] === "") continue;
    if (best === undefined || match.index < best.match.index)
      best = { match, rule };
  }
  return best;
};

const split = (rules: ReadonlyArray<Rule>, text: string): MarkdownNode[] => {
  const parts: MarkdownNode[] = [];
  let at = 0;
  for (;;) {
    const found = nextMatch(rules, text, at);
    if (found === undefined) break;
    const { match, rule } = found;
    if (match.index > at)
      parts.push({ type: "text", value: text.slice(at, match.index) });
    parts.push({
      type: "link",
      url: fill(rule.url, match),
      title: rule.title,
      children: [{ type: "text", value: match[0] }],
    });
    at = match.index + match[0].length;
  }
  if (parts.length === 0) return [{ type: "text", value: text }];
  if (at < text.length) parts.push({ type: "text", value: text.slice(at) });
  return parts;
};

const MAX_TEXT = 20_000;

const SKIPPED = new Set(["link", "linkReference", "code", "inlineCode"]);

export const remarkLinkPatterns = (links: ReadonlyArray<PluginLinkPattern>) => {
  const rules = links
    .map(compile)
    .filter((rule): rule is Rule => rule !== undefined);
  return () => (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      if (node.children === undefined || SKIPPED.has(node.type)) return;
      node.children = node.children.flatMap((child) => {
        if (child.type !== "text" || child.value === undefined) {
          visit(child);
          return [child];
        }
        // Bounds the work a plugin's pattern does on one long text.
        return child.value.length > MAX_TEXT
          ? [child]
          : split(rules, child.value);
      });
    };
    visit(tree);
  };
};

/**
 * The same patterns give the same plugin, so a refetch that changed nothing
 * re-parses no Markdown.
 */
const built = new Map<string, ReturnType<typeof remarkLinkPatterns>>();

/** The link patterns as one remark plugin, or null when there are none. */
export const linkRemarkFor = (links: ReadonlyArray<PluginLinkPattern>) => {
  if (links.length === 0) return null;
  const key = JSON.stringify(links);
  const plugin = built.get(key) ?? remarkLinkPatterns(links);
  built.set(key, plugin);
  return plugin;
};
